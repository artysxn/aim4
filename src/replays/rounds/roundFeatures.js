// ---------------------------------------------------------------------------
// replays/rounds/roundFeatures.js
// The state of a round at one tick, as numbers.
//
// Measurements only. Nothing here weighs anything or decides anything, which is
// what lets the same function feed the trainer in node and the viewer in the
// browser and have them agree by construction.
//
// Most of the hard parts already existed and are reused rather than rewritten:
// the plant timer and defuse feasibility from coach/winProbability, the live
// equipment totals with health weighting, the defuse kit search through pickup
// events, and map possession from coach/mapControlAdvantage. The genuinely new
// inputs are the duel edge (the gunfight model applied to every open fight),
// remaining utility, and how far apart the two sides are standing.
//
// Everything is oriented CT minus T. The round model predicts P(CT wins), so a
// positive number in any field means it favours the CT side.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { FLAG_ALIVE } from '../shared/tickFormat.js';
import { normalizeGrenadeType, normalizeLoadout } from '../viewer/equipmentIcons.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import {
  NADE_COST,
  ctHasDefuseKitAt,
  deadPlayersAt,
  liveEquipment,
  plantSituationAt
} from '../coach/winProbability.js';
import { possessionSharesAt } from '../coach/mapControlAdvantage.js';
import { bombRaceAt } from './bombRace.js';
import { predictDuel } from '../duels/duelModel.js';
import { paramVector } from '../duels/duelModelParams.js';
import { computeDuelSnapshot, duelContext } from '../duels/duelSnapshot.js';
import { blockingSmokesAt } from '../duels/sightRay.js';

/** Equipment average the model normalises against, matching winProbability. */
const EQUIP_SCALE = 5500;
/** Utility value one side can plausibly hold, for normalising. */
const UTIL_SCALE = 2000;
/** World units the two sides' centroids are typically apart. */
const DIST_SCALE = 2000;

/** Grenade stems, so loadout entries can be split from guns and armour. */
const NADE_STEMS = new Set(Object.keys(NADE_COST));

/**
 * Dollar value of the grenades a side still holds.
 *
 * Buys are known from the freezetime loadout; everything after that is the
 * pickup and remove log minus whatever has already been thrown. Utility is
 * tracked apart from equipment value because they do different jobs: a side
 * with rifles and no grenades cannot take a site, and the equipment average
 * cannot express that on its own.
 */
function utilityValue({ players, stats, grenades, itemEvents, tick, teamSides, deadIds }) {
  const out = { CT: 0, T: 0 };
  for (const p of players || []) {
    const side = teamSides?.[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    if (deadIds?.has(p.id)) continue;

    const held = new Map();
    for (const item of normalizeLoadout(stats?.[p.id]?.loadout || [])) {
      if (NADE_STEMS.has(item)) held.set(item, (held.get(item) || 0) + 1);
    }
    for (const e of itemEvents || []) {
      if (e.player !== p.id || (e.tick ?? 0) > tick) continue;
      const stem = normalizeGrenadeType(e.item);
      if (!NADE_STEMS.has(stem)) continue;
      const n = held.get(stem) || 0;
      held.set(stem, e.op === 'remove' ? Math.max(0, n - 1) : n + 1);
    }
    for (const g of grenades || []) {
      if (g.player !== p.id || (g.throwTick ?? g.tick ?? 0) > tick) continue;
      const stem = normalizeGrenadeType(g.type);
      if (!NADE_STEMS.has(stem)) continue;
      held.set(stem, Math.max(0, (held.get(stem) || 0) - 1));
    }
    for (const [stem, n] of held) out[side] += (NADE_COST[stem] || 0) * n;
  }
  return out;
}

/**
 * How far apart the two sides are standing.
 *
 * `centroid` is the gap between the two sides' centres of mass, which says
 * whether the round is still in its approach or already in contact. `nearest`
 * is the closest enemy pair, which is the one that is about to matter. A round
 * where both are large is not yet a fight; one where nearest is small but
 * centroid is large is a lone player in contact ahead of their team.
 */
function sideDistances(players, states, teamSides, deadIds) {
  const ct = [];
  const t = [];
  for (const p of players || []) {
    const side = teamSides?.[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    if (deadIds?.has(p.id)) continue;
    const s = states?.[p.slot];
    if (!s || (s.flags & FLAG_ALIVE) === 0 || s.health <= 0) continue;
    (side === 'CT' ? ct : t).push(s);
  }
  if (!ct.length || !t.length) return { centroid: 0, nearest: 0, known: false };

  const mean = (list, k) => list.reduce((a, s) => a + s[k], 0) / list.length;
  const centroid = Math.hypot(mean(ct, 'x') - mean(t, 'x'), mean(ct, 'y') - mean(t, 'y'));

  let nearest = Infinity;
  for (const a of ct) {
    for (const b of t) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < nearest) nearest = d;
    }
  }
  return { centroid, nearest: Number.isFinite(nearest) ? nearest : 0, known: true };
}

