// ---------------------------------------------------------------------------
// replays/gif/perspectives.js
// What a visual note can be seen from, and where the camera goes for each.
//
// A perspective is plain data until it is rendered:
//   { type: 'player', slot, mode: 'pov' | 'third' }   that player's eyes, or behind them
//   { type: 'map' }                                   the 2D map
//   { type: 'overview' }                              a 3D camera above the action
//   { type: 'camera', pose, shot? }                   a 3D camera held at a chosen place; shot numbers several
//   { type: 'landing', kind: '3d' | '2d', grenade }   where one grenade comes down
//
// DOM-free.
// ---------------------------------------------------------------------------

import { normalizeNadeType } from '../strategy/utilityImport.js';

const WORDS = { smokegrenade: 'Smoke', flashbang: 'Flash', hegrenade: 'HE', molotov: 'Molotov', decoy: 'Decoy' };

/** How far an overview stands back from what it looks at, at most, in world units. */
const OVERVIEW_MAX_DISTANCE = 1100;
/** How far back along a grenade's flight its landing is watched from, in world units. */
const LANDING_BACK = 380;
/** Lifted off the flight path a little: a grenade's last bounce can run along the floor. */
const LANDING_LIFT = 70;
/** Seconds after a grenade goes off that its landing clip keeps running. */
const LANDING_AFTER_SECONDS = 3;

const nadeWord = (g) => WORDS[normalizeNadeType(g?.type)] || 'Grenade';

/** Yaw and pitch in the demo's degrees (pitch positive down), looking from one point at another. */
export function lookPose(eye, target) {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  return {
    x: eye.x,
    y: eye.y,
    z: eye.z,
    yaw: (Math.atan2(dy, dx) * 180) / Math.PI,
    pitch: (-Math.atan2(dz, Math.hypot(dx, dy)) * 180) / Math.PI
  };
}

/**
 * A camera above everywhere these points are, tilted down at them and far enough back to hold them all.
 *
 * @param {Array<{ x: number, y: number, z: number }>} points
 */
export function overviewPose(points) {
  const list = (points || []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!list.length) return null;
  const min = (k) => Math.min(...list.map((p) => p[k] || 0));
  const max = (k) => Math.max(...list.map((p) => p[k] || 0));
  const target = { x: (min('x') + max('x')) / 2, y: (min('y') + max('y')) / 2, z: (min('z') + max('z')) / 2 };
  const span = Math.max(max('x') - min('x'), max('y') - min('y'));
  // Capped: with the teams at opposite ends, backing off to hold them all goes up past where the map's own sky and
  // lights hold together, and the picture washes out white. The middle of the action is what this is for anyway.
  const distance = Math.min(OVERVIEW_MAX_DISTANCE, Math.max(600, span * 0.6));
  return lookPose({ x: target.x, y: target.y - distance * 0.6, z: target.z + distance * 0.8 }, target);
}

/**
 * Watching a grenade land from back along its own flight. The grenade flew through that air, so it is the one
 * place known to have a clear line to where it came down, whatever the walls around it are doing.
 *
 * @param {{ at?: object, from?: object, path?: object[] }} g
 */
export function landingPose(g) {
  const at = g?.at;
  if (!Number.isFinite(at?.x) || !Number.isFinite(at?.y)) return null;
  const target = { x: at.x, y: at.y, z: Number(at.z) || 0 };
  const path = Array.isArray(g.path) && g.path.length ? g.path : g.from ? [g.from] : [];
  let eye = null;
  let gone = 0;
  let last = target;
  for (let i = path.length - 1; i >= 0; i--) {
    const p = path[i];
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    gone += Math.hypot(p.x - last.x, p.y - last.y, (p.z || 0) - (last.z || 0));
    last = p;
    eye = p;
    if (gone >= LANDING_BACK) break;
  }
  if (!eye || gone < 40) eye = { x: target.x - LANDING_BACK, y: target.y, z: target.z };
  return lookPose({ x: eye.x, y: eye.y, z: (Number(eye.z) || 0) + LANDING_LIFT }, target);
}

/**
 * The grenades thrown between two ticks, in throw order, optionally only some players'.
 *
 * @param {object} meta
 * @param {number} fromTick
 * @param {number} toTick
 * @param {string[]} [players]  player ids; none means everyone
 */
export function throwsInPart(meta, fromTick, toTick, players = []) {
  const only = new Set((players || []).map(String));
  return (meta?.events?.grenades || [])
    .filter((g) => {
      const t = Number(g.throwTick);
      return Number.isFinite(t) && t >= fromTick && t <= toTick && (!only.size || only.has(String(g.player)));
    })
    .sort((a, b) => Number(a.throwTick) - Number(b.throwTick));
}

/** The name on a perspective's tab, and what it is filed as. */
export function describePerspective(spec, meta) {
  const nameOf = (slot) => (meta?.players || []).find((p) => p.slot === slot)?.name || `Player ${slot}`;
  switch (spec?.type) {
    case 'player':
      return spec.mode === 'third'
        ? { view: 'third', label: `${nameOf(spec.slot)}, third person` }
        : { view: 'pov', label: `${nameOf(spec.slot)}, first person` };
    case 'overview':
      return { view: 'free', label: 'Overview' };
    case 'camera':
      return { view: 'free', label: spec.shot ? `Camera ${spec.shot}` : 'Camera' };
    case 'landing': {
      const who = (meta?.players || []).find((p) => String(p.id) === String(spec.grenade?.player))?.name;
      const what = `${nadeWord(spec.grenade)} landing${who ? `, ${who}` : ''}`;
      return { view: 'landing', label: spec.kind === '2d' ? `${what} (2D)` : what };
    }
    default:
      return { view: 'map', label: '2D map' };
  }
}

/**
 * The part of the round a perspective covers. A landing runs on until the grenade has done its work, which can be
 * after the part someone picked: that is the moment the clip is for.
 *
 * @returns {{ fromTick: number, toTick: number }}
 */
export function partFor(spec, { fromTick, toTick, tickRate = 64 }) {
  if (spec?.type !== 'landing') return { fromTick, toTick };
  const off = Number(spec.grenade?.detonateTick);
  return { fromTick, toTick: Number.isFinite(off) ? Math.max(toTick, off + LANDING_AFTER_SECONDS * tickRate) : toTick };
}

/** What makeRoundGif is asked to do for a perspective. */
export function renderOptions(spec) {
  switch (spec?.type) {
    case 'player':
      return { kind: '3d', camera: { player: spec.slot, mode: spec.mode === 'third' ? 'third' : 'pov' } };
    case 'overview':
      return { kind: '3d', camera: { overview: true } };
    case 'camera':
      return { kind: '3d', camera: { pose: spec.pose } };
    case 'landing':
      return spec.kind === '2d'
        ? { kind: '2d', view: { focus: spec.grenade?.at } }
        : { kind: '3d', camera: { pose: landingPose(spec.grenade) } };
    default:
      return { kind: '2d', view: 'players' };
  }
}
