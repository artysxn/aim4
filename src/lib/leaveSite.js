// Send the whole window to an address off the site (a sign-in, a checkout).
// Inside a tab the site runs in a frame, and Google, Paddle and the rest refuse
// to be framed, so the top window has to be the one that goes.
//
// The window itself navigates, in the browser and in the desktop app alike: the
// app's navigation handler already keeps sign-in pages (Google, X, Discord,
// Steam, Supabase) in the window. Handing the address to the app over its
// bridge instead was a message nobody could see arrive, and when it did not
// (or the address was relative, like Steam's /api/auth/steam), the button said
// "Redirecting to Google…" and nothing happened.
export function leaveSite(url) {
  let top = null;
  try {
    if (window.top && window.top !== window && window.top.location.origin === window.location.origin) top = window.top;
  } catch {
    /* cross-origin top: go from here */
  }
  // An absolute address, so the top page reads it the same as the frame would.
  const href = new URL(url, window.location.href).href;
  if (top && typeof top.__aim4Leave === 'function') {
    top.__aim4Leave(href);
    return;
  }
  (top || window).location.assign(href);
}
