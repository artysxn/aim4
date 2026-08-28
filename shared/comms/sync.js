// ---------------------------------------------------------------------------
// comms/sync.js — recording time <-> demo ticks, and what is being said now
//
// The manifest timestamps everything in recording time (ms since the user hit
// record). The viewer thinks in demo ticks. One anchor joins them: the
// countdown told us which recording millisecond is round 1's freeze end, and
// the demo says which tick that is.
//
//     tick = anchorTick + (ms - anchorMs) * tickRate / 1000
//
// One anchor covers a whole map. CS2 demos tick through timeouts and pauses in
// real time, and so does a wall-clock recording, so the two never drift apart
// mid-match — which is why this is a straight line and not a per-round table.
//
// Ticks are absolute within a demo, so a session anchored on round 1 resolves
// correctly in round 22 whether or not round 1 was ever loaded into the viewer.
// ---------------------------------------------------------------------------

/** How long a caption stays up after the speaker stops, in ms. */
export const LINGER_MS = 2000;

/**
 * @typedef {object} CommsMapping
 * @property {number} anchorMs    recording ms of round 1 freeze end
 * @property {number} anchorTick  demo tick of round 1 freeze end
 * @property {number} tickRate
 * @property {number} [offsetMs]  user nudge; positive shows captions LATER
 */

/**
 * Recording time to demo tick.
 *
 * The nudge follows the convention every subtitle tool uses: positive is
 * later. Press +1s and the words appear one second further into the round.
 * The buttons in the attach dialog say only "+1s", so the direction has to be
 * the one a person assumes without being told.
 *
 * @param {CommsMapping} m
 * @param {number} ms recording time
 */
export function msToTick(m, ms) {
  return m.anchorTick + ((ms - m.anchorMs + (m.offsetMs || 0)) * m.tickRate) / 1000;
}

/**
 * The inverse of msToTick, nudge included.
 *
 * @param {CommsMapping} m
 * @param {number} tick
 */
export function tickToMs(m, tick) {
  return m.anchorMs - (m.offsetMs || 0) + ((tick - m.anchorTick) * 1000) / m.tickRate;
}

/**
 * Convert a manifest's utterances into tick space once, up front.
 *
 * Done eagerly because playback asks "who is talking now" on every frame and
 * must never do arithmetic over thousands of utterances to answer. The result
 * is sorted by start tick and carries the widest span in it, which is what
 * bounds the backward walk in utterancesAtTick.
 *
 * @param {object} manifest  a validated manifest
 * @param {CommsMapping} mapping
 * @param {(speakerIndex: number) => (string|null)} [playerFor]
 *        speaker index -> roster player id, from the saved attach mapping.
 *        Unmapped speakers are kept: the 3D sidebar can still show a coach.
 */
export function buildTimeline(manifest, mapping, playerFor = () => null) {
  const linger = (LINGER_MS * mapping.tickRate) / 1000;
  let maxSpan = 0;

  const items = (manifest.utterances || []).map((u) => {
    const startTick = msToTick(mapping, u.startMs);
    const endTick = msToTick(mapping, u.endMs);
    const span = endTick + linger - startTick;
    if (span > maxSpan) maxSpan = span;
    return {
      speaker: u.speaker,
      playerId: playerFor(u.speaker),
      text: u.text,
      conf: u.conf,
      startTick,
      endTick,
      /** When the caption should disappear. */
      fadeTick: endTick + linger
    };
  });

  items.sort((a, b) => a.startTick - b.startTick);
  return { items, maxSpan, linger, mapping };
}

/** Index of the last item starting at or before `tick`, or -1. */
function lastStartedAt(items, tick) {
  let lo = 0;
  let hi = items.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].startTick <= tick) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Everything audible or lingering at `tick`, newest first.
 *
 * Binary search to the last utterance that has started, then walk back only as
 * far as the longest utterance in the session could still reach. Speakers talk
 * over each other, so several may be live at once.
 *
 * @param {ReturnType<buildTimeline>} timeline
 * @param {number} tick
 * @param {{ speaking?: boolean }} [opts] speaking: exclude lingering captions
 */
export function utterancesAtTick(timeline, tick, { speaking = false } = {}) {
  const { items, maxSpan } = timeline;
  const out = [];
  const from = lastStartedAt(items, tick);
  for (let i = from; i >= 0; i--) {
    const it = items[i];
    // Nothing earlier than this can still be on screen.
    if (tick - it.startTick > maxSpan) break;
    const until = speaking ? it.endTick : it.fadeTick;
    if (tick <= until) out.push(it);
  }
  return out.sort((a, b) => b.startTick - a.startTick);
}

/**
 * The line to show for each speaker: what they are saying, or last said.
 *
 * The 3D sidebar has a fixed row per player and would otherwise blank out
 * between sentences, which reads as "connection lost" rather than "listening".
 * `speaking` is what drives the live dot; the text outlives it.
 *
 * @param {ReturnType<buildTimeline>} timeline
 * @param {number} tick
 * @param {number} speakerCount
 */
export function speakerLines(timeline, tick, speakerCount) {
  const rows = new Array(speakerCount).fill(null);
  let filled = 0;
  const { items } = timeline;
  for (let i = lastStartedAt(items, tick); i >= 0 && filled < speakerCount; i--) {
    const it = items[i];
    if (rows[it.speaker]) continue;
    rows[it.speaker] = {
      text: it.text,
      speaking: tick >= it.startTick && tick <= it.endTick,
      ageTicks: Math.max(0, tick - it.endTick),
      startTick: it.startTick
    };
    filled++;
  }
  return rows;
}

/**
 * Round 1's freeze-end tick, from whatever round list is to hand.
 *
 * Prefers the real round 1. Falls back to the earliest round present only when
 * that round IS round 1 under another numbering (some ingests start at 0), and
 * otherwise returns null rather than guessing: anchoring to the wrong round
 * would silently shift every caption by minutes, which is worse than asking.
 *
 * @param {Array<{round?: number, freezeEndTick?: number, startTick?: number, tickRate?: number}>} rounds
 */
export function anchorRoundFrom(rounds) {
  const list = (Array.isArray(rounds) ? rounds : []).filter(
    (r) => r && Number.isFinite(r.freezeEndTick ?? r.startTick)
  );
  if (!list.length) return null;
  const byNumber = [...list].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
  const first = byNumber[0];
  const n = first.round ?? 1;
  if (n !== 1 && n !== 0) return null;
  return {
    round: n,
    anchorTick: first.freezeEndTick ?? first.startTick,
    tickRate: first.tickRate || 64
  };
}
