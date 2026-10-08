// ---------------------------------------------------------------------------
// replays/analytics/antistratInternal.js
// Teams antistrat, internal mode: a report on our own team, written to find
// what loses rounds.
//
// The other two modes scout an opponent. This one is pointed inward, and it is
// laid out the way a coach's internal review is: per side, the round types we
// run and face on full buy with the round win rate, the opening duel and both
// man-advantage conversions; then the weakest call and the enemy moves that
// punish us, round by round; the players' ratings on every call; a word on the
// best and the most struggling player; and a conclusion with the arithmetic of
// what one more round per half is worth.
//
// The round-by-round notes are the autocoach's (coach/coach.js): each round is
// coached the same way the viewer coaches it, and its flags are turned into
// short clauses (reportMessages.js `flag-*`). Nothing here is written by a
// model, and every claim links to the rounds it came from.
// ---------------------------------------------------------------------------

import { fetchRoundMeta, fetchRoundTicks } from '../api.js';
import { TickTrack } from '../tickStore.js';
import { analyseRound } from '../coach/coach.js';
import { loadCoachSmokes } from '../coach/coachSmokes.js';
import { COACH_CATEGORY } from '../coach/coachMessages.js';
import { MAPS } from '../shared/roundId.js';
import { aggregatePlayers, indexMaps, teamNameKey } from '../shared/statsMath.js';
import { mapRoundGrid, teamMapRoundGrid } from '../performance/mapRoundStats.js';
import { positionsAtPoint } from '../zones/pointInZone.js';
import { say } from './reportMessages.js';
import {
  capitalize,
  clockText,
  joinList,
  narrateSequence,
  paragraph,
  percent,
  plural,
  sentence,
  variantIndex
} from './reportProse.js';

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const INTERNAL_CATEGORIES = [
  { key: 'sideT', group: 'Sides', label: 'T side' },
  { key: 'sideCT', group: 'Sides', label: 'CT side' },
  { key: 'tables', group: 'Sections', label: 'Round type tables' },
  { key: 'notes', group: 'Sections', label: 'Round notes' },
  { key: 'ratings', group: 'Sections', label: 'Player ratings' },
  { key: 'players', group: 'Sections', label: 'Player notes' },
  { key: 'conclusion', group: 'Sections', label: 'Conclusion' }
];

export const INTERNAL_GROUPS = ['Sides', 'Sections'];

/**
 * Columns the internal report's stats payload needs: the round-library tags
 * the tables are built on, the roles the header names, and the full rating
 * bundle, because a rating built from part of it is a different number.
 */
export const INTERNAL_COLUMNS = ['swing', 'kills', 'aim', 'duels', 'coreOpenings', 'roundLibrary', 'roles'];

/** Full buy vs full buy: the tables and notes read only these. */
const FULL_VS_FULL = { econ: 4, oppEcon: 4 };

/** Rating bands, read off the reports this mirrors: red, orange, grey, plain, green, blue. */
export const RATING_BANDS = [
  { below: 0.85, color: '#e06666' },
  { below: 1.0, color: '#f6a04d' },
  { below: 1.12, color: '#9c9ca2' },
  { below: 1.3, color: '' },
  { below: 1.71, color: '#7bc96f' },
  { below: Infinity, color: '#5ea3f2' }
];

export function ratingColor(value) {
  if (!Number.isFinite(value)) return '';
  return RATING_BANDS.find((b) => value < b.below)?.color || '';
}

const SIDE_COLOR = { T: '#e06666', CT: '#5ea3f2' };

/** A call this far under even is worth a section. */
const WEAK_WINRATE = 50;
/** And has to have been run this often to count. */
const WEAK_MIN_ROUNDS = 6;
const PUNISH_MIN_ROUNDS = 3;
/** Rounds written out per block, so a 40-round call does not become a book. */
const BLOCK_ROUNDS_MAX = 12;
const RANDOM_ROUNDS = 6;
const WORST_ROUNDS_MAX = 7;
/** A kill this soon after a death answers it. */
const TRADE_SECONDS = 3;

// ---------------------------------------------------------------------------
// The coach pass
// ---------------------------------------------------------------------------

async function eachLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}

/** How a round ended, read off its events. */
function endOf(meta) {
  const bomb = meta.events?.bomb || [];
  const rate = meta.tickRate || 64;
  if (bomb.some((b) => b.type === 'defused')) return 'defused';
  const plant = bomb.find((b) => b.type === 'planted');
  if (plant && meta.winnerSide === 'T' && (meta.endTick - plant.tick) / rate >= 38) return 'exploded';
  return 'fight';
}

/**
 * Run the autocoach over a list of rounds, exactly as the viewer does, and
 * keep only what the notes need: the flags, every name in the round, and the
 * win chance line the coach measured them against.
 *
 * @param {{ files: string[], mapCode: string, network: object|null, onProgress?: Function }} args
 * @returns {Promise<Map<string, object>>}
 */
export async function coachRounds({ files, mapCode, network, onProgress }) {
  const smokes = await loadCoachSmokes(mapCode).catch(() => null);
  const out = new Map();
  let done = 0;
  await eachLimit(files, 3, async (file) => {
    try {
      const meta = await fetchRoundMeta(file);
      const track = new TickTrack(await fetchRoundTicks(file, 1));
      const scratch = [];
      const res = analyseRound({
        meta,
        track,
        network,
        coachSmokes: smokes,
        sampleAt: (tick) => {
          track.sampleAll(tick, scratch);
          return scratch;
        }
      });
      out.set(file, {
        flags: (res.flags || []).map((f) => ({
          tick: f.tick,
          playerId: f.playerId,
          rule: f.rule,
          category: f.category
        })),
        names: new Map((meta.players || []).map((p) => [p.id, p.name || p.id])),
        teamOf: new Map((meta.players || []).map((p) => [p.id, p.team])),
        series: (res.series || []).map((s) => ({ tick: s.tick, ct: s.ct, t: s.t })),
        end: endOf(meta),
        tickRate: meta.tickRate || 64
      });
    } catch {
      // A round that cannot be coached is still written, from its kills alone.
    }
    done++;
    onProgress?.(done, files.length);
  });
  return out;
}

