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

  // Sign in once with Google, then use a long-lived site session (stays signed in for a year).
  if (req.action === 'login') {
    const g = verify(req.idToken);
    if (!g.ok) return out({ ok: false, error: g.error, email: g.email });
    return out({ ok: true, email: g.email, session: createSession(g.email) });
  }
  if (req.action === 'logout') { if (req.session) endSession(req.session); return out({ ok: true }); }

  const who = req.session ? checkSession(req.session) : verify(req.idToken);
  if (!who.ok) return out({ ok: false, error: who.error, email: who.email });

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
        idea.feedback = { verdict: req.verdict === 'good' ? 'good' : 'reject', note, at: now, by: who.email, auto: !!req.auto };
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

const OWNER_EMAIL = 'jettism.contact@gmail.com';
const MIN_VIEWS = 50000;      // thumbnails from videos under this many views are never shown
const MAX_VIEWS = 10000000;   // ...or over this many (titles everyone already knows)

/**
 * thumbs.json = { thumbs: [shared pool], users: { "<email>": profile } }
 * profile    = { titles: {id: [{text, at}]}, saved: {id: at}, hidden: {id: {reason, at}},
 *                seen: {id: at}, notepad: "", notepadAt: "" }
 * Each signed-in person only ever sees and edits their own profile.
 */
function thumbsAction(req, who) {
  const data = loadJson('thumbs.json', { thumbs: [], users: {} });
  data.thumbs = data.thumbs || [];
  data.users = data.users || {};
  let changed = migrateThumbs(data);
  if (req.action === 'thumbs.list') {          // slow work only on page load, never on clicks
    importThumbsInbox(data);
    if (data.__imported) { changed = true; delete data.__imported; }
    if (checkViews(data)) changed = true;
  }

  const email = who.email;
  if (!data.users[email]) { data.users[email] = blankProfile(); changed = true; }
  const me = data.users[email];
  const now = new Date().toISOString();
  const t = req.id ? data.thumbs.find(x => x.id === req.id) : null;
  if (req.id && !t) return out({ ok: false, error: 'not_found' });
  const id = req.id;

  switch (req.action) {
    case 'thumbs.list':
      break;

    case 'thumbs.title': {           // save one of my titles; also add it to my notepad
      const text = String(req.text || '').trim().slice(0, 300);
      if (!text) return out({ ok: false, error: 'bad_request' });
      (me.titles[id] = me.titles[id] || []).push({ text, at: now });
      me.notepad = me.notepad.replace(/\s+$/, '') + (me.notepad.trim() ? '\n' : '') + text;
      changed = true;
      break;
    }

    case 'thumbs.save':              // bookmark on/off
      if (req.saved) me.saved[id] = now; else delete me.saved[id];
      changed = true;
      break;

    case 'thumbs.hide': {            // "don't recommend this" + why
      const reason = String(req.reason || '').trim().slice(0, 2000);
      if (!reason) return out({ ok: false, error: 'reason_required' });
      me.hidden[id] = { reason, at: now };
      changed = true;
      break;
    }

    case 'thumbs.unhide':
      delete me.hidden[id]; changed = true;
      break;

    case 'thumbs.seen':
      me.seen[id] = now; changed = true;
      break;

    case 'thumbs.notepad':
      me.notepad = String(req.text || '').slice(0, 200000);
      me.notepadAt = now; changed = true;
      break;

    default:
      return out({ ok: false, error: 'bad_request' });
  }

  if (changed) saveJson('thumbs.json', data);
  if (req.action !== 'thumbs.list') return out({ ok: true, email });

  // Give the page the shared pool merged with ONLY this person's profile.
  const view = data.thumbs.filter(x => x.checkedAt && !x.lowViews && !x.gone && !(x.viewCount > MAX_VIEWS)).map(x => ({
    id: x.id, title: x.title, creator: x.creator, niche: x.niche, views: x.views, url: x.url, addedAt: x.addedAt,
    myTitles: me.titles[x.id] || [],
    saved: !!me.saved[x.id], savedAt: me.saved[x.id] || '',
    hidden: !!me.hidden[x.id], hideReason: me.hidden[x.id] ? me.hidden[x.id].reason : '',
    seenAt: me.seen[x.id] || ''
  }));
  return out({ ok: true, email, thumbs: view, notepad: me.notepad });
}

/**
 * Ask YouTube for the real view count, title and channel of every thumbnail not checked yet
 * (YouTube Data API advanced service, run as the site owner). Videos under MIN_VIEWS, or that
 * no longer exist, stay in the pool (so the scout never re-adds them) but are never shown.
 */
