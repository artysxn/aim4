// ---------------------------------------------------------------------------
// replays/duels/duelSnapshot.js
// Every duel on the map, at one tick.
//
// This is the single entry point. The trainer calls it while walking a demo and
// the viewer calls it while a demo plays, and because it is the same function
// with the same inputs, a percentage shown on screen is computed from exactly
// the features the model was fitted on. Any split between the two would be
// invisible and would quietly ruin the numbers, so there is no second path.
//
// It also computes the things a single pair cannot know about itself: how many
// enemies are watching a given player, and how far apart those enemies are from
// that player's point of view. A crossfire is not a property of either duel in
// it. It is a property of the position, and the model's second stage needs it
// as an input, not as an afterthought.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { FLAG_ALIVE } from '../shared/tickFormat.js';
import { playerFeatures, pairFeatures, speedAt } from './duelFeatures.js';
import { blockingSmokesAt, getBlockedMask } from './sightRay.js';
import { bearingDeg, pairVision } from './visionState.js';

/**
 * Widest angular gap between two watchers, seen from the player they are both
 * watching.
 *
 * Two enemies holding the same angle are one problem to solve; the same two
 * split across the screen are two problems that cannot be solved in sequence.
 * The measure is the largest pairwise separation rather than an average,
 * because it is the worst gap that decides whether turning to face one of them
 * means turning your back on the other.
 *
 * @param {number[]} bearings degrees, from the watched player to each watcher
 */
export function watcherSpreadDeg(bearings) {
  if (bearings.length < 2) return 0;
  let widest = 0;
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      let d = Math.abs(bearings[i] - bearings[j]) % 360;
      if (d > 180) d = 360 - d;
      if (d > widest) widest = d;
    }
  }
  return widest;
}

/**
 * @typedef {object} DuelSnapshot
 * @property {number} tick
 * @property {Array} pairs      one entry per living cross-side pairing
 * @property {object} perPlayer keyed by slot: watchers, spreadDeg, losEnemies
 */

/**
 * Build the full duel picture for one tick.
 *
 * @param {object} args
 * @param {object} args.meta                round meta (players, weapons, events)
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {number} args.tick
 * @param {object} args.network             prepared zone network
 * @param {string} args.mapCode
 * @param {Array} [args.states]             pre-sampled tick records, else sampled here
 * @param {Array} [args.smokes]             live clouds, else derived from meta
 * @param {object} [args.visionTracker]     for information advantage
 * @param {object} args.reloadTracker
 * @returns {DuelSnapshot}
 */
export function computeDuelSnapshot({
  meta,
  track,
  tick,
  network,
  mapCode,
  states = null,
  smokes = null,
  visionTracker = null,
  reloadTracker
}) {
  const tickRate = meta?.tickRate || 64;
  const weapons = meta?.weapons || [];
  const roster = meta?.players || [];
  const live = states || track.sampleAll(tick, []);
  const clouds = smokes || blockingSmokesAt(meta?.events?.grenades, tick, tickRate);
  const blockedMask = getBlockedMask(network, mapCode);

  // --- living players, resolved once -------------------------------------
  /** @type {Array} */
  const players = [];
  for (const p of roster) {
    const state = live[p.slot];
    if (!state || (state.flags & FLAG_ALIVE) === 0 || state.health <= 0) continue;
    const name = weapons[state.weapon] || '';
    players.push(
      playerFeatures({
        state,
        player: p,
        weapons,
        speed: speedAt(track, p.slot, tick, tickRate),
        reload: reloadTracker.stateAt(p.id, name, tick)
      })
    );
  }

  // --- every cross-side pairing ------------------------------------------
  const pairs = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = 0; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      if (j <= i) continue;
      // Sides come from the per-tick record, never the roster: teams swap at
      // halftime and a roster-based check silently inverts every duel after it.
      if (!a.side || !b.side || a.side === b.side) continue;
      const vision = pairVision({ a, b, network, mapCode, smokes: clouds, blockedMask });
      pairs.push({ aSlot: a.slot, bSlot: b.slot, vision, a, b });
    }
  }

  if (visionTracker) visionTracker.observe(tick, pairs);

  const full = pairs.map((p) =>
    pairFeatures({
      a: p.a,
      b: p.b,
      vision: p.vision,
      infoAdvSecs: visionTracker ? visionTracker.infoAdvantageSeconds(p.aSlot, p.bSlot) : 0
    })
  );

  // --- who is under how many guns, and from how wide an arc ---------------
  /** @type {Record<number, {watchers:number, losEnemies:number, spreadDeg:number, watcherSlots:number[]}>} */
  const perPlayer = {};
  for (const p of players) {
    perPlayer[p.slot] = { watchers: 0, losEnemies: 0, spreadDeg: 0, watcherSlots: [] };
  }
  /** @type {Record<number, number[]>} */
  const bearings = {};
  for (const p of players) bearings[p.slot] = [];

  for (const pair of full) {
    const a = perPlayer[pair.aSlot];
    const b = perPlayer[pair.bSlot];
    if (pair.losClear) {
      a.losEnemies++;
      b.losEnemies++;
    }
    if (pair.bSeesA) {
      a.watchers++;
      a.watcherSlots.push(pair.bSlot);
      bearings[pair.aSlot].push(bearingDeg(pair.a.x, pair.a.y, pair.b.x, pair.b.y));
    }
    if (pair.aSeesB) {
      b.watchers++;
      b.watcherSlots.push(pair.aSlot);
      bearings[pair.bSlot].push(bearingDeg(pair.b.x, pair.b.y, pair.a.x, pair.a.y));
    }
  }
  for (const p of players) {
    perPlayer[p.slot].spreadDeg = watcherSpreadDeg(bearings[p.slot]);
  }

  return { tick, pairs: full, perPlayer, players, smokes: clouds };
}

