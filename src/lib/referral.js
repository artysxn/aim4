// ---------------------------------------------------------------------------
// src/lib/referral.js
// Remembering that someone arrived through an affiliate link.
//
// A referral link is ?ref=CODE on any page of the site. The gap between
// clicking it and paying is usually days, so the code has to survive a browser
// close, a page the visitor bookmarked, and a signup in between. localStorage
// with an explicit window is the whole mechanism.
//
// The window matters as policy, not just as housekeeping. It is the promise
// made to affiliates ("your link counts for 60 days") and the limit on it: a
// code that never expired would keep claiming a customer years after the video
// that sent them, and every one of a person's purchases forever would belong
// to whoever they first clicked.
//
// The server decides whether the code is real, whether the affiliate is
// active, and whether it is a self-referral. Nothing here is trusted: this is
// a note the browser keeps for itself and hands over at checkout.
// ---------------------------------------------------------------------------

const KEY = 'aim4.referral';

/** How long a click counts for. */
export const REFERRAL_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same shape the server enforces, so an unusable code is never stored. */
function clean(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 24);
}

/**
 * Take ?ref= off the current URL and remember it.
 *
 * FIRST TOUCH WINS, matching the server's unique constraint on the referral
 * row. A second link does not overwrite the first, so someone who clicks one
 * creator's link and later another's still belongs to the first. Doing it the
 * other way round here would only produce a disagreement with the database,
 * where the first write is the one that sticks.
 *
 * The parameter is stripped from the address bar afterwards: it has been read,
 * and leaving it there means it survives into every link the visitor copies
 * and shares from that page.
 */
export function captureReferral(search = window.location?.search) {
  let code = '';
  try {
    code = clean(new URLSearchParams(search || '').get('ref'));
  } catch {
    return null;
  }
  if (!code) return storedReferral();

  const existing = storedReferral();
  if (!existing) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    } catch {
      /* private mode: the visit still works, it just will not attribute */
    }
  }
  stripFromUrl();
  return existing || code;
}

/** Drop ?ref= from the address bar without reloading or adding history. */
function stripFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('ref')) return;
    url.searchParams.delete('ref');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* nothing depends on the address bar being tidy */
  }
}

/** The remembered code, or null once it is past the window. */
export function storedReferral() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw?.code) return null;
    if (!(Date.now() - (raw.at || 0) < REFERRAL_DAYS * DAY_MS)) {
      localStorage.removeItem(KEY);
      return null;
    }
    return clean(raw.code) || null;
  } catch {
    return null;
  }
}

/**
 * Forget it.
 *
 * Deliberately not called after a checkout. Once the server has written the
 * referral row, that row is the source of truth and first touch is settled
 * there, so re-sending the same code changes nothing. Clearing it here would
 * only lose the attribution for a second purchase made before the window is
 * up. This exists for a person who wants it gone, and for the tests.
 */
export function clearReferral() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
