// ---------------------------------------------------------------------------
// replays/duels/episodes.js
// Turning a round into labelled duels.
//
// An episode is one pairing's engagement: it opens when the two first have a
// clear line between them, and it ends when one kills the other (a label) or
// when the fight dissolves without resolving (no label). Sampling it at
// intervals rather than only at the kill is the whole point, because the
// question the model answers is "who wins from here", and "here" is every
// moment of the fight, not just the last one.
//
// Two decisions matter more than the rest.
//
// Episodes persist through lost contact for a grace period. Without that, a
// player who steps behind a doorframe and back out again would produce two
// unrelated half-fights, and the kill at the end of the second one would be
// scored as though the first had never happened, discarding the information
// advantage that actually decided it.
//
// Long standoffs are weighted down. An episode contributes a fixed total weight
// no matter how many snapshots it produced, so a thirty second AWP standoff
// counts once, like the half second peek it might otherwise outvote a hundred
// to one.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { isGun } from '../viewer/equipmentIcons.js';
import { computeDuelSnapshot, duelContext } from './duelSnapshot.js';
import { createReloadTracker } from './reloadTracker.js';
import { blockingSmokesAt } from './sightRay.js';
import {
  DISENGAGE_GRACE_SECONDS,
  VISION_MAX_DIST,
  createVisionTracker
} from './visionState.js';

/** Ticks between snapshots. 16 at 64 tick is a quarter of a second. */
export const DEFAULT_STRIDE = 16;

/**
 * Snapshots kept per episode.
 *
 * Enough to see a fight develop, few enough that one long standoff does not
 * fill the corpus with near-identical rows. Sampling is spread across the
 * episode and always keeps the last one, which is the moment of the kill.
 */
const MAX_SNAPSHOTS = 12;

/**
 * Rescan window for a kill that produced no episode, and its step.
 *
 * Two seconds covers a swing and the approach behind it; four ticks is fine
 * enough to catch a peek that a quarter second stride stepped straight over.
 * This runs only for orphaned kills, a few hundred in a whole corpus, so it can
 * afford to be much finer than the main walk.
 */
const RETRY_LOOKBACK_TICKS = 128;
const RETRY_STRIDE = 4;

/** Unordered key for a pair of slots. */
const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * @typedef {object} DuelEpisode
 * @property {string} round      round file stem
 * @property {string} map
 * @property {number} aSlot @property {number} bSlot
 * @property {number} startTick @property {number} endTick
 * @property {number|null} winnerSlot  null when the fight never resolved
 * @property {object[]} samples        duelContext per sampled tick, A = aSlot
 * @property {number[]} ticks
 */

/**
 * Walk one round and return its duels.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {object} args.network   prepared zone network
 * @param {string} args.mapCode
 * @param {string} [args.roundFile]
 * @param {number} [args.stride]
 * @returns {{ episodes: DuelEpisode[], stats: object }}
 */
