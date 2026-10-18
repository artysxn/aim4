// ---------------------------------------------------------------------------
// replays/eye/roundStory.js
// One round as a story the model can tell: where every player went and when,
// the shape of both teams every ten seconds, the utility and where it landed,
// the kills and where they happened, the plant, and how the round's pace
// compares with the same team's other rounds of the same kind.
//
// The input is one antistratScan `roundFeatures` record (the scouted team's
// view of a round: its players as `pts`, the other team as `opp`, sampled
// every second) and the zone network of the map. Nothing here fetches.
//
// Why: asked "what happened" or "what differentiates these rounds", the model
// only had a kill list and buy codes, so it compared buys and winners and
// guessed the pace from the kills ("a fast push" for a round the team stood
// still in for a minute). Positions over time are what a round is.
// ---------------------------------------------------------------------------

import { classifyPace, paceSite } from '../analytics/antistratScan.js';
import { ROUND_SECONDS } from '../viewer/roundClock.js';

/** A place has to be held this many seconds before it counts as a move (a step through a doorway is not). */
const HOLD_SECONDS = 2;
/** Seconds between two formation lines. */
const FORMATION_EVERY = 10;
/** Lines kept in the event list; the rest are summarised. */
const MAX_EVENTS = 110;

const NADE_WORD = { smokegrenade: 'smoke', molotov: 'molotov', incgrenade: 'molotov', flashbang: 'flash', hegrenade: 'HE' };
const BUY_WORD = ['pistol', 'eco', 'half buy', 'force buy', 'full buy'];

/** Seconds left on the round clock as "1:35". */
export function clockText(secondsLeft) {
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Position name -> { zone, area } from a map's zone network. A position in no
 * zone is its own zone; a zone in no area is its own area.
 */
export function placeIndex(network) {
  const posName = new Map((network?.positions || []).map((p) => [p.id, p.name]));
  const out = new Map();
  for (const p of network?.positions || []) out.set(p.name, { zone: p.name, area: p.name });
  const zoneOfPos = new Map();
  for (const z of network?.zones || []) {
    for (const id of z.positionIds || []) {
      const n = posName.get(id);
      if (!n) continue;
      zoneOfPos.set(n, z);
      out.set(n, { zone: z.name, area: z.name });
    }
  }
  for (const a of network?.areas || []) {
    const zoneIds = new Set(a.zoneIds || []);
    for (const [n, z] of zoneOfPos) if (zoneIds.has(z.id)) out.set(n, { ...out.get(n), area: a.name });
    for (const id of a.positionIds || []) {
      const n = posName.get(id);
      if (n) out.set(n, { zone: out.get(n)?.zone || n, area: a.name });
    }
  }
  return out;
}

/** Grenades closer together than this, from 2+ players, are one burst of utility. */
const EXECUTE_SPAN = 8;

/**
 * The execute in a side's grenades: the densest burst of utility, at least 3
 * grenades from at least 2 players inside EXECUTE_SPAN seconds. On a tie the
 * later burst wins: early map-control utility comes first, the execute after.
 *
 * @param {Array<{ t: number, player: string }>} throws  seconds since the round went live
 * @returns {{ start: number, end: number, count: number, throwers: number } | null}
 */
export function findExecute(throws) {
  const list = [...throws].filter((g) => Number.isFinite(g.t)).sort((a, b) => a.t - b.t);
  let best = null;
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].t - list[i].t <= EXECUTE_SPAN) j++;
    const burst = list.slice(i, j + 1);
    const throwers = new Set(burst.map((g) => g.player)).size;
    if (burst.length < 3 || throwers < 2) continue;
    // A window starting inside the best burst is the same burst missing its first grenade: only a
    // separate, later burst of the same size replaces it.
    if (!best || burst.length > best.count || (burst.length === best.count && burst[0].t > best.end)) {
      best = { start: burst[0].t, end: burst.at(-1).t, count: burst.length, throwers };
    }
  }
  return best;
}

/** The buy class a comparison groups by: eco and pistol, half and force, full. */
const buyClass = (econ) => (econ >= 4 ? 'full' : econ >= 2 ? 'force' : 'eco');

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** How a round's own pace numbers are read: the first time 2+ players stood on a site, the first kill, utility out by 1:20. */
function paceNumbers(r) {
  const entry = r.siteEntry?.(2) || null;
  const byClock = (clock) => r.nades.filter((n) => n.clock >= clock).length;
  return {
    pace: r.side === 'T' ? classifyPace(r) || 'other' : '',
    site: r.side === 'T' ? String(paceSite(r) || '').toUpperCase() : String(r.hitSite || '').toUpperCase(),
    entryClock: entry ? entry.clock : null,
    firstKillClock: r.firstKill ? r.firstKill.clock : null,
    utilityBy120: byClock(80),
    plantClock: r.plantClock ?? null
  };
}

