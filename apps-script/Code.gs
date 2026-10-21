/**
 * Scoring 4 Cricket — Google Apps Script backend.
 * Lives inside the "S4C Data" Google Sheet (Extensions → Apps Script).
 * Deploy as a Web app: Execute as "Me", Who has access "Anyone".
 *
 * Script properties (Project Settings → Script properties):
 *   CLIENT_ID  – the OAuth Web client ID from Google Cloud (required)
 *   OWNERS     – comma-separated owner emails (optional; defaults below)
 *   NOTIFY     – email that gets new scorer requests (optional; defaults to scoring4cricket@gmail.com)
 */

var DEFAULT_OWNERS = 'scoring4cricket@gmail.com,sm466991234@gmail.com,bmpwestside@gmail.com';
var CHUNK = 45000;            // characters per cell (Sheets limit is 50,000)
var TABS = {
  Users:   ['email', 'name', 'club', 'status', 'requested', 'decided'],
  Matches: ['id', 'owner', 'title', 'status', 'updated', 'data'],
  Live:    ['id', 'updated', 'pub'],
  Teams:   ['email', 'updated', 'data'],
  Sessions: ['token', 'email', 'name', 'created', 'expires'],
  Squads:  ['id', 'owner', 'name', 'updated', 'data']
};
var SESSION_DAYS = 90;

/* ---------- entry points ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'live') return out(live(p.id));
    if (p.action === 'ping') return out({ ok: true, app: 'S4C', time: new Date().toISOString() });
    if (p.action === 'decide') return decidePage(p.e, p.s, p.k);
    return out({ error: 'unknown' });
  } catch (err) {
    return out({ error: 'server', detail: String(err) });
  }
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return out({ error: 'bad-json' }); }
  try {
    var me = verify(body.token);
    if (!me) return out({ error: 'auth' });
    var role = roleOf(me.email);
    var a = body.action;

    if (a === 'me') {
      var res = { ok: true, user: userInfo(me, role), open: isOpen() };
      if (!me.session) { var ses = newSession(me); res.session = ses.token; res.sessionExp = ses.expires; }
      return out(res);
    }
    if (a === 'logout') { if (me.session) endSession(body.token); return out({ ok: true }); }
    if (a === 'request') return out(requestAccess(me, body));

    if (a === 'listUsers' || a === 'setUser' || a === 'setOpen') {
      if (role !== 'owner') return out({ error: 'forbidden' });
      if (a === 'listUsers') return out({ ok: true, users: listUsers(), open: isOpen() });
      if (a === 'setUser') return out(setUser(body.email, body.status, me.email));
      if (a === 'setOpen') { props().setProperty('OPEN', body.open ? '1' : '0'); return out({ ok: true, open: isOpen() }); }
    }

    if (role !== 'owner' && role !== 'scorer') return out({ error: 'forbidden', role: role });

    if (a === 'saveMatch') return out(saveMatch(me.email, role, body));
    if (a === 'listMatches') return out({ ok: true, matches: listMatches(me.email, role) });
    if (a === 'getMatch') return out(getMatch(me.email, role, body.id));
    if (a === 'saveTeams') return out(saveTeams(me.email, body.data));
    if (a === 'getTeams') return out({ ok: true, data: readText('Teams', me.email, 2) });
    if (a === 'listTeams') return out({ ok: true, teams: listTeams() });
    if (a === 'saveTeam') return out(saveTeam(me.email, role, body));
    if (a === 'deleteTeam') return out(deleteTeam(me.email, role, body.id));
    return out({ error: 'unknown' });
  } catch (err) {
    return out({ error: 'server', detail: String(err) });
  }
}

/** Run once from the editor to create the tabs and approve permissions. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(function (n) {
    var sh = ss.getSheetByName(n) || ss.insertSheet(n);
    sh.getRange(1, 1, 1, TABS[n].length).setValues([TABS[n]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  MailApp.getRemainingDailyQuota();   // asks for permission to send request emails
  secret();
  Logger.log('S4C setup done. CLIENT_ID set: ' + !!props().getProperty('CLIENT_ID'));
}

/* ---------- auth ---------- */

function props() { return PropertiesService.getScriptProperties(); }
function owners() {
  return (props().getProperty('OWNERS') || DEFAULT_OWNERS).toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(String);
}
function isOpen() { return props().getProperty('OPEN') === '1'; }

