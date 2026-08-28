// ---------------------------------------------------------------------------
// site/teamComms/model.js — who talks, when in the round, over many demos
//
// Inputs are things the site already stores: demo records (round timing,
// winners, economy digits), comms sidecars (sync anchor, speaker mapping)
// and comms manifests (utterances on the recording clock). This module turns
// them into round-relative talk segments and smooth per-player densities the
// Communication page can draw — the "who is talking at which part of the
// round" curves.
//
// Time inside a round is measured in seconds relative to FREEZE END: t = 0 is
// the round going live, negative seconds are freezetime. That is the axis a
// player thinks in — "the call happens in freeze, the mid-round talk at 30s".
// ---------------------------------------------------------------------------

import { msToTick } from '../../../shared/comms/sync.js';
import { teamNameKey } from '../../replays/shared/statsMath.js';
import { buyBucket } from '../../replays/shared/roundId.js';

/** The chart's time window: freezetime plus the competitive round clock. */
export const T_MIN = -25;
export const T_MAX = 115;
export const BIN_S = 1;

/** Which side of a record a team is: 1, 2, or 0 when it is not in the demo. */
export function teamIndexOf(record, teamName) {
  const want = teamNameKey(teamName || '');
  if (!want || !record) return 0;
  if (teamNameKey(record.team1?.name) === want) return 1;
  if (teamNameKey(record.team2?.name) === want) return 2;
  return 0;
}

/**
 * Per-round context from a demo record, oriented to one team.
 * Returns [] when the record does not involve that team or has no rounds.
 */
export function roundContexts(record, teamName) {
  if (!record || !Array.isArray(record.rounds)) return [];
  const teamIdx = teamIndexOf(record, teamName);
  if (!teamIdx) return [];
  const rate = record.tickRate || 64;
  return record.rounds
    .filter((r) => Number.isFinite(r.startTick) && Number.isFinite(r.freezeEndTick))
    .map((r) => ({
      demoId: record.id,
      map: record.map,
      round: r.round,
      win: r.winner === teamIdx,
      side: teamIdx === 1 ? r.team1Side : r.team2Side,
      buy: buyBucket(teamIdx === 1 ? r.econ1 : r.econ2),
      startTick: r.startTick,
      freezeEndTick: r.freezeEndTick,
      // The round is over at the official end when we have it: talk during
      // the walkout to the next freeze belongs to the round it reacts to.
      endTick: r.officialEndTick || r.endTick,
      tickRate: rate
    }));
}

/**
 * The ms -> tick mapping for one attached session, or null when the session
 * was never synced (no anchor means no honest way onto the demo clock).
 */
export function commsMapping(sidecar, record) {
  const anchorMs = sidecar?.sync?.anchorMs;
  if (!Number.isFinite(anchorMs)) return null;
  const round1 = (record?.rounds || []).find((r) => Number.isFinite(r.freezeEndTick));
  const anchorTick = Number.isFinite(sidecar.anchorTick)
    ? sidecar.anchorTick
    : round1?.freezeEndTick;
  if (!Number.isFinite(anchorTick)) return null;
  return {
    anchorMs,
    anchorTick,
    tickRate: record.tickRate || 64,
    offsetMs: sidecar.offsetMs || 0
  };
}

/**
 * Who a speaker index is: the demo's own mapping first (made in the attach
 * dialog for THIS session), the library-wide identity memory second.
 * Unmapped speakers keep an identity too — `uid:<uid>` — so a coach whose
 * voice was never linked still shows up under their TeamSpeak name.
 */
export function speakerResolver(sidecar, identities = {}) {
  const speakers = sidecar?.speakers || [];
  return (speakerIndex) => {
    const s = speakers[speakerIndex];
    if (!s) return null;
    const playerId = sidecar.mapping?.[s.uid] || identities[s.uid]?.playerId || '';
    return {
      uid: s.uid,
      nickname: s.nickname,
      playerId,
      key: playerId || `uid:${s.uid}`
    };
  };
}

/**
 * Clip a manifest's utterances onto a demo's rounds.
 *
 * @returns {Array<{ctx: object, key: string, t0: number, t1: number}>}
 *          seconds relative to each round's freeze end
 */
