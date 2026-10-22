/* Scoring 4 Cricket — cloud layer: Google sign-in, roles, sync to the S4C Data sheet, live viewer.
   Loaded before the main app script. The app calls CLOUD.* hooks. */
(function () {
  const CFG = Object.assign({ API_URL: '', CLIENT_ID: '', BASE: location.origin + location.pathname }, window.S4C_CONFIG || {});
  const TOK = 's4c-token', SYNC = 's4c-sync', WHO = 's4c-user', SYNCT = 's4c-sync-teams';
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const hashLive = () => { const m = /^#live=([A-Za-z0-9_-]{1,40})/.exec(location.hash); return m ? m[1] : null; };

  const C = window.CLOUD = {
    cfg: CFG,
    configured: !!(CFG.API_URL && CFG.CLIENT_ID),
    viewer: !!hashLive(),
    liveId: hashLive(),
    liveErr: '',
    role: 'none',            // none | pending | blocked | scorer | owner
    user: null,
    token: null,
    status: 'idle',          // idle | saving | saved | offline | error | signin
    users: null, usersAt: 0, open: false,
    busy: false, err: '',
    ready: false,
    sent: ls.get(SYNC) || {},
    sentT: ls.get(SYNCT) || {},
    dirty: {}, dirtyT: {}, delT: {}, teamsAt: 0
  };

  /* ---------- helpers ---------- */
  C.canEdit = t => !C.configured || !t || !t.owner || C.role === 'owner' || (C.user && t.owner === C.user.email);
  C.ok = () => !C.configured || C.role === 'owner' || C.role === 'scorer';
  C.name = () => (C.user && C.user.name) || (C.configured ? '' : 'Local mode');
  C.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  C.liveUrl = id => CFG.BASE + '#live=' + id;
  C.joinUrl = () => CFG.BASE + '#join';
  const rr = () => { if (typeof render === 'function') render(); };
  const say = t => { if (typeof toast === 'function') toast(t); };

  async function api(action, payload) {
    if (!C.configured) throw new Error('not-configured');
    const res = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action, token: C.token }, payload || {})), redirect: 'follow' });
    const j = await res.json();
    if (j.error === 'auth') { C.token = null; ls.set(TOK, null); C.status = 'signin'; promptSignIn(); throw new Error('auth'); }
    return j;
  }
  C.api = api;

  /* ---------- sign-in (full-page redirect: works inside the home-screen app too) ---------- */
  function parseJwt(t) { try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; } }
  const NONCE = 's4c-nonce';
  function startSignIn() {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ls.set(NONCE, nonce);
    const q = new URLSearchParams({ client_id: CFG.CLIENT_ID, redirect_uri: CFG.BASE, response_type: 'id_token', scope: 'openid email profile', nonce, prompt: 'select_account' });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
  }
  function promptSignIn() { C.status = 'signin'; paintStatus(); }
  C.drawButton = () => {};
  function takeRedirect() {
    if (!/[#&](id_token|error)=/.test(location.hash)) return null;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (h.get('error')) { C.err = h.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed (' + h.get('error') + ').'; return null; }
    const t = h.get('id_token'), p = parseJwt(t || '');
    if (!t || p.nonce !== ls.get(NONCE)) { C.err = 'Sign-in could not be confirmed. Please try again.'; return null; }
    ls.set(NONCE, null);
    return t;
  }

  async function whoAmI(fresh) {
    C.busy = true; C.err = ''; rr();
    try {
      const j = await api('me');
      if (j.ok) {
        const was = C.role;
        C.user = j.user; C.role = j.user.role; C.open = !!j.open;
        if (j.session) { C.token = j.session; ls.set(TOK, { t: j.session, exp: j.sessionExp || Date.now() + 864e5 * 30 }); }
        ls.set(WHO, { user: C.user, role: C.role });
        if (C.status === 'signin') C.status = 'idle';
        if ((C.role === 'owner' || C.role === 'scorer') && (fresh || was !== C.role)) pull();
        if (C.role === 'owner' || C.role === 'scorer') { flush(); C.pullTeams(true); }
      } else C.err = 'Sign-in failed (' + (j.error || 'unknown') + ').';
    } catch (e) {
      if (e.message !== 'auth') { C.err = navigator.onLine ? 'Could not reach the S4C server.' : 'You are offline.'; C.status = 'offline'; }
    }
    C.busy = false; C.ready = true; rr();
  }

  C.signOut = () => {
    const t = C.token;
    if (t && String(t).indexOf('s4c.') === 0) api('logout').catch(() => {});
    ls.set(TOK, null); ls.set(WHO, null); C.token = null; C.user = null; C.role = 'none'; C.users = null; C.status = 'idle';
    rr();
  };

  C.request = async (name, club) => {
    C.busy = true; rr();
    try { const j = await api('request', { name, club }); if (j.ok) { C.user = j.user; C.role = j.user.role; ls.set(WHO, { user: C.user, role: C.role }); } } catch (e) { C.err = 'Could not send your request.'; }
    C.busy = false; rr();
    if (C.role === 'scorer') { say('You are approved — welcome!'); pull(); }
  };

  /* ---------- owner admin ---------- */
  C.loadUsers = async force => {
    if (C.role !== 'owner' || (!force && C.users && Date.now() - C.usersAt < 30000)) return;
    C.usersAt = Date.now();
    try { const j = await api('listUsers'); if (j.ok) { C.users = j.users; C.open = j.open; rr(); } } catch (e) {}
  };
  C.setUser = async (email, status) => {
    try { const j = await api('setUser', { email, status }); if (j.ok) { C.users = j.users; rr(); say(status === 'approved' ? 'Scorer approved' : status === 'blocked' ? 'Access blocked' : 'Updated'); } }
    catch (e) { say('Could not update — try again'); }
  };
  C.setOpen = async open => {
    try { const j = await api('setOpen', { open }); if (j.ok) { C.open = j.open; rr(); } } catch (e) { say('Could not update — try again'); }
  };
  C.reqs = () => (C.users || []).map(u => ({ n: u.n || u.e, e: u.e, club: u.club || '—', s: u.s || 'pending' }));

  /* ---------- sync ---------- */
  const titleOf = m => { try { return m.teams[0].name + ' v ' + m.teams[1].name; } catch (e) { return 'Match'; } };
  const statusOf = m => { try { return (typeof resultOf === 'function' && resultOf(m)) ? 'done' : 'live'; } catch (e) { return 'live'; } };
  const worth = m => m && !m.sample && !m.deleted && m.inns && m.inns.some(x => x.ev && x.ev.length > 0);
  const quick = s => { let h = 0; for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ':' + h; };

  let timer = null;
  C.onSave = S => {
    if (C.viewer || !C.configured || !C.ok()) return;
    const ms = [S.match].concat(S.history || []);
    ms.forEach(m => {
      if (!worth(m)) return;
      if (!m.id) m.id = C.uid();
      const d = JSON.stringify(m), q = quick(d);
      if (C.sent[m.id] !== q) C.dirty[m.id] = m;
    });
    if (C.user) {
      const ids = new Set();
      (S.teams || []).forEach(t => {
        ids.add(t.id);
        if (!t.owner) { t.owner = C.user.email; t.ownerName = C.user.name; }
        if (!C.canEdit(t)) return;
        const q = quick(JSON.stringify(t));
        if (C.sentT[t.id] !== q) C.dirtyT[t.id] = t;
      });
      Object.keys(C.sentT).forEach(id => { if (!ids.has(id) && !C.delT[id]) C.delT[id] = true; });
    }
    if (pending()) { clearTimeout(timer); timer = setTimeout(flush, 1500); }
  };

  const pending = () => Object.keys(C.dirty).length + Object.keys(C.dirtyT).length + Object.keys(C.delT).length;
  let flushing = false;
  async function flush() {
    if (flushing || !C.token || !C.ok() || !C.configured) return;
    const ids = Object.keys(C.dirty);
    if (!pending()) return;
    if (!navigator.onLine) { C.status = 'offline'; paintStatus(); return; }
    flushing = true; C.status = 'saving'; paintStatus();
    try {
      for (const id of Object.keys(C.dirtyT)) {
        const t = C.dirtyT[id], d = JSON.stringify(t);
        const j = await api('saveTeam', { id, data: d });
        if (j.ok || j.error === 'not-yours') { C.sentT[id] = quick(d); if (C.dirtyT[id] === t) delete C.dirtyT[id]; }
      }
      for (const id of Object.keys(C.delT)) {
        const j = await api('deleteTeam', { id });
        if (j.ok || j.error === 'not-yours') { delete C.sentT[id]; delete C.delT[id]; }
      }
      ls.set(SYNCT, C.sentT);
      for (const id of ids) {
        const m = C.dirty[id];
        const d = JSON.stringify(m);
        const pub = JSON.stringify(typeof maskMatch === 'function' ? maskMatch(m) : m);
        const j = await api('saveMatch', { id, title: titleOf(m), status: statusOf(m), data: d, pub });
        if (j.ok) { C.sent[id] = quick(d); if (C.dirty[id] === m) delete C.dirty[id]; }
        else if (j.error === 'not-yours') { delete C.dirty[id]; say('This match belongs to another scorer — not saved online'); }
      }
      ls.set(SYNC, C.sent);
      C.status = pending() ? 'saving' : 'saved';
    } catch (e) { C.status = e.message === 'auth' ? 'signin' : 'offline'; }
    flushing = false; paintStatus();
    if (pending() && C.status === 'saving') setTimeout(flush, 800);
  }

  /* shared team list: bring in everyone's teams, keep local edits that are not uploaded yet */
  C.pullTeams = async force => {
    if (!C.configured || !C.token || !C.ok() || C.viewer) return;
    if (!force && Date.now() - C.teamsAt < 20000) return;
    C.teamsAt = Date.now();
    try {
      const j = await api('listTeams');
      if (!j.ok) return;
      const byId = {}; (S.teams || []).forEach(t => byId[t.id] = t);
      const server = new Set();
      const next = [];
      j.teams.forEach(x => {
        let t; try { t = JSON.parse(x.data); } catch (e) { return; }
        t.id = x.id; t.owner = x.owner; server.add(x.id);
        if (C.dirtyT[x.id] && byId[x.id]) next.push(byId[x.id]);
        else { next.push(t); C.sentT[x.id] = quick(JSON.stringify(t)); }
      });
      (S.teams || []).forEach(t => {
        if (server.has(t.id) || C.delT[t.id]) return;
        if (C.sentT[t.id]) { delete C.sentT[t.id]; return; }   // removed by its owner elsewhere
        next.push(t);                                            // new here, not uploaded yet
      });
      const before = JSON.stringify(S.teams || []);
      S.teams = next; ls.set(SYNCT, C.sentT);
      if (JSON.stringify(next) !== before) rr();
    } catch (e) {}
  };
  C.flush = flush;
  window.addEventListener('online', () => { C.status = 'idle'; flush(); });
  setInterval(() => { if (pending()) flush(); }, 20000);

  async function pull() {
    try {
      const j = await api('listMatches');
      if (!j.ok) return;
      const have = new Set([S.match && S.match.id].concat((S.history || []).map(h => h.id)).filter(Boolean));
      const mine = j.matches.filter(x => !have.has(x.id) && (x.mine != null ? x.mine : (C.role !== 'owner' || x.owner === C.user.email))).slice(-50);
      let changed = false;
      for (const x of mine) {
        const g = await api('getMatch', { id: x.id });
        if (!g.ok || !g.data) continue;
        let m; try { m = JSON.parse(g.data); } catch (e) { continue; }
        m.id = x.id; C.sent[x.id] = quick(g.data);
        if (x.status === 'live' && (!S.match || S.match.deleted || S.match.sample)) S.match = m;
        else { S.history = S.history || []; S.history.push(m); }
        changed = true;
      }
      await C.pullTeams(true);
      if (!S.teams || !S.teams.length) {           // teams saved by the older version of the app
        const t = await api('getTeams');
        if (t.ok && t.data) { try { S.teams = JSON.parse(t.data); changed = true; } catch (e) {} }
      }
      ls.set(SYNC, C.sent);
      if (changed) { rr(); say('Your matches are loaded'); }
    } catch (e) {}
  }

  /* ---------- status chip ---------- */
  function paintStatus() {
    const el = document.getElementById('syncchip');
    if (!el) return;
    const map = { idle: ['Signed in', 'ok'], saving: ['Saving…', 'sv'], saved: ['Saved online', 'ok'], offline: ['Offline · will sync', 'off'], error: ['Not saved online', 'off'], signin: ['Tap to sign in', 'off'] };
    let v = !C.configured ? ['Saved on this device', 'ok'] : C.viewer ? ['Live scoreboard', 'ok'] : C.ok() ? map[C.status] || map.idle : null;
    el.hidden = !v; el.style.display = v ? '' : 'none';
    if (!v) return;
    const ini = C.user && C.ok() && !C.viewer ? initials(C.user.name || C.user.email) : '';
    const quiet = ['Signed in', 'Saved online'].includes(v[0]);
    el.innerHTML = '<i></i>' + (ini ? '<b class="ini">' + ini + '</b>' + (quiet ? '' : ' · ' + v[0]) : v[0]);
    el.title = (C.user ? C.user.name + ' · ' + (C.role === 'owner' ? 'Owner' : 'Scorer') + ' · ' : '') + v[0];
    el.className = 'sync st-' + v[1];
    if (C.status === 'signin' && !C.viewer) el.setAttribute('data-act', 'signin'); else if (C.user && C.ok() && !C.viewer) { el.setAttribute('data-act', 'role'); } else el.removeAttribute('data-act');
  }
  function initials(n) { const w = String(n).replace(/@.*/, '').trim().split(/[\s._-]+/).filter(Boolean); return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); }
  C.paintStatus = paintStatus;
  C.signinAgain = promptSignIn;

  /* ---------- gate (not signed in / waiting) ---------- */
  C.gateView = () => {
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const head = `<div class="gate-logo"><img src="icons/logo.png" alt="Scoring 4 Cricket" width="200" height="200"></div>`;
    let body;
    if (C.busy && !C.user) body = `<p class="sub">Checking your account…</p>`;
    else if (!C.user) body = `<h2>Welcome to Scoring 4 Cricket</h2><p class="sub">Sign in with Google to score matches. Watching a game? Open the live link the scorer sent you — no sign-in needed.</p><div class="gsi"><button class="gbtn" data-act="gsignin"><svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.1 5.5c4.2-3.9 7.2-9.6 7.2-17z"/><path fill="#FBBC05" d="M10.6 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.4-4.7 2.3-8.8 2.3-6.2 0-11.5-4.2-13.4-9.9l-8 6.1C6.6 42.6 14.6 48 24 48z"/></svg><span>Continue with Google</span></button></div>`;
    else if (C.role === 'none') body = `<h2>Request scorer access</h2><p class="sub">Signed in as ${e(C.user.email)}. Tell the app owner who you are and they'll approve you.</p>
      <div class="field"><label for="rq-name">Your name</label><input id="rq-name" value="${e(C.user.name)}" maxlength="60"></div>
      <div class="field"><label for="rq-club">Club or team</label><input id="rq-club" placeholder="e.g. Nepean Hawks U14" maxlength="80"></div>
      <div class="row end"><button class="btn ghost" data-act="signout">Use another account</button><button class="btn" data-act="rq-send" ${C.busy ? 'disabled' : ''}>Send request</button></div>`;
    else if (C.role === 'pending') body = `<h2>Waiting for approval</h2><p class="sub">Thanks ${e(C.user.name)} — your request has been sent. You can start scoring as soon as the owner approves you.</p>
      <div class="row end"><button class="btn ghost" data-act="signout">Sign out</button><button class="btn" data-act="rq-check">Check again</button></div>`;
    else body = `<h2>Access blocked</h2><p class="sub">This account (${e(C.user.email)}) can't score in this app. Contact the app owner if you think this is a mistake.</p><div class="row end"><button class="btn ghost" data-act="signout">Sign out</button></div>`;
    return `<section class="panel gate">${head}${body}${C.err ? `<p class="err">${e(C.err)}</p>` : ''}</section>`;
  };

  C.handle = (act, b) => {
    switch (act) {
      case 'signout': C.signOut(); return true;
      case 'signin': case 'gsignin': startSignIn(); return true;
      case 'rq-send': C.request((document.getElementById('rq-name') || {}).value || '', (document.getElementById('rq-club') || {}).value || ''); return true;
      case 'rq-check': whoAmI(false); return true;
    }
    return false;
  };

  C.liveList = async () => {
    if (!C.configured) return { error: 'not-configured' };
    try { const r = await fetch(CFG.API_URL + '?action=liveList', { redirect: 'follow' }); return await r.json(); }
    catch (e) { return { error: 'offline' }; }
  };

  /* ---------- live viewer ---------- */
  let liveTimer = null, liveSig = '';
  async function pollLive() {
    if (!C.viewer) return;
    if (!C.configured) { C.liveErr = 'The live scoreboard is not connected yet.'; rr(); return; }
    try {
      const r = await fetch(CFG.API_URL + '?action=live&id=' + encodeURIComponent(C.liveId), { redirect: 'follow' });
      const j = await r.json();
      if (j.ok && j.pub) {
        C.liveErr = '';
        if (j.pub !== liveSig) {
          liveSig = j.pub;
          const m = JSON.parse(j.pub);
          const keep = { style: S.style, prefs: S.prefs };
          S.match = m; S.history = []; S.style = keep.style; S.prefs = keep.prefs;
          if (S.tab !== 'card' && S.tab !== 'live') S.tab = 'live';
          C.liveAt = Date.now(); rr();
        }
      } else { C.liveErr = j.error === 'not-found' ? 'This match was not found. Check the link.' : 'Could not load the match.'; rr(); }
    } catch (e) { C.liveErr = 'Reconnecting…'; rr(); }
    clearTimeout(liveTimer);
    const done = S.match && typeof resultOf === 'function' && !S.match.deleted && resultOf(S.match);
    liveTimer = setTimeout(pollLive, document.hidden ? 30000 : done ? 60000 : 10000);
  }
  document.addEventListener('visibilitychange', () => { if (C.viewer && !document.hidden) pollLive(); });
  window.addEventListener('hashchange', () => { if (hashLive() !== C.liveId) location.reload(); });

  /* ---------- start ---------- */
  C.start = () => {
    if (C.viewer) { pollLive(); return; }
    if (!C.configured) { C.ready = true; return; }
    const fromGoogle = takeRedirect();
    if (fromGoogle) { C.token = fromGoogle; whoAmI(true); return; }
    const who = ls.get(WHO);
    if (who && who.user) { C.user = who.user; C.role = who.role; }   // lets an approved scorer keep scoring offline
    const saved = ls.get(TOK);
    if (saved && saved.t && saved.exp > Date.now() + 60000) { C.token = saved.t; whoAmI(false); }
    else { C.ready = true; if (C.ok() && C.user) promptSignIn(); rr(); }
  };
})();
