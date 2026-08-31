// ---------------------------------------------------------------------------
// lib/leaderboardPaging.js
// Which page of a leaderboard to show, and where a given player is on it.
//
// Small enough to look obvious and wrong often enough to be worth pinning: an
// off-by-one here opens the board on the wrong page, or on page 3 of 2, and
// the symptom is a blank table rather than an error.
//
// A board is ranked over the WHOLE population and only then paged (see
// leaderboardsView), so an index here is a position on the board, not a
// position in whatever slice happens to be drawn.
// ---------------------------------------------------------------------------

/** Rows per page, coerced to at least one so a bad size cannot divide by zero. */
export function safeSize(size) {
  const n = Math.floor(Number(size) || 0);
  return n > 0 ? n : 1;
}

/** How many pages a board of `total` rows needs. Always at least one. */
export function pageCount(total, size) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  return Math.max(1, Math.ceil(n / safeSize(size)));
}

/** The page a row index falls on, 0 based. */
export function pageOf(index, size) {
  const i = Math.max(0, Math.floor(Number(index) || 0));
  return Math.floor(i / safeSize(size));
}

/** A page number forced inside the board. */
export function clampPage(page, total, size) {
  const last = pageCount(total, size) - 1;
  const p = Math.floor(Number(page) || 0);
  return Math.max(0, Math.min(p, last));
}

/**
 * The page a player is on, or 0 when they are not on the board.
 *
 * Zero rather than null because it is what the caller wants either way: a
 * board opens on the viewer's page when they are on it, and on the top when
 * they are not, which is the same behaviour it always had for a signed out
 * visitor.
 */
export function pageWithUser(list, userId, size) {
  if (!userId || !Array.isArray(list)) return 0;
  const at = list.findIndex((r) => r && r.user_id === userId);
  return at < 0 ? 0 : pageOf(at, size);
}

/** The slice of `list` shown on a page. */
export function pageSlice(list, page, size) {
  const s = safeSize(size);
  const from = clampPage(page, list?.length || 0, s) * s;
  return { from, rows: (list || []).slice(from, from + s) };
}
