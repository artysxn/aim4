// ---------------------------------------------------------------------------
// replays/eye/roundScout.js
// Finding rounds by anything a coach asks for, in one call.
//
// "5 full buy rounds against better ranked teams" took the model 14 calls on
// 17 Oct, and "find rounds where..." went through find_rounds, then a timeline
// per round, until the context was full. scout_rounds answers it in one: the
// question is checked from the cheapest read to the dearest, and a round is only
// read as deep as the question needs:
//
//   names      map, teams, players, buys, who won, round number: in the file name
//   sides      who was T, dominance: one request per few hundred rounds
//   grenades   where each landed, for a drawn region: one request per few hundred rounds
//   record     the kills, the plant, how it ended: one request per round
//   positions  where they stood, the kind of hit: two requests per round
//
// This file is the question and the answers about one record: what can be asked,
// and whether a round's record fits. eyeTools.js runs it against the library.
// Pure, so it is tested without one.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { NADE_KINDS, normNade } from '../analytics/antistratScan.js';
import { parseClock } from './eyeImages.js';
import { inRegion } from './mapRegions.js';
import { elapsedOfClock, grenadeOnly, normalizeCondition } from './roundQuery.js';
import { aliveGaps, gapFits, sideOfTeam, winnerSide } from './roundSample.js';

export class ScoutError extends Error {}

/** The stored buy buckets a word stands for (shared/roundId.js): 0 pistol, 1 eco, 2 half, 3 force, 4 full. */
const BUY_WORDS = { pistol: [0], eco: [1], half: [2], force: [3], full: [4], low: [1, 2, 3], bought: [2, 3, 4], any: null };
const BUY_NAMES = ['pistol', 'eco', 'half', 'force', 'full'];
export const HIT_KINDS = ['execute', 'split', 'rush', 'contact', 'no-hit'];
const ENDINGS = ['elimination', 'bomb', 'defuse', 'time'];
const KNOWN = new Set([
  'map', 'team', 'opponent', 'player', 'side', 'buy', 'vs_buy', 'result', 'winner', 'dominance', 'gap', 'prefer',
  'first_kill', 'first_kill_by', 'plant', 'plant_by', 'ended_by', 'kills', 'awp', 'round_from', 'round_to',
  'date_from', 'date_to', 'rank_own', 'rank_opp', 'not_in_playlist', 'where', 'hit', 'site', 'sort', 'count', 'more', 'describe'
]);

/** "full", "eco,force", ["eco","force"], "low" -> the buckets, or null for any. */
export function parseBuys(value, name = 'buy') {
  if (value === undefined || value === null || value === '') return null;
  const words = (Array.isArray(value) ? value : String(value).split(/[,/+]| or /)).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  const out = new Set();
  for (const w of words) {
    if (w === 'any') return null;
    const buckets = BUY_WORDS[w.replace(/ buy$/, '')];
    if (!buckets) throw new ScoutError(`Unknown ${name} "${w}". Use full, force, half, eco, pistol, low (eco, half or force), bought (half, force or full), or several joined by commas.`);
    for (const b of buckets) out.add(b);
  }
  return out.size ? out : null;
}