function verify(token) {
  if (!token || typeof token !== 'string' || token.length > 4000) return null;
  if (token.indexOf('s4c.') === 0) return session(token);
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var t = JSON.parse(res.getContentText());
  var cid = props().getProperty('CLIENT_ID');
  if (!cid || t.aud !== cid) return null;
  if (String(t.email_verified) !== 'true') return null;
  var left = Number(t.exp) - Math.floor(Date.now() / 1000);
  if (!(left > 0)) return null;
  var me = { email: String(t.email).toLowerCase(), name: t.name || t.email, picture: t.picture || '' };
  cache.put(key, JSON.stringify(me), Math.max(1, Math.min(600, left)));
  return me;
}

/* Long-lived app sessions, so scorers stay signed in after Google's 1-hour sign-in token expires. */
function newSession(me) {
  var token = 's4c.' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var now = new Date(), exp = new Date(now.getTime() + SESSION_DAYS * 864e5);
  withLock(function () { sheet('Sessions').appendRow([token, me.email, me.name, now, exp]); });
  CacheService.getScriptCache().put('ses_' + token, JSON.stringify({ email: me.email, name: me.name, picture: me.picture || '', session: true, exp: exp.getTime() }), 21600);
  return { token: token, expires: exp.getTime() };
}

function session(token) {
  var cache = CacheService.getScriptCache(), hit = cache.get('ses_' + token);
  var me = hit ? JSON.parse(hit) : null;
  if (!me) {
    var r = findRow('Sessions', token);
    if (!r) return null;
    me = { email: String(r.values[1]).toLowerCase(), name: r.values[2], picture: '', session: true, exp: new Date(r.values[4]).getTime() };
    cache.put('ses_' + token, JSON.stringify(me), 21600);
  }
  if (!(me.exp > Date.now())) return null;
  return me;
}

function endSession(token) {
  CacheService.getScriptCache().remove('ses_' + token);
  withLock(function () { var r = findRow('Sessions', token); if (r) sheet('Sessions').deleteRow(r.row); });
}

function roleOf(email) {
  if (owners().indexOf(email) >= 0) return 'owner';
  var u = findRow('Users', email);
  if (!u) return 'none';
  var st = String(u.values[3]);
  return st === 'approved' ? 'scorer' : st === 'blocked' ? 'blocked' : 'pending';
}

function userInfo(me, role) {
  var u = findRow('Users', me.email);
  return { email: me.email, name: (u && u.values[1]) || me.name, club: (u && u.values[2]) || '', picture: me.picture, role: role };
}

function requestAccess(me, body) {
  var role = roleOf(me.email);
  if (role === 'owner' || role === 'scorer' || role === 'blocked') return { ok: true, user: userInfo(me, role) };
  var name = clean(body.name, 60) || me.name, club = clean(body.club, 80);
  var status = isOpen() ? 'approved' : 'pending';
  var isNew = !findRow('Users', me.email);
  withLock(function () {
    var u = findRow('Users', me.email);
    var row = [me.email, name, club, u ? u.values[3] : status, u ? u.values[4] : new Date(), u ? u.values[5] : (status === 'approved' ? 'open sign-up' : '')];
    if (u) sheet('Users').getRange(u.row, 1, 1, row.length).setValues([row]);
    else sheet('Users').appendRow(row);
  });
  if (isNew) { try { notifyRequest(me.email, name, club, status); } catch (x) { Logger.log('Email failed: ' + x); } }
  return { ok: true, user: userInfo(me, roleOf(me.email)) };
}

function listUsers() {
  var v = sheet('Users').getDataRange().getValues();
  var outv = [];
  for (var i = 1; i < v.length; i++) if (v[i][0]) outv.push({ e: v[i][0], n: v[i][1], club: v[i][2], s: v[i][3], at: v[i][4] });
  return outv.reverse();
}

function setUser(email, status, by) {
  if (['approved', 'blocked', 'pending'].indexOf(status) < 0) return { error: 'bad-status' };
  email = String(email || '').toLowerCase();
  withLock(function () {
    var u = findRow('Users', email);
    if (!u) return;
    sheet('Users').getRange(u.row, 4, 1, 3).setValues([[status, u.values[4], by + ' · ' + new Date().toISOString().slice(0, 10)]]);
  });
  return { ok: true, users: listUsers() };
}