/** Mirror a pair record so `a` is the slot the caller asked about. */
function orient(pair, aSlot) {
  if (pair.aSlot === aSlot) return pair;
  return {
    aSlot: pair.bSlot,
    bSlot: pair.aSlot,
    dist: pair.dist,
    losClear: pair.losClear,
    aSeesB: pair.bSeesA,
    bSeesA: pair.aSeesB,
    offA: pair.offB,
    offB: pair.offA,
    infoAdvSecs: -pair.infoAdvSecs,
    a: pair.b,
    b: pair.a
  };
}

/**
 * One duel, plus everything else on the map that bears on it.
 *
 * The second stage of the model cannot be computed from a pair alone: a duel
 * you are winning outright changes completely when a second enemy is also
 * looking at you, and again depending on whether that enemy is stood beside the
 * first or across the map from them. This gathers exactly the surroundings that
 * matter and nothing else, which is also what makes a training sample small
 * enough to store: the other twenty pairs on the map are irrelevant to this one.
 *
 * The same function feeds the trainer and the viewer, so a stored sample and a
 * live frame present the model with the same shape.
 *
 * @param {DuelSnapshot} snapshot
 * @param {number} aSlot
 * @param {number} bSlot
 */
export function duelContext(snapshot, aSlot, bSlot) {
  const found = snapshot.pairs.find(
    (p) =>
      (p.aSlot === aSlot && p.bSlot === bSlot) || (p.aSlot === bSlot && p.bSlot === aSlot)
  );
  if (!found) return null;
  const pair = orient(found, aSlot);

  /**
   * Enemies of `slot`, other than the duel opponent, currently watching it.
   *
   * Both crosshair offsets are carried, not just the watcher's. The model needs
   * to weigh an extra enemy against the player's own ability to answer them,
   * and the reason being outnumbered hurts at all is that the player's
   * crosshair is committed to somebody else: `selfOff` is that commitment, and
   * without it a second attacker would be scored as though the victim were
   * equally ready for both.
   */
  const watchers = (slot, exclude) => {
    const out = [];
    for (const p of snapshot.pairs) {
      if (p.aSlot !== slot && p.bSlot !== slot) continue;
      const o = orient(p, slot);
      if (o.bSlot === exclude) continue;
      if (!o.bSeesA) continue;
      out.push({ p: o.b, dist: o.dist, off: o.offB, selfOff: o.offA });
    }
    return out;
  };

  // Only one kind of list is needed. A team mate of A who is watching B is, from
  // B's side of the fight, simply an extra enemy watching B, so "my team mates
  // helping me" and "extra enemies on my opponent" are the same set counted from
  // opposite ends. Keeping one list rather than two is what guarantees the
  // coupling term stays antisymmetric, and with it P(a) + P(b) = 1.
  return {
    pair,
    threatsOnA: watchers(aSlot, bSlot),
    threatsOnB: watchers(bSlot, aSlot),
    spreadA: snapshot.perPlayer[aSlot]?.spreadDeg || 0,
    spreadB: snapshot.perPlayer[bSlot]?.spreadDeg || 0
  };
}
