// ---------------------------------------------------------------------------
// replays/duels/duelOverlay.js
// The Duel stats tool's per-frame state.
//
// Keeps the trackers the model needs across frames and hands the renderer a
// plain description of what to draw: one line per living cross-side pairing
// that is inside a gunfight window (active ± 2s), one aim ray per player in
// those pairings, expected kills (xK) for fighters, and win percentages when
// a pairing is hovered.
//
// Pairings far from any fight are dropped rather than drawn dim. A full-buy
// round would otherwise paint every living enemy link at once, and the network
// stops being readable the moment more than one duel is on the map.
//
// The awkward part is that information advantage is a memory. Who saw whom
// first only exists as a running answer built by walking ticks in order, and a
// viewer does not walk in order: it seeks, scrubs and jumps rounds. So a
// backwards move rebuilds the memory over the seconds leading up to the new
// position, which is all it can hold anyway (the advantage saturates after a
// few seconds and contact lapses after three).
//
// DOM-free. The renderer projects world coordinates; nothing here knows about
// canvases.
// ---------------------------------------------------------------------------

import { isLowerLevel } from '../viewer/mapCalibration.js';
import { predictDuel } from './duelModel.js';
import { DUEL_MODEL_PARAMS, paramVector } from './duelModelParams.js';
import { computeDuelSnapshot, duelContext } from './duelSnapshot.js';
import { createReloadTracker } from './reloadTracker.js';
import { VISION_MAX_DIST, createVisionTracker } from './visionState.js';
import { blockingSmokesAt, castSightRay } from './sightRay.js';

/** Ticks between tracker updates while playing forward. */
const TRACK_STRIDE = 16;

/**
 * How far back a seek rebuilds the vision memory.
 *
 * Five seconds at 64 tick. Longer buys nothing: the information advantage term
 * saturates within four seconds and a pair that has been out of contact for
 * three is treated as a new engagement regardless.
 */
const REBUILD_TICKS = 320;

/**
 * How long the pair network stays on screen before a fight opens and after it
 * goes quiet. Outside that window the line is dropped so a full buy round does
 * not paint twenty-five dim pairings across the radar.
 */
export const DUEL_NETWORK_PAD_SECONDS = 2;

/** How far an aim ray is drawn before giving up, world units. */
const RAY_MAX = VISION_MAX_DIST;

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Walk a round once and record, per pairing, every contiguous span where either
 * player had the other on screen. The overlay uses these spans plus
 * {@link DUEL_NETWORK_PAD_SECONDS} to decide what to draw without peeking ahead
 * on every frame.
 *
 * @returns {Map<string, Array<{ start: number, end: number }>>}
 */
function buildActiveWindows({ meta, track, network, mapCode }) {
  const tickRate = meta.tickRate || 64;
  const visionTracker = createVisionTracker(tickRate);
  const reloadTracker = createReloadTracker({ meta });
  const start = meta.freezeEndTick ?? track.firstTick;
  const end = Math.min(meta.endTick ?? track.lastTick, track.lastTick);

  /** @type {Map<string, Array<{ start: number, end: number }>>} */
  const windows = new Map();
  /** @type {Map<string, number>} open window start tick */
  const open = new Map();

  const close = (key, endTick) => {
    const s = open.get(key);
    if (s === undefined) return;
    open.delete(key);
    let list = windows.get(key);
    if (!list) {
      list = [];
      windows.set(key, list);
    }
    list.push({ start: s, end: Math.max(s, endTick) });
  };

  for (let tick = start; tick <= end; tick += TRACK_STRIDE) {
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
    const activeNow = new Set();
    for (const pair of snapshot.pairs) {
      if (!(pair.aSeesB || pair.bSeesA)) continue;
      const key = pairKey(pair.aSlot, pair.bSlot);
      activeNow.add(key);
      if (!open.has(key)) open.set(key, tick);
    }
    for (const key of [...open.keys()]) {
      if (activeNow.has(key)) continue;
      // Last sample where this pair was active was the previous stride.
      close(key, tick - TRACK_STRIDE);
    }
  }
  for (const key of [...open.keys()]) close(key, end);
  return windows;
}

/** True when `tick` falls inside any padded active window for the pair. */
function pairVisible(windows, aSlot, bSlot, tick, padTicks) {
  const list = windows?.get(pairKey(aSlot, bSlot));
  if (!list?.length) return false;
  for (const w of list) {
    if (tick >= w.start - padTicks && tick <= w.end + padTicks) return true;
  }
  return false;
}

