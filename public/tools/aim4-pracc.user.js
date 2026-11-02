// ==UserScript==
// @name         aim4: upload PRACC demos
// @namespace    https://aim4.io/
// @version      1.0.0
// @description  Adds an Upload button to the Demos tab on pracc.com/team/server. aim4's server fetches the demos itself.
// @match        https://pracc.com/*
// @match        https://aim4.io/*
// @connect      aim4.io
// @connect      pracc.com
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
//   on pracc.com   puts the button on the Demos tab. A click reads the list the
//                  way the page itself does, and hands aim4 the signed links.
//
// What crosses between the two sites is the demo links and nothing else. The
// PRACC cookie stays on PRACC: its list is read from pracc.com, and the aim4 calls
// are `anonymous` so a browser cookie cannot ride along. The aim4 token only ever
// travels in an Authorization header, never in a URL.

(function () {
  'use strict';

  const AIM4 = 'https://aim4.io';
  const TOKEN_KEY = 'aim4Token';
  const REQUEST_KEY = 'aim4PraccRequest';
  /** Inside this the site renews on load, so a token this short is worth replacing. */
  const TOKEN_MARGIN_MS = 60 * 1000;
  const LINK_WAIT_MS = 25 * 1000;
  const POLL_MS = 3000;
  /** The page only lists a month's worth; the API returns more than that. */
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
    const cutoff = Date.now() - MONTH_MS;
    return (Array.isArray(rows) ? rows : []).filter(
      (row) => row && row.DownloadUrl && new Date(row.CreatedAt).getTime() > cutoff
    );
  }

  function rowLabel(row) {
    const names = [row.Team && row.Team.Name, row.OtherTeam && row.OtherTeam.Name].filter(Boolean);
    return names.join(' vs ').slice(0, 120);
  }

  const toSend = (rows) => rows.map((row) => ({ uid: row.Uid, url: row.DownloadUrl, label: rowLabel(row) }));

  // ---- the import ---------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ui = { host: null, button: null, status: null, text: '', busy: false };

  function say(text) {
    ui.text = text;
    if (ui.status) ui.status.textContent = text;
  }

  function setBusy(busy) {
    ui.busy = busy;
    if (ui.button) ui.button.disabled = busy;
  }

  const inProgress = (d) => !['done', 'duplicate', 'failed', 'refused'].includes(d.state);

  function progressLine(request) {
    const demos = request.demos;
    const total = demos.length;
    const stored = demos.filter((d) => d.state === 'done' || d.state === 'duplicate').length;
    const downloading = demos.find((d) => d.state === 'downloading');
    const parsing = demos.find((d) => d.state === 'parsing' || d.state === 'unpacking');
    if (downloading) {
      const pct = downloading.total ? ` ${Math.round((downloading.received / downloading.total) * 100)}%` : '';
      return `${stored} of ${total} in aim4. Downloading${pct}`;
    }
    if (parsing && parsing.rounds) return `${stored} of ${total} in aim4. Parsing round ${parsing.round} of ${parsing.rounds}`;
    if (parsing) return `${stored} of ${total} in aim4. Unpacking`;
    return `${stored} of ${total} in aim4. Waiting`;
  }

  function finalLine(demos) {
    const added = demos.filter((d) => d.state === 'done').length;
    const known = demos.filter((d) => d.state === 'duplicate').length;
    const failed = demos.filter((d) => d.state === 'failed' || d.state === 'refused');
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (known) parts.push(`${known} already in aim4`);
    if (failed.length) parts.push(`${failed.length} failed: ${failed[0].error || failed[0].reason}`);
    return parts.join(', ') || 'Nothing to upload';
  }

  /** Follow one request to its end. The id is enough, so the token can expire meanwhile. */
  async function follow(requestId) {
    for (;;) {
      let polled;
      try {
        polled = await aim4Request('GET', `/api/replays/pracc/imports/${requestId}`);
      } catch (_err) {
        // A blip while the server carries on. Say so and keep asking.
        say('Lost touch with aim4, still trying...');
        await sleep(POLL_MS * 2);
        continue;
      }
      if (polled.status === 404) {
        GM_deleteValue(REQUEST_KEY);
        throw new Error('aim4 restarted and lost track of this. Click Upload again, nothing is lost.');
      }
      const request = polled.json && polled.json.request;
      if (!request) {
        await sleep(POLL_MS);
        continue;
      }
      if (!request.demos.some(inProgress)) {
        GM_deleteValue(REQUEST_KEY);
        return request;
      }
      say(progressLine(request));
      await sleep(POLL_MS);
    }
  }

  async function sendAndFollow(demos) {
    // Asked for each send: a re-send can come an hour after the first one.
    const token = await ensureToken();
    const sent = await aim4Request('POST', '/api/replays/pracc/imports', { token, body: { demos } });
    const request = sent.json && sent.json.request;
    if (!request) {
      if (sent.status === 401) GM_deleteValue(TOKEN_KEY);
      const why = sent.json && (sent.json.message || sent.json.error);
      throw new Error(why || `aim4 answered ${sent.status}.`);
    }
    if (!request.demos.some(inProgress)) return request;
    GM_setValue(REQUEST_KEY, request.id);
    return follow(request.id);
  }

  async function runUpload() {
    if (ui.busy) return;
    setBusy(true);
    try {
      await ensureToken();
      say('Reading the demo list...');
      let rows = await fetchPraccDemos();
      if (!rows.length) {
        say('No demos to upload');
        return;
      }
      say(`Sending ${rows.length} to aim4...`);
      const results = new Map();
      let pending = toSend(rows);

      for (let attempt = 0; attempt <= MAX_RESENDS; attempt++) {
        const request = await sendAndFollow(pending);
        for (const demo of request.demos) results.set(demo.uid, demo);
        const expired = request.demos.filter((d) => d.reason === 'link_expired').map((d) => d.uid);
        if (!expired.length || attempt === MAX_RESENDS) break;
        // A signature only lasts an hour, and the list signs a fresh one each read.
        say(`${expired.length} links expired, getting new ones...`);
        rows = await fetchPraccDemos();
        const again = new Set(expired);
        pending = toSend(rows.filter((row) => again.has(row.Uid)));
        if (!pending.length) break;
      }
      say(finalLine([...results.values()]));
    } catch (err) {
      say(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  /** A reload in the middle of an import picks the same one back up. */
  async function resume() {
    const id = GM_getValue(REQUEST_KEY, null);
    if (!id || ui.busy) return;
    setBusy(true);
    try {
      const request = await follow(id);
      say(finalLine(request.demos));
    } catch (err) {
      say(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  // ---- the button ---------------------------------------------------------

  /** The Alert on the Demos tab links to 7-Zip. The 2D Replay tab's does not. */
  function demosTabPanel() {
    const link = document.querySelector('a[href^="https://7-zip.org"]');
    const alert = link && link.closest('.MuiAlert-root, [role="alert"]');
    return alert ? alert.parentElement : null;
  }

  function buildHost() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:12px;';

    const status = document.createElement('span');
    status.style.cssText = 'font-size:12px;opacity:.75;text-align:right;';
    status.setAttribute('aria-live', 'polite');
    status.textContent = ui.text;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Upload';
    button.title = 'Send these demos to aim4';
    button.disabled = ui.busy;
    // Dressed as the row's own DEMO button, so it reads as part of the page and
    // follows the theme rather than guessing at its colours.
    const twin = [...document.querySelectorAll('table .MuiButton-contained')].find((b) => /demo/i.test(b.textContent));
    if (twin) button.className = twin.className.replace(/\bMui-disabled\b/g, '');
    else button.style.cssText = 'background:#2979ff;color:#fff;border:0;border-radius:4px;padding:4px 14px;font-weight:700;cursor:pointer;text-transform:uppercase;';
    button.addEventListener('click', runUpload);

    host.append(status, button);
    ui.host = host;
    ui.button = button;
    ui.status = status;
    return host;
  }

  /**
   * React owns this panel and will rebuild it whenever it likes, which is why the
   * button is re-placed from what is on the page each time rather than from a
   * remembered position, and why it always goes last: below whatever just rendered.
   */
  function place() {
    const panel = demosTabPanel();
    const present = document.getElementById(HOST_ID);
    if (!panel) {
      if (present) present.remove();
      return;
    }
    const host = present || ui.host || buildHost();
    // The row's button only exists once the table has loaded.
    if (ui.button && !ui.button.className) {
      const twin = [...document.querySelectorAll('table .MuiButton-contained')].find((b) => /demo/i.test(b.textContent));
      if (twin) {
        ui.button.style.cssText = '';
        ui.button.className = twin.className.replace(/\bMui-disabled\b/g, '');
      }
    }
    if (host.parentElement !== panel || panel.lastElementChild !== host) panel.appendChild(host);
  }

  function runOnPracc() {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        place();
      });
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    place();
    void resume();
  }

  if (location.hostname === 'aim4.io') runOnAim4();
  else runOnPracc();
})();
