// ---------------------------------------------------------------------------
// shared/sim/optionSegmenter.js
// Reading options off a recorded track: the first half of the BC extractor.
//
// SIM-PLAN 9.3 clones behavior onto the OPTION vocabulary, not onto per-step
// movement heads, and the sequencing note in 15 explains why that ordering is
// load-bearing: an option has a signature across seconds, which is far easier
// to read off a demo than "which anchor is he pointed at right now", and
// cloning onto the wrong action space is the single most expensive mistake
// available in this project.
//
// This module is the signature reader. Given one player's pose track (and
// whatever events the source can attest), it emits labeled segments in the
// 6.6 vocabulary. It deliberately reads FEET, not thoughts:
//
//   holds are stillness with duration
//   peeks are excursions that come back
//   moves are displacement, and a rotate is a move that crosses the map
//   a fall_back is a reversal bought with blood (it needs the damage event)
//   objectives come from the channel events, which every source has
//
// Feet-only labels are the ones that stay TRUE when the belief structure and
// the macro action space change in P3c/P3d — which is why this half of the
// extractor can be built before those phases land. The intent-side labels
// (lurk vs slow advance, crossfire_hold vs hold) need teammate and vision
// context and join with the full extractor.
//
// Works on any pose source: a parsed demo track, an encoded sim round, or the
// engine's own recorder. DOM-free, model-free, deterministic.
// ---------------------------------------------------------------------------

import { REFRAG_RADIUS, REFRAG_WINDOW_SECONDS } from './demoContracts.js';

export const SEGMENTER_VERSION = 2;

/** Below this ground speed a body is standing, units/s. `[calibrate]` */
export const STILL_SPEED = 30;
/** Stillness shorter than this is a stutter-step, not a hold. Seconds. */
export const MIN_HOLD_SECONDS = 1.2;
/** An excursion that returns inside this radius came back. World units. */
export const RETURN_RADIUS = 120;
/** Out-and-back longer than this is a move that changed its mind, not a peek. */
export const MAX_PEEK_SECONDS = 2.5;
/** Net displacement above this reads as a rotation, not a local advance. */
export const ROTATE_DISPLACEMENT = 2000;
/** A reversal within this window of taking damage is a fall_back. Seconds. */
export const FALL_BACK_WINDOW_SECONDS = 1.5;
/** Segments shorter than this are folded into their neighbours. Seconds. */
export const MIN_SEGMENT_SECONDS = 0.4;
/** Isolated from the pack by this much is a lurk, not a slow advance. */
export const LURK_SPACING = 1400;
/** Teammates inside this radius count as the pack for an execute. */
export const PACK_RADIUS = 900;

/**
 * @typedef {object} Segment
 * @property {string} option     an id from options.js OPTION_DEFS
 * @property {number} startTick
 * @property {number} endTick
 * @property {object} [detail]   what the label was read from
 */

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Direction of travel over a run of poses, or null when it barely moved. */
function heading(poses, from, to) {
  const a = poses[from];
  const b = poses[to];
  if (!a || !b || dist(a, b) < 40) return null;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Absolute angle between two headings, radians in [0, PI]. */
function turn(h1, h2) {
  let d = Math.abs(h1 - h2) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/** Last pose on a teammate track at or before `tick`. */
function poseAt(track, tick) {
  if (!track?.length) return null;
  let best = track[0];
  for (const p of track) {
    if (p.tick > tick) break;
    best = p;
  }
  return best;
}

function packCentroid(teammates, tick) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const track of teammates) {
    const p = poseAt(track, tick);
    if (!p) continue;
    x += p.x;
    y += p.y;
    n += 1;
  }
  return n ? { x: x / n, y: y / n, n } : null;
}

function countNear(teammates, origin, tick, radius) {
  let n = 0;
  for (const track of teammates) {
    const p = poseAt(track, tick);
    if (p && dist(origin, p) <= radius) n += 1;
  }
  return n;
}

function headingToward(from, to, head) {
  if (head == null || !to) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.cos(head) * (dx / len) + Math.sin(head) * (dy / len) > 0.2;
}

/**
 * Label one player's round.
 *
 * @param {object} args
 * @param {Array<{tick:number, x:number, y:number}>} args.poses  uniform-ish
 *   samples of a LIVING player; stop the track at death
 * @param {Array<{type:string, tick:number}>} [args.events]  this player's own
 *   attested events: 'damage' (taken), 'plant_start', 'plant_end',
 *   'defuse_start', 'defuse_end'
 * @param {Array<Array<{tick:number, x:number, y:number}>>} [args.teammates]
 *   living teammates' pose tracks, for pack spacing / execute / lurk
 * @param {{x:number, y:number}|null} [args.site]  the site the round is hitting
 * @param {Array<{tick:number, x:number, y:number}>} [args.deaths]
 *   teammate deaths, for the trade window
 * @param {number} [args.tickRate]
 * @returns {Segment[]}
 */