/**
 * The gunfight model's verdict on every fight that is open right now.
 *
 * `edge` is the expected net duels won by CT: each open duel contributes
 * 2p − 1, so an even fight adds nothing and a fight CT is winning outright adds
 * one. This is the whole point of having trained the duel model first, and it
 * is a much sharper input than counting bodies, because five players alive with
 * three of them already caught in losing fights is not a five-man round.
 */
function duelEdgeAt({
  meta,
  track,
  tick,
  network,
  mapCode,
  states,
  reloadTracker,
  teamSides,
  bombPair
}) {
  if (!network || !track || !reloadTracker) {
    return { edge: 0, open: 0, bombDuel: 0, known: false };
  }
  const tickRate = meta?.tickRate || 64;
  const snapshot = computeDuelSnapshot({
    meta,
    track,
    tick,
    network,
    mapCode,
    states,
    smokes: blockingSmokesAt(meta?.events?.grenades, tick, tickRate),
    reloadTracker
  });
  const v = paramVector();
  const sideOfSlot = new Map();
  for (const p of meta?.players || []) sideOfSlot.set(p.slot, teamSides?.[p.team]);

  let edge = 0;
  let open = 0;
  for (const pair of snapshot.pairs) {
    // Only fights someone can actually see are open; the rest are two players
    // who happen to be on the map at the same time.
    if (!pair.aSeesB && !pair.bSeesA) continue;
    const ctx = duelContext(snapshot, pair.aSlot, pair.bSlot);
    if (!ctx) continue;
    const pa = predictDuel(ctx, v);
    const aIsCt = sideOfSlot.get(pair.aSlot) === 'CT';
    const pCt = aIsCt ? pa : 1 - pa;
    edge += 2 * pCt - 1;
    open++;
  }
  // The fight for the bomb specifically: the CT nearest it against the T
  // nearest it, whether or not they can see each other yet. This is the retake
  // in miniature, and it is a different question from the average of every open
  // duel on the map, because this is the one that decides the site.
  let bombDuel = 0;
  if (bombPair && bombPair.ctSlot >= 0 && bombPair.tSlot >= 0) {
    const ctx = duelContext(snapshot, bombPair.ctSlot, bombPair.tSlot);
    if (ctx) {
      const pa = predictDuel(ctx, v);
      const aIsCt = sideOfSlot.get(ctx.pair.aSlot) === 'CT';
      bombDuel = 2 * (aIsCt ? pa : 1 - pa) - 1;
    }
  }

  return { edge, open, bombDuel, known: true };
}

