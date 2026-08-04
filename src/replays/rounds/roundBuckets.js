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