// ---------------------------------------------------------------------------
// One round, as a note
// ---------------------------------------------------------------------------

export function zoneAt(x, y, network) {
  if (!network || !Number.isFinite(x) || !Number.isFinite(y)) return '';
  return positionsAtPoint(x, y, network).map((z) => z.name)[0] || '';
}

/** Our side's win chance just before and just after a tick, from the coach's line. */
function swingAt(coach, side, tick) {
  if (!coach?.series?.length) return 0;
  const key = side === 'CT' ? 'ct' : 't';
  let before = null;
  let after = null;
  for (const s of coach.series) {
    if (s.tick < tick) before = s[key];
    else if (after === null && s.tick >= tick + coach.tickRate) after = s[key];
  }
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return before - after;
}

function winAt(coach, side, tick) {
  if (!coach?.series?.length) return null;
  const key = side === 'CT' ? 'ct' : 't';
  let v = null;
  for (const s of coach.series) {
    if (s.tick <= tick) v = s[key];
    else break;
  }
  return Number.isFinite(v) ? v : null;
}

/** Alive counts (ours, theirs) just after a tick, from the kill log. */
function aliveAfter(r, tick) {
  let ours = 5;
  let theirs = 5;
  for (const k of r.kills) {
    if (k.tick > tick) break;
    if (k.victimOurs) ours--;
    else theirs--;
  }
  return { ours: Math.max(0, ours), theirs: Math.max(0, theirs) };
}

/** Which of an autocoach category's words goes in the thread of a round. */
function threadWord(flag, r = null) {
  if (!flag) return say(r && advantageThrown(r) ? 'thread-carelessness' : 'thread-none', 'none');
  if (flag.category === COACH_CATEGORY.MECHANICAL) {
    return say(
      flag.rule === 'unaware-openness' || flag.rule === 'not-ready' ? 'thread-mechanical' : 'thread-aim',
      flag.rule
    );
  }
  if (flag.category === COACH_CATEGORY.QUALITY) {
    return say(/flash|util|nade/.test(flag.rule) ? 'thread-utility' : 'thread-quality', flag.rule);
  }
  if (flag.category === COACH_CATEGORY.CARELESSNESS) return say('thread-carelessness', flag.rule);
  if (flag.category === COACH_CATEGORY.SYNCHRONIZATION) return say('thread-synchronization', flag.rule);
  return say('thread-none', 'none');
}

/**
 * Everything a note needs to know about one round, in one place: who did what
 * when, which of it the coach flagged, and what it cost.
 */
export function readRound(r, coach, ctx) {
  const names = (id) => coach?.names?.get(id) || ctx.nameOf.get(id) || id;
  const ours = new Set(r.ourIds || []);
  const flags = (coach?.flags || []).filter((f) => ours.has(f.playerId) && f.category !== COACH_CATEGORY.PRAISE);
  /** The kill a flag is about: the death of the flagged player at (about) its tick. */
  const killFor = (f) =>
    r.kills.find((k) => k.victim === f.playerId && Math.abs(k.tick - f.tick) <= 2) ||
    r.kills.find((k) => k.attacker === f.playerId && Math.abs(k.tick - f.tick) <= 2) ||
    null;
  const weighted = flags
    .map((f) => ({ f, kill: killFor(f), cost: swingAt(coach, r.side, f.tick) }))
    .sort((a, b) => b.cost - a.cost || a.f.tick - b.f.tick);
  return { names, flags, weighted, primary: weighted[0]?.f || null };
}

/** One flagged moment as a clause: "cptkurtka023 is caught looking away by br0". */
function flagClause(item, read, r, ctx) {
  const { f, kill } = item;
  const enemy = kill && kill.victim === f.playerId ? read.names(kill.attacker) : '';
  const key = `flag-${f.rule}`;
  const text = say(key, `${r.file}|${f.tick}`, {
    p: read.names(f.playerId),
    enemy: enemy || 'the enemy'
  });
  if (!text) return '';
  const zone = kill && kill.victim === f.playerId ? zoneAt(kill.x, kill.y, ctx.network) : '';
  return zone && !text.includes(zone) && /dies|caught|loses/.test(text) ? `${text} on ${zone}` : text;
}

/**
 * The largest man advantage we held in a round we then lost, or null.
 * Not a coach rule, but the plainest fact a lost round can carry: we were up
 * and it went away.
 */
function advantageThrown(r) {
  if (r.won) return null;
  let best = null;
  for (const kill of r.kills) {
    const a = aliveAfter(r, kill.tick);
    if (a.ours > a.theirs && (!best || a.ours - a.theirs > best.ours - best.theirs)) best = a;
  }
  return best;
}

/** Every handle in a round, so no sentence capitalises one. */
export function namesIn(coach, ctx) {
  return [...ctx.names, ...(coach?.names ? [...coach.names.values()] : [])];
}

/**
 * A round as the internal review writes it: how it opened, the one or two
 * moments that cost it (or won it), and how it ended.
 *
 * One clause per death: the coach can flag the same death under two rules
 * ("unaware" and "no gun out"), and the costlier of them is the one written.
 */
export function roundNote(r, coach, ctx) {
  const read = readRound(r, coach, ctx);
  const parts = [];
  const k = r.firstKill;
  const seed = r.file;
  /** `${player}@${tick}` of every death already written. */
  const written = new Set();
  const deathKey = (id, tick) => `${id}@${Math.round(tick / 8)}`;

  if (k) {
    const zone = k.victimZone ? ` on ${k.victimZone}` : '';
    if (k.victimOurs) {
      const flag = read.weighted.find((w) => w.f.playerId === k.victim && Math.abs(w.f.tick - k.tick) <= 2);
      const why = flag ? say(`why-${flag.f.rule}`, seed) : '';
      written.add(deathKey(k.victim, k.tick));
      const traded = r.kills.some(
        (x) => x.attackerOurs && x.tick > k.tick && (x.tick - k.tick) / r.tickRate <= TRADE_SECONDS
      );
      parts.push(
        `${read.names(k.victim)} dies first to ${read.names(k.attacker)}${zone}${why ? `, ${why}` : ''}${traded ? ' and is traded' : ''}`
      );
    } else {
      parts.push(`${read.names(k.attacker)} opens on ${read.names(k.victim)}${zone}`);
    }
  }

  if (!r.won) {
    // The moments that cost the most, as the coach priced them, one per death.
    let moments = 0;
    for (const item of read.weighted) {
      if (moments >= 2) break;
      const death = item.kill && item.kill.victim === item.f.playerId ? deathKey(item.f.playerId, item.kill.tick) : '';
      const key = death || `${item.f.playerId}#${item.f.rule}`;
      if (written.has(key)) continue;
      const clause = flagClause(item, read, r, ctx);
      if (!clause) continue;
      written.add(key);
      parts.push(clause);
      moments++;
    }
    parts.push(endClause(r, coach, seed));
  } else {
    parts.push(wonClause(r, read, seed));
  }
  return paragraph(parts.filter(Boolean), namesIn(coach, ctx));
}

