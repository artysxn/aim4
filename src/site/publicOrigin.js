// ---------------------------------------------------------------------------
// site/publicOrigin.js
// The address a link should carry when it leaves this page.
//
// In the aim4 desktop app the site is served from the app's own server on
// localhost, so a link built from `location.origin` reads
// "http://localhost:3784/…": dead for anyone it is sent to, and dead in a
// strategy saved to the team's stratbook (whose 2D link everyone opens on
// aim4.io). The app shows the same account and library as aim4.io, so its
// links go there. In a browser the page's own origin is right, staging and a
// local dev server included.
// ---------------------------------------------------------------------------

import { desktopApp } from './desktopApp.js';

export const PUBLIC_ORIGIN = 'https://aim4.io';

/** A local address the desktop app serves the site from. */
const LOCAL_ORIGIN = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=[/?#\s"'<>)\]]|$)/gi;

const isLocalHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** The origin to build shareable and stored links on. */
export function publicOrigin() {
  if (typeof window === 'undefined' || !window.location) return PUBLIC_ORIGIN;
  return isLocalHost(window.location.hostname) && desktopApp() ? PUBLIC_ORIGIN : window.location.origin;
}

/** Text with every local desktop-app address swapped for aim4.io. */
export function withPublicLinks(text) {
  return String(text ?? '').replace(LOCAL_ORIGIN, PUBLIC_ORIGIN);
}

/**
 * In the desktop app, anything copied leaves with aim4.io links: the copy
 * buttons (navigator.clipboard.writeText) and a plain Ctrl+C on selected text
 * (a link in a field, a note). Called once per window by mountDesktopExtras.
 */
export function installPublicClipboard(win = window) {
  if (!win || win.__aim4PublicClipboard) return;
  win.__aim4PublicClipboard = true;
  const clip = win.navigator?.clipboard;
  if (clip?.writeText) {
    const write = clip.writeText.bind(clip);
    try {
      clip.writeText = (text) => write(withPublicLinks(text));
    } catch {
      /* a read-only clipboard object: the copy event below still covers selections */
    }
  }
  win.document?.addEventListener('copy', (e) => {
    const selected = String(win.getSelection?.() || '');
    const field = win.document.activeElement;
    const text =
      field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') && typeof field.selectionStart === 'number'
        ? field.value.slice(field.selectionStart, field.selectionEnd)
        : selected;
    const swapped = withPublicLinks(text);
    if (!text || swapped === text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', swapped);
    e.preventDefault();
  });
}
