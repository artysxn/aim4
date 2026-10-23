// ---------------------------------------------------------------------------
// src/site/desktopApp.js
// The aim4 desktop app's bridge (recorder/app/src/desktop_bridge.js), or null
// in a browser.
//
// The site's tabs (tabs.js) run each tab in a same-origin frame. The app
// injects its bridge into those frames too, but only the top window can reach
// the app: a frame's copy never gets the app's replies and its messages never
// arrive. So a frame uses the top window's bridge.
// ---------------------------------------------------------------------------

export function desktopApp() {
  if (typeof window === 'undefined') return null;
  try {
    if (window.top !== window && window.top.location.origin === window.location.origin && window.top.aim4Desktop) {
      return window.top.aim4Desktop;
    }
  } catch {
    /* a cross-origin parent: not the app's tabs */
  }
  return window.aim4Desktop || null;
}
