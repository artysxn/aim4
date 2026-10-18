// ---------------------------------------------------------------------------
// replays/eye/roundValue.js
// What every moment of a round was worth, in the models' own currency.
//
// aim4 eye cannot judge a play by how it feels, and it should not judge one by
// what a handbook says. This file prices it. Two numbers carry everything:
//
//   round win chance   the trained round model (rounds/roundModel.js), read
//                      before and after each event. The change is the event's
//                      swing, in percentage points, for the side that made it.
//   xK                 expected kills, in the moment. At any tick of any open
//                      gunfight the duel model gives each player a win chance
//                      for it; xK is those chances summed over every fight the
//                      player is in. In a 1v1 it IS the win chance. It is read
//                      at one tick, so a fight can be followed as it turns.
//
// Both models were fitted on the library's own rounds and outcomes, so "good"
// here means "moved the round toward a win" and "bad" means the opposite. No
// rule in this file knows what a smoke, a lurk or a rotation is. When a move
// worked, the numbers say so; when it only looked right, they say that too.
//
// valueRound walks a round once and keeps the series, so questions about one
// moment (momentAtTick) are cheap afterwards.
//
// DOM-free: the tools call it in the page, the dataset builder in Node.
// ---------------------------------------------------------------------------

import { analyseRound } from '../coach/coach.js';
import { findRoundDecided } from '../coach/roundDecided.js';
import { DUEL_MODEL_PARAMS } from '../duels/duelModelParams.js';
import { createDuelScanner } from '../duels/duelScanner.js';
import { explainRound } from '../rounds/roundExplain.js';
import { roundWinFromFeatures } from '../rounds/roundWinAdapter.js';
import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { hasControlField } from '../zones/zoneOverlay.js';
import { clockLabel } from './eyeImages.js';

/** Ticks between duel scans. A quarter second at 64 tick. */
const SCAN_STRIDE = 16;
/** How far before a kill its fight is followed, in seconds. */
const FIGHT_LOOKBACK_SECONDS = 4;
/** A kill answered by the victim's team inside this many seconds was traded. */
const TRADE_SECONDS = 5;
/** Fight win chance below / above which the kill reads as an upset / expected. */
const UPSET_BELOW = 0.35;
const FAVOURED_ABOVE = 0.65;
/** The victim's win chance when the fight opened, below / above which their death reads as behind / favoured. */
const VICTIM_BEHIND_BELOW = 30;
const VICTIM_FAVOURED_ABOVE = 55;

/**
 * How a death reads from the victim's side, from their win chance when the
 * fight opened. That is the number that says how the fight started; the one
 * just before the kill mostly says who is about to win it, which is no news.
 * The data cannot say whether the victim chose the fight or was caught in it,
 * so a bad start is "behind", not "a mistake".
 *
 * @param {number|null} winAtContact  percent
 * @returns {'behind'|'close'|'favoured'|null}
 */
export function victimRead(winAtContact) {
  if (winAtContact == null) return null;
  return winAtContact < VICTIM_BEHIND_BELOW ? 'behind' : winAtContact > VICTIM_FAVOURED_ABOVE ? 'favoured' : 'close';
}
/** A factor that moved the swing by less than this many points is not named. */
const WHY_MIN_PP = 1;
/** Seconds after a bomb event before its effect on the series is read. */
const BOMB_SETTLE_SECONDS = 0.5;
/** Seconds between points of the condensed win-chance curve. */
const CURVE_SECONDS = 10;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const signed = (n) => `${n >= 0 ? '+' : ''}${round1(n)}`;

/** First index whose tick is >= `tick`, or the last index when none is. */
function indexAtOrAfter(series, tick) {
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].tick >= tick) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The sample strictly before `tick`, or the first sample. */
function sampleBefore(series, tick) {
  const i = indexAtOrAfter(series, tick);
  return series[Math.max(0, series[i].tick >= tick ? i - 1 : i)];
}

