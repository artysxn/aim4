// ---------------------------------------------------------------------------
// replays/viewer/roundClock.js
// The clock above the map. A CS2 round is not one continuous countdown, it is
// four phases, and the readout means something different in each:
//
//   freeze    buy time before the round goes live; the clock sits at 1:55
//   live      1:55 counting down to the bomb never being planted
//   planted   the countdown is replaced by the 40 second bomb timer
//             (ceil whole seconds so 39.999 -> 40; under 10s -> hundredths)
//   over      the winner is decided; the remaining ticks are the round end
//
// Everything is derived from tick numbers so the clock stays exact at any
// playback speed and never drifts against the tick data driving the droplets.
// ---------------------------------------------------------------------------

export const FREEZE_SECONDS = 3;
export const ROUND_SECONDS = 115; // 1:55
export const BOMB_SECONDS = 40;

/**
 * @typedef {object} RoundTiming
 * @property {number} tickRate
 * @property {number} startTick
 * @property {number} freezeEndTick
 * @property {number|null} plantTick
 * @property {number} endTick
 * @property {number} officialEndTick
 */

/**
 * Normalize a round record into timings the clock can trust, filling in any
 * boundary the parser could not find from the nominal phase lengths.
 */
export function timingFor(round) {
  const tickRate = round.tickRate || 64;
  const startTick = round.startTick ?? 0;
  const freezeEndTick = round.freezeEndTick ?? startTick + FREEZE_SECONDS * tickRate;
  const endTick = round.endTick ?? freezeEndTick + ROUND_SECONDS * tickRate;
  return {
    tickRate,
    startTick,
    freezeEndTick,
    plantTick: round.plantTick ?? null,
    endTick,
    officialEndTick: round.officialEndTick ?? endTick + 5 * tickRate
  };
}

export function totalTicks(timing) {
  return Math.max(1, timing.officialEndTick - timing.startTick);
}

export function totalSeconds(timing) {
  return totalTicks(timing) / timing.tickRate;
}

/**
 * Which phase a tick falls in, and what the clock reads there.
 *
 * `bombTimer` is what a SINGLE round wants and an aggregate view does not.
 * Watching one round, the plant replacing the countdown with 0:40 is the game's
 * own behaviour and the whole point. The Analyzer overlays many rounds on one
 * axis and aligns them all by `freezeEndTick + pos * tickRate`, so that axis IS
 * the round countdown and is shared by every round on screen. Reading the clock
 * off one reference round there let a plant in THAT round rewrite the shared
 * readout: at 1:10 the clock jumped to 0:40 while every other round drawn
 * beside it was still live and thirty seconds behind what the clock claimed.
 *
 * With it off the countdown simply continues, and `planted` still reports the
 * bomb is down for anything that wants to show it another way.
 *
 * @param {RoundTiming} timing
 * @param {number} tick   demo tick, may be fractional during interpolation
 * @param {{bombTimer?: boolean}} [opts]
 */
export function clockAt(timing, tick, { bombTimer = true } = {}) {
  const { tickRate, startTick, freezeEndTick, plantTick, endTick } = timing;
  const secs = (a, b) => (b - a) / tickRate;

  if (tick < freezeEndTick) {
    return {
      phase: 'freeze',
      label: formatClock(ROUND_SECONDS),
      seconds: ROUND_SECONDS,
      // How much buy time is left, for the freezetime pip.
      freezeLeft: Math.max(0, secs(tick, freezeEndTick))
    };
  }

  if (tick >= endTick) {
    // Round over: count up through the post-round so the readout keeps moving
    // while the last kill plays out.
    return {
      phase: 'over',
      label: formatClock(0),
      seconds: 0,
      overFor: Math.max(0, secs(endTick, tick))
    };
  }

  const planted = plantTick !== null && tick >= plantTick;

  if (planted && bombTimer) {
    const left = Math.max(0, BOMB_SECONDS - secs(plantTick, tick));
    return {
      phase: 'planted',
      label: formatBombClock(left),
      seconds: left,
      planted: true
    };
  }

  // Clamped at zero: a planted round runs past 1:55, and on a round-clock axis
  // "00:00" is the honest reading for that tail rather than a negative time.
  const left = ROUND_SECONDS - secs(freezeEndTick, tick);
  return {
    phase: 'live',
    label: formatClock(Math.max(0, left)),
    seconds: Math.max(0, left),
    planted
  };
}

/** "01:55" style readout for round / transport clocks. */
export function formatClock(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s - m * 60);
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/**
 * Bomb countdown. Whole seconds use ceil so 39.999 reads as 40 (not 39).
 * Under 10 seconds, show hundredths: 9.52, 0.01.
 */
export function formatBombClock(seconds) {
  const s = Math.max(0, seconds);
  if (s < 10) {
    // Floor to hundredths so 9.999 never prints as "10.00".
    return (Math.floor(s * 100) / 100).toFixed(2);
  }
  const whole = Math.min(BOMB_SECONDS, Math.ceil(s - 1e-9));
  const m = Math.floor(whole / 60);
  const rem = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

/** Phase boundaries as 0..1 fractions, for drawing markers on the scrub bar. */
export function phaseMarkers(timing) {
  const span = totalTicks(timing);
  const at = (t) => Math.max(0, Math.min(1, (t - timing.startTick) / span));
  const markers = [
    { key: 'freeze-end', at: at(timing.freezeEndTick), label: 'Live' },
    { key: 'end', at: at(timing.endTick), label: 'Round over' }
  ];
  if (timing.plantTick !== null) {
    markers.splice(1, 0, { key: 'plant', at: at(timing.plantTick), label: 'Bomb planted' });
  }
  return markers;
}