export function talkSegments(manifest, mapping, rounds, resolve) {
  if (!mapping || !rounds.length) return [];
  const out = [];
  for (const u of manifest.utterances || []) {
    const who = resolve(u.speaker);
    if (!who) continue;
    const st = msToTick(mapping, u.startMs);
    const et = msToTick(mapping, u.endMs);
    if (!(et > st)) continue;
    for (const ctx of rounds) {
      if (et <= ctx.startTick || st >= ctx.endTick) continue;
      const clip0 = Math.max(st, ctx.startTick);
      const clip1 = Math.min(et, ctx.endTick);
      out.push({
        ctx,
        key: who.key,
        t0: (clip0 - ctx.freezeEndTick) / ctx.tickRate,
        t1: (clip1 - ctx.freezeEndTick) / ctx.tickRate
      });
    }
  }
  return out;
}

/**
 * @typedef {object} CommsFilter
 * @property {string} [map]      map code, '' for all
 * @property {string} [side]     'T' | 'CT' | ''
 * @property {string} [result]   'win' | 'loss' | ''
 * @property {number|null} [buy] buy bucket 0-4, null for all
 * @property {number|null} [round] round number, null for all
 * @property {string} [demoId]   one demo, '' for all
 */

/** Does one round pass the page's filters? */
export function roundPasses(ctx, f = {}) {
  if (f.map && ctx.map !== f.map) return false;
  if (f.side && ctx.side !== f.side) return false;
  if (f.result === 'win' && !ctx.win) return false;
  if (f.result === 'loss' && ctx.win) return false;
  if (f.buy != null && f.buy !== '' && ctx.buy !== Number(f.buy)) return false;
  if (f.round != null && f.round !== '' && ctx.round !== Number(f.round)) return false;
  if (f.demoId && ctx.demoId !== f.demoId) return false;
  return true;
}

/** Small centered gaussian kernel, sigma in bins. */
function kernel(sigma) {
  const half = Math.max(1, Math.ceil(sigma * 3));
  const k = [];
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  return { k: k.map((v) => v / sum), half };
}

export function gaussianSmooth(values, sigma = 2) {
  const { k, half } = kernel(sigma);
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i++) {
    let acc = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= values.length) continue;
      acc += values[idx] * k[j + half];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Per-player talk density across the filtered rounds.
 *
 * Each bin holds the FRACTION of those rounds in which the player's mic was
 * live at that second — 0.4 at t=30 reads "in 40% of these rounds they were
 * talking half a minute in". Absolute, not share-of-voice: everyone quiet
 * mid-round shows as everyone low, which is itself the finding.
 *
 * @param {ReturnType<typeof talkSegments>} segments  already filtered
 * @param {number} roundCount  how many rounds passed the filter
 */
export function densitySeries(segments, roundCount, { tMin = T_MIN, tMax = T_MAX, sigma = 2 } = {}) {
  const bins = Math.ceil((tMax - tMin) / BIN_S);
  /** @type {Map<string, Float64Array>} */
  const perKey = new Map();
  for (const seg of segments) {
    let arr = perKey.get(seg.key);
    if (!arr) {
      arr = new Float64Array(bins);
      perKey.set(seg.key, arr);
    }
    const from = Math.max(tMin, seg.t0);
    const to = Math.min(tMax, seg.t1);
    if (to <= from) continue;
    // Spread the segment's seconds across the 1s bins it overlaps.
    let b = Math.floor((from - tMin) / BIN_S);
    const last = Math.min(bins - 1, Math.floor((to - tMin) / BIN_S));
    for (; b <= last; b++) {
      const binStart = tMin + b * BIN_S;
      const overlap = Math.min(to, binStart + BIN_S) - Math.max(from, binStart);
      if (overlap > 0) arr[b] += overlap;
    }
  }
  const n = Math.max(1, roundCount);
  return [...perKey.entries()].map(([key, arr]) => {
    const raw = Array.from(arr, (v) => v / (BIN_S * n));
    const smooth = gaussianSmooth(raw, sigma);
    const talkSeconds = arr.reduce((s, v) => s + v, 0);
    return { key, smooth, talkSeconds, peak: Math.max(...smooth) };
  });
}

/** m:ss for totals. */
export function fmtSeconds(s) {
  const whole = Math.round(s);
  const m = Math.floor(whole / 60);
  return `${m}:${String(whole % 60).padStart(2, '0')}`;
}
