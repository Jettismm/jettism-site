/**
 * Jettism Idea Board — backend (Google Apps Script Web App)
 *
 * Storage lives in the Drive folder "Jettism Idea Board":
 *   board.json           every idea, its status, feedback and production info
 *   allowed-emails.json  Google accounts allowed to use the board
 *   inbox/               new idea batches dropped here every 6 hours;
 *                        imported into board.json on the next page load
 *
 * Every request must carry a Google ID token from "Sign in with Google".
 * The token is checked with Google, and its email must be on the allowlist.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as: Me    Who has access: Anyone
 */

const CLIENT_ID = '527398886152-lraqu16t3ftnb9fqlgjf0givm9bs1s2v.apps.googleusercontent.com';
const FOLDER_ID = '1LTfMhKHx4Osf4i4TLzDalJRJd45Ih9mC';
const INBOX_ID  = '1RNMV62XDc8OZwZivcrTy0ifqTtWEY4z6';
const THUMBS_INBOX_ID = '19vMTZvOrjO4fA25kbr8-R4lqq3GgEAjD';

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out({ ok: false, error: 'bad_request' }); }

  const who = verify(req.idToken);
  if (!who.ok) return out({ ok: false, error: who.error });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  if (String(req.action || '').indexOf('thumbs.') === 0) {
    try { return thumbsAction(req, who); } finally { lock.releaseLock(); }
  }
  try {
    const board = loadBoard();
    importInbox(board);
    const now = new Date().toISOString();
    const idea = req.id ? board.ideas.find(i => i.id === req.id) : null;
    if (req.id && !idea) return out({ ok: false, error: 'not_found' });

    switch (req.action) {
      case 'list':
        break;

      case 'feedback': {             // good -> In Progress, reject -> trash
        const note = String(req.note || '').slice(0, 4000);
        if (req.verdict === 'reject' && !note.trim()) return out({ ok: false, error: 'reason_required' });
        idea.feedback = { verdict: req.verdict === 'good' ? 'good' : 'reject', note, at: now, by: who.email };
        idea.status = idea.feedback.verdict === 'good' ? 'progress' : 'rejected';
        if (idea.status === 'progress') idea.progress = idea.progress || { editor: '', recorded: false, sentToEditor: false, notes: '' };
        break;
      }

      case 'progress': {             // edit In Progress / Finished fields
        const f = req.fields || {};
        idea.progress = idea.progress || {};
        ['editor', 'notes', 'views', 'link'].forEach(k => { if (k in f) idea.progress[k] = String(f[k]).slice(0, 4000); });
        ['recorded', 'sentToEditor'].forEach(k => { if (k in f) idea.progress[k] = !!f[k]; });
        break;
      }

      case 'finish':
        idea.status = 'finished';
        idea.finishedAt = now;
        break;

      case 'move':                   // undo-style moves between columns
        if (['new', 'progress', 'finished', 'rejected'].indexOf(req.to) === -1) return out({ ok: false, error: 'bad_request' });
        idea.status = req.to;
        if (req.to === 'new') delete idea.feedback;
        break;

      default:
        return out({ ok: false, error: 'bad_request' });
    }

    if (req.action !== 'list') idea.updatedAt = now;
    saveBoard(board);
    return out({ ok: true, email: who.email, ideas: board.ideas });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- thumbnail practice (jettism.com/thumbs) ---------- */

function thumbsAction(req, who) {
  const data = loadJson('thumbs.json', { thumbs: [], notepad: '' });
  data.thumbs = data.thumbs || [];
  if (typeof data.notepad !== 'string') data.notepad = '';
  importThumbsInbox(data);
  const now = new Date().toISOString();
  const t = req.id ? data.thumbs.find(x => x.id === req.id) : null;
  if (req.id && !t) return out({ ok: false, error: 'not_found' });

  switch (req.action) {
    case 'thumbs.list':
      break;

    case 'thumbs.title': {           // save one of my titles; also add it to the notepad
      const text = String(req.text || '').trim().slice(0, 300);
      if (!text) return out({ ok: false, error: 'bad_request' });
      t.myTitles = t.myTitles || [];
      t.myTitles.push({ text, at: now });
      data.notepad = (data.notepad.replace(/\s+$/, '') + (data.notepad.trim() ? '\n' : '') + text);
      break;
    }

    case 'thumbs.save':              // bookmark on/off
      t.saved = !!req.saved;
      t.savedAt = t.saved ? now : '';
      break;

    case 'thumbs.hide': {            // "don't recommend this" + why
      const reason = String(req.reason || '').trim().slice(0, 2000);
      if (!reason) return out({ ok: false, error: 'reason_required' });
      t.hidden = true; t.hideReason = reason; t.hiddenAt = now;
      break;
    }

    case 'thumbs.unhide':
      t.hidden = false;
      break;

    case 'thumbs.seen':
      t.seenAt = now;
      break;

    case 'thumbs.notepad':
      data.notepad = String(req.text || '').slice(0, 200000);
      data.notepadAt = now;
      break;

    default:
      return out({ ok: false, error: 'bad_request' });
  }

  if (req.action !== 'thumbs.list' || data.__imported) { delete data.__imported; saveJson('thumbs.json', data); }
  return out({ ok: true, email: who.email, thumbs: data.thumbs, notepad: data.notepad });
}

function importThumbsInbox(data) {
  const files = DriveApp.getFolderById(THUMBS_INBOX_ID).getFiles();
  const seen = {};
  data.thumbs.forEach(x => seen[x.id] = true);
  const batches = [];
  while (files.hasNext()) batches.push(files.next());
  batches.sort((a, b) => a.getDateCreated() - b.getDateCreated());
  batches.forEach(file => {
    let b;
    try { b = JSON.parse(file.getBlob().getDataAsString()); }
    catch (e) { file.setName('BROKEN - ' + file.getName()); return; }
    const list = Array.isArray(b) ? b : (b.thumbs || []);
    const at = b.generatedAt || file.getDateCreated().toISOString();
    list.forEach(raw => {
      const id = String(raw.id || '').trim();
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || seen[id]) return;
      seen[id] = true;
      data.thumbs.push({
        id, addedAt: at,
        title: String(raw.title || ''), creator: String(raw.creator || ''),
        niche: String(raw.niche || ''), views: String(raw.views || ''),
        url: raw.url || ('https://www.youtube.com/watch?v=' + id),
        myTitles: [], saved: false, hidden: false
      });
    });
    file.setTrashed(true);
    data.__imported = true;
  });
}