/** The latest sample at or before `tick`, or the first sample. */
function sampleAtOrBefore(series, tick) {
  const i = indexAtOrAfter(series, tick);
  return series[Math.max(0, series[i].tick > tick ? i - 1 : i)];
}

/**
 * A sample's win chance for a side, as the model computes it at that instant.
 * The series the chart draws is smoothed over time, which lags a kill by a
 * second and halves its swing; pricing a move needs the unsmoothed reading.
 */
const winFor = (sample, side) => (side === 'CT' ? sample.ctNow : 100 - sample.ctNow);

/** Add the unsmoothed CT win chance (`ctNow`) to every sample. */
function addInstantReading(series, mapCode) {
  for (const s of series) {
    const f = s.parts?.features;
    s.ctNow = s.parts?.decided || !f ? s.ct : roundWinFromFeatures(f, mapCode, s.parts.phase, null).ct;
  }
}

/** Per-group log-odds the model assigns to CT in a sample, from its own ablation. */
function groupLogits(sample, mapCode) {
  const out = new Map();
  for (const g of explainRound(sample, mapCode)) out.set(g.label, g.logit);
  return out;
}

/**
 * The factors that moved a swing, from `side`'s point of view, largest first.
 *
 * The round model adds in log-odds, so what each group contributed is exactly
 * additive there; points are not. The change in each group's log-odds is turned
 * into points with the slope of the win curve at the middle of the swing, so
 * the factors read as pieces of the swing they sit under.
 */
