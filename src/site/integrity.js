// ---------------------------------------------------------------------------
// src/site/integrity.js
// The client half of account-sharing detection.
//
// On sign-in and on tab refocus, POST /api/account/session with a device id
// kept in localStorage. The server compares it against the previous session
// (country + device type + six-hour window, see server/account/integrity.js)
// and answers with the account's integrity state, which this module renders:
//
//   warning   → full-screen overlay with a 60 second cooldown. The countdown
//               is per page load ON PURPOSE: refreshing to skip it restarts
//               it. Continue (enabled at zero) acknowledges to the server.
//   probation → a notice naming the two sessions that tripped the flag and
//               the recent login history. Dismissable — the restriction
//               itself is server-side (the account resolves to Free), so the
//               overlay is information, not enforcement.
//
// The device id is a random token per browser install, not real hardware
// identity — the browser does not expose one. Combined with the country and
// device-type requirements it is still the right shape: clearing it just
// looks like a new device, which alone never flags anyone.
// ---------------------------------------------------------------------------

import { accessToken, apiBase } from '../replays/api.js';
import { activeLocale } from '../i18n/format.js';

const PING_MIN_MS = 5 * 60 * 1000;

const DEVICE_LABELS = {
  iphone: 'an iPhone',
  ipad: 'an iPad',
  'android-phone': 'an Android phone',
  'android-tablet': 'an Android tablet',
  'windows-pc': 'a Windows PC',
  mac: 'a Mac',
  'linux-pc': 'a Linux PC',
  chromebook: 'a Chromebook',
  other: 'an unrecognised device'
};

function deviceLabel(type) {
  return DEVICE_LABELS[type] || DEVICE_LABELS.other;
}

