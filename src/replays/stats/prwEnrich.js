// ---------------------------------------------------------------------------
// replays/stats/prwEnrich.js
// Predicted round winrate (PRW) averages and per-player swing from kill/damage
// logs. DOM-free so the stats index can run it in Node.
// ---------------------------------------------------------------------------

import { winSeriesFromMeta } from '../coach/roundDecided.js';
import { deadPlayersAt } from '../coach/winProbability.js';
import { phaseBounds } from '../coach/roundPhases.js';
import { roundWinAtTick } from '../rounds/roundWinAdapter.js';
import { possessionSharesAt } from '../coach/mapControlAdvantage.js';

/** Seconds between PRW / possession samples. */
export const PRW_SAMPLE_SECONDS = 4;

const NOT_A_GUN =
  /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

function isGun(weapon) {
  const w = String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
  return Boolean(w) && !NOT_A_GUN.test(w);
}

/**
 * Mean PRW for team 1 / team 2 from a 1 Hz kill-log series, subsampled every
 * PRW_SAMPLE_SECONDS. Returns nulls when the series is empty.
 *
 * @param {object} meta
 * @param {Array<{ct:number,t:number}>} [series]
 * @returns {{ prw1: number|null, prw2: number|null, samples: number }}
 */
export function averagePrwFromMeta(meta, series = null) {
  const samples = series || winSeriesFromMeta(meta);
  if (!samples.length) return { prw1: null, prw2: null, samples: 0 };
  const stride = Math.max(1, PRW_SAMPLE_SECONDS);
  let sum1 = 0;
  let sum2 = 0;
  let n = 0;
  const s1 = meta.team1Side || 'T';
  const s2 = meta.team2Side || 'CT';
  for (let i = 0; i < samples.length; i += stride) {
    const s = samples[i];
    const t1 = s1 === 'CT' ? s.ct : s.t;
    const t2 = s2 === 'CT' ? s.ct : s.t;
    if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
    sum1 += t1;
    sum2 += t2;
    n++;
  }
  if (!n) return { prw1: null, prw2: null, samples: 0 };
  return { prw1: sum1 / n, prw2: sum2 / n, samples: n };
}

/** Win% that opens a model advantage. */
export const ADVANTAGE_ENTER = 51;
/** Win% that closes (chokes) an open advantage. */
export const ADVANTAGE_EXIT = 50;

/**
 * Count advantage episodes for one side on a win% series.
 * An advantage starts when win% crosses above 51, and chokes if it later
 * falls below 50 before the round ends (held to the end = converted).
 *
 * @param {Array<{ct:number,t:number}>} series
 * @param {'CT'|'T'} side
 * @returns {{ advantages: number, chokes: number }}
 */
export function advantageChokeForSide(series, side) {
  let advantages = 0;
  let chokes = 0;
  let inAdv = false;
  const key = side === 'CT' ? 'ct' : 't';
  for (const s of series || []) {
    const wp = s?.[key];
    if (!Number.isFinite(wp)) continue;
    if (!inAdv && wp > ADVANTAGE_ENTER) {
      inAdv = true;
      advantages += 1;
    } else if (inAdv && wp < ADVANTAGE_EXIT) {
      chokes += 1;
      inAdv = false;
    }
  }
  return { advantages, chokes };
}

/**
 * Advantage / choke counters for team 1 and team 2.
 * @param {object} meta
 * @param {Array<{ct:number,t:number}>} [series]
 */
export function advantageChokeFromMeta(meta, series = null) {
  const samples = series || winSeriesFromMeta(meta);
  const s1 = meta?.team1Side === 'CT' ? 'CT' : 'T';
  const s2 = meta?.team2Side === 'CT' ? 'CT' : 'T';
  const a1 = advantageChokeForSide(samples, s1);
  const a2 = advantageChokeForSide(samples, s2);
  return {
    aca1: a1.advantages,
    ack1: a1.chokes,
    aca2: a2.advantages,
    ack2: a2.chokes
  };
}

/**
 * WP for one side at a tick, using kill-log deaths + optional HP map.
 * @returns {{ ct: number, t: number } | null}
 */
function wpSidesAt(meta, tick, deadIds, healthById = null, bounds = null) {
  if (!meta) return null;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const winnerSide =
    meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const endTick = meta.endTick ?? meta.freezeEndTick ?? 0;

  let maxSlot = 0;
  for (const p of players) {
    if (Number.isFinite(p.slot) && p.slot > maxSlot) maxSlot = p.slot;
  }
  const states = new Array(maxSlot + 1).fill(null);
  for (const p of players) {
    if (p.slot == null) continue;
    const alive = !deadIds.has(p.id);
    const hp = healthById?.has(p.id) ? healthById.get(p.id) : 100;
    states[p.slot] = { alive, health: alive ? Math.max(1, hp) : 0 };
  }

  // No tick buffer here by design: this path walks the kill log so a whole
  // library can be indexed without decoding positions. The model reads that as
  // missing geometry and falls back to bodies, economy, the clock and the
  // plant, which is exactly the information this call site ever had.
  const wp = roundWinAtTick({ meta, states, tick, bounds });
  return wp ? { ct: wp.ct, t: wp.t } : null;
}

function sideWp(wp, side) {
  if (!wp) return null;
  return side === 'CT' ? wp.ct : wp.t;
}

function teamSide(meta, team) {
  return team === 1 ? meta.team1Side || 'T' : meta.team2Side || 'CT';
}