function whyMoved(before, after, mapCode, side) {
  if (before?.parts?.decided || after?.parts?.decided) return [];
  const a = groupLogits(before, mapCode);
  const b = groupLogits(after, mapCode);
  const mid = (before.ctNow + after.ctNow) / 200;
  const slope = mid * (1 - mid) * 100;
  const sign = side === 'CT' ? 1 : -1;
  const rows = [];
  for (const label of new Set([...a.keys(), ...b.keys()])) {
    const delta = sign * ((b.get(label) || 0) - (a.get(label) || 0)) * slope;
    if (Math.abs(delta) >= WHY_MIN_PP) rows.push({ label, delta });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return rows.slice(0, 3).map((r) => `${r.label} ${signed(r.delta)}pp`);
}

/**
 * Walk one round and price it.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {object|null} [args.network]  prepared zone network. Without one the
 *   win chance falls back to bodies, economy and the clock, and xK is absent.
 * @param {object|null} [args.coachSmokes]
 * @returns {object|null}
 */
export function valueRound({ meta, track, network = null, coachSmokes = null }) {
  if (!meta?.players?.length || !track) return null;
  const mapCode = meta.map || '';
  const timing = timingFor(meta);
  const tickRate = timing.tickRate;
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const byId = new Map(meta.players.map((p) => [p.id, p]));
  const nameOf = (id) => byId.get(id)?.name || id || 'World';
  const sideOf = (id) => teamSides[byId.get(id)?.team] || '';
  const teamName = (team) => (team === 1 ? meta.team1?.name : meta.team2?.name) || `Team ${team}`;
  const secondsLeftAt = (tick) => ROUND_SECONDS - (tick - timing.freezeEndTick) / tickRate;
  const clockAt = (tick) => clockLabel(secondsLeftAt(tick));
  /** The clock to a tenth of a second, for following a fight. */
  const preciseClockAt = (tick) => {
    const left = Math.max(0, secondsLeftAt(tick));
    const tenths = Math.round(left * 10);
    return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}.${tenths % 10}`;
  };

  const scratch = [];
  const analysis = analyseRound({
    meta,
    track,
    network,
    coachSmokes,
    sampleAt: (tick) => {
      track.sampleAll(tick, scratch);
      return scratch;
    },
    duelsAt: null
  });
  const series = analysis?.series || [];
  if (!series.length) return null;
  addInstantReading(series, mapCode);

  const xkAvailable = Boolean(network && hasControlField(network) && DUEL_MODEL_PARAMS.trainedOn > 0);
  const kills = [...(meta.events?.kills || [])]
    .filter((k) => k.victim && k.tick >= timing.freezeEndTick)
    .sort((a, b) => a.tick - b.tick);

  // One forward pass over every tick any fight is read at: the scanner builds
  // its memory of who saw whom by walking in order, so asking out of order
  // would rebuild it for every kill.
  const scans = new Map();
  if (xkAvailable) {
    const wanted = new Set();
    for (const k of kills) {
      const last = Math.floor((k.tick - 8) / SCAN_STRIDE) * SCAN_STRIDE;
      for (let t = last - FIGHT_LOOKBACK_SECONDS * tickRate; t <= last; t += SCAN_STRIDE) {
        if (t >= timing.freezeEndTick) wanted.add(t);
      }
    }
    const scanner = createDuelScanner({ stride: SCAN_STRIDE });
    for (const tick of [...wanted].sort((a, b) => a - b)) {
      scans.set(tick, scanner.at({ meta, track, tick, network, mapCode, roundKey: meta.id || 'round' }));
    }
  }

  /** The killer's win chance against the victim at one scan, or null if no open fight between them. */
  const pairWin = (duels, killerSlot, victimSlot) => {
    for (const d of duels || []) {
      if (d.aSlot === killerSlot && d.bSlot === victimSlot) return d.pa;
      if (d.aSlot === victimSlot && d.bSlot === killerSlot) return 1 - d.pa;
    }
    return null;
  };
  /** xK of one slot at a scan: its win chance summed over every open fight it is in. */
  const xkOf = (duels, slot) => {
    let sum = 0;
    let fighting = false;
    for (const d of duels || []) {
      if (d.aSlot === slot) sum += d.pa;
      else if (d.bSlot === slot) sum += 1 - d.pa;
      else continue;
      fighting = true;
    }
    return fighting ? sum : null;
  };

  function fightBefore(kill) {
    if (!xkAvailable) return null;
    const killerSlot = byId.get(kill.attacker)?.slot;
    const victimSlot = byId.get(kill.victim)?.slot;
    if (killerSlot == null || victimSlot == null) return null;
    const last = Math.floor((kill.tick - 8) / SCAN_STRIDE) * SCAN_STRIDE;
    const first = last - FIGHT_LOOKBACK_SECONDS * tickRate;
    const trace = [];
    for (let t = first; t <= last; t += SCAN_STRIDE) {
      const p = pairWin(scans.get(t), killerSlot, victimSlot);
      if (p !== null) trace.push({ tick: t, p });
    }
    // xK is read at the latest scan, within the last second, in which either of them was fighting.
    let killerXk = null;
    let victimXk = null;
    for (let t = last; t > last - tickRate && killerXk === null && victimXk === null; t -= SCAN_STRIDE) {
      killerXk = xkOf(scans.get(t), killerSlot);
      victimXk = xkOf(scans.get(t), victimSlot);
    }
    if (!trace.length && killerXk === null && victimXk === null) return null;
    // The fight is the unbroken run of scans, ending now, in which the pair could see each other.
    let start = trace.length - 1;
    while (start > 0 && trace[start].tick - trace[start - 1].tick <= SCAN_STRIDE * 2) start--;
    const run = trace.slice(Math.max(0, start));
    // The label is read off the rounded number the model is shown, so the two can never disagree.
    const lastPct = run.length ? Math.round(run[run.length - 1].p * 100) : null;
    const contactPct = run.length ? Math.round(run[0].p * 100) : null;
    return {
      killer_win_at_contact: contactPct,
      killer_win_before_kill: lastPct,
      killer_read: lastPct === null ? null : lastPct < UPSET_BELOW * 100 ? 'upset' : lastPct > FAVOURED_ABOVE * 100 ? 'favoured' : 'even',
      // The victim's side of the same numbers, so nobody has to subtract or flip a perspective.
      victim_win_at_contact: contactPct === null ? null : 100 - contactPct,
      victim_win_before_kill: lastPct === null ? null : 100 - lastPct,
      victim_read: victimRead(contactPct === null ? null : 100 - contactPct),
      killer_xk: killerXk === null ? null : round2(killerXk),
      victim_xk: victimXk === null ? null : round2(victimXk),
      // The fight as it turned: killer win% at each quarter second the pair could see each other.
      trace: run.map((r) => `${preciseClockAt(r.tick)} ${Math.round(r.p * 100)}%`).slice(-8)
    };
  }

  const moments = [];
  const ledger = new Map(meta.players.map((p) => [p.id, { player: p.name, side: teamSides[p.team], kills: 0, deaths: 0, wpa_pp: 0, fightWins: [] }]));

  for (const kill of kills) {
    const killerSide = sideOf(kill.attacker);
    const victimSide = sideOf(kill.victim);
    // The acting side is the killer's. A death with no killer (fall, world) is the victim's side losing ground.
    const side = killerSide || (victimSide === 'CT' ? 'T' : 'CT');
    const before = sampleBefore(series, kill.tick);
    const after = series[indexAtOrAfter(series, kill.tick)];
    const swing = winFor(after, side) - winFor(before, side);
    const fight = fightBefore(kill);
    const tradedBy = kills.find(
      (k) => k.attacker && k.victim === kill.attacker && k.tick > kill.tick && k.tick - kill.tick <= TRADE_SECONDS * tickRate && sideOf(k.attacker) === victimSide
    );
    moments.push({
      tick: kill.tick,
      clock: clockAt(kill.tick),
      event: 'kill',
      side,
      killer: kill.attacker ? nameOf(kill.attacker) : null,
      victim: nameOf(kill.victim),
      text: `${nameOf(kill.attacker)} (${killerSide || '?'}) killed ${nameOf(kill.victim)} (${victimSide}) with ${kill.weapon}${kill.headshot ? ' (headshot)' : ''}`,
      swing_pp: round1(swing),
      win_chance: { before: Math.round(winFor(before, side)), after: Math.round(winFor(after, side)) },
      alive_after: `CT ${after.ctAlive}, T ${after.tAlive}`,
      why: whyMoved(before, after, mapCode, side),
      traded_by: tradedBy ? `${nameOf(tradedBy.attacker)} after ${round1((tradedBy.tick - kill.tick) / tickRate)}s` : null,
      fight
    });
    const k = ledger.get(kill.attacker);
    const v = ledger.get(kill.victim);
    if (k) {
      k.kills++;
      k.wpa_pp += swing;
      if (fight?.killer_win_before_kill != null) k.fightWins.push(fight.killer_win_before_kill);
    }
    if (v) {
      v.deaths++;
      v.wpa_pp -= swing;
      if (fight?.killer_win_before_kill != null) v.fightWins.push(100 - fight.killer_win_before_kill);
    }
  }

  for (const b of meta.events?.bomb || []) {
    if (b.type !== 'planted' && b.type !== 'defused') continue;
    const side = b.type === 'planted' ? 'T' : 'CT';
    const before = sampleBefore(series, b.tick);
    const after = series[indexAtOrAfter(series, b.tick + BOMB_SETTLE_SECONDS * tickRate)];
    moments.push({
      tick: b.tick,
      clock: clockAt(b.tick),
      event: b.type === 'planted' ? 'plant' : 'defuse',
      side,
      text: `${nameOf(b.player)} ${b.type === 'planted' ? 'planted' : 'defused'} the bomb${b.site ? ` on ${b.site}` : ''}`,
      swing_pp: round1(winFor(after, side) - winFor(before, side)),
      win_chance: { before: Math.round(winFor(before, side)), after: Math.round(winFor(after, side)) },
      alive_after: `CT ${after.ctAlive}, T ${after.tAlive}`,
      why: whyMoved(before, after, mapCode, side),
      traded_by: null,
      fight: null
    });
  }
  moments.sort((a, b) => a.tick - b.tick);

  // The coach's own flags, priced: what the side's win chance did across each.
  const flags = (analysis.flags || []).map((f) => {
    const side = sideOf(f.playerId);
    const before = sampleBefore(series, f.tick);
    const after = series[indexAtOrAfter(series, f.tick + 2 * tickRate)];
    return {
      tick: f.tick,
      clock: clockAt(f.tick),
      player: nameOf(f.playerId),
      side,
      rule: f.rule,
      category: f.category || '',
      text: f.text,
      cost_pp: side ? round1(winFor(after, side) - winFor(before, side)) : null
    };
  });

  const players = [...ledger.values()]
    .filter((p) => p.kills || p.deaths)
    .map((p) => ({
      player: p.player,
      side: p.side,
      kills: p.kills,
      deaths: p.deaths,
      wpa_pp: round1(p.wpa_pp),
      // How favourable the fights this player's kills and deaths came out of were, on average, for them.
      avg_fight_win_pct: p.fightWins.length ? Math.round(p.fightWins.reduce((a, b) => a + b, 0) / p.fightWins.length) : null
    }))
    .sort((a, b) => b.wpa_pp - a.wpa_pp);

  const open = series[0];
  const end = series[series.length - 1];
  const winnerSide = meta.winnerSide || teamSides[meta.winner] || '';
  const curve = [];
  let nextAt = timing.freezeEndTick;
  for (const s of series) {
    if (s.tick < nextAt) continue;
    curve.push(`${clockAt(s.tick)} CT ${Math.round(s.ctNow)}%`);
    nextAt = s.tick + CURVE_SECONDS * tickRate;
  }
  const decided = findRoundDecided(meta);
  const summary = {
    map: meta.mapName || mapCode,
    round: meta.round,
    teams: `${teamName(1)} (${teamSides[1]}) vs ${teamName(2)} (${teamSides[2]})`,
    winner: winnerSide ? `${winnerSide}${meta.winner ? ` (${teamName(meta.winner)})` : ''}` : null,
    opening_ct_win_pct: Math.round(open.ctNow),
    closing_ct_win_pct: Math.round(end.ctNow),
    decided_at: decided ? { clock: clockAt(decided.tick), side: decided.side } : null,
    planted_at: meta.plantTick ? clockAt(meta.plantTick) : null,
    xk_available: xkAvailable,
    curve
  };

  return { meta, track, network, mapCode, timing, series, summary, moments, flags, players, xkAvailable, clockAt, nameOf, sideOf, byId };
}

/** A moment as the model reads it: the clock names it, so the tick is dropped. */
export const publicMoment = ({ tick, ...rest }) => rest;

/**
 * The biggest swings of a valued round, ordered by size.
 * @param {object} value  from valueRound
 * @param {number} [n]
 */
export function topSwings(value, n = 8) {
  return [...value.moments]
    .sort((a, b) => Math.abs(b.swing_pp) - Math.abs(a.swing_pp))
    .slice(0, n)
    .sort((a, b) => a.tick - b.tick)
    .map(publicMoment);
}

/**
 * One tick of a valued round: the win chance and what makes it up, who is in
 * a fight with whom, and each fighter's xK at exactly this tick.
 *
 * @param {object} value  from valueRound
 * @param {number} tick
 */
export function momentAtTick(value, tick) {
  const { series, meta, track, network, mapCode, timing } = value;
  const sample = sampleAtOrBefore(series, tick);
  const lines = explainRound(sample, mapCode).map((g) => `${g.label}: ${g.pp >= 0 ? 'CT' : 'T'} ${round1(Math.abs(g.pp))}pp`);
  const out = {
    clock: value.clockAt(tick),
    ct_win_pct: Math.round(sample.ctNow),
    t_win_pct: Math.round(100 - sample.ctNow),
    alive: { CT: sample.ctAlive, T: sample.tAlive },
    decided: sample.parts?.decided || null,
    what_makes_it_up: sample.parts?.decided ? [`Round already decided for ${sample.parts.decided}`] : lines,
    open_fights: [],
    xk: []
  };
  if (!value.xkAvailable) return out;

  const scanner = createDuelScanner({ stride: SCAN_STRIDE });
  const duels = scanner.at({ meta, track, tick: Math.max(timing.freezeEndTick, tick), network, mapCode, roundKey: `${meta.id || 'round'}:moment` });
  const xk = new Map();
  for (const d of duels) {
    out.open_fights.push({
      a: `${value.nameOf(slotId(meta, d.aSlot))} (${d.aSide})`,
      b: `${value.nameOf(slotId(meta, d.bSlot))} (${d.bSide})`,
      a_win_pct: Math.round(d.pa * 100),
      b_win_pct: Math.round((1 - d.pa) * 100),
      distance: Math.round(d.dist)
    });
    xk.set(d.aSlot, (xk.get(d.aSlot) || 0) + d.pa);
    xk.set(d.bSlot, (xk.get(d.bSlot) || 0) + 1 - d.pa);
  }
  const bySlot = new Map(meta.players.map((p) => [p.slot, p]));
  out.xk = [...xk.entries()]
    .map(([slot, v]) => ({ player: bySlot.get(slot)?.name || String(slot), side: value.sideOf(bySlot.get(slot)?.id), xk: round2(v) }))
    .sort((a, b) => b.xk - a.xk);
  return out;
}

const slotId = (meta, slot) => meta.players.find((p) => p.slot === slot)?.id;

/** Moments a round_value answer lists unless asked for more. */
export const DEFAULT_MOMENTS = 8;
export const MAX_MOMENTS = 25;
/** Coach flags a round_value answer lists: the costliest ones. */
const MAX_FLAGS = 6;

export const NO_GEOMETRY =
  'This map has no geometry here, so fights carry no xK and the win chance reads bodies, equipment and the clock only.';

/**
 * What the round_value tool returns for a priced round.
 *
 * @param {object} value  from valueRound
 * @param {number} [moments]  how many of the biggest swings to list
 */
export function roundValueReport(value, moments = DEFAULT_MOMENTS) {
  const n = Math.max(1, Math.min(MAX_MOMENTS, Math.round(Number(moments) || DEFAULT_MOMENTS)));
  const flags = [...value.flags]
    .filter((f) => f.cost_pp !== null)
    .sort((a, b) => a.cost_pp - b.cost_pp)
    .slice(0, MAX_FLAGS)
    .sort((a, b) => a.tick - b.tick)
    .map(({ tick, ...rest }) => rest);
  const out = {
    ...value.summary,
    biggest_swings: topSwings(value, n),
    costliest_flags: flags,
    players: value.players,
    how_to_read:
      "swing_pp is the change in the acting side's round win chance, in percentage points. In fight, killer_* fields are the killer's win chance in that gunfight and victim_* the victim's (they add to 100). killer_read: upset (killer under 35 just before the kill), even, or favoured (over 65). victim_read judges the death from the victim's win chance when the fight opened: behind (under 30, a losing fight from the start), close, or favoured (over 55, losing it was variance, not a mistake). xK is the sum of a player's win chances over the fights they are in. wpa_pp credits each kill's swing to the killer and takes it from the victim."
  };
  if (!value.xkAvailable) out.note = NO_GEOMETRY;
  return out;
}

/** The round clock (seconds left) as a tick of a valued round. */
export function tickAtClock(value, secondsLeft) {
  const seconds = Math.max(0, Math.min(ROUND_SECONDS, secondsLeft));
  return Math.round(value.timing.freezeEndTick + (ROUND_SECONDS - seconds) * value.timing.tickRate);
}

/**
 * What the moment_value tool returns for a clock time of a priced round.
 *
 * @param {object} value  from valueRound
 * @param {number} secondsLeft
 */
export function momentReport(value, secondsLeft) {
  const out = momentAtTick(value, tickAtClock(value, secondsLeft));
  if (!value.xkAvailable) out.note = NO_GEOMETRY;
  return out;
}