function checkViews(data) {
  const todo = data.thumbs.filter(x => !x.checkedAt).map(x => x.id);
  if (!todo.length) return false;
  const now = new Date().toISOString();
  for (let i = 0; i < todo.length; i += 50) {
    const ids = todo.slice(i, i + 50);
    let items;
    try { items = YouTube.Videos.list('snippet,statistics', { id: ids.join(','), maxResults: 50 }).items || []; }
    catch (e) { return i > 0; }          // try again on the next page load
    const found = {};
    items.forEach(v => {
      found[v.id] = true;
      const x = data.thumbs.find(t => t.id === v.id);
      const n = Number((v.statistics && v.statistics.viewCount) || 0);
      x.viewCount = n;
      x.views = shortViews(n);
      if (v.snippet) { x.title = v.snippet.title || x.title; x.creator = v.snippet.channelTitle || x.creator; }
      x.lowViews = n < MIN_VIEWS;
      x.checkedAt = now;
    });
    ids.forEach(id => {
      if (!found[id]) { const x = data.thumbs.find(t => t.id === id); x.gone = true; x.checkedAt = now; }
    });
  }
  return true;
}

function shortViews(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function blankProfile() {
  return { titles: {}, saved: {}, hidden: {}, seen: {}, notepad: '', notepadAt: '' };
}

/** One-time move of the old single-user fields into the owner's profile. */
function migrateThumbs(data) {
  let moved = false;
  const owner = data.users[OWNER_EMAIL] || blankProfile();
  data.thumbs.forEach(x => {
    if (x.myTitles && x.myTitles.length) { owner.titles[x.id] = (owner.titles[x.id] || []).concat(x.myTitles); moved = true; }
    if (x.saved) { owner.saved[x.id] = x.savedAt || x.addedAt || new Date().toISOString(); moved = true; }
    if (x.hidden) { owner.hidden[x.id] = { reason: x.hideReason || '', at: x.hiddenAt || '' }; moved = true; }
    if (x.seenAt) { owner.seen[x.id] = x.seenAt; moved = true; }
    ['myTitles', 'saved', 'savedAt', 'hidden', 'hideReason', 'hiddenAt', 'seenAt'].forEach(k => {
      if (k in x) { delete x[k]; moved = true; }
    });
  });
  if (typeof data.notepad === 'string') {
    if (data.notepad) owner.notepad = owner.notepad ? owner.notepad + '\n' + data.notepad : data.notepad;
    delete data.notepad; delete data.notepadAt; moved = true;
  }
  if (moved || !data.users[OWNER_EMAIL]) data.users[OWNER_EMAIL] = owner;
  return moved;
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
        url: raw.url || ('https://www.youtube.com/watch?v=' + id)
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

/* ---------- long-lived sessions ---------- */

const SESSION_DAYS = 365;

function sessKey(token) {
  return 'sess_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 43);
}

function createSession(email) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty(sessKey(token), JSON.stringify({ email, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return token;
}

function checkSession(token) {
  const props = PropertiesService.getScriptProperties();
  const key = sessKey(String(token));
  const raw = props.getProperty(key);
  if (!raw) return { ok: false, error: 'signin_required' };
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) { props.deleteProperty(key); return { ok: false, error: 'signin_required' }; }
  if (allowedEmails().indexOf(s.email) === -1) { props.deleteProperty(key); return { ok: false, error: 'not_allowed', email: s.email }; }
  // keep active people signed in: push the expiry out again if it's under 300 days away
  if (s.exp - Date.now() < 300 * 864e5) { s.exp = Date.now() + SESSION_DAYS * 864e5; props.setProperty(key, JSON.stringify(s)); }
  return { ok: true, email: s.email };
}

function endSession(token) {
  PropertiesService.getScriptProperties().deleteProperty(sessKey(String(token)));
}

function allowedEmails() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('allowed_emails');
  if (hit) return JSON.parse(hit);
  const f = newestFile(FOLDER_ID, 'allowed-emails.json');
  if (!f) return [];
  let list = [];
  try { list = JSON.parse(f.getBlob().getDataAsString()).map(s => String(s).toLowerCase().trim()); }
  catch (e) { return []; }
  cache.put('allowed_emails', JSON.stringify(list), 300);   // re-read the list at most every 5 minutes
  return list;
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
      if (seen[id]) {
        // Backfill a "Why it won't work" critique onto an idea that's already on the board.
        const old = board.ideas.find(i => i.id === id);
        if (old && raw.whyNot) old.whyNot = raw.whyNot;
        return;
      }
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
        risk: raw.risk || '',
        whyNot: raw.whyNot || ''
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
  YouTube.Videos.list('statistics', { id: 'dQw4w9WgXcQ' });
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
}
