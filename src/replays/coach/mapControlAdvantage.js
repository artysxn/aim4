// ---------------------------------------------------------------------------
// Map-control → win-chance term.
//
// Per map we store average CT/T area % at clock 01:46 (see mapControlBases.js).
// Relative possession ignores neutral:
//   relCt = 50 + (ct - t) / 2
// At the map's baseline relCt, advantage is 0. Every relative point beyond
// that becomes an exponential CT win-% shift from even (log-odds stacked).
// ---------------------------------------------------------------------------

import { MAP_CONTROL_BASE } from './mapControlBases.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';
import {
  activePositionsAt,
  latestOwnerSide,
  summarizeZoneControl
} from '../zones/zoneOverlay.js';

/** Round clock seconds remaining for the baseline sample ("01:46"). */
export const MAP_CONTROL_BASE_CLOCK_LEFT = 106;

/**
 * How strongly map control shifts win%. 3 ⇒ 3× the base exponential curve.
 */
export const MAP_CONTROL_WEIGHT = 3;

/**
 * Exponential win-pp from even for |relative possession delta| d:
 *   base f(1)=1, f(2)=2.25, f(3)≈3.81; then × MAP_CONTROL_WEIGHT.
 * f(d) = MAP_CONTROL_WEIGHT * 4 * (1.25^d - 1)
 */
export function mapControlWinPpFromDelta(deltaRel) {
  const d = Math.abs(Number(deltaRel) || 0);
  if (d < 1e-9) return 0;
  const mag = MAP_CONTROL_WEIGHT * 4 * (Math.pow(1.25, d) - 1);
  // Cap so a total steamroll cannot swamp man/econ in one term.
  const capped = Math.min(28 * MAP_CONTROL_WEIGHT, mag);
  return Math.sign(deltaRel) * capped;
}

/** Relative CT/T possession ignoring neutral (sums to 100). */
export function relativePossession(ctPct, tPct) {
  const ct = Number(ctPct) || 0;
  const t = Number(tPct) || 0;
  const bias = (ct - t) / 2;
  return { ct: 50 + bias, t: 50 - bias };
}

/** Demo tick for round-clock 01:46 (9s after freeze end), or null if invalid. */
export function tickAtMapControlBaseline(meta) {
  if (!meta) return null;
  const tickRate = meta.tickRate || 64;
  const freeze = meta.freezeEndTick ?? meta.startTick;
  if (!Number.isFinite(freeze)) return null;
  const elapsed = ROUND_SECONDS - MAP_CONTROL_BASE_CLOCK_LEFT; // 9
  const tick = freeze + elapsed * tickRate;
  const end = meta.endTick ?? tick;
  if (tick > end) return null;
  const plantedAt =
    Number.isFinite(meta.plantTick)
      ? meta.plantTick
      : meta.events?.bomb?.find((b) => b?.type === 'planted')?.tick;
  if (Number.isFinite(plantedAt) && plantedAt <= tick) return null;
  return tick;
}

/**
 * Soft+active area possession at a tick (matches early-round overlay control
 * without needing radar LoS / beam simulation).
 *
 * @returns {{ ct: number, t: number, neu: number } | null}
 */
export function possessionSharesAt({ meta, states, network, presence, tick }) {
  if (!meta || (!network?._dynGrid?.ids?.length && !network?.zones?.length)) return null;
  if (!Number.isFinite(tick)) return null;
  const active = activePositionsAt({ meta, states, network });
  /** @type {Record<string, string>} */
  const paint = {};
  const ids = network._dynGrid?.ids?.length
    ? network._dynGrid.ids
    : (network.zones || []).filter((p) => p?.id && !p.hidden).map((p) => p.id);
  for (const id of ids) {
    const tAct = active.t.has(id);
    const ctAct = active.ct.has(id);
    if (tAct && ctAct) paint[id] = 'contested-active';
    else if (tAct) paint[id] = 't-active';
    else if (ctAct) paint[id] = 'ct-active';
    else {
      const side = latestOwnerSide(presence, id, tick);
      paint[id] =
        side === 'T' ? 't-control' : side === 'CT' ? 'ct-control' : 'empty';
    }
  }
  const pct = summarizeZoneControl(network, paint).pct;
  return { ct: pct.ct, t: pct.t, neu: pct.neutral };
}

/**
 * CT-favoring win-pp from even for current possession vs map baseline.
 * @returns {{ pp: number, deltaRel: number, relCt: number, baseRelCt: number, ct: number, t: number } | null}
 */
export function mapControlAdvantage(map, ctPct, tPct) {
  const base = MAP_CONTROL_BASE[map];
  if (!base || !Number.isFinite(base.ct) || !Number.isFinite(base.t)) return null;
  if (!Number.isFinite(ctPct) || !Number.isFinite(tPct)) return null;
  const cur = relativePossession(ctPct, tPct);
  const baseRel = relativePossession(base.ct, base.t);
  const deltaRel = cur.ct - baseRel.ct;
  const pp = mapControlWinPpFromDelta(deltaRel);
  return {
    pp,
    deltaRel,
    relCt: cur.ct,
    baseRelCt: baseRel.ct,
    ct: Number(ctPct) || 0,
    t: Number(tPct) || 0
  };
}

/** True when this map has a sampled baseline (dynamic cells need no painted zones). */
export function mapControlAdvantageEnabled(map, _network = null) {
  return Boolean(MAP_CONTROL_BASE[map]);
}