/**
 * @typedef {object} RoundFeatures
 * @property {number} ctAlive @property {number} tAlive
 * @property {number} ctEff   @property {number} tEff    health-weighted bodies
 * @property {number} equipDiff      capped average equipment, CT minus T
 * @property {number} utilDiff       grenade dollars, CT minus T
 * @property {number} possessionDiff map control share, CT minus T
 * @property {number} duelEdge       expected net open duels won by CT
 * @property {number} openDuels
 * @property {number} centroidDist   world units between the two sides
 * @property {number} nearestDist    closest enemy pair
 * @property {number} secondsLeft    round clock
 * @property {boolean} planted
 * @property {number} bombSecondsLeft
 * @property {boolean} ctHasKit
 * @property {number} ctKits
 */

/**
 * Everything the round model reads, at one tick.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {number} args.tick
 * @param {Array} args.states           pre-sampled tick records
 * @param {object} [args.network]       prepared zone network, for duels/possession
 * @param {string} args.mapCode
 * @param {object} [args.presence]      zone presence, for possession
 * @param {object} args.reloadTracker
 * @returns {RoundFeatures}
 */
export function roundFeaturesAt({
  meta,
  track,
  tick,
  states,
  network = null,
  mapCode,
  presence = null,
  reloadTracker
}) {
  const timing = timingFor(meta);
  const tickRate = timing.tickRate || 64;
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const players = meta.players || [];
  const deadIds = deadPlayersAt(meta.events?.kills, tick);

  const equip = liveEquipment({
    players,
    stats: meta.stats,
    states,
    grenades: meta.events?.grenades,
    tick,
    teamSides,
    deadIds
  });

  const util = utilityValue({
    players,
    stats: meta.stats,
    grenades: meta.events?.grenades,
    itemEvents: meta.events?.items,
    tick,
    teamSides,
    deadIds
  });

  const plant = plantSituationAt({ meta, states, tick, deadIds, teamSides, players });
  const dist = sideDistances(players, states, teamSides, deadIds);

  const ctHasKit = Boolean(
    plant.ctHasKit ||
      ctHasDefuseKitAt({
        players,
        stats: meta.stats,
        teamSides,
        items: meta.events?.items,
        tick,
        deadIds
      })
  );
  const bombSecondsLeft = Number.isFinite(plant.bombSecondsLeft) ? plant.bombSecondsLeft : 0;

  const race = bombRaceAt({
    meta,
    states,
    tick,
    network,
    deadIds,
    teamSides,
    bombSecondsLeft,
    ctHasKit
  });

  const duels = duelEdgeAt({
    meta,
    track,
    tick,
    network,
    mapCode,
    states,
    reloadTracker,
    teamSides,
    bombPair: { ctSlot: race.closestCtSlot, tSlot: race.closestTSlot }
  });

  let possessionDiff = 0;
  if (network && presence) {
    const shares = possessionSharesAt({ meta, states, network, presence, tick });
    if (shares) possessionDiff = (shares.ct || 0) - (shares.t || 0);
  }

  const elapsed = (tick - timing.freezeEndTick) / tickRate;
  const secondsLeft = Math.max(0, ROUND_SECONDS - elapsed);

  return {
    ctAlive: equip.ctAlive,
    tAlive: equip.tAlive,
    ctEff: equip.ctEff,
    tEff: equip.tEff,
    equipDiff: (equip.CT - equip.T) / EQUIP_SCALE,
    utilDiff: (util.CT - util.T) / UTIL_SCALE,
    possessionDiff,
    duelEdge: duels.edge,
    openDuels: duels.open,
    bombDuelEdge: duels.bombDuel,
    centroidDist: dist.centroid / DIST_SCALE,
    nearestDist: dist.nearest / DIST_SCALE,
    secondsLeft,
    planted: Boolean(plant.planted),
    bombSecondsLeft,
    ctHasKit,
    // --- bomb geometry and zone possession ---------------------------------
    ctBombDist: race.ctBombDist,
    tBombDist: race.tBombDist,
    bombDistDiff: race.bombDistDiff,
    ctInSite: race.ctInSite,
    tInSite: race.tInSite,
    keyZoneNet: race.keyZoneNet,
    defuseSlack: race.defuseSlack,
    defuseImpossible: race.defuseImpossible
  };
}