/**
 * Per-player PRW swing for one round (kill + non-lethal gun damage).
 * @param {object} meta
 * @returns {Record<string, number>}
 */
export function playerSwingFromMeta(meta) {
  /** @type {Record<string, number>} */
  const sw = {};
  if (!meta?.players?.length) return sw;

  // Computed once: phaseBounds sorts the kill log, and this walks one entry per
  // kill and per damage event, so recomputing it per call would be quadratic.
  const bounds = phaseBounds(meta);
  const teamOf = new Map((meta.players || []).map((p) => [p.id, p.team]));
  const kills = [...(meta.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const damages = [...(meta.events?.damage || [])]
    .filter((d) => d?.attacker && d?.victim && isGun(d.weapon))
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  const killTicks = new Set(kills.map((k) => `${k.victim}|${k.tick || 0}`));

  const add = (id, delta) => {
    if (!id || !Number.isFinite(delta) || Math.abs(delta) < 1e-6) return;
    sw[id] = (sw[id] || 0) + delta;
  };

  for (const k of kills) {
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;
    const tick = Number(k.tick) || 0;
    const beforeDead = deadPlayersAt(kills, tick - 1);
    const afterDead = new Set(beforeDead);
    afterDead.add(k.victim);
    const before = wpSidesAt(meta, Math.max(0, tick - 1), beforeDead, null, bounds);
    const after = wpSidesAt(meta, tick, afterDead, null, bounds);
    if (!before || !after) continue;
    const aSide = teamSide(meta, at);
    const vSide = teamSide(meta, vt);
    const dAtt = sideWp(after, aSide) - sideWp(before, aSide);
    const dVic = sideWp(after, vSide) - sideWp(before, vSide);
    add(k.attacker, dAtt);
    add(k.victim, dVic);
  }

  /** @type {Map<string, number>} cumulative HP removed (capped at 99 so they stay "alive") */
  const dmgTaken = new Map();
  for (const d of damages) {
    const tick = Number(d.tick) || 0;
    const key = `${d.victim}|${tick}`;
    // Lethal damage is credited via the kill event.
    if (killTicks.has(key)) continue;
    const at = teamOf.get(d.attacker);
    const vt = teamOf.get(d.victim);
    if (!at || !vt || at === vt) continue;
    if (deadPlayersAt(kills, tick).has(d.victim)) continue;

    const hp = Math.max(0, Number(d.hp) || 0);
    if (hp < 1) continue;

    const healthBefore = new Map();
    for (const p of meta.players) {
      const taken = dmgTaken.get(p.id) || 0;
      healthBefore.set(p.id, Math.max(1, 100 - taken));
    }
    const prevTaken = dmgTaken.get(d.victim) || 0;
    const healthAfter = new Map(healthBefore);
    const nextTaken = Math.min(99, prevTaken + hp);
    healthAfter.set(d.victim, Math.max(1, 100 - nextTaken));
    dmgTaken.set(d.victim, nextTaken);

    const dead = deadPlayersAt(kills, tick);
    const before = wpSidesAt(meta, tick, dead, healthBefore, bounds);
    const after = wpSidesAt(meta, tick, dead, healthAfter, bounds);
    if (!before || !after) continue;
    const aSide = teamSide(meta, at);
    const vSide = teamSide(meta, vt);
    add(d.attacker, sideWp(after, aSide) - sideWp(before, aSide));
    add(d.victim, sideWp(after, vSide) - sideWp(before, vSide));
  }

  return sw;
}

/**
 * PRW averages + swing bag + advantage-choke counters for one round meta.
 * @param {object} meta
 */
export function enrichPrwAndSwing(meta) {
  const series = winSeriesFromMeta(meta);
  const { prw1, prw2 } = averagePrwFromMeta(meta, series);
  const ac = advantageChokeFromMeta(meta, series);
  const sw = playerSwingFromMeta(meta);
  return { prw1, prw2, sw, ...ac };
}

/**
 * Mean soft+active possession for team 1 / 2 over the live phase, sampled
 * every PRW_SAMPLE_SECONDS. Requires a prepared control field + presence.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {{ sampleAll: Function }} args.track
 * @param {object} args.network
 * @param {object} args.presence
 * @returns {{ pos1: number|null, pos2: number|null, samples: number }}
 */
export function averagePossessionOverRound({ meta, track, network, presence }) {
  if (!meta || !track || !network || !presence) {
    return { pos1: null, pos2: null, samples: 0 };
  }
  const tickRate = meta.tickRate || 64;
  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const end = Math.max(from, meta.endTick ?? from);
  const step = PRW_SAMPLE_SECONDS * tickRate;
  const s1 = meta.team1Side || 'T';
  const s2 = meta.team2Side || 'CT';
  const scratch = [];
  let sum1 = 0;
  let sum2 = 0;
  let n = 0;
  for (let tick = from; tick <= end; tick += step) {
    track.sampleAll(tick, scratch);
    const shares = possessionSharesAt({
      meta,
      states: scratch,
      network,
      presence,
      tick
    });
    if (!shares) continue;
    const p1 = s1 === 'CT' ? shares.ct : shares.t;
    const p2 = s2 === 'CT' ? shares.ct : shares.t;
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue;
    sum1 += p1;
    sum2 += p2;
    n++;
  }
  if (!n) return { pos1: null, pos2: null, samples: 0 };
  return { pos1: sum1 / n, pos2: sum2 / n, samples: n };
}
