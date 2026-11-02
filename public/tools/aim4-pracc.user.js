// ==UserScript==
// @name         aim4: upload PRACC demos
// @namespace    https://aim4.io/
// @version      1.2.0
// @description  Adds an Upload button to each demo on pracc.com/team/server. aim4's server fetches the demo itself.
// @match        https://pracc.com/*
// @match        https://aim4.io/*
// @connect      aim4.io
// @connect      pracc.com
// @connect      your-objectstorage.com
// @connect      r2.cloudflarestorage.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @noframes
// @run-at       document-idle
// @downloadURL  https://aim4.io/tools/aim4-pracc.user.js
// @updateURL    https://aim4.io/tools/aim4-pracc.user.js
// ==/UserScript==

// Two halves, sharing Tampermonkey's storage:
//
//   on aim4.io     copies the signed-in session's access token into that storage.
//                  Only the access token, which lasts an hour. Never the refresh
//                  token, which is what could outlive a sign-out.
//   on pracc.com   puts an Upload button on each row of the Demos tab. A click
//                  hands aim4 that demo's signed link.
//
// What crosses between the two sites is signed storage links and nothing else.
// A row's DownloadUrl is a pracc.com address that only answers to the PRACC cookie
// and redirects to a one-hour signed link. So the browser follows that redirect
// and aim4 gets where it ended up, which works without any session. The PRACC
// cookie stays on PRACC, and the aim4 calls are `anonymous` so a browser cookie
// cannot ride along. The aim4 token only ever travels in an Authorization header,
// never in a URL.

