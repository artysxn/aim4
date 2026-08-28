// ---------------------------------------------------------------------------
// src/site/ingestReminder.js
// Closable top-right notice for @artysan when demo ingest is Off.
//
// Client-generated rather than a server notification: "ingest is off" is a
// condition to keep checking, not an event to file once. It renders through
// the shared toast in notify.js, so it looks like every other notice.
// ---------------------------------------------------------------------------

import { adminApi } from './admin/adminApi.js';
import { removeToast, showToast } from './notify.js';

const USERNAME = 'artysan';
const INTERVAL_MS = 10 * 60 * 1000;
const TOAST_ID = 'ingest-off';

/**
 * @param {import('../core/AuthManager.js').AuthManager} auth
 * @param {import('../lib/entitlements.js').EntitlementsClient} entitlements
 */
export function initIngestReminder(auth, entitlements) {
  let timer = 0;
  let snoozeUntil = 0;
  let checking = false;

  async function tick() {
    if (checking) return;
    if (Date.now() < snoozeUntil) return;
    const name = String(auth.displayName || '').trim().toLowerCase();
    if (!auth.isLoggedIn || name !== USERNAME) {
      removeToast(TOAST_ID);
      return;
    }
    await entitlements.ready().catch(() => null);
    if (!entitlements.isAdmin) {
      removeToast(TOAST_ID);
      return;
    }

    checking = true;
    try {
      const status = await adminApi.ingestStatus();
      if (status?.enabled) {
        removeToast(TOAST_ID);
        return;
      }
      showToast({
        id: TOAST_ID,
        title: 'No demos are ingesting',
        body: 'Switch ingest On in Admin.',
        href: '/admin',
        onDismiss: () => {
          snoozeUntil = Date.now() + INTERVAL_MS;
        }
      });
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
      removeToast(TOAST_ID);
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
