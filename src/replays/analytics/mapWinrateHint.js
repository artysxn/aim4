// Hover copy for the predicted-vs-actual overlay on Overview map bars.

/**
 * @param {number} actual  round winrate 0-100
 * @param {number} predicted  PRW 0-100
 * @returns {''|'under'|'over'}
 */
export function mapWinrateCompareKind(actual, predicted) {
  if (!Number.isFinite(actual) || !Number.isFinite(predicted)) return '';
  if (Math.abs(predicted - actual) < 0.05) return '';
  return predicted > actual ? 'under' : 'over';
}

/**
 * @param {number} actual
 * @param {number} predicted
 * @returns {string}
 */
export function mapWinrateHint(actual, predicted) {
  const kind = mapWinrateCompareKind(actual, predicted);
  if (!kind) return '';
  const actualTxt = `${actual.toFixed(1)}%`;
  const predTxt = `${predicted.toFixed(1)}%`;
  const gapTxt = `${Math.abs(predicted - actual).toFixed(1)}%`;
  if (kind === 'under') {
    return `You're not winning as much as you should. Your predicted round winrate is ${predTxt}, that being ${gapTxt} higher than your actual winrate at ${actualTxt}.`;
  }
  return `You're overperforming! Your real winrate is ${actualTxt}, ${gapTxt} higher than your predicted winrate at ${predTxt}.`;
}

/**
 * Track span between two winrates on a 0-100% bar grown from the left.
 * @param {number} a
 * @param {number} b
 * @returns {{ left: number, width: number }|null}
 */
export function mapWinrateGapSpan(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(0, Math.min(100, Math.min(a, b)));
  const hi = Math.max(0, Math.min(100, Math.max(a, b)));
  const width = hi - lo;
  if (width < 0.05) return null;
  return { left: lo, width };
}

/**
 * Solid fill width. Overperformance hatches the extra (predicted → actual),
 * so the solid bar stops at predicted and does not cover the hatch.
 * @param {number} actual
 * @param {number} predicted
 */
export function mapWinrateFillWidth(actual, predicted) {
  if (!Number.isFinite(actual)) return 0;
  const a = Math.max(0, Math.min(100, actual));
  if (mapWinrateCompareKind(actual, predicted) === 'over' && Number.isFinite(predicted)) {
    return Math.max(0, Math.min(100, predicted));
  }
  return a;
}
