// ---------------------------------------------------------------------------
// src/site/entry.js
// The page's one script. The top window is a browser-style host (tabs.js): a
// tab strip and one frame per tab, each frame being this same site. A frame
// (and anything with ?notabs) boots the site itself.
// ---------------------------------------------------------------------------

const framed = window.self !== window.top;
const plain = new URLSearchParams(window.location.search).has('notabs');

if (framed || plain) {
  document.documentElement.classList.add('in-tab');
  await import('./site.js');
} else {
  const { mountTabs } = await import('./tabs.js');
  mountTabs();
}
