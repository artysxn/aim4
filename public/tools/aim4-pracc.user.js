// ==UserScript==
// @name         aim4: upload PRACC demos
// @namespace    https://aim4.io/
// @version      1.1.0
// @description  Adds an Upload button to the Demos tab on pracc.com/team/server. aim4's server fetches the demos itself.
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
//   on pracc.com   puts the button on the Demos tab. A click reads the list the
//                  way the page itself does, and hands aim4 the signed links.
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
  const REQUEST_KEY = 'aim4PraccRequest';
  const KNOWN_KEY = 'aim4PraccKnown';
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
   * The rows as aim4 wants them, three at a time. A row whose link cannot be had
   * goes into `results` as failed, and the others carry on.
   */
  async function toSend(rows, results) {
    const out = new Array(rows.length).fill(null);
    let next = 0;
    let finished = 0;
    const worker = async () => {
      while (next < rows.length) {
        const at = next++;
        const row = rows[at];
        try {
          out[at] = { uid: row.Uid, url: await resolveLink(row.DownloadUrl), label: rowLabel(row) };
        } catch (err) {
          results.set(row.Uid, { uid: row.Uid, state: 'failed', reason: 'no_link', error: err.message });
        }
        say(`Getting links from PRACC, ${++finished} of ${rows.length}...`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out.filter(Boolean);
  }

  /**
   * Demos aim4 has confirmed, by PRACC's row id. A click only asks PRACC for the
   * links it still needs, because nothing says those requests are free on PRACC's
   * side. The list only spans a month, so entries older than that can go.
   */
  function knownDemos() {
    const known = GM_getValue(KNOWN_KEY, {});
    const cutoff = Date.now() - 2 * MONTH_MS;
    for (const uid of Object.keys(known)) {
      if (known[uid] < cutoff) delete known[uid];
    }
    return known;
  }

  function rememberDemos(demos) {
    const known = knownDemos();
    for (const demo of demos) {
      if (demo.uid && (demo.state === 'done' || demo.state === 'duplicate')) known[demo.uid] = Date.now();
    }
    GM_setValue(KNOWN_KEY, known);
  }

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
      const results = new Map();
      const known = knownDemos();
      for (const row of rows) {
        if (known[row.Uid]) results.set(row.Uid, { uid: row.Uid, state: 'duplicate' });
      }
      let pending = await toSend(rows.filter((row) => !known[row.Uid]), results);

      for (let attempt = 0; pending.length && attempt <= MAX_RESENDS; attempt++) {
        say(`Sending ${pending.length} to aim4...`);
        const request = await sendAndFollow(pending);
        for (const demo of request.demos) results.set(demo.uid, demo);
        rememberDemos(request.demos);
        const expired = request.demos.filter((d) => d.reason === 'link_expired').map((d) => d.uid);
        if (!expired.length || attempt === MAX_RESENDS) break;
        // A signature only lasts an hour, and PRACC signs a fresh one each time it is asked.
        say(`${expired.length} links expired, getting new ones...`);
        rows = await fetchPraccDemos();
        const again = new Set(expired);
        pending = await toSend(rows.filter((row) => again.has(row.Uid)), results);
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
      rememberDemos(request.demos);
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