function endClause(r, coach, seed) {
  // Kept fighting a lost round late on with almost nothing left: a save was
  // the better call. Only when the bomb was never down and the fights after
  // it cost more guns.
  if (coach?.series?.length && r.plantTick == null) {
    for (const kill of r.kills) {
      if (!kill.victimOurs) continue;
      const wp = winAt(coach, r.side, kill.tick + coach.tickRate);
      const { ours } = aliveAfter(r, kill.tick);
      const diedAfter = r.kills.filter((x) => x.victimOurs && x.tick > kill.tick).length;
      if (wp !== null && wp < 8 && kill.clock >= 25 && kill.clock <= 75 && ours >= 2 && ours <= 3 && diedAfter >= 2) {
        return say('end-save', seed, { wp: Math.max(1, Math.round(wp)), n: ours });
      }
    }
  }
  const up = advantageThrown(r);
  if (r.plantTick != null) {
    const { ours, theirs } = aliveAfter(r, r.plantTick);
    const site = (r.plantSite || '').toUpperCase() || 'the';
    if (ours === 0) return say('end-wiped', seed);
    return r.side === 'T'
      ? say('end-afterplant-lost', seed, { n: ours, m: theirs, site })
      : say('end-retake-lost', seed, { n: ours, m: theirs, site });
  }
  if (up) return say('end-advantage', seed, { n: up.ours, m: up.theirs });
  if (coach?.end === 'fight' && r.side === 'T') {
    const last = r.kills[r.kills.length - 1];
    const { ours } = aliveAfter(r, last ? last.tick : 0);
    if (ours > 0) return say('end-time', seed, { n: ours });
  }
  // The last even moment before it slipped away.
  let even = null;
  for (const kill of r.kills) {
    const a = aliveAfter(r, kill.tick);
    if (a.ours === a.theirs && a.ours >= 2) even = a;
  }
  if (even) return say('end-eliminated', seed, { n: even.ours, m: even.theirs });
  return r.firstKill?.victimOurs ? say('end-never-recovered', seed) : '';
}
function wonClause(r, read, seed) {
  const k = r.firstKill;
  const words = [];
  // A clutch: the last of ours alive took two or more.
  const ourDeaths = r.kills.filter((x) => x.victimOurs);
  if (ourDeaths.length === 4) {
    const lastDeath = ourDeaths[ourDeaths.length - 1];
    const alive = (r.ourIds || []).find((id) => !ourDeaths.some((d) => d.victim === id));
    const after = r.kills.filter((x) => x.attacker === alive && x.tick > lastDeath.tick).length;
    if (alive && after >= 2) words.push(say('end-clutch', seed, { p: read.names(alive), n: after }));
  }
  const byKiller = new Map();
  for (const x of r.kills) if (x.attackerOurs) byKiller.set(x.attacker, (byKiller.get(x.attacker) || 0) + 1);
  const best = [...byKiller.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!words.length && best && best[1] >= 3) words.push(say('end-multikill', seed, { p: read.names(best[0]), n: best[1] }));
  if (!words.length && k) words.push(say(k.attackerOurs ? 'end-converted' : 'end-comeback', seed));
  return words[0] || say('end-won', seed);
}

