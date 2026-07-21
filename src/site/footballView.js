// ---------------------------------------------------------------------------
// site/footballView.js
// The football menu, hosted on the aim4.io site shell. Same structure as the
// football page's own menu: display name, public lobby browser, join by code,
// create a lobby. Joining or creating navigates to the game page
// (/tools/football.html), which owns the live match session.
// ---------------------------------------------------------------------------

const NAME_KEY = 'aim4-football-name';
const GAME_PAGE = '/tools/football.html';

function wsUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) {
    const host = q.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${host}/football`;
  }
  const raw = import.meta.env.VITE_API_URL;
  if (raw) {
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/football`;
    } catch { /* fall through to same origin */ }
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/football`;
}

export function initFootballView({ auth, escapeHtml }) {
  const nameInput = document.getElementById('fb-name');
  const accountState = document.getElementById('fb-account-state');
  const listEl = document.getElementById('fb-lobby-list');
  const statusEl = document.getElementById('fb-status');
  const passInput = document.getElementById('fb-create-pass');
  const privateInput = document.getElementById('fb-create-private');
  const codeInput = document.getElementById('fb-join-code');

  let ws = null;
  let active = false;
  let retryTimer = 0;

  nameInput.value = localStorage.getItem(NAME_KEY) || '';

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('is-error', isError);
  }

  function syncAccount() {
    if (auth.isLoggedIn && auth.displayName) {
      nameInput.value = auth.displayName;
      nameInput.disabled = true;
      accountState.innerHTML = `Signed in as <strong>@${escapeHtml(auth.displayName)}</strong>`;
    } else {
      nameInput.disabled = false;
      nameInput.value = localStorage.getItem(NAME_KEY) || '';
      accountState.textContent = '';
    }
  }
  auth.onChange(syncAccount);
  syncAccount();

  /** Resolve the display name, focusing the field when one is required. */
  function myName(required = true) {
    if (auth.isLoggedIn && auth.displayName) return auth.displayName;
    const n = nameInput.value.trim().slice(0, 16);
    if (!n && required) {
      setStatus('Enter a name first', true);
      nameInput.focus();
    }
    return n;
  }

  function renderList(lobbies) {
    if (lobbies === null) {
      listEl.innerHTML = '<div class="fb-lobby-empty">…</div>';
      return;
    }
    if (!lobbies.length) {
      listEl.innerHTML = '<div class="fb-lobby-empty">No public lobbies right now, create one!</div>';
      return;
    }
    listEl.innerHTML = lobbies.map((l) => `
      <div class="fb-lobby-item">
        <div class="fb-lobby-info">
          <span class="fb-lobby-host">${escapeHtml(l.host)}${l.locked ? '<span class="tag">Password</span>' : ''}</span>
          <span class="fb-lobby-meta">${l.players}/${l.max} players &middot; ${l.inMatch ? 'Match in progress' : 'In lobby'}</span>
        </div>
        <button type="button" class="btn btn-sm primary" data-join-code="${escapeHtml(l.code)}">Join</button>
      </div>`).join('');
  }

  /** Persist the resolved name so the game page picks it up instantly. */
  function saveName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch { /* storage unavailable */ }
  }

  function goJoin(code) {
    const name = myName();
    if (!name) return;
    saveName(name);
    window.location.href = `${GAME_PAGE}?lobby=${encodeURIComponent(code)}`;
  }

  function goCreate() {
    const name = myName();
    if (!name) return;
    saveName(name);
    const params = new URLSearchParams({ create: '1' });
    if (privateInput.checked) params.set('private', '1');
    // The lobby password rides in sessionStorage, not the URL.
    try {
      sessionStorage.setItem('aim4-football-pass', passInput.value || '');
    } catch { /* storage unavailable, lobby is created without a password */ }
    window.location.href = `${GAME_PAGE}?${params}`;
  }

  function connect() {
    if (ws || !active) return;
    setStatus('');
    let socket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      setStatus('Server offline, retrying…', true);
      scheduleRetry();
      return;
    }
    ws = socket;
    ws.onopen = () => {
      setStatus('');
      send({ t: 'list' });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'lobbyList') renderList(msg.lobbies || []);
    };
    ws.onclose = () => {
      ws = null;
      if (!active) return;
      renderList(null);
      setStatus('Server offline, retrying…', true);
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 3000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  listEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-join-code]');
    if (btn) goJoin(btn.dataset.joinCode);
  });

  document.getElementById('fb-refresh').addEventListener('click', () => send({ t: 'list' }));
  document.getElementById('fb-create-btn').addEventListener('click', goCreate);
  document.getElementById('fb-join-btn').addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) {
      setStatus('Enter a 4-letter code', true);
      return;
    }
    goJoin(code);
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('fb-join-btn').click();
  });

  renderList(null);

  return {
    onShow() {
      active = true;
      syncAccount();
      if (ws && ws.readyState === 1) send({ t: 'list' });
      else connect();
    },
    onHide() {
      active = false;
      clearTimeout(retryTimer);
    }
  };
}