/** "later than 9 of 11" for a clock value (a lower clock is later in the round). */
function rankWords(value, others, { later = 'later', earlier = 'earlier' } = {}) {
  const v = others.filter((x) => Number.isFinite(x));
  if (!Number.isFinite(value) || !v.length) return '';
  const after = v.filter((x) => x > value).length;
  const before = v.filter((x) => x < value).length;
  if (after >= before) return `${later} than ${after} of ${v.length}`;
  return `${earlier} than ${before} of ${v.length}`;
}

/**
 * This round's pace against the same team's rounds of the same kind: same side,
 * same buy class for both teams. Pace is relative: "slow" only means something
 * against what this team usually does in this spot.
 */
export function comparePace(r, pool) {
  const mine = paceNumbers(r);
  const like = pool.filter((x) => x !== r && x.hasTicks && x.side === r.side && buyClass(x.ownEcon) === buyClass(r.ownEcon) && buyClass(x.oppEcon) === buyClass(r.oppEcon));
  const nums = like.map(paceNumbers);
  const counts = {};
  for (const n of nums) if (n.pace) counts[n.pace] = (counts[n.pace] || 0) + 1;
  const out = {
    this_round: {
      ...(mine.pace ? { pace: mine.pace } : {}),
      ...(mine.site ? { site: mine.site } : {}),
      first_on_a_site: mine.entryClock != null ? clockText(mine.entryClock) : 'never (no 2 players on a site)',
      first_kill: mine.firstKillClock != null ? clockText(mine.firstKillClock) : 'none',
      utility_thrown_by_1_20: mine.utilityBy120,
      ...(mine.plantClock != null ? { plant: clockText(mine.plantClock) } : {})
    },
    compared_with: `${like.length} other ${r.side} round${like.length === 1 ? '' : 's'} of this team on this map with the same buys (${buyClass(r.ownEcon)} vs ${buyClass(r.oppEcon)})`
  };
  if (like.length) {
    const entryMed = median(nums.map((n) => n.entryClock));
    const killMed = median(nums.map((n) => n.firstKillClock));
    const utilMed = median(nums.map((n) => n.utilityBy120));
    out.usual = {
      ...(Object.keys(counts).length ? { paces: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') } : {}),
      first_on_a_site: entryMed != null ? clockText(entryMed) : 'n/a',
      first_kill: killMed != null ? clockText(killMed) : 'n/a',
      utility_thrown_by_1_20: utilMed
    };
    const reading = [];
    const e = rankWords(mine.entryClock, nums.map((n) => n.entryClock));
    if (e) reading.push(`onto a site ${e}`);
    const k = rankWords(mine.firstKillClock, nums.map((n) => n.firstKillClock));
    if (k) reading.push(`first kill ${k}`);
    const u = nums.filter((n) => n.utilityBy120 < mine.utilityBy120).length;
    reading.push(`more utility by 1:20 than ${u} of ${nums.length}`);
    out.reading = `This round went ${reading.join('; ')}.`;
  }
  return out;
}

/**
 * The round as text.
 *
 * @param {object} r            roundFeatures record (scouted team = "ours")
 * @param {object} opts
 * @param {Map<string,string>} opts.names   player id -> name
 * @param {object} opts.network             the map's zone network
 * @param {string} opts.ours                the scouted team's name
 * @param {string} opts.theirs              the other team's name
 * @param {object[]} [opts.pool]            the scouted team's other rounds on this map (for pace)
 */
export function roundStory(r, { names, network, ours, theirs, pool = [], window = [0, ROUND_SECONDS] }) {
  const [w0, w1] = [Math.min(...window), Math.max(...window)];
  const inWindow = (elapsed) => elapsed >= w0 - 0.5 && elapsed <= w1 + 0.5;
  const places = placeIndex(network);
  const nameOf = (id) => names?.get?.(id) || id;
  const zoneOf = (pos) => (pos ? places.get(pos)?.zone || pos : '');
  const sideOurs = r.side;
  const sideTheirs = r.side === 'T' ? 'CT' : 'T';
  const teamWord = (isOurs) => `${isOurs ? ours : theirs} (${isOurs ? sideOurs : sideTheirs})`;
  const events = [];
  const push = (elapsed, text) => events.push({ elapsed, text });

  // Moves: a player's callout (the painted position, "Car", "Pit", "Bottom mid"), counted once held
  // HOLD_SECONDS, one line per team per second. Zones and areas are groupings ("Mid + A", "T_A")
  // that read like nothing a player would call.
  if (r.hasTicks && r.series?.length) {
    for (const [key, isOurs] of [['pts', true], ['opp', false]]) {
      const held = new Map();
      const pending = new Map();
      const bySecond = new Map();
      for (const s of r.series) {
        for (const p of s[key] || []) {
          const zone = p.pos || '';
          if (!zone) continue;
          const was = held.get(p.id);
          if (was === zone) {
            pending.delete(p.id);
            continue;
          }
          const pend = pending.get(p.id);
          if (!pend || pend.zone !== zone) {
            pending.set(p.id, { zone, since: s.elapsed });
            continue;
          }
          if (s.elapsed - pend.since + 1 >= HOLD_SECONDS) {
            held.set(p.id, zone);
            pending.delete(p.id);
            const at = Math.round(pend.since);
            if (!bySecond.has(at)) bySecond.set(at, []);
            bySecond.get(at).push(`${nameOf(p.id)} ${was ? '→ ' : 'at '}${zone}`);
          }
        }
      }
      for (const [at, moves] of bySecond) push(at, `${teamWord(isOurs)}: ${moves.join('; ')}`);
    }
  }

  // Utility, both teams, where it landed.
  for (const [list, isOurs] of [[r.nades || [], true], [r.enemyNades || [], false]]) {
    for (const n of list) {
      const where = n.label || n.zone || 'open ground';
      push(Number.isFinite(n.throwAt) ? n.throwAt : n.at, `${teamWord(isOurs)}: ${nameOf(n.player)} ${NADE_WORD[n.type] || n.type} → ${where}`);
    }
  }

  // Kills, with where both ends stood.
  for (const k of r.kills || []) {
    const from = k.attackerZone ? ` (${zoneOf(k.attackerZone) || k.attackerZone})` : '';
    const at = k.victimZone ? ` (${zoneOf(k.victimZone) || k.victimZone})` : '';
    const extra = [k.throughSmoke ? 'through smoke' : '', k.attackerBlind ? 'while blind' : ''].filter(Boolean).join(', ');
    push(ROUND_SECONDS - k.clock, `KILL ${nameOf(k.attacker)}${from} killed ${nameOf(k.victim)}${at}, ${String(k.weapon).replace(/^weapon_/, '')}${extra ? `, ${extra}` : ''}`);
  }

  if (r.plantClock != null) push(ROUND_SECONDS - r.plantClock, `BOMB planted${r.plantSite ? ` on ${r.plantSite.toUpperCase()}` : ''}`);

  events.sort((a, b) => a.elapsed - b.elapsed);
  const lines = events.filter((e) => inWindow(e.elapsed)).map((e) => `${clockText(ROUND_SECONDS - e.elapsed)} ${e.text}`);
  const cut = lines.length > MAX_EVENTS ? lines.length - MAX_EVENTS : 0;

  // Formations: where each team stood, by zone, every FORMATION_EVERY seconds.
  const formations = [];
  if (r.hasTicks && r.series?.length) {
    const shape = (pts) => {
      const groups = new Map();
      for (const p of pts) {
        const a = zoneOf(p.pos) || 'unknown';
        if (!groups.has(a)) groups.set(a, []);
        groups.get(a).push(nameOf(p.id));
      }
      return [...groups.entries()]
        .sort((x, y) => y[1].length - x[1].length)
        .map(([a, who]) => `${a} ${who.length}${who.length <= 2 ? ` (${who.join(', ')})` : ''}`)
        .join(', ');
    };
    for (const s of r.series) {
      const e = Math.round(s.elapsed);
      if (e % FORMATION_EVERY !== 0 || !inWindow(s.elapsed)) continue;
      const left = clockText(ROUND_SECONDS - s.elapsed);
      formations.push(`${left} ${ours}: ${shape(s.pts) || 'all dead'} | ${theirs}: ${shape(s.opp || []) || 'all dead'}`);
      if (!s.pts.length || !(s.opp || []).length) break;
    }
  }

  return {
    sides: `${ours} ${sideOurs}, ${theirs} ${sideTheirs}`,
    buys: `${ours} ${BUY_WORD[r.ownEcon] || r.ownEcon}, ${theirs} ${BUY_WORD[r.oppEcon] || r.oppEcon}`,
    result: `${r.won ? ours : theirs} won${r.plantSite ? `, bomb planted on ${r.plantSite.toUpperCase()}` : ''}`,
    has_positions: Boolean(r.hasTicks),
    pace: comparePace(r, pool),
    formations,
    events: cut ? [...lines.slice(0, MAX_EVENTS), `… ${cut} later events left out`] : lines
  };
}