function countryName(code) {
  if (!code) return 'an unknown country';
  try {
    return new Intl.DisplayNames([activeLocale()], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function sideLabel(side) {
  if (!side) return 'an unknown location';
  return `${countryName(side.country)} on ${deviceLabel(side.deviceType)}`;
}

function deviceId() {
  try {
    let id = localStorage.getItem('aim4.deviceId');
    if (!/^[a-f0-9]{32}$/.test(id || '')) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('aim4.deviceId', id);
    }
    return id;
  } catch {
    // Storage blocked: no id. The server treats a missing id as never-flag,
    // which fails open — the honest choice for a heuristic.
    return null;
  }
}

function overlay() {
  let host = document.getElementById('integrity-overlay');
  if (host) return null; // one at a time
  host = document.createElement('div');
  host.id = 'integrity-overlay';
  host.className = 'integrity-overlay';
  document.body.appendChild(host);
  return host;
}

/**
 * First offense: warn, and hold the door for 60 seconds. Everything under the
 * overlay stays inert until Continue, and Continue stays disabled until the
 * countdown ends.
 *
 * Exported (with showProbation) so the overlay can be driven directly in dev;
 * the server decides when they actually appear.
 */
export function showWarning(warning, onAck) {
  const host = overlay();
  if (!host) return;

  const card = document.createElement('div');
  card.className = 'integrity-card';

  const h = document.createElement('h2');
  h.textContent = 'Unusual sign-in pattern';

  const what = document.createElement('p');
  what.textContent =
    `This account was used from ${sideLabel(warning.from)}, then within six hours ` +
    `from ${sideLabel(warning.to)} — a different device in a different country. ` +
    'aim4 accounts are personal and this pattern usually means an account is being shared.';

  const vpn = document.createElement('p');
  vpn.className = 'integrity-muted';
  vpn.textContent =
    'Heads up: using a VPN can cause problems with account integrity checks like this one. ' +
    'If this keeps happening, the account will be placed on probation.';

  const appeal = document.createElement('p');
  appeal.className = 'integrity-muted';
  appeal.textContent =
    'If aim4 got this wrong, open a ticket from the Contact page and we will verify you.';

  const count = document.createElement('div');
  count.className = 'integrity-count';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn integrity-continue';
  btn.disabled = true;
  btn.textContent = 'Continue';

  let left = 60;
  const paint = () => {
    count.textContent = left > 0 ? `You can continue in ${left}s` : 'You can continue now.';
    btn.disabled = left > 0;
  };
  paint();
  const timer = window.setInterval(() => {
    left -= 1;
    paint();
    if (left <= 0) window.clearInterval(timer);
  }, 1000);

  btn.addEventListener('click', () => {
    if (left > 0) return;
    host.remove();
    onAck?.();
  });

  card.append(h, what, vpn, appeal, count, btn);
  host.appendChild(card);
}

/** Second offense: name the evidence, list the sessions, point at /contact. */
export function showProbation(probation) {
  // Once per page load is enough; SPA navigation must not re-nag.
  if (document.getElementById('integrity-overlay')) return;
  const host = overlay();
  if (!host) return;

  const card = document.createElement('div');
  card.className = 'integrity-card';

  const h = document.createElement('h2');
  h.textContent = 'Account on probation';

  const what = document.createElement('p');
  what.textContent =
    `We detected a login from ${sideLabel(probation.from)}, followed within six hours by ` +
    `${sideLabel(probation.to)}, and it was not the first time. This pattern indicates ` +
    'account sharing, which is not allowed on personal plans.';

  const effect = document.createElement('p');
  effect.textContent =
    'While on probation this account cannot use premium features and is restricted to the ' +
    'Free tier. Your subscription itself has not been cancelled.';

  const wrap = document.createElement('div');
  wrap.className = 'integrity-sessions';
  if ((probation.sessions || []).length) {
    const label = document.createElement('p');
    label.className = 'integrity-muted';
    label.textContent = 'Recent sessions on this account:';
    wrap.appendChild(label);
    const list = document.createElement('ul');
    for (const s of probation.sessions.slice(0, 5)) {
      const li = document.createElement('li');
      const when = s.at ? new Date(s.at).toLocaleString() : 'unknown time';
      li.textContent = `${when} — ${countryName(s.country)}, ${deviceLabel(s.deviceType)}`;
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  const appeal = document.createElement('p');
  appeal.className = 'integrity-muted';
  appeal.append('If no sharing is involved, ');
  const link = document.createElement('a');
  link.href = '/contact';
  link.textContent = 'open a ticket';
  appeal.append(link);
  appeal.append(' with verification and we will lift the probation.');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn integrity-continue';
  btn.textContent = 'Understood';
  btn.addEventListener('click', () => host.remove());
  // The /contact link is SPA-routed by the shell's delegated click handler;
  // the overlay just has to get out of the way.
  link.addEventListener('click', () => host.remove());

  card.append(h, what, effect, wrap, appeal, btn);
  host.appendChild(card);
}

export function initIntegrity(auth, entitlements = null) {
  const API_BASE = apiBase();
  let lastPing = 0;
  let inFlight = false;
  let hadProbation = false;

  async function ack() {
    try {
      const token = await accessToken();
      await fetch(`${API_BASE}/api/account/integrity/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
    } catch {
      /* offline: the warning re-appears next load, which is the right failure */
    }
  }

  function react(integrity) {
    if (!integrity) return;
    if (integrity.probation) {
      showProbation(integrity.probation);
      // The tier just changed server-side; pull the gates in line without
      // waiting for the next natural refresh.
      if (!hadProbation) entitlements?.refresh?.();
      hadProbation = true;
      return;
    }
    hadProbation = false;
    if (integrity.warning) showWarning(integrity.warning, ack);
  }

  async function ping(force = false) {
    if (inFlight || !auth.isLoggedIn) return;
    if (!force && Date.now() - lastPing < PING_MIN_MS) return;
    inFlight = true;
    try {
      const token = await accessToken();
      if (!token) return;
      const res = await fetch(`${API_BASE}/api/account/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ deviceId: deviceId() })
      });
      if (!res.ok) return;
      lastPing = Date.now();
      const body = await res.json().catch(() => ({}));
      react(body.integrity);
    } catch {
      /* offline: quiet, like the notification poller */
    } finally {
      inFlight = false;
    }
  }

  // A real sign-in change should ping immediately; TOKEN_REFRESHED does not
  // emit onChange (AuthManager short-circuits it), so this stays quiet.
  auth.onChange(() => void ping(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void ping();
  });
  void ping(true);
}
