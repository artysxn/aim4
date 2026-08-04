// ---------------------------------------------------------------------------
// replays/duels/duelOverlay.js
// The Duel stats tool's per-frame state.
//
// Keeps the trackers the model needs across frames and hands the renderer a
// plain description of what to draw: one line per living cross-side pairing,
// one aim ray per living player, and the win percentages for whichever pairing
// the cursor is on.
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

/** How far an aim ray is drawn before giving up, world units. */
const RAY_MAX = VISION_MAX_DIST;

export function createDuelOverlay() {
  let visionTracker = null;
  let reloadTracker = null;
  let key = '';
  let lastTick = -Infinity;

  const reset = () => {
    visionTracker = null;
    reloadTracker = null;
    key = '';
    lastTick = -Infinity;
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
     * @param {boolean} args.showPercent   shift is held
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
      showPercent = false,
      radarLevel = 'default'
    }) {
      if (!meta || !track || !network) return null;
      advance({ meta, track, tick, network, mapCode, roundKey });

      const tickRate = meta.tickRate || 64;
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

      // One line per pairing. The probability is computed for every pair, not
      // just the hovered one, so hovering is instant and so a future readout
      // can use them without another pass.
      const lines = [];
      for (const pair of snapshot.pairs) {
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
          // Everything else on the map is a duel that has not started yet.
          active: pair.aSeesB || pair.bSeesA,
          losClear: pair.losClear,
          pa,
          pb: 1 - pa
        });
      }

      // Aim rays. Drawn from each living player along their view angle until
      // the map, the painted geometry or a smoke stops them, which is the same
      // set of occluders the duel's own sight test uses.
      const rays = [];
      // On a stacked map the two floors share one radar image, so a ray cast on
      // the floor that is not being shown would be drawn across rooms it has
      // nothing to do with. On every other map both sides of this are false and
      // nothing is skipped.
      const showingLower = radarLevel === 'lower';
      for (const p of snapshot.players) {
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
        hover: hovered || null,
        showPercent: Boolean(showPercent && hovered),
        // False while the committed seed parameters are still in place, so the
        // caller can avoid presenting guesses as though they were measurements.
        trained: DUEL_MODEL_PARAMS.trainedOn > 0
      };
    }
  };
}
