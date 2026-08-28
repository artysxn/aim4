// ---------------------------------------------------------------------------
// src/site/notify.js
// Toasts, and the notification feed that fills them.
//
// The toast is the ingest-off reminder's card, generalized: same top-right
// position, same dismiss, but stacked, titled, and clickable. The reminder
// itself now renders through here, and so does everything the server files
// under /api/notifications — a ticket reply, news for the admins, whatever
// comes next. One visual for "the site wants a word", wherever the word
// comes from.
// ---------------------------------------------------------------------------

import { accessToken } from '../replays/api.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
const POLL_MS = 90 * 1000;
/** More than this many cards is a wall, not news. */
const MAX_VISIBLE = 3;

function stack() {
  let host = document.getElementById('site-toast-stack');
  if (!host) {
    host = document.createElement('div');
    host.id = 'site-toast-stack';
    host.className = 'site-toast-stack';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Show one toast. Returns its element; calling with the same `id` while it is
 * on screen is a no-op, so pollers can re-assert without stuttering.
 *
 * @param {{ id: string, title: string, body?: string, href?: string,
 *           onDismiss?: () => void, onOpen?: () => void }} opts
 */
export function showToast({ id, title, body = '', href = '', onDismiss, onOpen }) {
  const domId = `toast-${id}`;
  const existing = document.getElementById(domId);
  if (existing) return existing;

  const toast = document.createElement('div');
  toast.id = domId;
  toast.className = 'site-toast';
  toast.setAttribute('role', 'status');

  const main = document.createElement(href ? 'a' : 'div');
  main.className = 'site-toast-main';
  if (href) main.href = href;
  const titleEl = document.createElement('div');
  titleEl.className = 'site-toast-title';
  titleEl.textContent = title;
  main.appendChild(titleEl);
  if (body) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'site-toast-body';
    bodyEl.textContent = body;
    main.appendChild(bodyEl);
  }
  if (href) {
    main.addEventListener('click', () => {
      onOpen?.();
      toast.remove();
    });
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'site-toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => {
    toast.remove();
    onDismiss?.();
  });

  toast.append(main, close);
  stack().appendChild(toast);
  return toast;
}

export function removeToast(id) {
  document.getElementById(`toast-${id}`)?.remove();
}

// ---------------------------------------------------------------------------
// The feed.
// ---------------------------------------------------------------------------

async function authHeaders() {
  const token = await accessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

/**
 * Poll /api/notifications while signed in and surface unread ones as toasts.
 * Dismissing marks read on the server, so the same news never comes back —
 * on this device or any other.
 */
export function initNotifications(auth) {
  let timer = 0;
  let inFlight = false;
  /** Shown-and-dismissed this session, so a poll race cannot resurrect one. */
  const handled = new Set();

  async function markRead(ids) {
    try {
      await fetch(`${API_BASE}/api/notifications/read`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ ids })
      });
    } catch {
      /* offline: it stays unread and reappears, which is the right failure */
    }
  }

  async function tick() {
    if (inFlight || !auth.isLoggedIn) return;
    inFlight = true;
    try {
      const res = await fetch(`${API_BASE}/api/notifications`, { headers: await authHeaders() });
      if (!res.ok) return;
      const { notifications = [] } = await res.json();
      const unread = notifications.filter((n) => !n.read && !handled.has(n.id));
      for (const n of unread.slice(0, MAX_VISIBLE)) {
        showToast({
          id: n.id,
          title: n.title,
          body: n.body,
          href: n.link || '',
          onOpen: () => {
            handled.add(n.id);
            void markRead([n.id]);
          },
          onDismiss: () => {
            handled.add(n.id);
            void markRead([n.id]);
          }
        });
      }
    } catch {
      /* offline: quiet */
    } finally {
      inFlight = false;
    }
  }

  function arm() {
    if (timer) window.clearInterval(timer);
    timer = 0;
    if (!auth.isLoggedIn) return;
    void tick();
    timer = window.setInterval(() => void tick(), POLL_MS);
  }

  auth.onChange(arm);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void tick();
  });
  arm();
}
