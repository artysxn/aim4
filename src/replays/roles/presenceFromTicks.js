// ---------------------------------------------------------------------------
// Painted region presence sampling (deprecated).
// Geography roles / stats index no longer stamp region bags; Analytics filters
// via user-drawn shapes at query time instead.
// ---------------------------------------------------------------------------

/**
 * @deprecated Always returns null.
 */
export function presenceFromTicks(_buffer, _meta, _network, _players) {
  return null;
}

/** Sum region seconds from a legacy player presence blob. */
export function sec(bag, ...keys) {
  if (!bag?.r) return 0;
  let n = 0;
  for (const k of keys) n += bag.r[k] || 0;
  return n;
}