/* ---------- email notification for new scorer requests ---------- */

function notifyTo() { return props().getProperty('NOTIFY') || 'scoring4cricket@gmail.com'; }

function secret() {
  var s = props().getProperty('LINK_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props().setProperty('LINK_SECRET', s); }
  return s;
}

function sign(email, status) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(email).toLowerCase() + '|' + status, secret())).replace(/=+$/, '');
}

function decideUrl(email, status) {
  return ScriptApp.getService().getUrl() + '?action=decide&e=' + encodeURIComponent(email) + '&s=' + status + '&k=' + sign(email, status);
}

function notifyRequest(email, name, club, status) {
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var who = esc(name) + (club ? ' (' + esc(club) + ')' : '') + ' &lt;' + esc(email) + '&gt;';
  var btn = function (href, label, bg) { return '<a href="' + href + '" style="display:inline-block;padding:12px 22px;margin:4px 8px 4px 0;border-radius:24px;background:' + bg + ';color:#fff;text-decoration:none;font-weight:bold">' + label + '</a>'; };
  var html, subject;
  if (status === 'approved') {
    subject = 'S4C: ' + name + ' joined as a scorer';
    html = '<p>' + who + ' signed in and was approved automatically because Open sign-up is on.</p><p>' + btn(decideUrl(email, 'blocked'), 'Block', '#b3202a') + '</p>';
  } else {
    subject = 'S4C: ' + name + ' wants to score';
    html = '<p>' + who + ' has asked for scorer access to Scoring 4 Cricket.</p><p>' + btn(decideUrl(email, 'approved'), 'Approve', '#1f7a3f') + btn(decideUrl(email, 'blocked'), 'Decline', '#b3202a') + '</p><p style="color:#666">You can also approve them in the app under Admin → Scorer access.</p>';
  }
  MailApp.sendEmail({ to: notifyTo(), subject: subject, htmlBody: html, name: 'Scoring 4 Cricket' });
}

function decidePage(email, status, key) {
  var page = function (title, msg) {
    return HtmlService.createHtmlOutput('<div style="font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:24px;border-radius:16px;background:#0B1E3F;color:#fff;text-align:center"><h2 style="color:#D4AF37;margin-top:0">' + title + '</h2><p>' + msg + '</p><p><a style="color:#D4AF37" href="https://scoring4cricket.github.io/">Open Scoring 4 Cricket</a></p></div>').setTitle('Scoring 4 Cricket');
  };
  email = String(email || '').toLowerCase();
  if (['approved', 'blocked'].indexOf(status) < 0 || !key || key !== sign(email, status)) return page('Link not valid', 'This approval link is not valid. Use Admin → Scorer access in the app instead.');
  var u = findRow('Users', email);
  if (!u) return page('Not found', 'There is no request from ' + email + '.');
  setUser(email, status, 'email link');
  var n = String(u.values[1] || email).replace(/[<>&]/g, '');
  return page(status === 'approved' ? 'Approved' : 'Declined', status === 'approved' ? n + ' can now score matches.' : n + ' can not score in the app.');
}

/* ---------- matches ---------- */

function saveMatch(email, role, b) {
  var id = clean(b.id, 40);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return { error: 'bad-id' };
  if (typeof b.data !== 'string' || b.data.length > 2000000) return { error: 'bad-data' };
  var res = { ok: true, id: id };
  withLock(function () {
    var r = findRow('Matches', id);
    if (r && role !== 'owner' && String(r.values[1]) !== email) { res = { error: 'not-yours' }; return; }
    var owner = r ? String(r.values[1]) : email;
    var now = new Date();
    writeText('Matches', id, [id, owner, clean(b.title, 120), clean(b.status, 20), now], b.data);
    if (typeof b.pub === 'string' && b.pub.length < 2000000) {
      writeText('Live', id, [id, now], b.pub);
      try { if (b.pub.length < 95000) CacheService.getScriptCache().put('live_' + id, b.pub, 21600); else CacheService.getScriptCache().remove('live_' + id); } catch (x) {}
    }
  });
  return res;
}

