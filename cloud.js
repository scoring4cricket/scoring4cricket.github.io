/* Scoring 4 Cricket — cloud layer: Google sign-in, roles, sync to the S4C Data sheet, live viewer.
   Loaded before the main app script. The app calls CLOUD.* hooks. */
(function () {
  const CFG = Object.assign({ API_URL: '', CLIENT_ID: '', BASE: location.origin + location.pathname }, window.S4C_CONFIG || {});
  const TOK = 's4c-token', SYNC = 's4c-sync', WHO = 's4c-user';
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
    dirty: {}
  };

  /* ---------- helpers ---------- */
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

  /* ---------- sign-in ---------- */
  function parseJwt(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return {}; } }

  function loadGsi(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.onload = cb;
    s.onerror = () => { C.err = 'Could not load Google sign-in. Check your connection.'; rr(); };
    document.head.appendChild(s);
  }
  let gsiInit = false;
  function initGsi() {
    if (gsiInit || !window.google) return;
    google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true });
    gsiInit = true;
  }
  function promptSignIn() { loadGsi(() => { initGsi(); try { google.accounts.id.prompt(); } catch (e) {} }); }
  C.drawButton = () => {
    const el = document.getElementById('gsi');
    if (!el) return;
    loadGsi(() => { initGsi(); el.innerHTML = ''; google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 }); });
  };

  async function onCredential(r) {
    C.token = r.credential;
    const p = parseJwt(C.token);
    ls.set(TOK, { t: C.token, exp: (p.exp || 0) * 1000 });
    await whoAmI(true);
  }

  async function whoAmI(fresh) {
    C.busy = true; C.err = ''; rr();
    try {
      const j = await api('me');
      if (j.ok) {
        const was = C.role;
        C.user = j.user; C.role = j.user.role; C.open = !!j.open;
        ls.set(WHO, { user: C.user, role: C.role });
        if (C.status === 'signin') C.status = 'idle';
        if ((C.role === 'owner' || C.role === 'scorer') && (fresh || was !== C.role)) pull();
        if (C.role === 'owner' || C.role === 'scorer') flush();
      } else C.err = 'Sign-in failed (' + (j.error || 'unknown') + ').';
    } catch (e) {
      if (e.message !== 'auth') { C.err = navigator.onLine ? 'Could not reach the S4C server.' : 'You are offline.'; C.status = 'offline'; }
    }
    C.busy = false; C.ready = true; rr();
  }

  C.signOut = () => {
    ls.set(TOK, null); ls.set(WHO, null); C.token = null; C.user = null; C.role = 'none'; C.users = null;
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}
    rr(); setTimeout(C.drawButton, 50);
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
    const t = JSON.stringify(S.teams || []), tq = quick(t);
    if (S.teams && S.teams.length && C.sent._teams !== tq) C.dirty._teams = true;
    if (Object.keys(C.dirty).length) { clearTimeout(timer); timer = setTimeout(flush, 1500); }
  };

  let flushing = false;
  async function flush() {
    if (flushing || !C.token || !C.ok() || !C.configured) return;
    const ids = Object.keys(C.dirty);
    if (!ids.length) return;
    if (!navigator.onLine) { C.status = 'offline'; paintStatus(); return; }
    flushing = true; C.status = 'saving'; paintStatus();
    try {
      for (const id of ids) {
        if (id === '_teams') {
          const d = JSON.stringify(S.teams || []);
          const j = await api('saveTeams', { data: d });
          if (j.ok) { C.sent._teams = quick(d); delete C.dirty._teams; }
          continue;
        }
        const m = C.dirty[id];
        const d = JSON.stringify(m);
        const pub = JSON.stringify(typeof maskMatch === 'function' ? maskMatch(m) : m);
        const j = await api('saveMatch', { id, title: titleOf(m), status: statusOf(m), data: d, pub });
        if (j.ok) { C.sent[id] = quick(d); if (C.dirty[id] === m) delete C.dirty[id]; }
        else if (j.error === 'not-yours') { delete C.dirty[id]; say('This match belongs to another scorer — not saved online'); }
      }
      ls.set(SYNC, C.sent);
      C.status = Object.keys(C.dirty).length ? 'saving' : 'saved';
    } catch (e) { C.status = e.message === 'auth' ? 'signin' : 'offline'; }
    flushing = false; paintStatus();
    if (Object.keys(C.dirty).length && C.status === 'saving') setTimeout(flush, 800);
  }
  C.flush = flush;
  window.addEventListener('online', () => { C.status = 'idle'; flush(); });
  setInterval(() => { if (Object.keys(C.dirty).length) flush(); }, 20000);

  async function pull() {
    try {
      const j = await api('listMatches');
      if (!j.ok) return;
      const have = new Set([S.match && S.match.id].concat((S.history || []).map(h => h.id)).filter(Boolean));
      const mine = j.matches.filter(x => !have.has(x.id) && (C.role !== 'owner' || x.owner === C.user.email)).slice(-30);
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
      if (!S.teams || !S.teams.length) {
        const t = await api('getTeams');
        if (t.ok && t.data) { try { S.teams = JSON.parse(t.data); C.sent._teams = quick(t.data); changed = true; } catch (e) {} }
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
    el.innerHTML = '<i></i>' + v[0];
    el.className = 'sync st-' + v[1];
    if (C.status === 'signin' && !C.viewer) el.setAttribute('data-act', 'signin'); else el.removeAttribute('data-act');
  }
  C.paintStatus = paintStatus;
  C.signinAgain = promptSignIn;

  /* ---------- gate (not signed in / waiting) ---------- */
  C.gateView = () => {
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const head = `<div class="gate-logo"><img src="icons/logo.png" alt="Scoring 4 Cricket" width="200" height="200"></div>`;
    let body;
    if (C.busy && !C.user) body = `<p class="sub">Checking your account…</p>`;
    else if (!C.user) body = `<h2>Welcome to Scoring 4 Cricket</h2><p class="sub">Sign in with Google to score matches. Watching a game? Open the live link the scorer sent you — no sign-in needed.</p><div id="gsi" class="gsi"></div>`;
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
      case 'signin': promptSignIn(); return true;
      case 'rq-send': C.request((document.getElementById('rq-name') || {}).value || '', (document.getElementById('rq-club') || {}).value || ''); return true;
      case 'rq-check': whoAmI(false); return true;
    }
    return false;
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
    const who = ls.get(WHO);
    if (who && who.user) { C.user = who.user; C.role = who.role; }   // lets an approved scorer keep scoring offline
    const saved = ls.get(TOK);
    if (saved && saved.t && saved.exp > Date.now() + 60000) { C.token = saved.t; whoAmI(false); }
    else { C.ready = true; if (C.ok()) C.status = 'signin'; promptSignIn(); setTimeout(C.drawButton, 50); }
  };
})();
