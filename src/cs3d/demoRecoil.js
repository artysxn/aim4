// ---------------------------------------------------------------------------
// src/cs3d/demoRecoil.js
// A demo player's spray punch at any tick, rebuilt from the shots they fired.
//
// The tick data does not carry m_aimPunchAngle, but every shot is there with
// its tick and weapon, and shared/sim3d/recoil.js is CS2's own model (0.03°
// RMS over a 20-shot AK spray against real demos). So the punch at a tick is
// the current spray played again from its first shot: deterministic, which
// is what makes a scrub, a seek or a held-R rewind land on exactly the punch
// that playing through would have shown.
// ---------------------------------------------------------------------------

import {
  createRecoilState,
  resetRecoil,
  fireRecoil,
  updateRecoil,
  updateRecoilIndex,
  aimPunch,
  cameraPunch,
  RECOIL_DECAY_THRESHOLD
} from '../../shared/sim3d/recoil.js';

/**
 * Shots further apart than this start a new spray. By then the punch is back
 * on exactly zero (the decay has a linear term that lands it there) and the
 * recoil index is down to about a thousandth.
 */
export const SPRAY_GAP_SECONDS = 1.5;

/** updateRecoil takes at most a quarter second per call. */
const MAX_STEP = 0.25;

/**
 * One list per player, in tick order.
 * @param {Array<{tick:number, player:string|number, weapon:string}>} shots
 * @returns {Map<string|number, object[]>}
 */
export function shotsByPlayer(shots) {
  const out = new Map();
  for (const sh of shots || []) {
    if (!Number.isFinite(sh?.tick)) continue;
    let list = out.get(sh.player);
    if (!list) out.set(sh.player, (list = []));
    list.push(sh);
  }
  for (const list of out.values()) list.sort((a, b) => a.tick - b.tick);
  return out;
}

const cycleOf = (weapon) => (Array.isArray(weapon.cycleTime) ? weapon.cycleTime[0] : weapon.cycleTime) || 0.1;

/** Let `dt` seconds pass after the shot at `from`, as a frame loop would. */
function advance(state, dt, cycle, from) {
  for (let left = dt; left > 1e-9; left -= MAX_STEP) updateRecoil(state, Math.min(MAX_STEP, left));
  // The index holds for cycle × 1.1 after a shot, then falls.
  const decay = from + dt - Math.max(from, from + cycle * RECOIL_DECAY_THRESHOLD);
  if (decay > 0) updateRecoilIndex(state, decay, cycle, from + dt);
}

/** Index of the last shot at or before `tick`, or -1. */
function lastAtOrBefore(list, tick) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * The punch at `tick`, degrees, Source QAngle (pitch+ is down, yaw+ is left).
 *
 * @param {object[]|null} list  one player's shots, in tick order (shotsByPlayer)
 * @param {number} tick         the playhead, fractional ticks are fine
 * @param {number} rate         ticks per second
 * @param {(weapon: string) => object|null} statsOf  a weapons-pack row by name;
 *   a weapon without a recoil block (knife, grenade) kicks nothing
 * @param {{aim: number[], camera: number[], viewPunch: number[], state?: object}} [out]
 * @returns {{aim: number[], camera: number[], viewPunch: number[]}}
 *   `aim` the full punch (what bullets and the viewmodel take), `camera` the
 *   view's share (the shake plus 45% of the aim punch), `viewPunch` the shake
 */
export function demoSprayPunch(list, tick, rate, statsOf, out = { aim: [0, 0, 0], camera: [0, 0, 0], viewPunch: [0, 0] }) {
  out.aim[0] = out.aim[1] = out.aim[2] = 0;
  out.camera[0] = out.camera[1] = out.camera[2] = 0;
  out.viewPunch[0] = out.viewPunch[1] = 0;
  if (!list?.length || !(rate > 0) || !Number.isFinite(tick)) return out;
  const last = lastAtOrBefore(list, tick);
  if (last < 0) return out;
  const gap = SPRAY_GAP_SECONDS * rate;
  if (tick - list[last].tick > gap) return out;
  // Back to the start of this spray: the first shot after a long enough pause,
  // or the last weapon switch (the recoil index belongs to the weapon).
  let first = last;
  while (first > 0 && list[first].tick - list[first - 1].tick <= gap && list[first - 1].weapon === list[last].weapon) first--;

  const state = out.state || (out.state = createRecoilState());
  resetRecoil(state);
  let prev = null;
  let cycle = 0.1;
  for (let i = first; i <= last; i++) {
    const weapon = statsOf(list[i].weapon);
    if (!weapon?.recoil) continue;
    const t = list[i].tick / rate;
    if (prev !== null) advance(state, t - prev, cycle, prev);
    cycle = cycleOf(weapon);
    fireRecoil(state, weapon, { now: t });
    prev = t;
  }
  if (prev === null) return out;
  const now = tick / rate;
  if (now > prev) advance(state, now - prev, cycle, prev);
  aimPunch(state, out.aim);
  cameraPunch(state, out.camera);
  out.viewPunch[0] = state.viewPunch[0];
  out.viewPunch[1] = state.viewPunch[1];
  return out;
}