function loadJson(name, fallback) {
  const f = newestFile(FOLDER_ID, name);
  if (!f) return fallback;
  try { return JSON.parse(f.getBlob().getDataAsString()); } catch (e) { return fallback; }
}

function saveJson(name, obj) {
  const f = newestFile(FOLDER_ID, name);
  const text = JSON.stringify(obj);
  if (f) f.setContent(text);
  else DriveApp.getFolderById(FOLDER_ID).createFile(name, text, 'application/json');
}

function doGet() {
  return out({ ok: true, service: 'jettism-idea-board' });
}

/* ---------- auth ---------- */

function verify(idToken) {
  if (!idToken) return { ok: false, error: 'signin_required' };
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);

  let info = cache.get(key);
  if (info) info = JSON.parse(info);
  else {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'signin_required' };
    info = JSON.parse(res.getContentText());
    if (info.aud !== CLIENT_ID) return { ok: false, error: 'signin_required' };
    if (Number(info.exp) * 1000 < Date.now()) return { ok: false, error: 'signin_required' };
    cache.put(key, JSON.stringify({ email: info.email, email_verified: info.email_verified, exp: info.exp }), 300);
  }
  if (Number(info.exp) * 1000 < Date.now()) return { ok: false, error: 'signin_required' };

  const email = String(info.email || '').toLowerCase();
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!verified || allowedEmails().indexOf(email) === -1) return { ok: false, error: 'not_allowed', email };
  return { ok: true, email };
}

function allowedEmails() {
  const f = newestFile(FOLDER_ID, 'allowed-emails.json');
  if (!f) return [];
  try { return JSON.parse(f.getBlob().getDataAsString()).map(s => String(s).toLowerCase().trim()); }
  catch (e) { return []; }
}

/* ---------- storage ---------- */

function loadBoard() {
  const f = newestFile(FOLDER_ID, 'board.json');
  if (!f) return { ideas: [] };
  try {
    const b = JSON.parse(f.getBlob().getDataAsString());
    b.ideas = b.ideas || [];
    return b;
  } catch (e) { return { ideas: [] }; }
}

function saveBoard(board) {
  const f = newestFile(FOLDER_ID, 'board.json');
  const text = JSON.stringify(board, null, 1);
  if (f) f.setContent(text);
  else DriveApp.getFolderById(FOLDER_ID).createFile('board.json', text, 'application/json');
}

/** Pull every idea batch in inbox/ into the board, then trash the batch file. */
function importInbox(board) {
  const files = DriveApp.getFolderById(INBOX_ID).getFiles();
  const seen = {};
  board.ideas.forEach(i => seen[i.id] = true);
  const batches = [];
  while (files.hasNext()) batches.push(files.next());
  batches.sort((a, b) => a.getDateCreated() - b.getDateCreated());

  batches.forEach(file => {
    let data;
    try { data = JSON.parse(file.getBlob().getDataAsString()); }
    catch (e) { file.setName('BROKEN - ' + file.getName()); return; }
    const list = Array.isArray(data) ? data : (data.ideas || []);
    const batchAt = data.generatedAt || file.getDateCreated().toISOString();
    list.forEach((raw, n) => {
      const id = raw.id || ('i' + file.getDateCreated().getTime().toString(36) + n);
      if (seen[id]) return;
      seen[id] = true;
      board.ideas.push({
        id,
        status: 'new',
        createdAt: batchAt,
        type: raw.type || '',
        title: raw.title || 'Untitled idea',
        altTitle: raw.altTitle || '',
        hook: raw.hook || '',
        how: Array.isArray(raw.how) ? raw.how : (raw.how ? [String(raw.how)] : []),
        defenses: raw.defenses || '',
        setupTime: raw.setupTime || '',
        ifFails: raw.ifFails || '',
        risk: raw.risk || ''
      });
    });
    file.setTrashed(true);
  });
}

function newestFile(folderId, name) {
  const it = DriveApp.getFolderById(folderId).getFilesByName(name);
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  }
  return best;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to grant Drive + external request permissions. */
function authorize() {
  DriveApp.getFolderById(FOLDER_ID).getName();
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
}