export function segmentTrack({
  poses,
  events = [],
  tickRate = 64,
  teammates = [],
  site = null,
  deaths = []
}) {
  if (!poses || poses.length < 2) return [];

  // ---- objectives first: a channel outranks feet, in labels as in play ----
  const objectives = [];
  let open = null;
  for (const e of events) {
    if (e.type === 'plant_start' || e.type === 'defuse_start') {
      open = { option: e.type === 'plant_start' ? 'plant' : 'defuse', startTick: e.tick };
    } else if (open && (e.type === 'plant_end' || e.type === 'defuse_end')) {
      objectives.push({ ...open, endTick: e.tick, detail: { from: 'channel' } });
      open = null;
    }
  }
  if (open) {
    objectives.push({
      ...open,
      endTick: poses[poses.length - 1].tick,
      detail: { from: 'channel, unfinished' }
    });
  }

  // ---- classify samples as still or moving --------------------------------
  const still = new Array(poses.length).fill(false);
  for (let i = 1; i < poses.length; i += 1) {
    const dt = (poses[i].tick - poses[i - 1].tick) / tickRate;
    const speed = dt > 0 ? dist(poses[i - 1], poses[i]) / dt : 0;
    still[i] = speed < STILL_SPEED;
  }
  still[0] = still[1] ?? true;

  // ---- runs of same state become raw segments ------------------------------
  const runs = [];
  let start = 0;
  for (let i = 1; i <= poses.length; i += 1) {
    if (i < poses.length && still[i] === still[start]) continue;
    runs.push({ still: still[start], from: start, to: i - 1 });
    start = i;
  }

  /**
   * Split one moving run at sharp reversals. A body that turns around does
   * not have to stop first, and a fall_back read as the tail of one long
   * advance is a fall_back nobody labeled. Called only on runs that already
   * failed the peek test — a jiggle IS a reversal, and it must win first.
   */
  const STRIDE = Math.max(2, Math.round((0.5 * tickRate) / ((poses[1].tick - poses[0].tick) || 8)));
  function splitAtReversals(run) {
    if (run.to - run.from < STRIDE * 2) return [run];
    const pieces = [];
    let segFrom = run.from;
    let prev = heading(poses, run.from, run.from + STRIDE);
    for (let i = run.from + STRIDE; i + STRIDE <= run.to; i += STRIDE) {
      const h = heading(poses, i, i + STRIDE);
      if (prev !== null && h !== null && turn(prev, h) > (2 * Math.PI) / 3) {
        pieces.push({ still: false, from: segFrom, to: i });
        segFrom = i;
      }
      if (h !== null) prev = h;
    }
    pieces.push({ still: false, from: segFrom, to: run.to });
    return pieces;
  }

  const raw = [];
  for (const run of runs) {
    if (run.still) {
      raw.push(run);
      continue;
    }
    // The whole run gets the peek test before any splitting: an excursion
    // that comes back quickly is one gesture, not two moves.
    const a = poses[run.from];
    const b = poses[run.to];
    const seconds = (b.tick - a.tick) / tickRate;
    let maxOut = 0;
    for (let i = run.from; i <= run.to; i += 1) maxOut = Math.max(maxOut, dist(a, poses[i]));
    const isPeek =
      dist(a, b) < RETURN_RADIUS && maxOut > RETURN_RADIUS * 0.8 && seconds <= MAX_PEEK_SECONDS;
    if (isPeek) raw.push({ ...run, peek: true, maxOut });
    else raw.push(...splitAtReversals(run));
  }

  const damageTicks = events.filter((e) => e.type === 'damage').map((e) => e.tick);

  const out = [];
  for (let r = 0; r < raw.length; r += 1) {
    const seg = raw[r];
    const a = poses[seg.from];
    const b = poses[seg.to];
    const seconds = (b.tick - a.tick) / tickRate;

    if (seg.still) {
      if (seconds >= MIN_HOLD_SECONDS) {
        out.push({
          option: 'hold_angle',
          startTick: a.tick,
          endTick: b.tick,
          detail: { seconds: Number(seconds.toFixed(2)) }
        });
      }
      // Short stillness folds into whatever motion surrounds it.
      continue;
    }

    // Moving. The peek was decided on the whole run, before any splitting.
    const pack = packCentroid(teammates, a.tick);
    const spacing =
      pack != null ? { dx: Math.round(pack.x - a.x), dy: Math.round(pack.y - a.y) } : null;
    const withSpacing = (detail) => (spacing ? { ...detail, spacing } : detail);

    if (seg.peek) {
      out.push({
        option: 'jiggle',
        startTick: a.tick,
        endTick: b.tick,
        detail: withSpacing({ excursion: Math.round(seg.maxOut) })
      });
      continue;
    }

    // Fall back: this move begins on the heels of damage and reverses the
    // direction the previous move was carrying.
    const hurt = damageTicks.some(
      (t) => a.tick - t >= 0 && a.tick - t <= FALL_BACK_WINDOW_SECONDS * tickRate
    );
    if (hurt && r > 0) {
      const prevMove = raw
        .slice(0, r)
        .reverse()
        .find((p) => !p.still);
      const before = prevMove ? heading(poses, prevMove.from, prevMove.to) : null;
      const now = heading(poses, seg.from, seg.to);
      if (before !== null && now !== null && turn(before, now) > (2 * Math.PI) / 3) {
        out.push({
          option: 'fall_back',
          startTick: a.tick,
          endTick: b.tick,
          detail: withSpacing({ reversalDeg: Math.round((turn(before, now) * 180) / Math.PI) })
        });
        continue;
      }
    }

    let option = dist(a, b) >= ROTATE_DISPLACEMENT ? 'rotate' : 'advance';
    const nowHead = heading(poses, seg.from, seg.to);
    if (option !== 'rotate' && nowHead != null) {
      const window = REFRAG_WINDOW_SECONDS * tickRate;
      const death = deaths.find(
        (d) => a.tick - d.tick >= 0 && a.tick - d.tick <= window && dist(a, d) <= REFRAG_RADIUS
      );
      if (death && headingToward(a, death, nowHead)) option = 'trade';
      else if (site && countNear(teammates, a, a.tick, PACK_RADIUS) >= 2 && headingToward(a, site, nowHead)) {
        option = 'execute_entry';
      } else if (pack && dist(a, pack) >= LURK_SPACING) option = 'lurk';
    }

    out.push({
      option,
      startTick: a.tick,
      endTick: b.tick,
      detail: withSpacing({ displacement: Math.round(dist(a, b)) })
    });
  }

  // ---- objectives override whatever the feet said meanwhile ----------------
  const merged = [];
  for (const seg of out) {
    const clipped = objectives.reduce((acc, o) => {
      const next = [];
      for (const s of acc) {
        if (s.endTick <= o.startTick || s.startTick >= o.endTick) {
          next.push(s);
          continue;
        }
        if (s.startTick < o.startTick) next.push({ ...s, endTick: o.startTick });
        if (s.endTick > o.endTick) next.push({ ...s, startTick: o.endTick });
      }
      return next;
    }, [seg]);
    merged.push(...clipped);
  }
  merged.push(...objectives);
  merged.sort((p, q) => p.startTick - q.startTick);

  // ---- housekeeping: drop slivers, fuse same-label neighbours --------------
  const cleaned = [];
  for (const seg of merged) {
    const seconds = (seg.endTick - seg.startTick) / tickRate;
    if (seconds < MIN_SEGMENT_SECONDS && seg.option !== 'plant' && seg.option !== 'defuse') {
      continue;
    }
    const last = cleaned[cleaned.length - 1];
    if (last && last.option === seg.option && seg.startTick - last.endTick <= tickRate) {
      last.endTick = seg.endTick;
      continue;
    }
    cleaned.push({ ...seg });
  }
  return cleaned;
}

/**
 * Label coverage: the share of the track's living time that got a label.
 * The BC extractor reports this per demo — a segmenter that only explains
 * half the round is a labeler with an opinion about the other half.
 */
export function coverage(segments, poses, tickRate = 64) {
  if (!poses?.length) return 0;
  const total = (poses[poses.length - 1].tick - poses[0].tick) / tickRate;
  if (!(total > 0)) return 0;
  let labeled = 0;
  for (const s of segments) labeled += (s.endTick - s.startTick) / tickRate;
  return Math.min(1, labeled / total);
}

/**
 * The segment covering `tick`, or null when the track has a gap there.
 */
export function optionAt(segments, tick) {
  if (!segments?.length) return null;
  for (const s of segments) {
    if (tick >= s.startTick && tick < s.endTick) return s;
  }
  for (const s of segments) {
    if (tick >= s.startTick && tick <= s.endTick) return s;
  }
  return null;
}
