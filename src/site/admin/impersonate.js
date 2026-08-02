// ---------------------------------------------------------------------------
// src/site/admin/impersonate.js
// Starting, ending, and never forgetting that you are in a "view as" session.
//
// The banner is fixed, red, and not dismissible. An admin who forgets they are
// impersonating and then edits something is the failure this prevents, and a
// dismissible banner is the same as no banner within about ten minutes.
//
// Copy per CLAUDE.md: "Viewing as @username" and nothing else. No subtitle
// explaining what impersonation is.
// ---------------------------------------------------------------------------

import { impersonationTicket, setImpersonationTicket } from '../../lib/entitlements.js';
import { adminApi } from './adminApi.js';

const BANNER_ID = 'impersonation-banner';
const META_KEY = 'aim4.impersonate.meta';

function readMeta() {
  try {
    return JSON.parse(sessionStorage.getItem(META_KEY) || 'null');
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  try {
    if (meta) sessionStorage.setItem(META_KEY, JSON.stringify(meta));
    else sessionStorage.removeItem(META_KEY);
  } catch {
    /* private browsing */
  }
}

export function isImpersonating() {
  return Boolean(impersonationTicket());
}

/** Start a session and reload, so every view re-reads state as the target. */
export async function startImpersonation(targetId, username, { readOnly = true } = {}) {
  const { ticket, expiresAt } = await adminApi.impersonate(targetId, { readOnly });
  setImpersonationTicket(ticket);
  writeMeta({ username, targetId, readOnly, startedAt: Date.now(), expiresAt });
  window.location.assign('/');
}

export async function endImpersonation() {
  const ticket = impersonationTicket();
  if (ticket) {
    // Revoke server-side too, so the ticket is dead even if it was copied out
    // of this tab before it was cleared.
    await adminApi.endImpersonation(ticket).catch(() => {});
  }
  setImpersonationTicket('');
  writeMeta(null);
  window.location.assign('/admin');
}

function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m`;
}

/**
 * Render the banner and keep its timer moving. Safe to call on every page load;
 * it does nothing when no session is active.
 */
export function mountImpersonationBanner() {
  const existing = document.getElementById(BANNER_ID);
  const meta = readMeta();

  if (!isImpersonating() || !meta) {
    existing?.remove();
    document.body.classList.remove('is-impersonating');
    return;
  }

  document.body.classList.add('is-impersonating');
  const bar = existing || document.createElement('div');
  bar.id = BANNER_ID;
  bar.className = 'impersonation-banner';

  if (!existing) {
    const label = document.createElement('span');
    label.className = 'impersonation-label';
    const timer = document.createElement('span');
    timer.className = 'impersonation-timer';
    const exit = document.createElement('button');
    exit.type = 'button';
    exit.className = 'impersonation-exit';
    exit.textContent = 'Exit';
    exit.addEventListener('click', () => {
      endImpersonation().catch(() => {});
    });
    bar.append(label, timer, exit);
    document.body.prepend(bar);
  }

  bar.querySelector('.impersonation-label').textContent = `Viewing as @${meta.username}`;

  const tick = () => {
    const timer = bar.querySelector('.impersonation-timer');
    if (!timer) return;
    timer.textContent = elapsed(meta.startedAt);
    // The ticket expires server-side. Clearing it here keeps the banner honest
    // rather than showing a session that stopped working minutes ago.
    if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) {
      setImpersonationTicket('');
      writeMeta(null);
      window.location.reload();
    }
  };
  tick();
  clearInterval(bar._timer);
  bar._timer = setInterval(tick, 10_000);
}