/** "Round 16 vs Monte (L)". */
export function roundTitle(r) {
  return `Round ${r.round} vs ${r.opponent} (${r.won ? 'W' : 'L'})`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function cellRow(row, cell) {
  return { key: row.key, label: row.label, cell };
}

/**
 * Own calls on this side (the "Ran" lane of this side's table) and the calls
 * faced on it (the "Faced" lane of the other side's table), both full buy vs
 * full buy, most-played first.
 */
function tablesFor(grid, side) {
  const other = side === 'T' ? 'CT' : 'T';
  const own = (grid?.[side] || []).filter((r) => r.ran.rounds).map((r) => cellRow(r, r.ran));
  const faced = (grid?.[other] || []).filter((r) => r.faced.rounds).map((r) => cellRow(r, r.faced));
  const byRounds = (a, b) => b.cell.rounds - a.cell.rounds || a.label.localeCompare(b.label);
  return { own: own.sort(byRounds), faced: faced.sort(byRounds) };
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * One rating per main player per call, the same Rating 3.0 the Performance
 * page's Maps chapter shows for those rounds, and the plain averages the
 * review's tables carry.
 */
function ratingsFor(payload, ctx, side, maps) {
  const other = side === 'T' ? 'CT' : 'T';
  const grids = ctx.mains.map((m) => mapRoundGrid(payload, m.id, FULL_VS_FULL, maps.players, maps.demos)[ctx.mapCode]);
  const build = (tableSide, lane) => {
    const labels = (grids[0]?.[tableSide] || []).map((r) => ({ key: r.key, label: r.label }));
    const rows = [];
    for (const { key, label } of labels) {
      const values = grids.map((g) => {
        const row = (g?.[tableSide] || []).find((x) => x.key === key);
        return Number.isFinite(row?.[lane]?.rating) ? row[lane].rating : null;
      });
      if (values.every((v) => v === null)) continue;
      const have = values.filter((v) => v !== null);
      rows.push({ key, label, values, avg: have.reduce((a, b) => a + b, 0) / have.length });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    const playerAvg = ctx.mains.map((_, i) => {
      const list = rows.map((r) => r.values[i]).filter((v) => v !== null);
      return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    });
    const have = playerAvg.filter((v) => v !== null);
    return { rows, playerAvg, teamAvg: have.length ? have.reduce((a, b) => a + b, 0) / have.length : null };
  };
  return {
    players: ctx.mains.map((m) => m.short || m.name),
    own: build(side, 'ran'),
    faced: build(other, 'faced')
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** The category most of a set of rounds was lost to, by their costliest flag. */
function topCategory(rounds, coached, ctx) {
  const counts = new Map();
  let silent = 0;
  for (const r of rounds) {
    const read = readRound(r, coached.get(r.file), ctx);
    const cat = read.primary?.category || (advantageThrown(r) ? COACH_CATEGORY.CARELESSNESS : '');
    if (!cat) {
      silent++;
      continue;
    }
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  // Mostly rounds with nothing wrong in them: say that, not the minority's reason.
  if (silent > rounds.length * 0.6) return 'none';
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || 'none';
}

function conclusionFor(rounds, coached, ctx, seed) {
  const lost = rounds.filter((r) => !r.won);
  const won = rounds.filter((r) => r.won);
  const parts = [];
  if (lost.length) parts.push(say(`concl-${topCategory(lost, coached, ctx)}`, seed));
  // The won rounds carry fewer flags per round than the lost ones.
  if (won.length && lost.length) {
    const per = (list) =>
      list.reduce((n, r) => n + readRound(r, coached.get(r.file), ctx).flags.length, 0) / list.length;
    if (per(won) < per(lost)) parts.push(say('concl-won', seed));
  }
  return parts.join(' ');
}

function blockRounds(list, coached, ctx) {
  return list.slice(0, BLOCK_ROUNDS_MAX).map((r) => ({
    file: r.file,
    title: roundTitle(r),
    won: r.won,
    note: roundNote(r, coached.get(r.file), ctx)
  }));
}

function notesFor(ctx, side, tables, coached) {
  const seed = `${ctx.seed}|notes|${side}`;
  const set = ctx.rounds.filter((r) => r.side === side && r.ownEcon >= 4 && r.oppEcon >= 4);
  const out = { weakest: null, punishing: [], restFine: true, own: null, faced: [], random: null };

  // On CT, "All A hits", the retakes and the afterplants are the T side's
  // decisions arriving at us, not calls of ours: they belong to the faced list.
  const reactive = (key) => /^all-[ab]-hits$|retake|afterplant/.test(key);
  const weak = tables.own
    .filter(
      (row) =>
        row.key !== 'default' &&
        !(side === 'CT' && reactive(row.key)) &&
        row.cell.rounds >= WEAK_MIN_ROUNDS &&
        row.cell.winrate < WEAK_WINRATE
    )
    .sort((a, b) => a.cell.winrate - b.cell.winrate)[0];
  if (weak) out.weakest = { key: weak.key, label: weak.label, winrate: Math.round(weak.cell.winrate), files: weak.cell.files };
  out.punishing = tables.faced
    .filter((row) => row.key !== 'default' && row.cell.rounds >= PUNISH_MIN_ROUNDS && row.cell.winrate < WEAK_WINRATE)
    .sort((a, b) => a.cell.winrate - b.cell.winrate)
    .slice(0, 3)
    .map((row) => ({ key: row.key, label: row.label, winrate: Math.round(row.cell.winrate), rounds: row.cell.rounds, files: row.cell.files }));
  // "Everything else is close to >50%": nothing left below 45 once the named ones are out.
  const named = new Set([out.weakest?.key, ...out.punishing.map((p) => p.key)].filter(Boolean));
  out.restFine = [...tables.own, ...tables.faced].every(
    (row) => named.has(row.key) || row.cell.rounds < WEAK_MIN_ROUNDS || row.cell.winrate >= 45
  );

  const listed = new Set();
  const take = (list) => {
    for (const r of list) listed.add(r.file);
    return list;
  };
  const byTime = (a, b) => a.demoId.localeCompare(b.demoId) || a.round - b.round;

  if (out.weakest) {
    const rounds = take(set.filter((r) => (r.tags?.[side] || []).some((t) => t.k === out.weakest.key)).sort(byTime));
    out.own = {
      label: out.weakest.label,
      rounds: blockRounds(rounds, coached, ctx),
      conclusion: conclusionFor(rounds, coached, ctx, `${seed}|own`)
    };
  }
  const other = side === 'T' ? 'CT' : 'T';
  out.punishing.forEach((p, i) => {
    let rounds = set.filter((r) => (r.tags?.[other] || []).some((t) => t.k === p.key)).sort(byTime);
    if (i > 0) rounds = rounds.filter((r) => !r.won && !listed.has(r.file)).slice(0, 2);
    if (!rounds.length) return;
    take(rounds);
    const wins = set.filter((r) => (r.tags?.[other] || []).some((t) => t.k === p.key) && r.won);
    const lines = [];
    if (i === 0) {
      lines.push(conclusionFor(rounds, coached, ctx, `${seed}|faced|${p.key}`));
      lines.push(
        say('concl-faced', seed, {
          wins: wins.length,
          rounds: p.rounds,
          call: p.label,
          winrate: p.winrate
        })
      );
      if (wins.length === 1 && wins[0].oppEcon <= 1) lines.push(say('concl-faced-eco', seed, { call: p.label }));
    }
    out.faced.push({
      label: p.label,
      first: i === 0,
      rounds: blockRounds(rounds, coached, ctx),
      conclusion: lines.filter(Boolean).join(' ')
    });
  });

  // Lost rounds "at random", picked by a hash so the same rounds come back.
  const flagged = (r) => readRound(r, coached.get(r.file), ctx).flags.length > 0 || Boolean(advantageThrown(r));
  const pool = set
    .filter((r) => !r.won && !listed.has(r.file))
    .sort(
      (a, b) =>
        Number(flagged(b)) - Number(flagged(a)) ||
        variantIndex('random', a.file, 1e9) - variantIndex('random', b.file, 1e9)
    )
    .slice(0, RANDOM_ROUNDS)
    .sort(byTime);
  if (pool.length >= 2) {
    const thread = pool.map((r) => threadWord(readRound(r, coached.get(r.file), ctx).primary, r));
    out.random = {
      rounds: blockRounds(pool, coached, ctx),
      thread: sentence(narrateSequence(thread, { last: say('int-random-last', seed) }))
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Player notes
// ---------------------------------------------------------------------------

function playerNotesFor(ctx, side, ratings, coached, payload, maps, officialIds) {
  const seed = `${ctx.seed}|players|${side}`;
  const out = { best: null, officials: null, worst: null };
  const mapName = MAPS[ctx.mapCode]?.name || ctx.mapCode;

  // Coach flags per player across this side's coached rounds.
  const sideRounds = ctx.rounds.filter((r) => r.side === side && coached.has(r.file));
  const flagsBy = new Map();
  for (const r of sideRounds) {
    for (const f of coached.get(r.file).flags) {
      if (f.category === COACH_CATEGORY.PRAISE) continue;
      flagsBy.set(f.playerId, (flagsBy.get(f.playerId) || 0) + 1);
    }
  }

  // The standout, on the full buy calls the tables above are built on: clearly
  // ahead of everyone else, or not worth a paragraph.
  const order = ratings.own.playerAvg
    .map((v, i) => ({ i, v }))
    .filter((x) => x.v !== null)
    .sort((a, b) => b.v - a.v);
  const lead = order.length >= 2 ? order[0].v - order[1].v : 0;
  if (order.length >= 2 && ((order[0].v >= 1.15 && lead >= 0.15) || (order[0].v >= 1.0 && lead >= 0.2))) {
    const m = ctx.mains[order[0].i];
    const mine = flagsBy.get(m.id) || 0;
    const fewest = ctx.mains.every((x) => x.id === m.id || (flagsBy.get(x.id) || 0) >= mine);
    out.best = {
      name: m.name,
      text: say('pl-best', seed, { name: m.name, side, map: mapName }),
      clean:
        fewest && sideRounds.length
          ? say('pl-best-clean', seed, { name: m.name, flags: plural(mine, 'flagged mistake'), rounds: sideRounds.length })
          : ''
    };
  }

  // Every round of the side on this map, any buy: what "regardless of buy" means.
  const rows = [];
  const officialRows = [];
  for (const demo of payload?.demos || []) {
    for (const row of demo.rounds || []) {
      if (row.m !== ctx.mapCode) continue;
      rows.push(row);
      if (officialIds?.has(demo.id)) officialRows.push(row);
    }
  }

  // Officials, when some of the matches were marked as such.
  if (officialRows.length) {
    const stats = aggregatePlayers(officialRows, maps.players, { side }, maps.demos);
    const values = ctx.mains.map((m) => {
      const p = stats.find((x) => x.id === m.id);
      return Number.isFinite(p?.rating) ? p.rating : null;
    });
    if (values.some((v) => v !== null)) {
      const have = values.filter((v) => v !== null);
      out.officials = {
        text: say('pl-officials', seed, { side }),
        values,
        avg: have.reduce((a, b) => a + b, 0) / have.length
      };
    }
  }

  // The most struggling player: lowest rating over the whole side.
  const stats = aggregatePlayers(rows, maps.players, { side }, maps.demos);
  const candidates = ctx.mains
    .map((m) => ({ m, s: stats.find((x) => x.id === m.id) }))
    .filter((x) => x.s && x.s.rounds >= 10)
    .sort((a, b) => a.s.rating - b.s.rating);
  const worst = candidates[0];
  if (worst && worst.s.rating < 0.9 && candidates.length >= 3) {
    const { m, s } = worst;
    const name = m.name;
    const id = m.id;
    // Lost full buys where they died having done little, spread across the
    // opponents rather than the first seven rounds of one match.
    const byDemo = new Map();
    for (const r of ctx.rounds) {
      if (r.side !== side || r.won || r.ownEcon < 4 || !(r.ourIds || []).includes(id)) continue;
      const mine = r.kills.filter((k) => k.attacker === id).length;
      if (!r.kills.some((k) => k.victim === id) || mine >= 2) continue;
      if (!byDemo.has(r.demoId)) byDemo.set(r.demoId, []);
      byDemo.get(r.demoId).push(r);
    }
    const queues = [...byDemo.values()].map((list) => list.sort((a, b) => a.round - b.round));
    const picked = [];
    while (picked.length < WORST_ROUNDS_MAX && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (q.length && picked.length < WORST_ROUNDS_MAX) picked.push(q.shift());
      }
    }
    picked.sort((a, b) => a.demoId.localeCompare(b.demoId) || a.round - b.round);
    let kills = 0;
    let deaths = 0;
    const notes = [];
    for (const r of picked) {
      const coach = coached.get(r.file);
      const read = readRound(r, coach, ctx);
      const death = r.kills.find((k) => k.victim === id);
      const mineKills = r.kills.filter((k) => k.attacker === id && k.tick < death.tick);
      kills += r.kills.filter((k) => k.attacker === id).length;
      deaths += 1;
      const zone = zoneAt(death.x, death.y, ctx.network);
      const lastKill = mineKills[mineKills.length - 1];
      let clause;
      if (lastKill && (death.tick - lastKill.tick) / r.tickRate <= TRADE_SECONDS) {
        clause = say('pl-worst-kill-refragged', r.file, { p: name });
      } else if (mineKills.length) {
        clause = say('pl-worst-one-then-dies', r.file, {
          p: name,
          enemy: read.names(death.attacker),
          zone: zone ? ` on ${zone}` : ''
        });
      } else {
        clause = say('pl-worst-no-kill', r.file, { p: name, enemy: read.names(death.attacker), zone: zone ? ` on ${zone}` : '' });
      }
      const flag = read.weighted.find((w) => w.f.playerId === id && Math.abs(w.f.tick - death.tick) <= 2);
      const why = flag ? say(`why-${flag.f.rule}`, r.file) : '';
      if (why) clause = `${clause}, ${why}`;
      notes.push({
        file: r.file,
        title: roundTitle(r),
        note: `${sentence(clause, namesIn(coach, ctx)).replace(/\.$/, '')} (${kills}-${deaths}).`
      });
    }
    // What the flagged mistakes on this player mostly were.
    const cats = new Map();
    for (const r of sideRounds) {
      for (const f of coached.get(r.file).flags) {
        if (f.playerId !== id || f.category === COACH_CATEGORY.PRAISE) continue;
        cats.set(f.category, (cats.get(f.category) || 0) + 1);
      }
    }
    const topCats = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    const WHY = {
      [COACH_CATEGORY.MECHANICAL]: 'a lack of awareness in the moment',
      [COACH_CATEGORY.CARELESSNESS]: 'a slight overextension',
      [COACH_CATEGORY.QUALITY]: 'spacing that leaves the duel untradable',
      [COACH_CATEGORY.SYNCHRONIZATION]: 'moving before the team is ready'
    };
    const why = joinList(topCats.map((c) => WHY[c]).filter(Boolean), 'or') || 'a lack of awareness in the moment';
    const openWins = ctx.rounds.filter((r) => r.side === side && r.firstKill?.attacker === id).length;
    const best = openWins >= 3 ? say('pl-impact-opens', seed, { name }) : say('pl-impact-trades', seed);
    out.worst = {
      name,
      text: say('pl-worst', seed, {
        name,
        side,
        rating: s.rating.toFixed(2),
        kd: s.kd.toFixed(2),
        kast: s.kast.toFixed(1)
      }),
      rounds: notes,
      conclusion: say('pl-worst-concl', seed, { name, side, map: mapName, best, why })
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conclusion
// ---------------------------------------------------------------------------

function sideRecord(rounds, side) {
  const set = rounds.filter((r) => r.side === side);
  const wins = set.filter((r) => r.won).length;
  return { rounds: set.length, wins, winrate: percent(wins, set.length) };
}

function conclusionReport(ctx, coached, officialIds, games) {
  const seed = `${ctx.seed}|conclusion`;
  const practice = ctx.rounds.filter((r) => !officialIds?.has(r.demoId));
  const official = ctx.rounds.filter((r) => officialIds?.has(r.demoId));
  const base = practice.length ? practice : ctx.rounds;
  const t = sideRecord(base, 'T');
  const ct = sideRecord(base, 'CT');
  const parts = [];
  const gamesWord = plural(games, 'game');
  const mapName = MAPS[ctx.mapCode]?.name || ctx.mapCode;
  const offT = sideRecord(official, 'T');
  const offCT = sideRecord(official, 'CT');
  const first = [];
  if (official.length && Math.abs(offT.winrate - t.winrate) <= 6 && Math.abs(offCT.winrate - ct.winrate) <= 6) {
    first.push(say('cc-practice-official', seed, { team: ctx.teamName }));
  }
  const strong = t.winrate >= ct.winrate ? 'T' : 'CT';
  const weak = strong === 'T' ? 'CT' : 'T';
  const strongRec = strong === 'T' ? t : ct;
  const weakRec = strong === 'T' ? ct : t;
  if (strongRec.winrate - weakRec.winrate >= 10) {
    first.push(
      say('cc-strong-weak', seed, {
        strong,
        weak,
        strongWr: strongRec.winrate,
        weakWr: weakRec.winrate,
        games: gamesWord,
        team: ctx.teamName
      })
    );
  } else {
    first.push(say('cc-both', seed, { team: ctx.teamName, tWr: t.winrate, ctWr: ct.winrate, map: mapName, games: gamesWord }));
  }
  if (official.length) first.push(say('cc-official-rates', seed, { tWr: offT.winrate, ctWr: offCT.winrate }));
  parts.push(first.join(' '));

  // How many of the weaker side's lost full buys carry a flagged mistake.
  const lost = ctx.rounds.filter((r) => r.side === weak && !r.won && r.ownEcon >= 4 && coached.has(r.file));
  const fixable = lost.filter((r) => readRound(r, coached.get(r.file), ctx).flags.length > 0).length;
  if (lost.length >= 4) {
    const share = percent(fixable, lost.length);
    parts.push(say(share >= 50 ? 'int-fixable' : 'int-fixable-some', seed, { side: weak, share }));
  }

  parts.push(say('int-benchmark', seed));
  const line = (wr) => {
    const frac = (wr / 100).toFixed(2);
    const r = Math.round(21 * (wr / 100) * 100) / 100;
    const diff = r - 10.5;
    return say('int-math-line', seed, {
      wr,
      frac,
      rounds: r,
      diff: Math.abs(diff) > 0.001 && wr !== 50 ? ` (${diff > 0 ? '+' : ''}${diff.toFixed(2)})` : ''
    });
  };
  const all = sideRecord(base, 'T').rounds + sideRecord(base, 'CT').rounds;
  const allWins = sideRecord(base, 'T').wins + sideRecord(base, 'CT').wins;
  const overall = percent(allWins, all);
  parts.push([say('int-math-game', seed), line(50), line(56), overall !== 50 && overall !== 56 ? line(overall) : '']
    .filter(Boolean)
    .join('\n'));
  // One round per half is about a tenth of a side's rounds.
  const perSide = 10.5;
  parts.push(
    say('int-math-one', seed, {
      side: weak,
      team: ctx.teamName,
      map: mapName,
      one: Math.min(100, Math.round(weakRec.winrate + 100 / perSide)),
      two: Math.min(100, Math.round(weakRec.winrate + 200 / perSide))
    })
  );

  // What to work on: the categories the lost rounds were flagged with most.
  const cats = new Map();
  for (const r of ctx.rounds.filter((x) => !x.won && coached.has(x.file))) {
    const primary = readRound(r, coached.get(r.file), ctx).primary;
    if (primary) cats.set(primary.category, (cats.get(primary.category) || 0) + 1);
  }
  const focus = [...cats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([c]) => say(`focus-${c}`, seed))
    .filter(Boolean);
  // Two focus areas read as a list; joined with a plain "and" they run together.
  const focusText = focus.length > 1 ? `${focus[0]}, as well as ${focus[1]}` : focus[0] || say('focus-default', seed);
  parts.push(say('int-closing', seed, { focus: focusText }));
  return { paragraphs: parts };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Everything the internal report prints, as data.
 *
 * @param {{
 *   results: object,            antistrat scan output with `extract`
 *   payload: object,            stats payload over the same demos, INTERNAL_COLUMNS
 *   teamKey: string,
 *   teamName: string,
 *   mapCode: string,
 *   coached: Map<string, object>,  from coachRounds
 *   officialIds?: Set<string>
 * }} input
 */
export function buildInternalReport({ results, payload, teamKey, teamName, mapCode, coached, officialIds }) {
  const extract = results.extract;
  const ctx = {
    ...extract,
    mapCode,
    teamName,
    seed: `${teamName}|${mapCode}|internal`,
    names: [...(extract.nameOf?.values?.() || [])]
  };
  const maps = indexMaps(payload || { demos: [] });
  const key = teamNameKey(teamKey || teamName);
  const grid = teamMapRoundGrid(payload, key, FULL_VS_FULL, maps.players, maps.demos)[mapCode];
  const games = new Set(ctx.rounds.map((r) => r.demoId)).size;
  const out = {
    teamName,
    mapCode,
    games,
    positions: results.sections?.positions || [],
    players: ctx.mains.map((m) => m.name),
    sides: {},
    conclusion: null
  };
  for (const side of ['T', 'CT']) {
    const tables = tablesFor(grid, side);
    const ratings = ratingsFor(payload, ctx, side, maps);
    out.sides[side] = {
      tables,
      notes: notesFor(ctx, side, tables, coached),
      ratings,
      players: playerNotesFor(ctx, side, ratings, coached, payload, maps, officialIds)
    };
  }
  out.conclusion = conclusionReport(ctx, coached, officialIds, games);
  return out;
}

/** Every round file the report may write about, for the coach pass. */
export function internalCoachFiles(results) {
  return (results.extract?.rounds || []).filter((r) => r.ownEcon >= 4).map((r) => r.file);
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const LINK_FILES_MAX = 40;

const LINK_STYLE = 'color: inherit; text-decoration: underline dotted';

function link(esc, label, files) {
  const list = (files || []).filter(Boolean).slice(0, LINK_FILES_MAX);
  if (!list.length) return label;
  // In the text's own colour with a dotted line: these documents read like a
  // coach's sheet, and a page of accent-coloured numbers does not.
  return `<a href="${esc(`/demos?rounds=${list.map(encodeURIComponent).join(',')}`)}" style="${LINK_STYLE}">${label}</a>`;
}

const colored = (html, color) => (color ? `<span style="color: ${color}">${html}</span>` : html);
const li = (items) => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');

function table(head, rows) {
  if (!rows.length) return '';
  const cells = (list, tag) => list.map((c) => `<${tag}>${c}</${tag}>`).join('');
  return `<table><thead><tr>${cells(head, 'th')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cells(r, 'td')}</tr>`)
    .join('')}</tbody></table>`;
}

const pctCell = (n) => (Number.isFinite(n) ? `${Math.round(n)}%` : '––');

/** The win rate cell: small samples say how small, the two biggest say how big. */
function winrateCell(row, big) {
  const c = row.cell;
  const base = pctCell(c.winrate);
  if (c.rounds <= 4) return `${base} (${c.wins} of ${c.rounds})`;
  if (big.has(row.key)) return `${base} (${c.rounds} rounds)`;
  return base;
}

function roundTableHtml(esc, title, rows) {
  if (!rows.length) return '';
  const big = new Set([...rows].sort((a, b) => b.cell.rounds - a.cell.rounds).slice(0, 2).map((r) => r.key));
  return `<p><strong>${esc(title)}</strong></p>${table(
    ['Name', 'WR', 'OPK', '5v4', '4v5'],
    rows.map((row) => [
      link(esc, esc(row.label), row.cell.files),
      winrateCell(row, big),
      pctCell(row.cell.opkRate),
      pctCell(row.cell.conv5v4),
      pctCell(row.cell.conv4v5)
    ])
  )}`;
}

function ratingTableHtml(esc, title, side, players, block) {
  if (!block.rows.length) return '';
  const head = [colored(esc(title), SIDE_COLOR[side]), ...players.map((p) => colored(esc(p), SIDE_COLOR[side])), colored('Team avg', SIDE_COLOR[side])];
  const val = (v) => (Number.isFinite(v) ? colored(v.toFixed(2), ratingColor(v)) : '––');
  const rows = block.rows.map((r) => [esc(r.label), ...r.values.map(val), val(r.avg)]);
  rows.push(['<strong>Player Average</strong>', ...block.playerAvg.map(val), val(block.teamAvg)]);
  return table(head, rows);
}

function roundList(esc, block, bullets = true) {
  const items = block.rounds.map((r) => `${link(esc, `<strong>${esc(r.title)}:</strong>`, [r.file])} ${esc(r.note)}`);
  if (bullets) return li(items);
  return items.map((x) => `<p>${x}</p>`).join('');
}

const anchor = (id) => ` id="${id}"`;

/**
 * @param {{
 *   teamName: string,
 *   mapCode: string,
 *   categories: string[],
 *   report: ReturnType<typeof buildInternalReport>
 * }} spec
 * @param {(s: string) => string} esc
 */
export function buildInternalDocHtml(spec, esc) {
  const report = spec.report;
  const cats = new Set(spec.categories || []);
  const mapName = MAPS[spec.mapCode]?.name || spec.mapCode;
  const parts = [];
  parts.push(`<h1 style="font-size: 25px">${esc(`${spec.teamName}: ${mapName}`.toUpperCase())}</h1>`);
  parts.push(
    li(
      (report.positions || []).map(
        (p) =>
          `${esc(p.name)}: T ${esc(p.tRole || 'unknown')}, CT ${esc(p.ctRole || 'unknown')} (${plural(p.matches, 'match', 'matches')})`
      )
    )
  );

  // Contents, linking into the document.
  const toc = [];
  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    toc.push(`<a style="${LINK_STYLE}" href="#${side.toLowerCase()}-side"><strong>${side} SIDE</strong></a>`);
    if (cats.has('tables') || cats.has('notes')) {
      toc.push(`&nbsp;&nbsp;&nbsp;&nbsp;<a style="${LINK_STYLE}" href="#${side.toLowerCase()}-full">${side} SIDE, FULL BUY vs FULL BUY</a>`);
    }
    if (cats.has('players')) toc.push(`&nbsp;&nbsp;&nbsp;&nbsp;<a style="${LINK_STYLE}" href="#${side.toLowerCase()}-notes">${side} SIDE NOTES</a>`);
  }
  if (cats.has('conclusion')) toc.push(`<a style="${LINK_STYLE}" href="#conclusion"><strong>Conclusion</strong></a>`);
  if (toc.length) parts.push(`<p>${toc.join('<br>')}</p><hr>`);

  for (const side of ['T', 'CT']) {
    if (!cats.has(side === 'T' ? 'sideT' : 'sideCT')) continue;
    const bag = report.sides[side];
    const lower = side.toLowerCase();
    parts.push(`<h1 style="font-size: 25px"${anchor(`${lower}-side`)}>${side} SIDE</h1>`);
    if (cats.has('tables')) {
      parts.push(`<h2 style="font-size: 19px"${anchor(`${lower}-full`)}>${side} SIDE, FULL BUY vs FULL BUY</h2>`);
      parts.push(roundTableHtml(esc, `Own strategies as ${side}`, bag.tables.own));
      parts.push(
        roundTableHtml(esc, side === 'T' ? 'Facing (x) round/setup by CTs' : 'Facing (x) round by Ts', bag.tables.faced)
      );
    }
    if (cats.has('notes')) parts.push(notesHtml(esc, bag.notes, side, cats.has('tables')));
    if (cats.has('ratings')) {
      parts.push(`<h2 style="font-size: 19px">${side} PLAYER RATINGS</h2>`);
      parts.push(ratingTableHtml(esc, `Own strategies ${side}`, side, bag.ratings.players, bag.ratings.own));
      parts.push(ratingTableHtml(esc, side === 'T' ? 'Facing (x) setup' : 'Facing (x) round', side, bag.ratings.players, bag.ratings.faced));
    }
    if (cats.has('players')) parts.push(playerNotesHtml(esc, bag.players, side, bag.ratings.players));
  }

  if (cats.has('conclusion') && report.conclusion) {
    parts.push(`<h1 style="font-size: 25px"${anchor('conclusion')}>Conclusion</h1>`);
    for (const p of report.conclusion.paragraphs) {
      parts.push(`<p>${p.split('\n').map(esc).join('<br>')}</p>`);
    }
  }
  return parts.join('');
}

function notesHtml(esc, notes, side, tablesShown) {
  const parts = [];
  if (!notes.weakest && !notes.punishing.length && !notes.random) return '';
  parts.push(`<h2 style="font-size: 19px">${side} SIDE, FULL BUY vs FULL BUY DETAILED NOTES</h2>`);
  if (tablesShown) parts.push(`<p>${esc(say('int-intro', side))}</p>`);
  const weakest = notes.weakest
    ? link(esc, esc(`${notes.weakest.label} (${notes.weakest.winrate}% winrate)`), notes.weakest.files)
    : esc(say('int-no-weak', side));
  parts.push(`<p><strong>${esc(say('int-weakest', side))}</strong><br>${weakest}</p>`);
  const punish = notes.punishing.length
    ? notes.punishing.map((p) => link(esc, esc(`${p.label} (${p.winrate}% winrate)`), p.files)).join('<br>')
    : esc(say('int-no-punishing', side));
  parts.push(`<p><strong>${esc(say('int-punishing', side))}</strong><br>${punish}</p>`);
  if (notes.restFine) parts.push(`<p>${esc(say('int-rest-fine', side))}</p>`);

  if (notes.own?.rounds.length) {
    parts.push(`<p><strong>${esc(say('int-start-own', side, { call: notes.own.label }))}</strong></p>`);
    parts.push(roundList(esc, notes.own));
    if (notes.own.conclusion) parts.push(`<p><strong>Conclusion:</strong> ${esc(notes.own.conclusion)}</p>`);
  }
  for (const block of notes.faced) {
    const intro = block.first
      ? say('int-start-faced', side, { n: block.rounds.length, call: block.label })
      : say('int-couple-examples', side, { call: block.label });
    parts.push(`<p>${esc(intro)}</p>`);
    parts.push(roundList(esc, block));
    if (block.conclusion) parts.push(`<p><strong>Conclusion:</strong> ${esc(block.conclusion)}</p>`);
  }
  if (notes.random) {
    parts.push(`<p>${esc(say('int-random-intro', side))}</p>`);
    parts.push(roundList(esc, notes.random, false));
    parts.push(`<p>${esc(capitalize(notes.random.thread))}</p>`);
  }
  return parts.join('');
}

function playerNotesHtml(esc, notes, side, players) {
  if (!notes.best && !notes.worst && !notes.officials) return '';
  const parts = [`<h2 style="font-size: 19px"${anchor(`${side.toLowerCase()}-notes`)}>${side} SIDE NOTES</h2>`];
  if (notes.best) {
    parts.push(`<p>${esc(notes.best.text)}</p>`);
    if (notes.best.clean) parts.push(`<p>${esc(notes.best.clean)}</p>`);
  }
  if (notes.officials) {
    parts.push(`<p>${esc(notes.officials.text)}</p>`);
    const val = (v) => (Number.isFinite(v) ? colored(v.toFixed(2), ratingColor(v)) : '––');
    parts.push(
      table(
        [colored(`${side} Side`, SIDE_COLOR[side]), ...players.map((p) => colored(esc(p), SIDE_COLOR[side])), colored('Team avg', SIDE_COLOR[side])],
        [['Rating / Player', ...notes.officials.values.map(val), val(notes.officials.avg)]]
      )
    );
  }
  if (notes.worst) {
    parts.push(`<p>${esc(notes.worst.text)}</p>`);
    parts.push(
      li(notes.worst.rounds.map((r) => `${link(esc, `<strong>${esc(r.title)}:</strong>`, [r.file])} ${esc(r.note)}`))
    );
    parts.push(`<p><strong>Conclusion:</strong></p><p>${esc(notes.worst.conclusion)}</p>`);
  }
  return parts.join('');
}
