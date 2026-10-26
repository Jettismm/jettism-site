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

const CLIENT_ID = 'PASTE_GOOGLE_CLIENT_ID_HERE';
const FOLDER_ID = '1LTfMhKHx4Osf4i4TLzDalJRJd45Ih9mC';
const INBOX_ID  = '1RNMV62XDc8OZwZivcrTy0ifqTtWEY4z6';

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return out({ ok: false, error: 'bad_request' }); }

  const who = verify(req.idToken);
  if (!who.ok) return out({ ok: false, error: who.error });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
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
