// ---------------------------------------------------------------------------
// shared/sim/situationKey.js
// Coarse address for memory (SIM-PLAN 18.2).
//
// Two rounds a human would describe with the same sentence must hash to the
// same key. Written at decision points only: freeze, snapshot, first contact,
// man-count change, plant, team interrupt. About 12-15 writes per round.
// ---------------------------------------------------------------------------

export const SITUATION_VERSION = 1;

const CLOCK_BUCKET = 20;

export function clockBucket(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const lo = Math.floor(s / CLOCK_BUCKET) * CLOCK_BUCKET;
  return `${lo}-${lo + CLOCK_BUCKET}`;
}

export function menKey(ours, theirs) {
  return `${Math.max(0, ours)}v${Math.max(0, theirs)}`;
}

export function econPair(us, them) {
  return `${us || 'full'}-vs-${them || 'full'}`;
}

export function utilBucket(n) {
  const v = Number(n) || 0;
  if (v <= 0) return 'none';
  if (v <= 2) return 'low';
  if (v <= 5) return 'med';
  return 'high';
}

/**
 * @param {object} args
 * @returns {{v:number, map:string, side:string, phase:string, clock:string,
 *   men:string, econ:string, control:string, start:string, shape:string,
 *   read:string, util:string, roles:string, hash:string}}
 */
export function situationKey({
  map = 'INF',
  side = 'T',
  phase = 'early',
  secondsLeft = 115,
  ours = 5,
  theirs = 5,
  econUs = 'full',
  econThem = 'full',
  control = 'none',
  start = 'default',
  shape = 'spread',
  read = 'unknown',
  utilUs = 'med',
  utilThem = 'med',
  roles = 'staffed'
} = {}) {
  const row = {
    v: SITUATION_VERSION,
    map: String(map).toUpperCase(),
    side: side === 'CT' ? 'CT' : 'T',
    phase,
    clock: clockBucket(secondsLeft),
    men: menKey(ours, theirs),
    econ: econPair(econUs, econThem),
    control,
    start,
    shape,
    read,
    util: `us:${utilUs},them:${utilThem}`,
    roles
  };
  row.hash = [
    row.v,
    row.map,
    row.side,
    row.phase,
    row.clock,
    row.men,
    row.econ,
    row.control,
    row.start,
    row.shape,
    row.read,
    row.util,
    row.roles
  ].join('|');
  return row;
}

export function shapeFromCore(core) {
  if (!core || !core.size) return 'spread';
  const lurk = core.lurkers?.length || 0;
  return `core${core.size}${lurk ? `,lurk${lurk}` : ''}`;
}