/** 90, "90+", "80-100", {"min":90,"max":100} -> { min, max }, or null. */
export function parseRange(value, name = 'dominance') {
  if (value === undefined || value === null || value === '') return null;
  let min = 0;
  let max = 100;
  if (typeof value === 'number') min = value;
  else if (typeof value === 'object') {
    min = Number(value.min ?? 0);
    max = Number(value.max ?? 100);
  } else {
    const m = /^\s*(\d+)\s*(\+|-\s*(\d+))?\s*$/.exec(String(value));
    if (!m) throw new ScoutError(`${name} is a number from 0 to 100, or a range like {"min":90} or {"min":0,"max":40}.`);
    min = Number(m[1]);
    max = m[3] !== undefined ? Number(m[3]) : 100;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new ScoutError(`${name} is a number from 0 to 100, or a range like {"min":90} or {"min":0,"max":40}.`);
  return { min, max };
}

/** "1:20" -> 80 seconds left on the clock. */
function clockLeft(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const left = parseClock(value);
  if (left === null || left === undefined || !Number.isFinite(left)) throw new ScoutError(`${name} is a round clock like "1:20".`);
  return left;
}

/**
 * The question, checked and in one shape. An argument this tool does not know is refused: left
 * out, the rounds come back looking as if they fit (19 Oct: a gap that checked nothing).
 */
export function parseScout(args = {}) {
  const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
  if (unknown.length) throw new ScoutError(`scout_rounds has no "${unknown.join('", "')}". Conditions on positions and utility go in where; what it knows: ${[...KNOWN].join(', ')}.`);
  const side = args.side ? String(args.side).toUpperCase() : '';
  if (side && side !== 'ANY' && side !== 'T' && side !== 'CT') throw new ScoutError('side is "T" or "CT".');
  let result = args.result ? String(args.result).toLowerCase() : '';
  let winner = args.winner ? String(args.winner) : '';
  // Said the other way round: the team won.
  if (winner === 'team') [winner, result] = ['', 'won'];
  else if (winner === 'opponent') [winner, result] = ['', 'lost'];
  winner = winner.toUpperCase();
  if (winner === 'ANY') winner = '';
  if (result === 'any') result = '';
  if (result && result !== 'won' && result !== 'lost') throw new ScoutError('result is "won" or "lost".');
  if (winner && winner !== 'T' && winner !== 'CT') throw new ScoutError('winner is "T" or "CT"; for the team named, use result.');
  const gap = args.gap && (Number.isFinite(args.gap.never_below) || Number.isFinite(args.gap.reaches)) ? args.gap : null;
  if (args.gap && !gap) throw new ScoutError('gap needs never_below or reaches. never_below 0: never fewer players alive than the other side (never 4v5); -1: never two fewer (never 3v5); reaches 2: two more at some point (5v3).');
  const firstKill = args.first_kill ? String(args.first_kill).toLowerCase() : '';
  if (firstKill && firstKill !== 'team' && firstKill !== 'opponent') throw new ScoutError('first_kill is "team" (the side asked about got it) or "opponent".');
  let plant = args.plant ?? null;
  if (typeof plant === 'string') {
    const p = plant.trim().toUpperCase();
    if (p === 'TRUE' || p === 'YES') plant = true;
    else if (p === 'FALSE' || p === 'NO') plant = false;
    else if (p === 'A' || p === 'B') plant = p;
    else throw new ScoutError('plant is true, false, "A" or "B".');
  }
  const endedBy = args.ended_by ? String(args.ended_by).toLowerCase() : '';
  if (endedBy && !ENDINGS.includes(endedBy)) throw new ScoutError(`ended_by is ${ENDINGS.join(', ')}.`);
  const hit = args.hit ? String(args.hit).toLowerCase() : '';
  if (hit && !HIT_KINDS.includes(hit)) throw new ScoutError(`hit is ${HIT_KINDS.join(', ')}.`);
  const site = args.site ? String(args.site).toUpperCase() : '';
  if (site && site !== 'A' && site !== 'B') throw new ScoutError('site is "A" or "B".');
  const sort = args.sort ? String(args.sort).toLowerCase() : 'random';
  if (!['random', 'dominance', 'newest'].includes(sort)) throw new ScoutError('sort is random, dominance or newest.');
  const awp = args.awp ? String(args.awp).toLowerCase() : '';
  if (awp && !['team', 'opponent', 'both', 'none'].includes(awp)) throw new ScoutError('awp is team, opponent, both or none.');
  if (args.where !== undefined && !Array.isArray(args.where)) throw new ScoutError('where is a list of conditions, as in query_rounds.');
  const given = Array.isArray(args.where) ? args.where : [];
  return {
    map: args.map || '',
    team: args.team || '',
    opponent: args.opponent || '',
    player: args.player || '',
    side: side === 'ANY' ? '' : side,
    buy: parseBuys(args.buy, 'buy'),
    vsBuy: parseBuys(args.vs_buy, 'vs_buy'),
    result,
    winner,
    dominance: parseRange(args.dominance),
    gap,
    grace: args.gap?.grace != null && Number.isFinite(Number(args.gap.grace)) ? Math.max(0, Number(args.gap.grace)) : 2,
    prefer: Boolean(args.prefer),
    firstKill,
    firstKillBy: clockLeft(args.first_kill_by, 'first_kill_by'),
    plant,
    plantBy: clockLeft(args.plant_by, 'plant_by'),
    endedBy,
    kills: args.kills && typeof args.kills === 'object' ? { player: String(args.kills.player || ''), min: Math.max(1, Number(args.kills.min) || 1) } : null,
    awp,
    roundFrom: Number.isFinite(Number(args.round_from)) && args.round_from !== '' && args.round_from != null ? Number(args.round_from) : null,
    roundTo: Number.isFinite(Number(args.round_to)) && args.round_to !== '' && args.round_to != null ? Number(args.round_to) : null,
    dateFrom: args.date_from ? String(args.date_from) : '',
    dateTo: args.date_to ? String(args.date_to) : '',
    rankOwn: args.rank_own ? String(args.rank_own) : '',
    rankOpp: args.rank_opp ? String(args.rank_opp) : '',
    notInPlaylist: args.not_in_playlist ? String(args.not_in_playlist) : '',
    // Grenades in a drawn region are told from the landings alone; the rest needs the round's movement.
    where: given.filter((c) => !grenadeOnly(c)),
    grenadeWhere: given.filter(grenadeOnly),
    hit,
    site,
    sort,
    count: Math.max(1, Math.min(30, Math.round(Number(args.count)) || 8)),
    more: Math.max(0, Math.round(Number(args.more)) || 0),
    describe: args.describe === undefined ? null : Boolean(args.describe)
  };
}

/** Does this question read a round's record, its positions, who was T? */
export const needsRecord = (a) => Boolean(a.gap || a.firstKill || a.firstKillBy !== null || a.plant !== null || a.plantBy !== null || a.endedBy || a.kills);
export const needsPositions = (a) => Boolean(a.where.length || a.hit || a.site);
export const needsSides = (a) => Boolean(a.side || a.winner || a.dominance || a.sort === 'dominance');

export const buyWord = (code) => BUY_NAMES[code] ?? String(code);

/**
 * Who a round is read for: the team named, else the team facing the opponent named, else the side
 * named, else the winner.
 *
 * @param {{ team1: string, team2: string, winner: number }} row  a round of the library
 * @param {{ mine: Set<string>|null, theirs: Set<string>|null, side: string, seat1Side: string|null }} who
 * @returns {1|2|0} the seat, 0 when it cannot be told yet
 */
export function subjectSeat(row, { mine = null, theirs = null, side = '', seat1Side = null } = {}) {
  if (mine) return mine.has(row.team1) ? 1 : mine.has(row.team2) ? 2 : 0;
  if (theirs) return theirs.has(row.team1) ? 2 : theirs.has(row.team2) ? 1 : 0;
  if (side) return seat1Side ? (seat1Side === side ? 1 : 2) : 0;
  return row.winner === 2 ? 2 : 1;
}

/**
 * One side's read of a round from its grenades alone, in the shape roundQuery.js tests: the same
 * landings and times roundFeatures gives, for a question about no more than that.
 */
export function grenadesOf(meta, side) {
  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const teamOf = new Map((meta?.players || []).map((p) => [p.id, p.team]));
  const nades = [];
  const enemyNades = [];
  for (const g of meta?.events?.grenades || []) {
    const type = normNade(g.type);
    const det = Number(g.detonateTick ?? g.throwTick);
    const x = Number(g.at?.x);
    const y = Number(g.at?.y);
    if (!NADE_KINDS.includes(type) || !teamOf.has(g.player) || !Number.isFinite(det) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const landed = { type, player: g.player, x, y, z: Number(g.at?.z), at: (det - timing.freezeEndTick) / rate, throwAt: (Number(g.throwTick ?? det) - timing.freezeEndTick) / rate, zone: '', label: '' };
    (sideOfTeam(meta, teamOf.get(g.player)) === side ? nades : enemyNades).push(landed);
  }
  return { side, hasTicks: true, nades, enemyNades, kills: [], series: [], won: winnerSide(meta) === side };
}

const NADE_WORD = { smokegrenade: 'smoke', molotov: 'molotov', flashbang: 'flash', hegrenade: 'HE' };
const NADE_TYPE = { smoke: 'smokegrenade', molotov: 'molotov', flash: 'flashbang', he: 'hegrenade' };

/**
 * What landed in each region a list of conditions asks about, for the answer: "1: smoke 1:12". So a
 * round reads as evidence, and the model has no reason to open it to see why it fit.
 */
export function regionHits(read, where, regions) {
  const out = [];
  const seen = new Set();
  const walk = (raw) => {
    const [kind, arg] = Object.entries(normalizeCondition(raw))[0] || [];
    if (kind === 'any') return void arg.forEach(walk);
    if (kind !== 'utility' || seen.has(arg.region)) return;
    const region = regions.find((r) => r.id === Number(arg.region));
    if (!region) return;
    seen.add(arg.region);
    const who = String(arg.who ?? 'team').toLowerCase();
    const ours = who === 'team' || who.toUpperCase() === read.side;
    const from = elapsedOfClock(arg.from, -Infinity);
    const to = elapsedOfClock(arg.to, Infinity);
    const list = (ours ? read.nades : read.enemyNades).filter((g) => g.throwAt >= Math.min(from, to) && g.throwAt <= Math.max(from, to) && (!NADE_TYPE[arg.type] || g.type === NADE_TYPE[arg.type]) && inRegion(region, g.x, g.y, g.z));
    if (list.length) out.push(`${region.id}: ${list.map((g) => `${NADE_WORD[g.type]} ${clockText(ROUND_SECONDS - g.throwAt)}`).join(', ')}`);
  };
  where.forEach(walk);
  return out.join('; ');
}

const clockText = (left) => {
  const s = Math.max(0, Math.round(left));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** How a round ended, from its record. */
export function endingOf(meta) {
  const bomb = meta?.events?.bomb || [];
  if (bomb.some((b) => b.type === 'exploded')) return 'bomb';
  if (bomb.some((b) => b.type === 'defused')) return 'defuse';
  const dead = new Set((meta?.events?.kills || []).map((k) => k.victim));
  const alive = { T: 0, CT: 0 };
  for (const p of meta?.players || []) if (!dead.has(p.id)) alive[sideOfTeam(meta, p.team)]++;
  if (!alive.T || !alive.CT) return 'elimination';
  // Both alive with no bomb event: only the clock ends that, and only for the CTs.
  return winnerSide(meta) === 'CT' ? 'time' : 'elimination';
}

/** What a round's record says, read for one side. */
export function recordFacts(meta, side, grace = 2) {
  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const clockOf = (tick) => ROUND_SECONDS - (Number(tick) - timing.freezeEndTick) / rate;
  const sideOfPlayer = new Map((meta?.players || []).map((p) => [p.id, sideOfTeam(meta, p.team)]));
  const kills = [...(meta?.events?.kills || [])].filter((k) => k.victim).sort((a, b) => Number(a.tick) - Number(b.tick));
  const first = kills.find((k) => sideOfPlayer.get(k.attacker) && sideOfPlayer.get(k.attacker) !== sideOfPlayer.get(k.victim));
  const planted = (meta?.events?.bomb || []).find((b) => b.type === 'planted');
  const plantTick = Number.isFinite(meta?.plantTick) ? meta.plantTick : planted?.tick ?? null;
  const byPlayer = new Map();
  for (const k of kills) if (k.attacker && sideOfPlayer.get(k.attacker) !== sideOfPlayer.get(k.victim)) byPlayer.set(k.attacker, (byPlayer.get(k.attacker) || 0) + 1);
  return {
    won: winnerSide(meta) === side,
    firstKillBy: first ? (sideOfPlayer.get(first.attacker) === side ? 'team' : 'opponent') : '',
    firstKillClock: first ? clockOf(first.tick) : null,
    planted: plantTick != null,
    plantClock: plantTick != null ? clockOf(plantTick) : null,
    plantPoint: planted && Number.isFinite(Number(planted.x)) ? { x: Number(planted.x), y: Number(planted.y) } : null,
    ending: endingOf(meta),
    gaps: aliveGaps(meta, side, grace),
    killsOf: (name) => {
      if (!name) {
        let best = 0;
        for (const [id, n] of byPlayer) if (sideOfPlayer.get(id) === side) best = Math.max(best, n);
        return best;
      }
      const q = name.trim().toLowerCase();
      const hit = (meta?.players || []).find((p) => String(p.name || '').toLowerCase() === q);
      return hit ? byPlayer.get(hit.id) || 0 : -1;
    }
  };
}

/**
 * Does a round's record fit? `plantSite` is the planted site worked out from where the bomb went
 * down: the site the demo's own event names reads the other site on Dust2.
 *
 * @returns {{ fits: boolean, gapFits: boolean }}
 */
export function recordFits(facts, a, plantSite = null) {
  const gapOk = !a.gap || gapFits(facts.gaps, a.gap);
  const rest =
    (!a.firstKill || facts.firstKillBy === a.firstKill) &&
    (a.firstKillBy === null || (facts.firstKillClock !== null && facts.firstKillClock >= a.firstKillBy)) &&
    (a.plant === null || (a.plant === true && facts.planted) || (a.plant === false && !facts.planted) || (typeof a.plant === 'string' && facts.planted && plantSite === a.plant)) &&
    (a.plantBy === null || (facts.plantClock !== null && facts.plantClock >= a.plantBy)) &&
    (!a.endedBy || facts.ending === a.endedBy) &&
    (!a.kills || facts.killsOf(a.kills.player) >= a.kills.min);
  return { fits: rest && gapOk, gapFits: gapOk, rest };
}

/** "never behind, up to +3 (5v2)": the words without the kill by kill. */
export const aliveWords = (words) => String(words).split(';')[0];

/** The question in a line, for the answer. */
export function askedWords(a) {
  const buys = (set) => (set ? [...set].map(buyWord).join(' or ') : '');
  return [
    a.team && a.team,
    a.side && `${a.side} side`,
    a.opponent && `vs ${a.opponent}`,
    a.buy && `buy ${buys(a.buy)}`,
    a.vsBuy && `their buy ${buys(a.vsBuy)}`,
    a.result,
    a.winner && `${a.winner} won`,
    a.dominance && `dominance ${a.dominance.min} to ${a.dominance.max}`,
    a.hit && `${a.hit}`,
    a.site && `site ${a.site}`
  ].filter(Boolean).join(', ');
}

// ---- a note on a round --------------------------------------------------------

/** How long one note may be, and what a note on a round never says. */
export const NOTE_CHARS = 160;
const RESULT_WORDS = /\b(wins?|won|winning|lose|loses|lost|losing|kills?|killed|killing|deaths?|dies|died|frags?|clutch(es|ed)?|aces?|traded?|trades|trading|3k|4k|5k|2k)\b/i;

/**
 * Why a note will not do, or '' when it will. A note says what a side did and could do again, so a
 * kill or a result does not belong (21 Oct: "win the B fights" on half a playlist's notes), and neither
 * does the other team: it reads as a demo, not a call.
 *
 * @param {string} text
 * @param {{ otherNames?: string[] }} [opts]  the other side's team and players, when the side is known
 */
export function noteProblem(text, { otherNames = [] } = {}) {
  const t = String(text || '').trim();
  if (t.length > NOTE_CHARS) return `it is ${t.length} characters: one line of at most ${NOTE_CHARS}, the call first`;
  const word = RESULT_WORDS.exec(t);
  if (word) return `it says "${word[0]}": no kills and no result, only what the side did`;
  const lower = t.toLowerCase();
  const other = otherNames.find((n) => n && n.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(lower));
  if (other) return `it names ${other} from the other team: only this side's play`;
  return '';
}
