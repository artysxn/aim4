// ---------------------------------------------------------------------------
// src/site/ingestReminder.js
// Closable top-right notice for @artysan when demo ingest is Off.
// ---------------------------------------------------------------------------

import { adminApi } from './admin/adminApi.js';

const USERNAME = 'artysan';
const INTERVAL_MS = 10 * 60 * 1000;
const TOAST_ID = 'ingest-off-toast';

/**
 * @param {import('../core/AuthManager.js').AuthManager} auth
 * @param {import('../lib/entitlements.js').EntitlementsClient} entitlements
 */
export function initIngestReminder(auth, entitlements) {
  let timer = 0;
  let snoozeUntil = 0;
  let checking = false;

  function dismiss() {
    document.getElementById(TOAST_ID)?.remove();
    snoozeUntil = Date.now() + INTERVAL_MS;
  }

  function showToast() {
    if (document.getElementById(TOAST_ID)) return;
    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.className = 'ingest-off-toast';
    toast.setAttribute('role', 'status');

    const text = document.createElement('div');
    text.className = 'ingest-off-toast-text';
    text.textContent = 'No demos are ingesting. Switch ingest On in Admin.';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ingest-off-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', dismiss);

    toast.append(text, close);
    document.body.appendChild(toast);
  }

  async function tick() {
    if (checking) return;
    if (Date.now() < snoozeUntil) return;
    const name = String(auth.displayName || '').trim().toLowerCase();
    if (!auth.isLoggedIn || name !== USERNAME) {
      document.getElementById(TOAST_ID)?.remove();
      return;
    }
    await entitlements.ready().catch(() => null);
    if (!entitlements.isAdmin) {
      document.getElementById(TOAST_ID)?.remove();
      return;
    }

    checking = true;
    try {
      const status = await adminApi.ingestStatus();
      if (status?.enabled) {
        document.getElementById(TOAST_ID)?.remove();
        return;
      }
      showToast();
    } catch {
      /* non-admin / offline: stay quiet */
    } finally {
      checking = false;
    }
  }

  function arm() {
    if (timer) clearInterval(timer);
    timer = 0;
    const name = String(auth.displayName || '').trim().toLowerCase();
    if (!auth.isLoggedIn || name !== USERNAME) {
      document.getElementById(TOAST_ID)?.remove();
      return;
    }
    void tick();
    timer = window.setInterval(() => {
      void tick();
    }, INTERVAL_MS);
  }

  auth.onChange(arm);
  entitlements.onChange(arm);
  arm();
}