export function createDuelOverlay() {
  let visionTracker = null;
  let reloadTracker = null;
  let key = '';
  let lastTick = -Infinity;
  /** Per-round active fight windows, built once when the round is first drawn. */
  let windowsKey = '';
  /** @type {Map<string, Array<{ start: number, end: number }>> | null} */
  let activeWindows = null;

  const reset = () => {
    visionTracker = null;
    reloadTracker = null;
    key = '';
    lastTick = -Infinity;
    windowsKey = '';
    activeWindows = null;
  };

  /**
   * Advance the trackers to `tick`, rebuilding if the viewer jumped.
   * Only the tracker state is produced here; the caller takes the final
   * snapshot itself so it is not computed twice.
   */
  function advance({ meta, track, tick, network, mapCode, roundKey }) {
    const tickRate = meta.tickRate || 64;
    if (roundKey !== key) {
      key = roundKey;
      visionTracker = createVisionTracker(tickRate);
      reloadTracker = createReloadTracker({ meta });
      lastTick = -Infinity;
    }

    const from =
      tick < lastTick || tick - lastTick > REBUILD_TICKS
        ? Math.max(meta.freezeEndTick ?? track.firstTick, tick - REBUILD_TICKS)
        : lastTick + TRACK_STRIDE;

    if (tick < lastTick) visionTracker.reset();

    for (let t = from; t < tick; t += TRACK_STRIDE) {
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
    }
    lastTick = tick;
  }

  return {
    reset,

    /**
     * Everything the renderer needs for one frame, or null when the tool has
     * nothing to say (no geometry loaded, no round, nobody alive).
     *
     * @param {object} args
     * @param {object} args.meta
     * @param {import('../tickStore.js').TickTrack} args.track
     * @param {number} args.tick
     * @param {object} args.network        prepared zone network
     * @param {string} args.mapCode
     * @param {string} args.roundKey       changes when the round changes
     * @param {{aSlot:number,bSlot:number}|null} args.hover
     * @param {boolean} [args.showPercent]  unused; odds show whenever hover is set
     * @param {'default'|'lower'} [args.radarLevel]  stacked maps: floor on show
     */
    compute({
      meta,
      track,
      tick,
      network,
      mapCode,
      roundKey,
      hover = null,
      showPercent: _showPercent = false,
      radarLevel = 'default'
    }) {
      if (!meta || !track || !network) return null;
      // Fallback / holding meta often has an empty roster. Building windows from
      // that and caching them under the real round key leaves the overlay empty
      // until the tool is toggled (reset). Wait for a real roster.
      if (!(meta.players?.length > 0)) return null;
      advance({ meta, track, tick, network, mapCode, roundKey });

      const tickRate = meta.tickRate || 64;
      if (windowsKey !== roundKey) {
        windowsKey = roundKey;
        activeWindows = buildActiveWindows({ meta, track, network, mapCode });
      }
      const padTicks = DUEL_NETWORK_PAD_SECONDS * tickRate;

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
      if (!snapshot.players.length) return null;

      const v = paramVector();

      // One line per pairing that is inside its fight window (active ± pad).
      // Pairings that never become a gunfight, or that are more than the pad
      // away from one, are dropped entirely so the radar stays readable.
      const lines = [];
      for (const pair of snapshot.pairs) {
        if (!pairVisible(activeWindows, pair.aSlot, pair.bSlot, tick, padTicks)) {
          continue;
        }
        const ctx = duelContext(snapshot, pair.aSlot, pair.bSlot);
        if (!ctx) continue;
        const pa = predictDuel(ctx, v);
        lines.push({
          aSlot: pair.aSlot,
          bSlot: pair.bSlot,
          ax: pair.a.x,
          ay: pair.a.y,
          bx: pair.b.x,
          by: pair.b.y,
          aSide: pair.a.side,
          bSide: pair.b.side,
          dist: pair.dist,
          // A duel is active the moment either player has the other on screen.
          // Everything else still drawn here is in the pad before / after that.
          active: pair.aSeesB || pair.bSeesA,
          losClear: pair.losClear,
          pa,
          pb: 1 - pa
        });
      }

      // Aim rays only for players in a currently visible duel. Drawing every
      // living player's ray is most of the clutter the pad is meant to kill.
      const raySlots = new Set();
      for (const line of lines) {
        raySlots.add(line.aSlot);
        raySlots.add(line.bSlot);
      }
      const rays = [];
      // On a stacked map the two floors share one radar image, so a ray cast on
      // the floor that is not being shown would be drawn across rooms it has
      // nothing to do with. On every other map both sides of this are false and
      // nothing is skipped.
      const showingLower = radarLevel === 'lower';
      for (const p of snapshot.players) {
        if (!raySlots.has(p.slot)) continue;
        if (isLowerLevel(mapCode, p.z) !== showingLower) continue;
        const hit = castSightRay({
          ox: p.x,
          oy: p.y,
          dirDeg: p.yaw,
          maxDist: RAY_MAX,
          network,
          smokes
        });
        rays.push({
          slot: p.slot,
          side: p.side,
          x0: p.x,
          y0: p.y,
          x1: hit.x,
          y1: hit.y,
          blocked: hit.blocked
        });
      }

      // Expected kills: sum of this player's win chance across every active
      // duel they are in. A 50/50 is 0.5; a 1v2 at 99% into both is ~2.
      const xkBySlot = new Map();
      for (const line of lines) {
        if (!line.active) continue;
        xkBySlot.set(line.aSlot, (xkBySlot.get(line.aSlot) || 0) + line.pa);
        xkBySlot.set(line.bSlot, (xkBySlot.get(line.bSlot) || 0) + line.pb);
      }
      const xk = [];
      for (const p of snapshot.players) {
        const value = xkBySlot.get(p.slot);
        if (!(value > 0)) continue;
        if (isLowerLevel(mapCode, p.z) !== showingLower) continue;
        xk.push({
          slot: p.slot,
          side: p.side,
          x: p.x,
          y: p.y,
          xk: value
        });
      }

      const hovered =
        hover &&
        lines.find(
          (l) =>
            (l.aSlot === hover.aSlot && l.bSlot === hover.bSlot) ||
            (l.aSlot === hover.bSlot && l.bSlot === hover.aSlot)
        );

      return {
        lines,
        rays,
        xk,
        hover: hovered || null,
        /** True when a pair is hovered — renderer shows exact win % on both. */
        showPercent: Boolean(hovered),
        // False while the committed seed parameters are still in place, so the
        // caller can avoid presenting guesses as though they were measurements.
        trained: DUEL_MODEL_PARAMS.trainedOn > 0
      };
    }
  };
}
