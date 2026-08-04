// ---------------------------------------------------------------------------
// replays/rounds/roundBuckets.js
// The scenarios a round snapshot gets filed under.
//
// Overlapping views of the same moment, not a partition. Their job is to turn
// one loss number into a diagnosis: a model can be respectable overall while
// being hopeless after a plant, because plants are a minority of ticks, and
// only a per-scenario report can say so.
//
// DOM-free.
// ---------------------------------------------------------------------------

export const ROUND_BUCKET_IDS = [
  'phase_early',
  'phase_mid',
  'phase_late',
  'man_even',
  'man_ct_up',
  'man_t_up',
  // By size of the advantage AND who holds it. These exist because the three
  // above could not see the model's worst error: a one-man lead was being
  // called twelve points too high, and `man_ct_up` averaged that together with
  // two- and three-man leads calibrated to within a point. The bucket read four
  // points off, blame steering shrugged, and the optimizer was never told where
  // to look.
  //
  // Split by side as well as size, because calibration error is a signed
  // average: a bucket holding both 5v4 and 4v5 has the two errors cancel almost
  // exactly and reports itself clean while both halves are wrong.
  'men_ct_d1',
  'men_ct_d2',
  'men_ct_d3up',
  'men_t_d1',
  'men_t_d2',
  'men_t_d3up',
  'planted',
  'unplanted',
  'eco_ct',
  'eco_t',
  'eco_even',
  'clutch'
];

/** Equipment average gap, as a share of the cap, above which a side is "up". */
const ECO_EDGE = 0.18;

/**
 * The exact matchup, as a dense index, for the training objective.
 *
 * By the literal pair of body counts rather than by the gap between them. The
 * gap is not enough: 5v4 and 2v1 are both "one man up" and are worth 68% and
 * 84% respectively, so a bucket holding both reports a comfortable average
 * while being badly wrong at each end. Grouping by gap is what let a nine-point
 * error at 5v4 hide inside a five-point one at "+1 man".
 *
 * Kept as an integer because the trainer counts these per shard on every loss
 * evaluation and cannot afford to be building strings there.
 */
export const MAN_BUCKET_COUNT = 36;

/** @param {number} ctAlive @param {number} tAlive @returns {number} 0..35 */
export function manBucketOf(ctAlive, tAlive) {
  const c = ctAlive < 0 ? 0 : ctAlive > 5 ? 5 : ctAlive;
  const t = tAlive < 0 ? 0 : tAlive > 5 ? 5 : tAlive;
  return c * 6 + t;
}

/** Human-readable names, in index order. */
export const MAN_BUCKET_NAMES = Array.from(
  { length: MAN_BUCKET_COUNT },
  (_, i) => `${(i / 6) | 0}v${i % 6}`
);

/**
 * @param {import('./roundFeatures.js').RoundFeatures} f
 * @param {'early'|'mid'|'late'} phase
 * @returns {string[]}
 */
export function bucketizeRound(f, phase) {
  const out = [`phase_${phase}`];

  const diff = f.ctAlive - f.tAlive;
  if (diff > 0) out.push('man_ct_up');
  else if (diff < 0) out.push('man_t_up');
  else out.push('man_even');

  const size = Math.abs(diff);
  if (size >= 1) {
    const side = diff > 0 ? 'ct' : 't';
    out.push(`men_${side}_${size === 1 ? 'd1' : size === 2 ? 'd2' : 'd3up'}`);
  }

  out.push(f.planted ? 'planted' : 'unplanted');

  if (f.equipDiff > ECO_EDGE) out.push('eco_ct');
  else if (f.equipDiff < -ECO_EDGE) out.push('eco_t');
  else out.push('eco_even');

  // One player left against two or more: the situation everyone remembers and
  // the one a round model is most often asked about.
  if ((f.ctAlive === 1 && f.tAlive >= 2) || (f.tAlive === 1 && f.ctAlive >= 2)) {
    out.push('clutch');
  }

  return out;
}