function listMatches(email, role) {
  var v = sheet('Matches').getDataRange().getValues(), outv = [];
  for (var i = 1; i < v.length; i++) {
    if (!v[i][0]) continue;
    if (role !== 'owner' && String(v[i][1]) !== email) continue;
    outv.push({ id: v[i][0], owner: v[i][1], title: v[i][2], status: v[i][3], updated: v[i][4] });
  }
  return outv;
}

function getMatch(email, role, id) {
  var r = findRow('Matches', String(id || ''));
  if (!r) return { error: 'not-found' };
  if (role !== 'owner' && String(r.values[1]) !== email) return { error: 'not-yours' };
  return { ok: true, id: r.values[0], data: joinChunks(r.values, 5) };
}

function live(id) {
  id = String(id || '');
  if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return { error: 'bad-id' };
  var c = CacheService.getScriptCache().get('live_' + id);
  if (c) return { ok: true, pub: c };
  var r = findRow('Live', id);
  if (!r) return { error: 'not-found' };
  return { ok: true, pub: joinChunks(r.values, 2), updated: r.values[1] };
}

/* Shared team list: every approved scorer sees every team; only its creator or an owner can change it. */
function listTeams() {
  var v = sheet('Squads').getDataRange().getValues(), outv = [];
  for (var i = 1; i < v.length; i++) if (v[i][0]) outv.push({ id: String(v[i][0]), owner: String(v[i][1]), data: joinChunks(v[i], 4) });
  return outv;
}

function saveTeam(email, role, b) {
  var id = clean(b.id, 40);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return { error: 'bad-id' };
  if (typeof b.data !== 'string' || b.data.length > 1000000) return { error: 'bad-data' };
  var res = { ok: true, id: id };
  withLock(function () {
    var r = findRow('Squads', id);
    if (r && role !== 'owner' && String(r.values[1]) !== email) { res = { error: 'not-yours' }; return; }
    var owner = r ? String(r.values[1]) : email;
    var name = '';
    try { name = clean(JSON.parse(b.data).name, 80); } catch (x) {}
    writeText('Squads', id, [id, owner, name, new Date()], b.data);
  });
  return res;
}

function deleteTeam(email, role, id) {
  id = String(id || '');
  var res = { ok: true };
  withLock(function () {
    var r = findRow('Squads', id);
    if (!r) return;
    if (role !== 'owner' && String(r.values[1]) !== email) { res = { error: 'not-yours' }; return; }
    sheet('Squads').deleteRow(r.row);
  });
  return res;
}

function saveTeams(email, data) {
  if (typeof data !== 'string' || data.length > 1000000) return { error: 'bad-data' };
  withLock(function () { writeText('Teams', email, [email, new Date()], data); });
  return { ok: true };
}

/* ---------- sheet helpers ---------- */

function sheet(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]); sh.setFrozenRows(1); }
  return sh;
}

function findRow(name, key) {
  if (!key) return null;
  var v = sheet(name).getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]).toLowerCase() === String(key).toLowerCase()) return { row: i + 1, values: v[i] };
  return null;
}

function writeText(name, key, fixed, text) {
  var sh = sheet(name), parts = [];
  for (var i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  if (!parts.length) parts.push('');
  // Each chunk starts with "~" so Sheets never reads it as a number or formula.
  var row = fixed.concat(parts.map(function (p) { return '~' + p; }));
  var r = findRow(name, key);
  var at = r ? r.row : sh.getLastRow() + 1;
  if (r) { var w = sh.getLastColumn(); if (w > 0) sh.getRange(at, 1, 1, w).clearContent(); }
  sh.getRange(at, fixed.length + 1, 1, parts.length).setNumberFormat('@');
  sh.getRange(at, 1, 1, row.length).setValues([row]);
}

function joinChunks(values, from) {
  var s = '';
  for (var i = from; i < values.length; i++) {
    var v = values[i];
    if (v === '' || v == null) break;
    v = String(v);
    s += v.charAt(0) === '~' ? v.slice(1) : v;
  }
  return s;
}

function readText(name, key, from) { var r = findRow(name, key); return r ? joinChunks(r.values, from) : ''; }

function withLock(fn) {
  var l = LockService.getScriptLock();
  l.waitLock(20000);
  try { fn(); SpreadsheetApp.flush(); } finally { l.releaseLock(); }
}

function clean(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n); }

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