(function () {
  'use strict';

  const AIM4 = 'https://aim4.io';
  const TOKEN_KEY = 'aim4Token';
  const REQUESTS_KEY = 'aim4PraccRequests';
  const KNOWN_KEY = 'aim4PraccKnown';
  /** Inside this the site renews on load, so a token this short is worth replacing. */
  const TOKEN_MARGIN_MS = 60 * 1000;
  const LINK_WAIT_MS = 25 * 1000;
  const POLL_MS = 3000;
  const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
  /** Links last an hour. If a queue outlasts that, the expired ones are re-sent. */
  const MAX_RESENDS = 3;
  const HOST_ID = 'aim4-pracc-upload';

  // ---- aim4.io ------------------------------------------------------------

  function readAim4Session() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!/^sb-.+-auth-token$/.test(key || '')) continue;
      try {
        const session = JSON.parse(localStorage.getItem(key));
        if (session && session.access_token && session.expires_at) {
          return { accessToken: session.access_token, expiresAt: session.expires_at * 1000 };
        }
      } catch (_err) {
        /* not ours to worry about */
      }
    }
    return null;
  }

  function runOnAim4() {
    // The site renews its own session, a moment after load and then on its own
    // schedule. So: quickly at first, for a tab opened just to do this, then slowly.
    const copy = () => {
      const session = readAim4Session();
      if (session) GM_setValue(TOKEN_KEY, session);
      else GM_deleteValue(TOKEN_KEY);
    };
    copy();
    const eager = setInterval(copy, 500);
    setTimeout(() => {
      clearInterval(eager);
      setInterval(copy, 30 * 1000);
    }, LINK_WAIT_MS);
  }

  // ---- talking to aim4 ----------------------------------------------------

  function freshToken() {
    const stored = GM_getValue(TOKEN_KEY, null);
    return stored && stored.expiresAt - Date.now() > TOKEN_MARGIN_MS ? stored.accessToken : null;
  }

  /**
   * A token that will last, opening aim4.io behind this tab when there is none.
   * Loading the site is what refreshes the session, and the half of this script
   * running over there hands back the result.
   */
  async function ensureToken() {
    const have = freshToken();
    if (have) return have;
    say('Connecting to aim4...');
    const tab = GM_openInTab(`${AIM4}/`, { active: false, insert: true, setParent: true });
    const giveUp = Date.now() + LINK_WAIT_MS;
    while (Date.now() < giveUp) {
      await sleep(500);
      const token = freshToken();
      if (token) {
        tab.close();
        return token;
      }
    }
    throw new Error('Sign in on the aim4 tab that opened, then click Upload again.');
  }

  function aim4Request(method, path, { token, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `${AIM4}${path}`,
        anonymous: true,
        timeout: 30 * 1000,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (res) => {
          let json = null;
          try {
            json = JSON.parse(res.responseText);
          } catch (_err) {
            /* an edge error page; the status is what is left to go on */
          }
          resolve({ status: res.status, json });
        },
        onerror: () => reject(new Error('Could not reach aim4.')),
        ontimeout: () => reject(new Error('aim4 did not answer.'))
      });
    });
  }

  // ---- reading the list ---------------------------------------------------

  const PRACC_LIST = 'https://pracc.com/api/team/server/demos';

  function praccListViaFetch(headers) {
    return fetch(PRACC_LIST, { credentials: 'include', headers }).then(async (res) => ({
      status: res.status,
      text: await res.text()
    }));
  }

  function praccListViaGm(headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: PRACC_LIST,
        headers,
        timeout: 30 * 1000,
        onload: (res) => resolve({ status: res.status, text: res.responseText }),
        onerror: () => reject(new Error('Could not reach PRACC.')),
        ontimeout: () => reject(new Error('PRACC did not answer.'))
      });
    });
  }

  /**
   * The request the page makes for this tab, with the same filter it applies.
   *
   * A sandboxed fetch is the plain way to ask. Firefox's sandbox can throw on it or
   * leave a SameSite cookie behind, so a refusal gets one more try the other way.
   * Both go to pracc.com only: this is the one place that cookie is ever in play.
   */
  async function fetchPraccDemos() {
    const headers = { Accept: 'application/vnd.pracc.v1+json' };
    const team = localStorage.getItem('app.active_team_id');
    if (team) headers['X-Selected-Team-ID'] = team;
    let res = await praccListViaFetch(headers).catch(() => null);
    if (!res || res.status === 401 || res.status === 403) res = await praccListViaGm(headers);
    if (res.status === 401) throw new Error('Sign in to PRACC first.');
    if (res.status !== 200) throw new Error(`PRACC answered ${res.status} for the demo list.`);
    const rows = JSON.parse(res.text);
    // The page's own filter to the letter, rows without a link included: buttons are
    // matched to rows by position.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 1);
    return (Array.isArray(rows) ? rows : []).filter((row) => row && new Date(row.CreatedAt) > cutoff);
  }

  function rowLabel(row) {
    const names = [row.Team && row.Team.Name, row.OtherTeam && row.OtherTeam.Name].filter(Boolean);
    return names.join(' vs ').slice(0, 120);
  }

  /**
   * Where a row's DownloadUrl redirects to: the signed link aim4 can use.
   * Asks for one byte and hangs up on seeing the headers, so no demo comes down.
   */
  function resolveLink(url) {
    if (new URL(url).hostname !== 'pracc.com') return Promise.resolve(url);
    const headers = {};
    const team = localStorage.getItem('app.active_team_id');
    if (team) headers['X-Selected-Team-ID'] = team;
    return new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      const check = (res) => {
        if (settled || !res.finalUrl || new URL(res.finalUrl).hostname === 'pracc.com') return;
        settled = true;
        resolve(res.finalUrl);
        if (req && req.abort) req.abort();
      };
      const fail = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      req = GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { ...headers, Range: 'bytes=0-0' },
        timeout: 30 * 1000,
        onreadystatechange: (res) => {
          if (res.readyState >= 2) check(res);
        },
        onload: (res) => {
          check(res);
          fail(res.status === 401 ? 'Sign in to PRACC first.' : `PRACC answered ${res.status} for this demo's link.`);
        },
        onerror: () => fail('Could not get this demo\'s link from PRACC.'),
        ontimeout: () => fail('PRACC did not answer for this demo\'s link.')
      });
    });
  }

  /**
   * Demos aim4 has confirmed, by PRACC's row id, so a row can say so on load
   * without asking anybody. The list only spans a month, so old entries can go.
   */
  function knownDemos() {
    const known = GM_getValue(KNOWN_KEY, {});
    const cutoff = Date.now() - 2 * MONTH_MS;
    for (const uid of Object.keys(known)) {
      if (known[uid] < cutoff) delete known[uid];
    }
    return known;
  }

  function rememberDemo(uid) {
    const known = knownDemos();
    known[uid] = Date.now();
    GM_setValue(KNOWN_KEY, known);
  }

  // ---- one demo's import --------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** uid -> what its button says. Lives here because React can rebuild the row at any time. */
  const rowState = new Map();
  /** uid -> its button, reused when a row comes back. */
  const rowButtons = new Map();
  const ui = { host: null, message: '' };

  function say(text) {
    ui.message = text;
    if (ui.host) ui.host.textContent = text;
  }

  function setRow(uid, text, { busy = false, title = '' } = {}) {
    rowState.set(uid, { text, busy, title });
    const button = rowButtons.get(uid);
    if (button) paintButton(button, uid);
  }

  const inProgress = (d) => !['done', 'duplicate', 'failed', 'refused'].includes(d.state);

  function progressText(demo) {
    if (demo.state === 'downloading') {
      return demo.total ? `${Math.round((demo.received / demo.total) * 100)}%` : 'Downloading';
    }
    if (demo.state === 'parsing' && demo.rounds) return `Round ${demo.round}/${demo.rounds}`;
    if (demo.state === 'parsing') return 'Parsing';
    if (demo.state === 'unpacking') return 'Unpacking';
    return 'Queued';
  }

  function savedRequests() {
    return GM_getValue(REQUESTS_KEY, {});
  }

  function saveRequest(uid, id) {
    const requests = savedRequests();
    if (id) requests[uid] = id;
    else delete requests[uid];
    GM_setValue(REQUESTS_KEY, requests);
  }

  /** Follow one request to its end. The id is enough, so the token can expire meanwhile. */
  async function follow(uid, requestId) {
    for (;;) {
      let polled;
      try {
        polled = await aim4Request('GET', `/api/replays/pracc/imports/${requestId}`);
      } catch (_err) {
        // A blip while the server carries on. Keep asking.
        await sleep(POLL_MS * 2);
        continue;
      }
      if (polled.status === 404) {
        saveRequest(uid, null);
        throw new Error('aim4 restarted and lost track of this demo. Click Upload again, nothing is lost.');
      }
      const demo = polled.json && polled.json.request && polled.json.request.demos[0];
      if (!demo) {
        await sleep(POLL_MS);
        continue;
      }
      if (!inProgress(demo)) {
        saveRequest(uid, null);
        return demo;
      }
      setRow(uid, progressText(demo), { busy: true });
      await sleep(POLL_MS);
    }
  }

  function finish(uid, demo) {
    if (demo.state === 'done' || demo.state === 'duplicate') {
      rememberDemo(uid);
      setRow(uid, 'In aim4', { title: 'Already in aim4. Click to check again.' });
      return;
    }
    const why = demo.error || demo.reason || 'aim4 would not take this demo.';
    setRow(uid, 'Failed', { title: why });
    say(why);
  }

  async function uploadRow(row) {
    const uid = row.Uid;
    if (rowState.get(uid)?.busy) return;
    say('');
    setRow(uid, 'Starting', { busy: true });
    try {
      let current = row;
      for (let attempt = 0; ; attempt++) {
        // Asked for each send: a re-send can come an hour after the first one.
        const token = await ensureToken();
        const url = await resolveLink(current.DownloadUrl);
        const sent = await aim4Request('POST', '/api/replays/pracc/imports', {
          token,
          body: { demos: [{ uid, url, label: rowLabel(current) }] }
        });
        const request = sent.json && sent.json.request;
        if (!request) {
          if (sent.status === 401) GM_deleteValue(TOKEN_KEY);
          const why = sent.json && (sent.json.message || sent.json.error);
          throw new Error(why || `aim4 answered ${sent.status}.`);
        }
        let demo = request.demos[0];
        if (inProgress(demo)) {
          saveRequest(uid, request.id);
          demo = await follow(uid, request.id);
        }
        if (demo.reason !== 'link_expired' || attempt >= MAX_RESENDS) {
          finish(uid, demo);
          return;
        }
        // A signature only lasts an hour, and PRACC signs a fresh one each time it is asked.
        const fresh = (await fetchPraccDemos()).find((r) => r.Uid === uid);
        if (!fresh || !fresh.DownloadUrl) throw new Error('PRACC no longer lists this demo.');
        current = fresh;
      }
    } catch (err) {
      const why = err.message || String(err);
      setRow(uid, 'Failed', { title: why });
      say(why);
    }
  }

  /** A reload in the middle of an import picks the same ones back up. */
  function resume() {
    for (const [uid, id] of Object.entries(savedRequests())) {
      setRow(uid, 'Queued', { busy: true });
      follow(uid, id).then(
        (demo) => finish(uid, demo),
        (err) => {
          setRow(uid, 'Upload');
          say(err.message || String(err));
        }
      );
    }
  }

  // ---- the buttons --------------------------------------------------------

  /** The Alert on the Demos tab links to 7-Zip. The 2D Replay tab's does not. */
  function demosTabPanel() {
    const link = document.querySelector('a[href^="https://7-zip.org"]');
    const alert = link && link.closest('.MuiAlert-root, [role="alert"]');
    return alert ? alert.parentElement : null;
  }

  const isDemoButton = (b) => !b.dataset.aim4Upload && /^\s*demo\s*$/i.test(b.textContent);

  function paintButton(button, uid) {
    const state = rowState.get(uid) || { text: 'Upload', busy: false, title: '' };
    button.textContent = state.text;
    button.disabled = state.busy;
    button.title = state.title || 'Send this demo to aim4';
    // Disabled MUI buttons go grey through a class; the progress has to stay readable.
    button.style.opacity = state.busy ? '.75' : '';
    button.style.cursor = state.busy ? 'default' : '';
    button.style.pointerEvents = 'auto';
    button.style.whiteSpace = 'nowrap';
    button.style.color = '#fff';
  }

  function buttonFor(row, twin) {
    let button = rowButtons.get(row.Uid);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.dataset.aim4Upload = '1';
      button.addEventListener('click', () => uploadRow(button.aim4Row));
      rowButtons.set(row.Uid, button);
    }
    button.aim4Row = row;
    // Dressed as the row's own DEMO button, so it reads as part of the page and
    // follows the theme rather than guessing at its colours.
    button.className = twin.className.replace(/\bMui-disabled\b/g, '');
    paintButton(button, row.Uid);
    return button;
  }

  // Row ids are not in the DOM, so a row is matched to the list by position. That
  // only holds if the list is the one the page rendered, and the row's name is the
  // check on it: a demo that landed since the page loaded shifts everything by one.
  const list = { rows: null, loading: false, at: 0 };

  async function loadList() {
    if (list.loading || Date.now() - list.at < 15 * 1000) return;
    list.loading = true;
    list.at = Date.now();
    try {
      list.rows = await fetchPraccDemos();
      schedulePlace();
    } catch (err) {
      say(err.message || String(err));
    } finally {
      list.loading = false;
    }
  }

  function rowMatches(tr, row) {
    const names = [row.Team && row.Team.Name, row.OtherTeam && row.OtherTeam.Name].filter(Boolean);
    const text = tr.cells[0] ? tr.cells[0].textContent : '';
    return names.length < 2 ? true : names.some((name) => text.includes(name));
  }

  function placeRowButtons(panel) {
    const trs = [...panel.querySelectorAll('table tr')].filter((tr) => [...tr.querySelectorAll('button')].some(isDemoButton));
    if (!trs.length) return;
    if (!list.rows) {
      void loadList();
      return;
    }
    const lined = list.rows.length === trs.length && trs.every((tr, i) => rowMatches(tr, list.rows[i]));
    if (!lined) {
      // A fresh read fixes it if ours is the stale one. If the page's is, only a reload will.
      void loadList();
      for (const button of rowButtons.values()) button.remove();
      say('The demo list changed. Reload the page to upload.');
      return;
    }
    if (ui.message === 'The demo list changed. Reload the page to upload.') say('');

    const known = knownDemos();
    trs.forEach((tr, i) => {
      const row = list.rows[i];
      const twin = [...tr.querySelectorAll('button')].find(isDemoButton);
      if (!row.DownloadUrl || twin.disabled) return;
      if (known[row.Uid] && !rowState.has(row.Uid)) {
        rowState.set(row.Uid, { text: 'In aim4', busy: false, title: 'Already in aim4. Click to check again.' });
      }
      const button = buttonFor(row, twin);
      if (button.nextElementSibling !== twin) twin.parentElement.insertBefore(button, twin);
    });
  }

  /**
   * React owns this panel and will rebuild it whenever it likes, which is why
   * everything is re-placed from what is on the page each time rather than from a
   * remembered position.
   */
  function place() {
    const panel = demosTabPanel();
    let host = document.getElementById(HOST_ID);
    if (!panel) {
      if (host) host.remove();
      return;
    }
    if (!host) {
      host = ui.host || document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'font-size:12px;opacity:.75;text-align:right;margin-top:12px;min-height:1px;';
      host.setAttribute('aria-live', 'polite');
      host.textContent = ui.message;
      ui.host = host;
    }
    if (host.parentElement !== panel || panel.lastElementChild !== host) panel.appendChild(host);
    placeRowButtons(panel);
  }

  let placeQueued = false;
  function schedulePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  }

  function runOnPracc() {
    new MutationObserver(schedulePlace).observe(document.body, { childList: true, subtree: true });
    place();
    resume();
  }

  if (location.hostname === 'aim4.io') runOnAim4();
  else runOnPracc();
})();