export function extractEpisodes({
  meta,
  track,
  network,
  mapCode,
  roundFile = meta?.id || '',
  stride = DEFAULT_STRIDE
}) {
  const tickRate = meta?.tickRate || 64;
  const graceTicks = DISENGAGE_GRACE_SECONDS * tickRate;
  const start = meta.freezeEndTick ?? meta.startTick ?? track.firstTick;
  const end = Math.min(meta.endTick ?? track.lastTick, track.lastTick);

  const visionTracker = createVisionTracker(tickRate);
  const reloadTracker = createReloadTracker({ meta });
  const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));

  /**
   * Kills between two players, keyed by pair, in tick order. Consulted as the
   * walk passes each kill's tick so a fight can be closed and labelled at the
   * moment it actually ended.
   */
  const kills = [];
  for (const k of meta.events?.kills || []) {
    const a = slotOf.get(k.attacker);
    const b = slotOf.get(k.victim);
    if (a == null || b == null || a === b) continue;
    // Wallbangs are not duels in the sense being modelled here. Nobody saw
    // anybody; a player fired through a wall at a sound. Counting them as
    // fights the model failed to notice would be scoring it against a question
    // it was never asked.
    const duel = isGun(k.weapon) && !k.penetrated;
    kills.push({ tick: k.tick, attacker: a, victim: b, duel });
  }
  kills.sort((x, y) => x.tick - y.tick);

  /** @type {Map<string, object>} */
  const open = new Map();
  /** @type {DuelEpisode[]} */
  const episodes = [];
  const stats = {
    gunKills: 0,
    labelled: 0,
    recovered: 0,
    recoveredUnsighted: 0,
    killsWithoutEpisode: 0,
    censored: 0,
    snapshots: 0
  };

  const close = (key, winnerSlot, tick) => {
    const ep = open.get(key);
    if (!ep) return;
    open.delete(key);
    if (!ep.samples.length) return;
    ep.endTick = tick;
    ep.winnerSlot = winnerSlot;
    if (winnerSlot === null) stats.censored++;
    else stats.labelled++;
    episodes.push(ep);
  };

  let killIndex = 0;

  /**
   * Resolve every kill the feed reports up to `tick`.
   *
   * This must run before the snapshot, not after. Kills land on exact ticks and
   * the walk steps in strides, so by the time the walk reaches a snapshot the
   * victim has usually been dead for a fraction of a second and has already
   * dropped out of the living pairs. Draining the feed second means every
   * episode gets closed as "one player vanished" a few ticks before its own
   * kill is read, and the corpus ends up with no labels at all.
   */
  /** Duels the kill feed resolved with no episode open, retried below. */
  const orphans = [];

  const drainKills = (tick) => {
    while (killIndex < kills.length && kills[killIndex].tick <= tick) {
      const k = kills[killIndex++];
      if (k.duel) stats.gunKills++;
      const key = pairKey(k.attacker, k.victim);
      if (open.has(key)) {
        // Only a gunfight labels a gunfight. A standoff ended by a molotov, a
        // grenade or a knife did resolve, but not by the mechanism this model
        // predicts, and scoring the crosshairs and rifles of the moment against
        // that outcome would be teaching it from the wrong lesson.
        close(key, k.duel ? k.attacker : null, k.tick);
      } else if (k.duel) {
        orphans.push(k);
      }
      // The victim cannot be in any other fight either.
      for (const [otherKey, ep] of [...open]) {
        if (ep.aSlot === k.victim || ep.bSlot === k.victim) close(otherKey, null, k.tick);
      }
    }
  };

  for (let tick = start; tick <= end; tick += stride) {
    drainKills(tick);
    const smokes = blockingSmokesAt(meta.events?.grenades, tick, tickRate);
    const snapshot = computeDuelSnapshot({
      meta,
      track,
      tick,
      network,
      mapCode,
      smokes,
      visionTracker,
      reloadTracker
    });

    // --- open or extend an episode for every pair in contact ---------------
    const seen = new Set();
    for (const pair of snapshot.pairs) {
      const key = pairKey(pair.aSlot, pair.bSlot);
      seen.add(key);
      let ep = open.get(key);
      if (!ep) {
        if (!pair.losClear) continue;
        ep = {
          round: roundFile,
          map: mapCode,
          aSlot: pair.aSlot,
          bSlot: pair.bSlot,
          startTick: tick,
          endTick: tick,
          winnerSlot: null,
          samples: [],
          ticks: [],
          lastContact: tick
        };
        open.set(key, ep);
      }
      if (pair.losClear) ep.lastContact = tick;
      else if (tick - ep.lastContact > graceTicks) {
        // Out of contact long enough that this is no longer one fight.
        close(key, null, tick);
        continue;
      }
      // Only moments with a live sightline describe a duel. A pair waiting out
      // the grace period behind cover is still one episode, but those ticks are
      // not fights and must not be scored as though they were.
      if (!pair.losClear) continue;
      const ctx = duelContext(snapshot, ep.aSlot, ep.bSlot);
      if (!ctx) continue;
      ep.samples.push(ctx);
      ep.ticks.push(tick);
    }

    // Anyone gone from the living pairs without a kill to explain it (falls,
    // fire, the bomb) leaves every episode they were in, unresolved.
    for (const [key] of [...open]) {
      if (!seen.has(key)) close(key, null, tick);
    }
  }

  drainKills(end);
  for (const [key] of [...open]) close(key, null, end);

  // --- second pass: kills whose fight fell between two samples -------------
  //
  // The walk steps a quarter of a second at a time, which is longer than a
  // great many duels last. A player swings a corner, fires, and is dead again
  // inside two hundred milliseconds; if no sample happened to land inside that
  // window, the pair never registered a clear line and the kill was orphaned.
  //
  // The kill itself is proof the fight existed, so rather than lose it, the
  // window before it is rescanned at fine granularity. If a clear line turns up
  // the episode is built from those moments and labelled as normal. If none
  // does, the fight really was fought through geometry this model cannot see
  // and it stays dropped.
  for (const k of orphans) {
    const scanFrom = Math.max(start, k.tick - RETRY_LOOKBACK_TICKS);
    const scanTracker = createVisionTracker(tickRate);
    const clear = { samples: [], ticks: [] };
    const any = { samples: [], ticks: [] };
    // Same orientation rule as the main walk, so the two sources cannot differ
    // in which player ends up as A and skew the per-scenario reporting.
    const aSlot = Math.min(k.attacker, k.victim);
    const bSlot = Math.max(k.attacker, k.victim);

    for (let t = scanFrom; t <= k.tick; t += RETRY_STRIDE) {
      const snapshot = computeDuelSnapshot({
        meta,
        track,
        tick: t,
        network,
        mapCode,
        smokes: blockingSmokesAt(meta.events?.grenades, t, tickRate),
        visionTracker: scanTracker,
        reloadTracker
      });
      const ctx = duelContext(snapshot, aSlot, bSlot);
      if (!ctx) continue;
      if (ctx.pair.dist > VISION_MAX_DIST) continue;
      any.samples.push(ctx);
      any.ticks.push(t);
      if (ctx.pair.losClear) {
        clear.samples.push(ctx);
        clear.ticks.push(t);
      }
    }

    // Prefer moments the geometry agrees were fights. Failing that, take the
    // kill feed's word for it.
    //
    // This is the model's own limits being worked around, and it is sound for a
    // specific reason: line of sight is not one of the model's inputs. It gates
    // which moments count as a duel, but the features that decide the duel are
    // crosshairs, guns, range, health and the rest, and all of those are just as
    // true when the shot went through a door gap the flat map cannot represent.
    // Throwing these fights away would not make the corpus cleaner, it would
    // make it selectively blind to close-quarters and awkward-angle duels,
    // which is precisely the population it would then be worst at.
    const use = clear.samples.length ? clear : any;
    if (!use.samples.length) {
      stats.killsWithoutEpisode++;
      continue;
    }
    if (clear.samples.length) stats.recovered++;
    else stats.recoveredUnsighted++;
    stats.labelled++;

    episodes.push({
      round: roundFile,
      map: mapCode,
      aSlot,
      bSlot,
      startTick: use.ticks[0],
      endTick: k.tick,
      winnerSlot: k.attacker,
      sighted: clear.samples.length > 0,
      samples: use.samples,
      ticks: use.ticks
    });
  }

  // --- thin long episodes, and weight each one as a single fight -----------
  for (const ep of episodes) {
    if (ep.samples.length > MAX_SNAPSHOTS) {
      const keep = [];
      const keepTicks = [];
      const step = (ep.samples.length - 1) / (MAX_SNAPSHOTS - 1);
      for (let i = 0; i < MAX_SNAPSHOTS; i++) {
        const idx = Math.round(i * step);
        keep.push(ep.samples[idx]);
        keepTicks.push(ep.ticks[idx]);
      }
      ep.samples = keep;
      ep.ticks = keepTicks;
    }
    ep.weight = ep.samples.length ? 1 / ep.samples.length : 0;
    stats.snapshots += ep.samples.length;
  }

  return { episodes, stats };
}
