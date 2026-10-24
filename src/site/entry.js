// ---------------------------------------------------------------------------
// src/site/entry.js
// The page's one script. In the desktop app the top window is a browser-style
// host (tabs.js): a tab strip and one frame per tab, each frame being this
// same site. In a browser the browser already has tabs and an address bar, so
// the site boots itself and every page keeps its own URL. A frame (and
// anything with ?notabs) boots the site itself too.
//
// The app injects window.aim4Desktop before any of the page's scripts run
// (recorder/app/src/desktop_bridge.js), so it is already there to ask.
// ---------------------------------------------------------------------------

const framed = window.self !== window.top;
const plain = new URLSearchParams(window.location.search).has('notabs');
const desktop = Boolean(window.aim4Desktop);

if (framed || plain || !desktop) {
  if (framed) document.documentElement.classList.add('in-tab');
  await import('./site.js');
} else {
  const { mountTabs } = await import('./tabs.js');
  mountTabs();
}
