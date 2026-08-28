// ---------------------------------------------------------------------------
// replays/shared/matchSides.js
// Demo Manager match row: when exactly one team is focused, that team sits
// on the left and the score follows so the left number is that team's.
// ---------------------------------------------------------------------------

function sideMatches(side, ids, name) {
  const id = String(side?.id || '')
    .trim()
    .toLowerCase();
  const n = String(side?.name || '')
    .trim()
    .toLowerCase();
  if (id && ids.has(id)) return true;
  if (name && n && n === name) return true;
  return false;
}

/**
 * @param {{
 *   left: { id?: string, name?: string },
 *   right: { id?: string, name?: string },
 *   scoreLeft?: number,
 *   scoreRight?: number,
 *   focusIds?: string[],
 *   focusName?: string
 * }} args
 * @returns {{
 *   left: { id?: string, name?: string },
 *   right: { id?: string, name?: string },
 *   scoreLeft?: number,
 *   scoreRight?: number
 * }}
 */
export function orientMatchSides(args) {
  const left = args?.left || {};
  const right = args?.right || {};
  const scoreLeft = args?.scoreLeft;
  const scoreRight = args?.scoreRight;
  const ids = new Set((args?.focusIds || []).map((id) => String(id).toLowerCase()));
  const name = String(args?.focusName || '')
    .trim()
    .toLowerCase();
  if (!ids.size && !name) {
    return { left, right, scoreLeft, scoreRight };
  }
  if (!sideMatches(left, ids, name) && sideMatches(right, ids, name)) {
    return { left: right, right: left, scoreLeft: scoreRight, scoreRight: scoreLeft };
  }
  return { left, right, scoreLeft, scoreRight };
}

/**
 * @param {number} scoreLeft
 * @param {number} scoreRight
 * @param {string} [fallback]
 */
export function formatMatchScore(scoreLeft, scoreRight, fallback = '…') {
  if (!Number.isFinite(scoreLeft) || !Number.isFinite(scoreRight)) return fallback;
  return `${scoreLeft} - ${scoreRight}`;
}
