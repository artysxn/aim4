// ---------------------------------------------------------------------------
// replays/duels/duelScanner.js
// The fights that are open at a tick, priced.
//
// The duel overlay answers "draw me this round's fight network"; this answers
// the much smaller question the win probability needs — who is in a gunfight
// right now and who is winning it — and answers it without walking the whole
// round first. Keeping them apart matters because the win chart and the Duels
// tool are toggled independently, and neither should have to pay for the other.
//
// A fight is open the moment either player has the other on screen with a clear
// line. That is the same definition the overlay draws as "active", and it is
// the point from which the duel model's number is a statement about something
// that is about to happen rather than a hypothetical about two players who
// cannot even see each other.
//
// The awkward part, as in the overlay, is that information advantage is a
// memory: who saw whom first only exists as a running answer built by walking
// ticks in order, and a viewer seeks and scrubs. So a backwards jump rebuilds
// the memory over the seconds leading up to the new position, which is all it
// can hold anyway.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { predictDuel } from './duelModel.js';
import { DUEL_MODEL_PARAMS, paramVector } from './duelModelParams.js';
import { computeDuelSnapshot, duelContext } from './duelSnapshot.js';
import { createReloadTracker } from './reloadTracker.js';
import { blockingSmokesAt } from './sightRay.js';
import { createVisionTracker } from './visionState.js';

/**
 * Ticks between live win-probability scans.
 *
 * An eighth of a second at 64 tick. A fight can swing from even to decided
 * inside half a second, so a scan per second would show the answer only after
 * it stopped being news; a scan per rendered frame would recompute every pair
 * on the map sixty times a second to move the number by nothing.
 */
export const DUEL_SCAN_STRIDE = 8;

/** How far back a seek rebuilds the vision memory. Five seconds at 64 tick. */
const REBUILD_TICKS = 320;

/** The tick `tick` belongs to on the scan grid. */
export function scanTickFor(tick, stride = DUEL_SCAN_STRIDE) {
  return Math.floor(tick / stride) * stride;
}

const EMPTY = [];

/**
 * Every open fight in a snapshot, with the model's verdict on each.
 *
 * @param {import('./duelSnapshot.js').DuelSnapshot} snapshot
 * @param {(slot: number) => string} [nameOf]
 * @returns {Array<{aSlot:number,bSlot:number,aSide:string,bSide:string,pa:number}>}
 */
export function activeDuels(snapshot, nameOf = null) {
  const out = [];
  if (!snapshot?.pairs?.length) return out;
  const v = paramVector();
  for (const pair of snapshot.pairs) {
    if (!(pair.aSeesB || pair.bSeesA)) continue;
    const ctx = duelContext(snapshot, pair.aSlot, pair.bSlot);
    if (!ctx) continue;
    out.push({
      aSlot: pair.aSlot,
      bSlot: pair.bSlot,
      aSide: pair.a.side,
      bSide: pair.b.side,
      aName: nameOf ? nameOf(pair.aSlot) : '',
      bName: nameOf ? nameOf(pair.bSlot) : '',
      dist: pair.dist,
      pa: predictDuel(ctx, v)
    });
  }
  return out;
}

/**
 * A scanner that carries the trackers the duel model needs across ticks.
 *
 * @param {object} [opts]
 * @param {number} [opts.stride]  ticks between catch-up snapshots. The live
 *   readout walks the scan grid; a caller that already walks the round a second
 *   at a time passes its own cadence so it does not pay for eight times the
 *   snapshots to reach the same ticks.
 */
export function createDuelScanner({ stride = DUEL_SCAN_STRIDE } = {}) {
  let key = '';
  let visionTracker = null;
  let reloadTracker = null;
  let lastTick = -Infinity;
  let cachedTick = null;
  let cached = EMPTY;
  let names = null;

  function reset() {
    key = '';
    visionTracker = null;
    reloadTracker = null;
    lastTick = -Infinity;
    cachedTick = null;
    cached = EMPTY;
    names = null;
  }

  /**
   * The open fights at `tick`, or an empty list when the model cannot speak:
   * no geometry, no full tick data, or untrained parameters. Repeated calls at
   * the same tick — every rendered frame inside one scan window — reuse the
   * answer rather than recomputing every pair on the map.
   *
   * @param {object} args
   * @param {object} args.meta
   * @param {import('../tickStore.js').TickTrack} args.track
   * @param {number} args.tick
   * @param {object} args.network   prepared zone network
   * @param {string} args.mapCode
   * @param {string} args.roundKey  changes when the round changes
   */
  function at({ meta, track, tick, network, mapCode, roundKey }) {
    if (!meta || !track || !network) return EMPTY;
    if (!Number.isFinite(tick)) return EMPTY;
    // Seed parameters are guesses. Letting them move the round win chance would
    // dress a guess up as a measurement, which is worse than saying nothing.
    if (!(DUEL_MODEL_PARAMS.trainedOn > 0)) return EMPTY;

    const tickRate = meta.tickRate || 64;
    if (roundKey !== key) {
      key = roundKey;
      visionTracker = createVisionTracker(tickRate);
      reloadTracker = createReloadTracker({ meta });
      lastTick = -Infinity;
      cachedTick = null;
      cached = EMPTY;
      names = new Map((meta.players || []).map((p) => [p.slot, p.name || p.id]));
    }
    if (cachedTick === tick) return cached;

    const snapshotAt = (t) =>
      computeDuelSnapshot({
        meta,
        track,
        tick: t,
        network,
        mapCode,
        smokes: blockingSmokesAt(meta.events?.grenades, t, tickRate),
        visionTracker,
        reloadTracker
      });

    const from =
      tick < lastTick || tick - lastTick > REBUILD_TICKS
        ? Math.max(meta.freezeEndTick ?? track.firstTick, tick - REBUILD_TICKS)
        : lastTick + stride;
    if (tick < lastTick) visionTracker.reset();
    for (let t = from; t < tick; t += stride) snapshotAt(t);
    lastTick = tick;

    cached = activeDuels(snapshotAt(tick), (slot) => names?.get(slot) || '');
    cachedTick = tick;
    return cached;
  }

  return { reset, at };
}
