// ---------------------------------------------------------------------------
// replays/eye/eyeTools.js
// What aim4 eye can do: the tools the model calls, and the code behind them.
//
// Every tool runs here, in the page, on the same code the rest of the site
// runs (the roster catalogue, the stats payload, the antistrat scan and
// summary, the document store). The model only decides which to call and with
// what; it never sees a number that did not come back from one of these.
//
//   list_teams                 teams in the library and the maps they have demos on
//   map_zones                  the callout names a map knows (positions, zones, areas)
//   query_rounds               count rounds of a team on a map that match conditions
//   antistrat_summary          the antistrat sheet for a team on a map, as points
//   create_antistrat_document  write antistrat documents into the user's team docs
//                              (asks the user first)
//   database_query             the Database: players and teams, pooled over any filter
//   list_matches               the matches (one per demo), newest first or at random
//   match_summary              one match: score, halves, completeness, players' stats in it
//   find_rounds                search the library's rounds (match, teams, players, map, buys)
//   round_details              one round's record: kills, grenades, bomb, score
//   team_documents             list and read the user's team documents
//   team_rankings              the VRS world ranking
//   site_map                   every page of the site, with links to cite
//   find_weaknesses            where a team loses on a map and side, measured and ranked
//   review_antistrat_document  check a document against the data and itself
//   rewrite_antistrat_document save a reorganised version (asks the user first)
//   queue_antistrat_documents  several teams and maps, one document each, in a row
//                              (asks the user once)
//   round_value                what each kill and plant of a round was worth: round win
//                              chance before and after, the gunfight's xK, who gained
//   moment_value               one clock time of a round: win chance, what makes it up,
//                              the open gunfights and each fighter's xK at that tick
//   screenshot_round           (vision only) one moment of a round, as a picture
// ---------------------------------------------------------------------------

import {
  fetchAggregate,
  fetchAggregateForRounds,
  fetchRoster,
  fetchRoundMeta,
  fetchRoundTicks,
  fetchTeamDocument,
  fetchTeams,
  fetchUtilityArchive,
  saveTeamStrategy,
  saveUtilityArchive,
  fetchVrsRanks,
  findRounds,
  saveTeamDocument
} from '../api.js';
import { screenshotRound } from './eyeVision.js';
import { momentValueTool, roundValueTool } from './eyeValue.js';
import { noteRounds, roundIdsIn } from './roundRefs.js';
import { getStatsPayload } from '../statsCache.js';
import { buyBucket, MAPS } from '../shared/roundId.js';
import { splitStoredName } from '../shared/roundFilter.js';
import { teamNameKey } from '../shared/statsMath.js';
import { PLAYER_COLUMN_INFO, TEAM_COLUMN_INFO } from '../stats/columnCatalog.js';
import { listTeams } from '../analytics/analyticsMath.js';
import { loadMapContext, runAntistratScan } from '../analytics/antistratScan.js';
import { PACE_TYPES } from '../analytics/patternDefs.js';
import {
  SUMMARY_CATEGORIES,
  buildOutlineDocHtml,
  buildSixpackDocHtml,
  buildSummaryDocHtml,
  buildSummaryReport
} from '../analytics/antistratSummary.js';
import { opinionsFrom } from '../training/opinions.js';
import { pointsFromSummaryHtml } from '../training/trainingSources.js';
import { QueryError, runRoundQuery, zoneNames } from './roundQuery.js';
import { buildRewrite, outlineOfHtml, reviewOutline } from './docReview.js';
import { findWeaknesses } from './weaknesses.js';
import { findExecute, roundStory } from './roundStory.js';
import { ROUND_KINDS, classifyRound } from './roundTypes.js';
import { playerPatterns } from './playerPatterns.js';
import { loadRound } from './eyeRound.js';
import { relinkAgainst, resolveSeats, sidePlayers } from '../strategy/addStrategy.js';
import { foldRoundUtility } from '../strategy/utilityImport.js';
import { createNamer } from '../strategy/regionNames.js';
import { loadCoachSmokes } from '../coach/coachSmokes.js';
import { demosForPlayer } from '../shared/rosterQuery.js';
import { TickTrack } from '../tickStore.js';
import { timingFor } from '../viewer/roundClock.js';

/** A tool's answer is cut to this many characters before the model reads it. */
export const MAX_RESULT_CHARS = 12000;

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ---- the library -------------------------------------------------------------

let catalogue = null;
/** The roster catalogue as teams and their demos, fetched once a session. */
async function library() {
  if (!catalogue) {
    catalogue = (async () => {
      const roster = await fetchRoster();
      const players = roster?.players || [];
      const demos = (roster?.demos || []).map((d) => {
        const seats = [];
        const pairs = d.p || [];
        for (let i = 0; i < pairs.length; i += 2) {
          const p = players[pairs[i]];
          if (p?.i) seats.push({ id: p.i, name: p.n || p.i, team: pairs[i + 1] === 2 ? 2 : 1 });
        }
        return { id: d.id, map: d.m || '', t1: d.t1 || '', t2: d.t2 || '', name1: d.n1 || '', name2: d.n2 || '', uploadedAt: d.u || 0, players: seats, rounds: [] };
      });
      // Two matches with the same teams, map and day had the same name ("Phantom vs fnatic, Inferno,
      // 17 Oct"), and the model wrote up round 3 of the wrong one. Such matches get "(game 1)",
      // "(game 2)" in upload order, so every match's name says which one it is.
      const sameName = new Map();
      for (const d of demos) {
        const key = [[d.name1 || d.t1, d.name2 || d.t2].map((n) => String(n).toLowerCase()).sort().join('|'), d.map, shortDate(d.uploadedAt, false)].join('|');
        if (!sameName.has(key)) sameName.set(key, []);
        sameName.get(key).push(d);
      }
      for (const group of sameName.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0) || String(a.id).localeCompare(String(b.id)));
        group.forEach((d, i) => (d.game = i + 1));
      }
      const payload = { demos, identityOnly: true };
      const names = new Map(players.filter((p) => p.i).map((p) => [p.i, p.k || p.n || p.i]));
      return { payload, teams: listTeams(payload), names };
    })().catch((err) => {
      catalogue = null;
      throw err;
    });
  }
  return catalogue;
}

/** "Nuke", "de_nuke", "nuk" -> "NUK". */
export function mapCodeOf(value) {
  // "Nuke T" / "Nuke CT side": a side slipped into the map name.
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^de_/, '')
    .replace(/\s+(t|ct)(\s+side)?$/, '');
  for (const [code, m] of Object.entries(MAPS)) {
    if (code.toLowerCase() === v || String(m.name || '').toLowerCase() === v || String(m.file || '').toLowerCase().replace(/^de_/, '') === v) return code;
  }
  throw new ToolError(`Unknown map "${value}". Maps: ${Object.values(MAPS).map((m) => m.name).join(', ')}.`);
}

export class ToolError extends Error {}

/** A team by name: exact first, then the only one whose name contains it. */
async function teamOf(name) {
  const { teams } = await library();
  const q = String(name || '').trim().toLowerCase();
  if (!q) throw new ToolError('Name a team.');
  const exact = teams.filter((t) => t.name.toLowerCase() === q || t.key === q);
  if (exact.length === 1) return exact[0];
  const near = teams.filter((t) => t.name.toLowerCase().includes(q));
  if (near.length === 1) return near[0];
  if (!near.length) throw new ToolError(`No team called "${name}" in the library. Call list_teams to see the names.`);
  throw new ToolError(`"${name}" could be ${near.slice(0, 8).map((t) => t.name).join(', ')}. Use the exact name.`);
}

/** The ids a team plays under across the library's demos. */
function idsOfTeam(payload, team) {
  return new Set(
    payload.demos.flatMap((d) => [
      teamNameKey(d.name1, d.t1) === team.key ? d.t1 : '',
      teamNameKey(d.name2, d.t2) === team.key ? d.t2 : ''
    ]).filter(Boolean)
  );
}

/**
 * Team id -> team name across the library. A round file names its teams by
 * short per-demo ids ("AVg", "52C"); the model and the user need the name.
 */
function teamNames(payload) {
  const names = new Map();
  for (const d of payload.demos) {
    if (d.t1 && d.name1 && !names.has(d.t1)) names.set(d.t1, d.name1);
    if (d.t2 && d.name2 && !names.has(d.t2)) names.set(d.t2, d.name2);
  }
  return names;
}

/** The match (demo) a round file belongs to: its "~<demoId>" suffix, or '' for an old name without one. */
export const matchOfFile = (file) => splitStoredName(String(file || '')).demoId;

/** "Phantom vs fnatic, Ancient, 12 Oct" */
function matchLabel(d) {
  const date = shortDate(d.uploadedAt, false);
  return `${d.name1 || d.t1 || 'Team 1'} vs ${d.name2 || d.t2 || 'Team 2'}, ${MAPS[d.map]?.name || d.map}${date ? `, ${date}` : ''}${d.game ? ` (game ${d.game})` : ''}`;
}

/** A library match by id. */
async function matchById(id) {
  const { payload } = await library();
  const d = payload.demos.find((x) => String(x.id) === String(id || '').trim());
  if (!d) throw new ToolError(`No match with id "${id}". Use an id from list_matches.`);
  return d;
}

/**
 * Every round of one match the library has, in order. The match is the
 * "~<demoId>" on each round file; rounds from before that suffix existed
 * cannot be told apart from a rematch and are left out.
 */
const matchRounds = new Map();
async function roundsOfMatch(d) {
  const key = String(d.id);
  if (!matchRounds.has(key)) {
    matchRounds.set(
      key,
      findRounds({ maps: [d.map], teams: [d.t1, d.t2].filter(Boolean) }, 2000)
        .then((res) => (res.rounds || []).filter((r) => matchOfFile(r.file) === key).sort((a, b) => a.round - b.round))
        .catch((err) => {
          matchRounds.delete(key);
          throw err;
        })
    );
  }
  return matchRounds.get(key);
}

/** The stratbook's lists, the same the round viewer offers (timelineViewer.js). */
export const STRAT_ECONOMY = ['Pistol', 'Full buy', 'Full buy + AWP', 'Antiforce', 'Force', 'Eco'];
export const STRAT_CATEGORY_T = ['Pistol', 'Set call', 'Default', 'Opener', 'Midround', 'Lateround', 'Cheap exec'];
export const STRAT_CATEGORY_CT = ['Pistol', 'Set call', 'Default', 'Opener', 'Midround', 'Setup', 'Retake'];

/**
 * A note's grenade links, from the draft's tags to the archive's ids:
 * "<Window smoke><!t3>" becomes "<Window smoke><!ab12>". A tag with no stored
 * throw (or one the model made up) becomes the plain label, so a note never
 * links a throw that does not exist.
 */
export function linkStrategyTags(text, idOfTag) {
  let linked = 0;
  const out = String(text || '').replace(/<([^<>]+)><!([A-Za-z0-9_-]+)>/g, (_, label, tag) => {
    const real = idOfTag.get(tag);
    if (!real) return label;
    linked++;
    return `<${label}><!${real}>`;
  });
  return { text: out, linked };
}

/**
 * Link grenades a note names in plain words: the first "Long smoke" in a note
 * of the player who threw it becomes "<Long smoke><!t2>". Text already inside a
 * link is left alone, and each grenade is linked once.
 *
 * @param {string} text
 * @param {Array<{ tag: string, what: string }>} throws  the column player's own grenades
 */
export function autoLinkGrenades(text, throws) {
  let out = String(text || '');
  for (const t of throws) {
    if (!t.what || out.includes(`<!${t.tag}>`)) continue;
    const esc = t.what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Not inside an existing <...> label.
    const re = new RegExp(`(^|[^<\\w])(${esc})(?![^<]*>)`, 'i');
    out = out.replace(re, (_, pre, words) => `${pre}<${words}><!${t.tag}>`);
  }
  return out;
}

/** Strategies being written: draft id -> the round, columns, seats and grenades. */
const drafts = new Map();
let draftSeq = 0;

/** "1:35" from seconds left on the round clock. */
const clockText = (secondsLeft) => {
  const s = Math.max(0, Math.round(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** "The Golden Horde vs ynkesu, Cache, 14 Oct, round 4", or '' when the round's match is unknown. */
async function roundLabelOf(file) {
  try {
    const demoId = matchOfFile(file);
    if (!demoId) return '';
    const d = await matchById(demoId);
    const row = (await roundsOfMatch(d)).find((r) => r.file === file);
    return `${matchLabel(d)}${row ? `, round ${row.round}` : ''}`;
  } catch {
    return '';
  }
}

/** "1:30" (or 90) as seconds since the round went live; `fallback` when not given. */
function clockArg(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value));
  const left = m ? Number(m[1]) * 60 + Number(m[2]) : Number(value);
  if (!Number.isFinite(left)) throw new ToolError(`"${value}" is not a round clock. Use for example 1:30.`);
  return 115 - left;
}

/** "first half" (rounds 1-12), "second half" (13-24), "overtime 1" (25-30) ... */
export const halfOf = (n) => (n <= 12 ? 'first half' : n <= 24 ? 'second half' : `overtime ${Math.ceil((n - 24) / 6)}`);

/** A match round's winner by team name; round files seat the teams either way round. */
const winnerNameIn = (d) => (r) => {
  const id = r.winner === 1 ? r.team1 : r.team2;
  return id === d.t1 ? d.name1 || d.t1 : id === d.t2 ? d.name2 || d.t2 : id;
};

/** The score going into each round of a match, from the rounds the library has. */
function scoresBefore(d, rounds) {
  const winner = winnerNameIn(d);
  const n1 = d.name1 || d.t1;
  const n2 = d.name2 || d.t2;
  const score = { [n1]: 0, [n2]: 0 };
  const out = new Map();
  const missing = rounds.length ? rounds[0].round - 1 : 0;
  for (const r of rounds) {
    out.set(r.file, `${n1} ${score[n1]} - ${score[n2]} ${n2}${missing ? ` (round${missing === 1 ? '' : 's'} 1${missing > 1 ? `-${missing}` : ''} not in the library)` : ''}`);
    const w = winner(r);
    score[w] = (score[w] || 0) + 1;
  }
  return out;
}

/** A round file from match + number, so the model never has to write one. */
async function fileOfMatchRound(match, number) {
  const d = await matchById(match);
  const rounds = await roundsOfMatch(d);
  const n = Math.round(Number(number));
  const hit = rounds.find((r) => r.round === n);
  if (!hit) {
    const have = rounds.map((r) => r.round);
    throw new ToolError(
      `${matchLabel(d)} has no round ${n} in the library. It has ${have.length} rounds: ${have.length ? `${have[0]} to ${have.at(-1)}` : 'none'}${have.length && have.at(-1) - have[0] + 1 !== have.length ? ' (some missing)' : ''}.`
    );
  }
  return hit.file;
}

/**
 * Is a CS2 score the end of a match? Regulation is MR12: first to 13, and 12-12
 * goes to overtime, played in blocks of 6 rounds (first to 4 of a block wins).
 */
export function matchComplete(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi === 13 && lo <= 11) return true;
  if (lo < 12) return false;
  // Overtime: after 12-12, each block of 6 is won at 4 (16-x, 19-x ...) unless it ties at 3-3.
  const over = hi - 12;
  return over % 3 === 1 && hi - lo >= 2;
}

/** What the composer's + menu can attach: team names and players of the library. */
export async function attachChoices() {
  const { teams } = await library();
  const roster = await fetchRoster();
  return {
    teams: teams.map((t) => t.name).sort((a, b) => a.localeCompare(b)),
    players: (roster?.players || []).filter((p) => p.i).map((p) => ({ id: p.i, name: p.k || p.n || p.i })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

/** The newest rounds a team played, for the + menu's round picker. */
export async function roundsOfTeam(teamName, limit = 30) {
  const { payload } = await library();
  const team = await teamOf(teamName);
  const res = await findRounds({ teams: [...idsOfTeam(payload, team)] }, 400);
  const names = teamNames(payload);
  return (res.rounds || []).slice(0, limit).map((r) => ({
    file: r.file,
    label: `${r.mapName} round ${r.round}, ${names.get(r.team1) || r.team1} vs ${names.get(r.team2) || r.team2}`
  }));
}

async function demosOf(team, mapCode) {
  const { payload } = await library();
  return payload.demos
    .filter((d) => d.map === mapCode && (teamNameKey(d.name1, d.t1) === team.key || teamNameKey(d.name2, d.t2) === team.key))
    .map((d) => d.id);
}

/** Scans are the slow part (seconds per map); one per team and map a session. */
const scans = new Map();
async function teamScan(teamName, map, onProgress) {
  const team = await teamOf(teamName);
  const mapCode = mapCodeOf(map);
  const key = `${team.key}|${mapCode}`;
  if (!scans.has(key)) {
    scans.set(
      key,
      (async () => {
        const demoIds = await demosOf(team, mapCode);
        if (!demoIds.length) throw new ToolError(`${team.name} has no demos on ${MAPS[mapCode]?.name || mapCode}.`);
        const { names } = await library();
        onProgress?.(`Loading ${team.name} on ${MAPS[mapCode]?.name || mapCode}…`);
        const payload = await getStatsPayload(demoIds, { columns: ['roundLibrary', 'roles'] });
        const results = await runAntistratScan({
          properNames: names,
          payload,
          teamKey: team.key,
          mapCode,
          demoIds,
          paceKeys: PACE_TYPES.map((p) => p.key),
          keepRounds: true,
          onProgress: (done, total) => onProgress?.(`Reading ${team.name} on ${MAPS[mapCode]?.name || mapCode}: round ${done} of ${total}…`)
        });
        let report = null;
        return {
          team,
          mapCode,
          demoIds,
          results,
          report() {
            report ||= buildSummaryReport({ extract: results.extract, sections: results.sections, mapCode, teamName: team.name });
            return report;
          }
        };
      })().catch((err) => {
        scans.delete(key);
        throw err;
      })
    );
  }
  return scans.get(key);
}

// ---- the tools -----------------------------------------------------------------

const CONDITION_HELP =
  'Conditions (times are the round clock from "1:55" down to "0:00"): ' +
  '{"players_in":{"zone":"Silo","who":"team"|"opponent","min":1,"max":5,"from":"1:55","to":"1:20"}}, ' +
  '{"utility":{"who":"team"|"opponent","type":"smoke"|"molotov"|"flash"|"he"|"any","zone":"Heaven","from":"1:55","to":"0:00","min":1}}, ' +
  '{"kill":{"by":"team"|"opponent","zone":"...","from":"...","to":"...","min":1}}, {"first_kill":{"by":"team"|"opponent","zone":"..."}}, ' +
  '{"site":"A"|"B"|"none"}, {"plant":true|false}, {"won":true|false}, {"pace":"rush"|"pop"|"contact"|"full-exec"|"default"|"slow-default"|"other"}, {"not":<condition>}.';

/** OpenAI-style tool definitions, as the model sees them. */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_teams',
      description: 'Teams in the demo library and the maps each has demos on. Use it to find the exact team name.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of a team name; omit for the biggest teams.' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'map_zones',
      description: 'The callout names a map knows (positions, the zones that group them, areas). Use these names in query_rounds.',
      parameters: { type: 'object', properties: { map: { type: 'string' } }, required: ['map'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_rounds',
      description:
        'Count one team\'s rounds on one map that match conditions, optionally grouped. Returns which rounds were counted, how many were considered, how many matched, the groups with win counts, and a few matching rounds by match and number (to open or show one). ' +
        'team "all" asks every team with 2+ demos on the map the same question at once and ranks them by win rate: use it for "which team is best (or worst) at ...", never one call per team and never antistrat_summary for each team. ' +
        'Example: best B executes on Inferno -> {"team":"all","map":"Inferno","side":"T","buy":"full","where":[{"pace":"full-exec"},{"site":"B"}]}. ' +
        'The antistrat documents count over these pools, so a check of a document number must use the same one or it will differ without being wrong: ' +
        'pace ("Rush 11% (12 rounds)"): side T, buy "bought", vs_buy any, group_by pace; ' +
        'T site rounds ("Win 76% of B rounds"): side T, buy full, vs_buy any, group_by site; ' +
        'CT against hits ("Win 45% against A hits (9 of 20)"): side CT, buy full, vs_buy full, group_by site; ' +
        'baselines and weaknesses: buy full, vs_buy full. ' +
        'To check a whole document, call review_antistrat_document instead: it recounts every point with the pool that point was written from. ' +
        CONDITION_HELP,
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'A team, or "all" to rank every team on the map.' },
          map: { type: 'string' },
          min_demos: { type: 'number', description: 'With team "all": only teams with at least this many demos on the map (default 2).' },
          side: { type: 'string', enum: ['T', 'CT', 'any'] },
          buy: { type: 'string', enum: ['full', 'force', 'half', 'eco', 'pistol', 'bought', 'any'], description: "The team's buy. bought = half, force or full." },
          vs_buy: { type: 'string', enum: ['full', 'force', 'half', 'eco', 'pistol', 'any'], description: "The other team's buy." },
          where: { type: 'array', items: { type: 'object' }, description: 'Conditions that must all hold.' },
          group_by: { type: 'string', enum: ['site', 'won', 'pace', 'plant', 'first_kill', 'buy', 'side'] }
        },
        required: ['team', 'map']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'antistrat_summary',
      description:
        "The antistrat sheet for a team on a map: positions, pace, tells, default utility, dangerous rounds, buys, site rounds, lurks, players, and opinions built from them. Each point says how many rounds back it. Slow the first time (it reads every round).",
      parameters: {
        type: 'object',
        properties: { team: { type: 'string' }, map: { type: 'string' }, side: { type: 'string', enum: ['T', 'CT', 'both'] } },
        required: ['team', 'map']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_antistrat_document',
      description: "Write one antistrat document for a team on one or more maps into your team's Documents. The title carries the date. It only saves; reviewing it is a separate step the user must ask for.",
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          maps: { type: 'array', items: { type: 'string' } },
          style: { type: 'string', enum: ['full', 'outline', 'sixpack'] },
          side: { type: 'string', enum: ['T', 'CT', 'both'], description: 'Only one side when the user asks for one (default both).' }
        },
        required: ['team', 'maps']
      }
    }
  }
];

const BUYS = ['full', 'force', 'half', 'eco', 'pistol', 'any'];
// The stored economy digit: 0 pistol, 1 eco (shared/roundId.js ECONOMIES).
const BUY_CODE = { pistol: 0, eco: 1, half: 2, force: 3, full: 4 };

/** The Database's columns an answer usually needs; others can be named in `columns`. */
const PLAYER_COLUMNS = ['name', 'teamLabel', 'rounds', 'rating', 'kast', 'adr', 'kills', 'deaths', 'kd', 'impact', 'openKills', 'openDeaths', 'a4r', 'a4aim', 'utilDmgPerRound', 'flashHitRate', 'awpAccuracy'];
const TEAM_COLUMNS = ['name', 'rounds', 'matches', 'avgRating', 'winrate', 'ctWinrate', 'tWinrate'];

/** Every Database column the site's catalogue knows, by key, with what it means. */
const columnInfo = (table) => {
  const out = new Map();
  for (const c of table === 'teams' ? TEAM_COLUMN_INFO : PLAYER_COLUMN_INFO) {
    for (const key of c.keys || [c.key]) out.set(key, { label: c.label, about: c.about });
  }
  return out;
};
const columnList = (table) => [...columnInfo(table)].map(([key, c]) => (c.label && c.label !== key ? `${key} (${c.label})` : key)).join(', ');
/** Columns that only make sense next to the counts behind them. */
const COLUMN_SAMPLES = { akpr: ['akprKills', 'akprRounds'] };

TOOLS.push(
  {
    type: 'function',
    function: {
      name: 'database_query',
      description:
        "The Database page: one row per player or per team, pooled over every match that fits the filters. Use it for ratings, ADR, KAST, opening duels, utility damage, AWP accuracy and the like. " +
        `Default player columns: ${PLAYER_COLUMNS.join(', ')}. Default team columns: ${TEAM_COLUMNS.join(', ')}. ` +
        `Every other column is asked for by key in "columns" and can be sorted on with "sort_by". Player columns: ${columnList('players')}. Team columns: ${columnList('teams')}. ` +
        'There is no per-map column: to compare maps, call once per map with the "map" filter. The answer explains each extra column. Before saying a statistic does not exist, look for it in these lists.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: ['players', 'teams'] },
          map: { type: 'string', description: 'One map, or omit for all maps.' },
          side: { type: 'string', enum: ['T', 'CT', 'any'] },
          buy: { type: 'string', enum: BUYS, description: "The subject's buy." },
          vs_buy: { type: 'string', enum: BUYS, description: "The other team's buy." },
          result: { type: 'string', enum: ['won', 'lost', 'any'], description: 'Only rounds the subject won or lost.' },
          team: { type: 'string', description: "Only this team's rounds (players: their stats while playing for it)." },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
          rank_own: { type: 'string', description: 'World rank of the subject team, for example "20" or "10-30".' },
          rank_opp: { type: 'string', description: 'World rank of the other team.' },
          min_rounds: { type: 'number' },
          columns: { type: 'array', items: { type: 'string' } },
          sort_by: { type: 'string' },
          limit: { type: 'number', description: 'Rows to return, at most 40.' }
        },
        required: ['table']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_matches',
      description:
        'The matches (games) in the library: one per demo, a team against a team on one map. Each has an id for match_summary and find_rounds. Newest first, or random: true for a random pick. Use this, not find_rounds, for anything about a game or match.',
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          opponent: { type: 'string', description: 'Only matches against this team (needs team).' },
          map: { type: 'string' },
          random: { type: 'boolean', description: 'Pick at random from the matches that fit.' },
          limit: { type: 'number', description: 'How many, default 10, at most 30.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'match_summary',
      description:
        "One match: the score, the score at half time, how many of its rounds the library has and whether that looks like the whole match, who won each round, and every player's stats over this match only (rating, kills, deaths, ADR, KAST), best first. Use it for a game's scoreline, top performer or length.",
      parameters: { type: 'object', properties: { match: { type: 'string', description: 'A match id from list_matches or find_rounds.' } }, required: ['match'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_rounds',
      description:
        'Search the round library. Returns rounds with their file (for screenshot_round and round_details), the match they belong to, map, round number, teams, buys and who won. Filter by match, team, opponent, player, map, who won and buys. Rounds with the same team names can come from different matches: only the match id says which game a round is from.',
      parameters: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Only the rounds of this match (an id from list_matches), in order.' },
          team: { type: 'string' },
          opponent: { type: 'string', description: 'Only rounds against this team (needs team).' },
          player: { type: 'string', description: 'A player name (any team).' },
          map: { type: 'string' },
          won_by: { type: 'string', enum: ['team', 'opponent', 'any'], description: 'Relative to "team".' },
          buy: { type: 'string', enum: BUYS, description: "The team's buy." },
          limit: { type: 'number', description: 'At most 30.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'round_details',
      description: "One round's record: the score going into it and which half, each player, kills with weapons and clock times, grenades thrown, the bomb. No positions: for who went where, use round_timeline.",
      parameters: { type: 'object', properties: { round: { type: 'string' } }, required: ['round'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'show_round',
      description:
        "Put a round in the chat for the user to watch: a small radar player they can play, pause and scrub, opening at from (or paused at at, as a still picture of that moment). Use it whenever you talk about a round or a moment the user would want to see: the rounds you compare, the play you describe, the setup you point at. You do not see it; it is for the user.",
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Clock to start from, for example 1:30 (default the start).' },
          to: { type: 'string', description: 'Clock to stop at, for example 0:50 (default the end).' },
          at: { type: 'string', description: 'Open paused at this clock instead, as a still of that moment.' },
          caption: { type: 'string', description: 'One short line on what to look at.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'strategy_draft',
      description:
        "Start writing a round's execute into the team's stratbook as a strategy, the way a coach would. Finds the execute (the burst of utility that starts it, call_at) unless you give from, and returns: the stratbook's columns with the player in each and where he waits at the call, the side's grenades from the call on with their clock time, where each is thrown from and a tag to link it, the call and economy types allowed, and how to write the notes. Then read the round from call_at (round_timeline), write one note per column, and call save_strategy.",
      parameters: {
        type: 'object',
        properties: {
          side: { type: 'string', enum: ['T', 'CT'], description: 'Which side of the round to write up.' },
          from: { type: 'string', description: 'Where the strategy starts, when the user says ("the execute begins around 0:30" -> "0:30"). Leave out to find the execute.' },
          to: { type: 'string', description: '...to this clock.' }
        },
        required: ['side']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_strategy',
      description:
        "Save the strategy you wrote from a strategy_draft into the team's stratbook. Each note is that column's player's part of the round as a sequence a player can follow during a round: what they buy or carry if it matters, where they go and when (round clock), what they hold, what they throw (link each grenade with its tag, written <label><!tag>, for example <Window smoke><!t3>), and what they do on the call. One to four short sentences per column.",
      parameters: {
        type: 'object',
        properties: {
          draft: { type: 'string', description: 'The draft id from strategy_draft.' },
          name: { type: 'string', description: 'A short strategy name, as a coach would call it (for example "B split with mid smoke").' },
          category: { type: 'string', description: 'One of the call types strategy_draft listed.' },
          economy: { type: 'string', description: 'One of the economy types strategy_draft listed.' },
          description: { type: 'string', description: 'One or two sentences: the idea of the strategy and when to call it.' },
          notes: {
            type: 'array',
            items: { type: 'object', properties: { column: { type: 'string' }, text: { type: 'string' } }, required: ['column', 'text'] },
            description: 'One per stratbook column, by the column names strategy_draft gave.'
          }
        },
        required: ['draft', 'name', 'category', 'economy', 'notes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'round_timeline',
      description:
        "Watch one round: where every player of both teams went and when (each move to a new place, with the clock), both teams' shape every 10 seconds (how many players where, and who is alone), every grenade with where it landed, every kill with where both players stood, the plant, the score going in, and the round's pace compared with the same team's other rounds with the same buys (when they got onto a site, first kill, utility by 1:20, against their usual). Use it for what happened in a round, what a team did, how two rounds differ, and whether a round was fast or slow. Give match and number (or a round file). team picks whose view (default: the first team of the match; both teams' players are in it either way).",
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'The team to read the round for (its pace is compared with its own rounds).' },
          from: { type: 'string', description: 'Only events from this clock (for example 1:30)...' },
          to: { type: 'string', description: '...to this clock (for example 0:50).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'round_value',
      description:
        "Price a round: which kills, plants and defuses moved the round most, by how many points of win chance, and why (players alive, health, equipment, bomb...). For each kill it gives both players' win chance in that gunfight as it turned (xK in the moment) and whether it was an upset, even or expected. Also each player's net gain and the costliest mistakes the coach flagged. Use it to judge what was good or bad in a round, and to find the moments worth looking at. Use a file from find_rounds.",
      parameters: {
        type: 'object',
        properties: {
          round: { type: 'string', description: 'A round file from find_rounds.' },
          moments: { type: 'number', description: 'How many of the biggest swings to list (default 8, at most 25).' }
        },
        required: ['round']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'moment_value',
      description:
        "One clock time of a round, priced: each side's win chance, what is separating the sides, every gunfight open at that tick with each player's win chance in it, and each fighter's xK (their win chances summed over the fights they are in; in a 1v1 it is the win chance). Call it at two clock times to see how a fight or a position changed. Use a file from find_rounds.",
      parameters: {
        type: 'object',
        properties: {
          round: { type: 'string', description: 'A round file from find_rounds.' },
          clock: { type: 'string', description: 'Round clock, for example 1:20. 1:55 is the start of the live round.' }
        },
        required: ['round', 'clock']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'team_documents',
      description:
        "The user's team documents (antistrat sheets, notes). Without \"title\" or \"id\" lists them, newest first, each with its id and date; with one of them reads that document as text. Documents can share a title: the newest is used unless you pass an id.",
      parameters: { type: 'object', properties: { title: { type: 'string' }, id: { type: 'string', description: 'A document id from the list.' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'team_rankings',
      description: 'The VRS world ranking (rank, team, points). Use it for who is a top 10 or top 30 team.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Part of a team name.' }, top: { type: 'number', description: 'How many to list, default 20.' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall_earlier',
      description: 'Read an earlier question of this chat that was folded into the summary to make room. No arguments: lists the folded questions by number. question: n returns that question, its whole answer and its tool calls.',
      parameters: { type: 'object', properties: { question: { type: 'number', description: 'Number from the list (1 = the oldest folded question).' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'site_map',
      description: 'Every page of aim4 and what it shows, with links. Use it to point the user to the right page, or to find which tool covers a question.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'classify_rounds',
      description:
        "What kind of hit each of a team's T rounds on a map was, read from where the players walked: execute (one lane, 3+ grenades onto the site before the entry), split (the entry came from 2+ lanes at once), rush, contact (one lane, little utility) or no hit. Players who arrive late are joiners, not a lane. Returns counts and win rates per kind and site, and the best rounds of each kind (won, planted, players kept, speed) with match and number to show. Use it for 'B execute vs B split', 'their best A splits', or 'which team has the best B executes' (team: \"all\").",
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'A team, or "all" to compare every team with 2+ demos on the map.' },
          map: { type: 'string' },
          kind: { type: 'string', enum: ROUND_KINDS, description: 'Only this kind.' },
          site: { type: 'string', enum: ['A', 'B'] },
          full_buy: { type: 'boolean', description: 'Only rounds where both teams had a full buy.' },
          best: { type: 'number', description: 'Best rounds listed per kind and site, default 3.' }
        },
        required: ['team', 'map']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'player_patterns',
      description:
        "How each player of a team plays one map, read from the rounds: where he starts, whether he looks for early fights and where, whether he plays alone, his opening duels, whether his deaths get traded and whether he trades, the utility he throws and when, CT rotations and T lurks, each with 'in X of N rounds', and what to do against him. Use it to write player notes in a coach's words instead of a most-played position.",
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          map: { type: 'string' },
          side: { type: 'string', enum: ['T', 'CT', 'both'] },
          player: { type: 'string', description: 'Only this player (part of the name).' },
          all_buys: { type: 'boolean', description: 'Count every buy; by default only full-buy rounds.' }
        },
        required: ['team', 'map']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_weaknesses',
      description:
        "Where a team loses on one map and side, measured from its rounds: sites or paces they lose more than their usual, spots where they lose their fights, where their opening deaths pile up, ranked. Also their numbers in retakes or post-plants, after losing the opening duel, anti-ecos and forces, and the exploitable tells from the antistrat. Use it for any question about weaknesses or how to beat a team.",
      parameters: {
        type: 'object',
        properties: { team: { type: 'string' }, map: { type: 'string' }, side: { type: 'string', enum: ['T', 'CT', 'both'] } },
        required: ['team', 'map']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'review_antistrat_document',
      description:
        "Check one of the user's antistrat documents: wrong arithmetic, impossible counts, points on too few rounds, duplicates, numbers that changed or are not in the current data, strong points it is missing, empty sections. Returns the document's outline (numbered points) and the issues.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The document title, or part of it (team_documents lists them). Several with one title: the newest is used.' },
          id: { type: 'string', description: 'A document id from team_documents, instead of the title.' },
          team: { type: 'string', description: 'Only when the title does not say which team it is about.' },
          maps: { type: 'array', items: { type: 'string' }, description: 'Only when the title does not say the maps.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_antistrat_document',
      description:
        'Save a reorganised and rewritten version of a document you reviewed. Give every section with its points, in the order they should read. Numbers must be copied from the review (the document or its "current data" lines) or from a query you ran this turn; any other number is refused, and the refusal names the point. Points keep their round links. ' +
        'A long document goes in parts of about 3 to 5 sections per call. Every call for the same reviewed document adds to one "Reviewed:" copy (a section sent again with the same heading replaces the old one), so parts never make separate documents. final false keeps the sections without saving until a later call.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The reviewed document.' },
          id: { type: 'string', description: 'The reviewed document id, instead of the title.' },
          final: { type: 'boolean', description: 'false: keep these sections and wait for more. true or omitted: join everything sent so far and save.' },
          mode: { type: 'string', enum: ['copy', 'replace'], description: 'copy (default) saves a new document next to it; replace overwrites it.' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: { side: { type: 'string', description: 'For example "Nuke T side".' }, heading: { type: 'string' }, points: { type: 'array', items: { type: 'string' } } },
              required: ['heading', 'points']
            }
          }
        },
        required: ['sections']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queue_antistrat_documents',
      description:
        "Create several antistrat documents in a row: one document per job, each a team on one or more maps. maps can be [\"all\"] for every map the team has at least 3 demos on.  a job that fails does not stop the rest.",
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { team: { type: 'string' }, maps: { type: 'array', items: { type: 'string' } }, style: { type: 'string', enum: ['full', 'outline', 'sixpack'] }, side: { type: 'string', enum: ['T', 'CT', 'both'] } },
              required: ['team', 'maps']
            }
          }
        },
        required: ['jobs']
      }
    }
  }
);

/** Offered only when the running model can read pictures. */
export const VISION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'screenshot_round',
      description:
        'Look at one moment of a round: a picture of the radar with every player, their facing, weapons, grenades and the bomb, and the same moment as text. Use a file from find_rounds and a round clock time (1:55 is the start of the live round). Use it to check positions, setups and what a utility lineup did. Take a second picture at another clock to see what changed.',
      parameters: {
        type: 'object',
        properties: {
          round: { type: 'string', description: 'A round file from find_rounds.' },
          clock: { type: 'string', description: 'Round clock, for example 1:20.' },
          view: { type: 'string', enum: ['players', 'map'], description: 'players (default) zooms onto where the players are; map shows the whole radar.' },
          show: { type: 'boolean', description: 'Also show this moment to the user in the chat (as a still they can play on from).' }
        },
        required: ['round', 'clock']
      }
    }
  }
];

/**
 * Tools that read one round take it by match and round number as well as by
 * file. The model used to build file names itself ("...-155-CCH-15_...") from
 * the pattern of other files and got "Round not found"; a number cannot be
 * guessed wrong that way.
 */
const ROUND_TOOLS = new Set(['round_details', 'round_timeline', 'round_value', 'moment_value', 'screenshot_round', 'show_round', 'strategy_draft']);
for (const t of [...TOOLS, ...VISION_TOOLS]) {
  if (!ROUND_TOOLS.has(t.function.name)) continue;
  const p = t.function.parameters;
  p.properties = {
    match: { type: 'string', description: 'A match id (list_matches).' },
    number: { type: 'number', description: 'The round number in that match.' },
    ...p.properties,
    round: { type: 'string', description: 'Or a round file from find_rounds, copied exactly. Never write one yourself.' }
  };
  p.required = (p.required || []).filter((k) => k !== 'round');
}

/** The tool definitions for a model, with or without vision. */
export const toolsFor = ({ vision = false } = {}) => (vision ? [...TOOLS, ...VISION_TOOLS] : TOOLS);

const SITE_PAGES = [
  { page: 'Demo library', link: '/demos', about: 'Every uploaded match and round, with the round viewer (2D and 3D).' },
  { page: 'Database', link: '/database', about: 'Player and team tables with filters and columns (database_query reads this).' },
  { page: 'Pattern Finder', link: '/patterns', about: 'Search rounds by position, utility and timing.' },
  { page: 'Antistrat', link: '/patterns?chapter=antistrat', about: 'Team scouting sheets per map (antistrat_summary reads this).' },
  { page: 'Player scouting', link: '/patterns?chapter=scout', about: 'One player at a time: roles, positions, habits.' },
  { page: 'Charts', link: '/patterns?chapter=charts', about: 'Scatter and bar charts over the Database columns.' },
  { page: 'Team documents', link: '/team/documents', about: "The team's written notes and generated sheets (team_documents reads these)." },
  { page: 'Aim trainer', link: '/trainer', about: 'Aim scenarios and routines.' }
];

/** Cut a result to what fits the model's context, saying so when it was cut. */
function fit(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the rest did not fit]`;
}

const STYLES = ['full', 'outline', 'sixpack'];
const styleTitle = (style) => (style === 'sixpack' ? 'Sixpack' : style === 'outline' ? 'Outline' : 'Summary');
const mapName = (code) => MAPS[code]?.name || code;

/** The team the user's documents go to. */
async function myTeam() {
  const myTeams = await fetchTeams();
  const dest = myTeams?.[0];
  if (!dest) throw new ToolError('The user is not in a team, so there is nowhere to save documents.');
  return dest;
}

/** The sheet for a team on a map as the review compares points: fresh, with rounds. */
function freshPoints(scan) {
  const html = buildSummaryDocHtml(
    { teamName: scan.team.name, mapCode: scan.mapCode, categories: SUMMARY_CATEGORIES.map((c) => c.key), report: scan.report(), links: true },
    escapeHtml
  );
  return pointsFromSummaryHtml(html).map((p) => ({ ...p, side: `${mapName(scan.mapCode)} ${p.side}`.trim() }));
}

/** Build one antistrat document and save it. */
/** "T", "CT" or "both" from what the model passed. */
const sideOf = (side) => (String(side || '').toUpperCase() === 'T' ? 'T' : String(side || '').toUpperCase() === 'CT' ? 'CT' : 'both');

/** @returns {Promise<{ title: string, id: string }>} */
async function writeAntistratDoc(team, maps, style, dest, onProgress, side = 'both') {
  const drop = side === 'T' ? 'sideCT' : side === 'CT' ? 'sideT' : '';
  const categories = SUMMARY_CATEGORIES.map((c) => c.key).filter((k) => k !== drop);
  const specs = [];
  for (const m of maps) {
    const scan = await teamScan(team.name, m, onProgress);
    specs.push({ teamName: team.name, mapCode: m, categories, report: scan.report(), links: false });
  }
  const html =
    style === 'sixpack'
      ? buildSixpackDocHtml(specs, escapeHtml)
      : specs.map((sp) => (style === 'outline' ? buildOutlineDocHtml(sp, escapeHtml) : buildSummaryDocHtml(sp, escapeHtml))).join('<hr>');
  // Dated, so a second sheet for the same team and maps can be told from the first.
  const sideWords = side === 'both' ? '' : ` ${side} side`;
  const title = `${styleTitle(style)}: ${team.name} on ${maps.map(mapName).join(', ')}${sideWords} (${shortDate(Date.now(), false)})`;
  const saved = await saveTeamDocument(dest.id, { title, html });
  return { title, id: saved?.document?.id || '' };
}

/** A team's maps: named ones, or "all" for every map with at least `min` demos. */
async function mapsOf(team, maps, min = 3) {
  const list = (Array.isArray(maps) ? maps : [maps]).filter(Boolean);
  if (list.some((m) => String(m).toLowerCase() === 'all')) {
    const { payload } = await library();
    const counts = new Map();
    for (const d of payload.demos) {
      if (teamNameKey(d.name1, d.t1) === team.key || teamNameKey(d.name2, d.t2) === team.key) counts.set(d.map, (counts.get(d.map) || 0) + 1);
    }
    const all = [...counts].filter(([code, n]) => n >= min && MAPS[code]).sort((a, b) => b[1] - a[1]).map(([code]) => code);
    if (!all.length) throw new ToolError(`${team.name} has no map with ${min}+ demos.`);
    return all;
  }
  if (!list.length) throw new ToolError('Name at least one map.');
  return [...new Set(list.map(mapCodeOf))];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A document's last-saved time in milliseconds, or 0. */
const updatedOf = (d) => {
  const v = d?.updatedAt ?? d?.updated;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};

/** 1792264605162 -> "17 Oct 21:30" (no time of day when `withTime` is false). */
export function shortDate(ms, withTime = true) {
  if (!ms) return '';
  const d = new Date(ms);
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return withTime ? `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : date;
}

/** A title compared without case or the generator's date: "Outline: X on Nuke (17 Oct)" -> "outline: x on nuke". */
const undatedTitle = (t) =>
  String(t || '')
    .trim()
    .replace(/\s*\(\d{1,2} [A-Za-z]{3}\)\s*$/, '')
    .toLowerCase();

/**
 * A document of the user's team: by id, else by title (exact, then containing it).
 * Several documents with the same title (the generator writes a new one each
 * time) resolve to the newest, and `note` says so. Different titles that all
 * contain the words are refused, listed with their dates and ids.
 */
async function documentOf(title, id) {
  const dest = await myTeam();
  const docs = dest.documents || [];
  let near;
  if (id) {
    near = docs.filter((d) => String(d.id) === String(id));
    if (!near.length) throw new ToolError(`No document with id "${id}". Call team_documents to list them.`);
  } else {
    const want = undatedTitle(title);
    if (!want) throw new ToolError('Name the document (team_documents lists them).');
    // The date the generator adds ("... on Cache (18 Oct)") is left out on both sides, so the
    // title without it finds the newest copy, not an older undated one that matches exactly.
    const exact = docs.filter((d) => undatedTitle(d.title) === want);
    near = exact.length ? exact : docs.filter((d) => undatedTitle(d.title).includes(want));
    if (!near.length) throw new ToolError(`No document called "${title}". Call team_documents to list them.`);
    const titles = new Set(near.map((d) => undatedTitle(d.title)));
    if (titles.size > 1) {
      const list = near
        .sort((a, b) => updatedOf(b) - updatedOf(a))
        .slice(0, 6)
        .map((d) => `"${d.title}" (${shortDate(updatedOf(d)) || 'no date'}, id ${d.id})`);
      throw new ToolError(`"${title}" matches different documents: ${list.join('; ')}. Call again with the id of the one you mean.`);
    }
  }
  const sorted = [...near].sort((a, b) => updatedOf(b) - updatedOf(a));
  const pick = sorted[0];
  const note =
    !id && sorted.length > 1
      ? `${sorted.length} documents have this title (dates aside); used the newest, "${pick.title}" (${shortDate(updatedOf(pick)) || 'undated'}, id ${pick.id}).`
      : '';
  const full = (await fetchTeamDocument(dest.id, pick.id)) || pick;
  return { dest, doc: full, note };
}

/** "Summary: NAVI on Nuke, Mirage" -> the team and maps a generated title names. */
function subjectOfTitle(rawTitle) {
  // The date the generator adds to a title ("... on Nuke (17 Oct)") is not part of the maps.
  const title = String(rawTitle || '').replace(/\s*\(\d{1,2} [A-Z][a-z]{2}\)\s*$/, '');
  const m = String(title || '').match(/^(?:summary|outline|sixpack|reviewed)?:?\s*(.+?)\s+on\s+(.+)$/i);
  if (!m) return null;
  return { team: m[1].replace(/^(summary|outline|sixpack|reviewed):\s*/i, ''), maps: m[2].split(/\s*,\s*|\s+and\s+/) };
}

/** The last review per document: what a rewrite is checked against. */
const reviews = new Map();

/** Numbers from this turn's data tools: a rewrite may quote what the model measured, not only what the review listed. */
const turnNumbers = new Set();
/** Sections sent with final false, per document, until the final call joins and saves them. */
const pendingRewrites = new Map();
/** Reviewed document id -> the "Reviewed:" copy a rewrite saved, and its sections, so later calls add to that copy. */
const rewriteCopies = new Map();
const DATA_TOOLS = new Set(['query_rounds', 'find_weaknesses', 'antistrat_summary', 'database_query', 'review_antistrat_document']);

/** Call at the start of each question: its tool results are the only ones a rewrite may draw numbers from. */
export function resetTurnFacts() {
  turnNumbers.clear();
  pendingRewrites.clear();
}


const roundsLink = (files) => (files?.length ? `/demos?rounds=${files.slice(0, 150).map(encodeURIComponent).join(',')}` : '');

/**
 * Run one tool call.
 *
 * @param {string} name
 * @param {object} args
 * @param {{ onProgress?: (label: string) => void, confirm?: (question: string) => Promise<boolean> }} ctx
 * @returns {Promise<{ content: string, display: string, link?: string }>}
 *   `content` goes to the model, `display` and `link` to the person
 */
/**
 * Run one tool. Every round id a result shows is remembered, so a slightly
 * mangled copy of it can be read back later (roundRefs.js).
 */
export async function runTool(name, args = {}, ctx = {}) {
  const result = await runToolInner(name, args, ctx);
  noteRounds(roundIdsIn(result?.content));
  if (DATA_TOOLS.has(name) && typeof result?.content === 'string' && !result.content.startsWith('Error:')) {
    for (const n of result.content.match(/\d+(?:\.\d+)?/g) || []) turnNumbers.add(n);
  }
  return result;
}

async function runToolInner(name, args = {}, ctx = {}) {
  try {
    // A round named by match and number becomes its file before any tool reads it.
    if (ROUND_TOOLS.has(name) && args.match && args.number != null && !args.round) {
      args = { ...args, round: await fileOfMatchRound(args.match, args.number) };
    }
    switch (name) {
      case 'round_timeline': {
        const file = String(args.round || '').trim();
        if (!file) throw new ToolError('Give match and number (or a round file from find_rounds).');
        const demoId = matchOfFile(file);
        if (!demoId) throw new ToolError('That round has no match id (an old round name). Find it with find_rounds by match.');
        const d = await matchById(demoId);
        const rounds = await roundsOfMatch(d);
        const row = rounds.find((x) => x.file === file);
        if (!row) throw new ToolError(`No round with that file in ${matchLabel(d)}. Never write a file yourself: give match and number.`);
        // Whose view: the team asked for, else the first team of the match.
        const team = await teamOf(args.team || d.name1 || d.t1);
        const scan = await teamScan(team.name, d.map, ctx.onProgress);
        const all = scan.results.extract.rounds || [];
        const r = all.find((x) => String(x.demoId) === String(d.id) && x.round === row.round);
        if (!r) throw new ToolError(`${team.name} has no read of round ${row.round} of ${matchLabel(d)}: the round is in the library but its positions could not be read.`);
        const ours = scan.team.name;
        const theirs = teamNameKey(d.name1, d.t1) === scan.team.key ? d.name2 || d.t2 : d.name1 || d.t1;
        const { names } = await library();
        const story = roundStory(r, { names, network: scan.results.extract.network, ours, theirs, pool: all, window: [clockArg(args.from, 0), clockArg(args.to, 115)] });
        const label = `${matchLabel(d)}, round ${row.round}`;
        return {
          content: fit({ round: label, match: d.id, number: row.round, half: halfOf(row.round), score_before: scoresBefore(d, rounds).get(file), ...story }),
          display: `Watched ${label}`,
          link: roundsLink([file])
        };
      }
      case 'list_teams': {
        const { teams, payload } = await library();
        const q = String(args.query || '').trim().toLowerCase();
        const counts = new Map();
        for (const d of payload.demos) {
          for (const [n, t] of [[d.name1, d.t1], [d.name2, d.t2]]) {
            const key = `${teamNameKey(n, t)}|${d.map}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
        const rows = teams
          .filter((t) => !q || t.name.toLowerCase().includes(q))
          .map((t) => ({
            team: t.name,
            maps: [...t.maps].map((m) => ({ map: MAPS[m]?.name || m, demos: counts.get(`${t.key}|${m}`) || 0 })).filter((m) => m.demos).sort((a, b) => b.demos - a.demos)
          }))
          .filter((t) => t.maps.length)
          .sort((a, b) => b.maps.reduce((n, m) => n + m.demos, 0) - a.maps.reduce((n, m) => n + m.demos, 0))
          .slice(0, 20);
        return { content: fit(rows), display: `Found ${rows.length} team${rows.length === 1 ? '' : 's'}${q ? ` matching "${args.query}"` : ''}` };
      }
      case 'map_zones': {
        const code = mapCodeOf(args.map);
        const { network } = await loadMapContext(code);
        if (!network) throw new ToolError(`${MAPS[code]?.name || code} has no zone network yet.`);
        return { content: fit(zoneNames(network)), display: `Read the callouts of ${MAPS[code]?.name || code}` };
      }
      case 'query_rounds': {
        const { payload } = await library();
        const byId = new Map(payload.demos.map((d) => [String(d.id), d]));
        /** A few matched rounds by name, match and number: enough to open one, small enough to keep. */
        const examples = (refs, n) =>
          [...refs]
            .sort(() => Math.random() - 0.5)
            .slice(0, n)
            .map((x) => {
              const d = byId.get(String(x.demoId));
              return { label: d ? `${matchLabel(d)}, round ${x.round}` : `round ${x.round}`, match: x.demoId, number: x.round, won: x.won };
            });
        // Every team at once: one row per team, so "which team is best at" is one call.
        if (String(args.team || '').trim().toLowerCase() === 'all') {
          const mapCode = mapCodeOf(args.map);
          const minDemos = Math.max(1, Math.round(args.min_demos) || 2);
          const teams = (await library()).teams.filter((t) => {
            const n = payload.demos.filter((d) => d.map === mapCode && (teamNameKey(d.name1, d.t1) === t.key || teamNameKey(d.name2, d.t2) === t.key)).length;
            return n >= minDemos;
          });
          if (!teams.length) throw new ToolError(`No team has ${minDemos}+ demos on ${mapName(mapCode)}.`);
          const rows = [];
          const failed = [];
          let counted = '';
          for (const [i, t] of teams.entries()) {
            try {
              const scan = await teamScan(t.name, mapCode, (label) => ctx.onProgress?.(`Team ${i + 1} of ${teams.length}: ${label}`));
              // The teams are the grouping here; a group_by ("team", or any other) is left out rather than failing every team.
              const r = runRoundQuery(scan.results.extract.rounds, scan.results.extract.network, { ...args, group_by: undefined });
              counted ||= r.counted;
              rows.push({ team: scan.team.name, considered: r.considered, matched: r.matched, won: r.won, win_pct: r.matched ? Math.round((r.won / r.matched) * 100) : null, share_pct: r.share, examples: examples(r.refs, 2) });
            } catch (err) {
              failed.push(`${t.name}: ${err.message}`);
            }
          }
          const MIN_MATCHED = 3;
          const ranked = rows.filter((r) => r.matched >= MIN_MATCHED).sort((a, b) => b.win_pct - a.win_pct || b.matched - a.matched);
          const thin = rows.filter((r) => r.matched < MIN_MATCHED).map((r) => `${r.team} ${r.won} of ${r.matched}`);
          return {
            content: fit({
              map: mapName(mapCode),
              counted,
              teams_checked: rows.length,
              ranked_by_win_rate: ranked,
              ...(thin.length ? { too_few_rounds_to_rank: thin.join(', ') } : {}),
              ...(failed.length ? { failed } : {}),
              note: `Teams with ${minDemos}+ demos on this map. Ranked only with ${MIN_MATCHED}+ matching rounds; under about 8 is thin.`
            }),
            display: `Compared ${rows.length} teams on ${mapName(mapCode)}`
          };
        }
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const r = runRoundQuery(scan.results.extract.rounds, scan.results.extract.network, args);
        const { files, refs, ...rest } = r;
        const head = `${scan.team.name} on ${MAPS[scan.mapCode]?.name || scan.mapCode}: ${r.matched} of ${r.considered} rounds`;
        return { content: fit({ team: scan.team.name, map: MAPS[scan.mapCode]?.name, ...rest, examples: examples(refs, 5) }), display: head, link: roundsLink(files) };
      }
      case 'antistrat_summary': {
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const report = scan.report();
        const side = args.side === 'T' || args.side === 'CT' ? args.side : 'both';
        const cats = SUMMARY_CATEGORIES.map((c) => c.key).filter((k) => side === 'both' || k !== (side === 'T' ? 'sideCT' : 'sideT'));
        const html = buildSummaryDocHtml({ teamName: scan.team.name, mapCode: scan.mapCode, categories: cats, report, links: true }, escapeHtml);
        const points = pointsFromSummaryHtml(html);
        const bySection = [];
        for (const p of points) {
          // Section names often carry the side already ("T Pace"): no "T T Pace".
          const head = (p.side && !String(p.section || '').startsWith(`${p.side} `) ? `${p.side} ${p.section}` : String(p.section || p.side)).trim();
          let block = bySection.find((b) => b.section === head);
          if (!block) bySection.push((block = { section: head, points: [] }));
          block.points.push(`${p.text} [${p.files.length} rounds]`);
        }
        const opinions = opinionsFrom(report).map((o) => o.text);
        return {
          content: fit({ team: scan.team.name, map: MAPS[scan.mapCode]?.name, rounds: scan.results.rounds, sheet: bySection, opinions }),
          display: `Read the antistrat for ${scan.team.name} on ${MAPS[scan.mapCode]?.name || scan.mapCode} (${points.length} points)`
        };
      }
      case 'create_antistrat_document': {
        const team = await teamOf(args.team);
        const maps = await mapsOf(team, args.maps);
        const style = STYLES.includes(args.style) ? args.style : 'full';
        const side = sideOf(args.side);
        const dest = await myTeam();
        const ok = (await ctx.confirm?.(`Create a ${style} antistrat document for ${team.name} on ${maps.map(mapName).join(', ')}${side === 'both' ? '' : `, ${side} side`} in your team's Documents (${dest.name})?`)) ?? true;
        if (!ok) return { content: 'The user declined. Nothing was created.', display: 'Document not created (declined)' };
        const { title, id } = await writeAntistratDoc(team, maps, style, dest, ctx.onProgress, side);
        return {
          content: `Saved "${title}" to your team's Documents (${dest.name})${id ? `, id ${id}` : ''}. It was built from the current data just now, so its numbers are current; pass this id to review or rewrite it.`,
          display: `Saved "${title}"`,
          link: '/team/documents'
        };
      }
      case 'queue_antistrat_documents': {
        const raw = (Array.isArray(args.jobs) ? args.jobs : []).slice(0, 20);
        if (!raw.length) throw new ToolError('Give at least one job: a team and its maps.');
        const jobs = [];
        for (const j of raw) {
          const team = await teamOf(j.team);
          jobs.push({ team, maps: await mapsOf(team, j.maps), style: STYLES.includes(j.style) ? j.style : 'full', side: sideOf(j.side) });
        }
        const dest = await myTeam();
        const list = jobs.map((j, i) => `${i + 1}. ${j.team.name} on ${j.maps.map(mapName).join(', ')} (${j.style})`).join('\n');
        const ok = (await ctx.confirm?.(`Create ${jobs.length} antistrat document${jobs.length === 1 ? '' : 's'} in your team's Documents (${dest.name})?\n${list}`)) ?? true;
        if (!ok) return { content: 'The user declined. Nothing was created.', display: 'Queue not run (declined)' };
        const done = [];
        const failed = [];
        for (const [i, j] of jobs.entries()) {
          const before = new Set(scans.keys());
          try {
            const { title, id } = await writeAntistratDoc(j.team, j.maps, j.style, dest, (label) => ctx.onProgress?.(`Document ${i + 1} of ${jobs.length}: ${label}`), j.side);
            done.push(id ? `${title} (id ${id})` : title);
          } catch (err) {
            failed.push(`${j.team.name}: ${err.message}`);
          }
          // A long queue would otherwise hold every scan's rounds in memory.
          for (const k of scans.keys()) if (!before.has(k)) scans.delete(k);
        }
        return {
          content: fit({ saved: done, failed, saved_to: `your team's Documents (${dest.name})` }),
          display: `Saved ${done.length} of ${jobs.length} document${jobs.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}`,
          link: '/team/documents'
        };
      }
      case 'classify_rounds': {
        const { payload } = await library();
        const byId = new Map(payload.demos.map((d) => [String(d.id), d]));
        const mapCode = mapCodeOf(args.map);
        const want = (c) =>
          c.kind !== 'no-hit' || args.kind === 'no-hit'
            ? (!args.kind || c.kind === args.kind) && (!args.site || c.site === String(args.site).toUpperCase())
            : false;
        const best = Math.max(1, Math.min(8, Math.round(args.best) || 3));
        /** One team's T rounds on the map, classified, filtered. */
        const classified = (scan) => {
          const { rounds, network, nameOf } = scan.results.extract;
          return rounds
            .filter((r) => r.side === 'T' && (!args.full_buy || (r.ownEcon === 4 && r.oppEcon === 4)))
            .map((r) => ({ r, c: classifyRound(r, network, { nameOf, mapCode: scan.mapCode }) }))
            .filter((x) => x.c);
        };
        const ref = (x, team) => {
          const d = byId.get(String(x.r.demoId));
          const { score, pace, ...c } = x.c;
          return { ...(team ? { team } : {}), round: d ? `${matchLabel(d)}, round ${x.r.round}` : `round ${x.r.round}`, match: x.r.demoId, number: x.r.round, ...c };
        };
        if (String(args.team || '').trim().toLowerCase() === 'all') {
          const teams = (await library()).teams.filter((t) => payload.demos.filter((d) => d.map === mapCode && (teamNameKey(d.name1, d.t1) === t.key || teamNameKey(d.name2, d.t2) === t.key)).length >= 2);
          if (!teams.length) throw new ToolError(`No team has 2+ demos on ${mapName(mapCode)}.`);
          const rows = [];
          const top = [];
          const failed = [];
          for (const [i, t] of teams.entries()) {
            try {
              const scan = await teamScan(t.name, mapCode, (label) => ctx.onProgress?.(`Team ${i + 1} of ${teams.length}: ${label}`));
              const all = classified(scan);
              const hit = all.filter((x) => want(x.c));
              const won = hit.filter((x) => x.c.won).length;
              rows.push({ team: scan.team.name, t_rounds: all.length, matched: hit.length, won, win_pct: hit.length ? Math.round((won / hit.length) * 100) : null });
              top.push(...hit.map((x) => ({ x, team: scan.team.name })));
            } catch (err) {
              failed.push(`${t.name}: ${err.message}`);
            }
          }
          const ranked = rows.filter((r) => r.matched >= 3).sort((a, b) => b.win_pct - a.win_pct || b.matched - a.matched);
          const thin = rows.filter((r) => r.matched && r.matched < 3).map((r) => `${r.team} ${r.won} of ${r.matched}`);
          const bestRounds = top.sort((a, b) => b.x.c.score - a.x.c.score).slice(0, best * 2).map(({ x, team }) => ref(x, team));
          return {
            content: fit({ map: mapName(mapCode), kind: args.kind || 'any', site: args.site || 'any', ranked_by_win_rate: ranked, ...(thin.length ? { too_few_to_rank: thin.join(', ') } : {}), best_rounds: bestRounds, ...(failed.length ? { failed } : {}), note: 'Ranked with 3+ matching rounds; under about 8 is thin.' }),
            display: `Classified T rounds of ${rows.length} teams on ${mapName(mapCode)}`
          };
        }
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const all = classified(scan);
        const hit = all.filter((x) => want(x.c));
        const groups = new Map();
        for (const x of hit) {
          const key = x.c.kind === 'no-hit' ? 'no hit' : `${x.c.site} ${x.c.kind}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(x);
        }
        const kinds = [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(([key, list]) => {
            const won = list.filter((x) => x.c.won).length;
            const splits = list.filter((x) => x.c.kind === 'split');
            const laneMix = splits.length ? Object.entries(splits.reduce((m, x) => ((m[x.c.lanes.map((l) => l.from).sort().join(' + ')] = (m[x.c.lanes.map((l) => l.from).sort().join(' + ')] || 0) + 1), m), {})).map(([k, n]) => `${k}: ${n}`) : undefined;
            return {
              kind: key,
              rounds: list.length,
              won,
              win_pct: Math.round((won / list.length) * 100),
              after_a_fake: list.filter((x) => x.c.fake).length,
              ...(laneMix ? { lanes: laneMix } : {}),
              best: [...list].sort((a, b) => b.c.score - a.c.score).slice(0, best).map((x) => ref(x))
            };
          });
        return {
          content: fit({ team: scan.team.name, map: mapName(scan.mapCode), t_rounds: all.length, matched: hit.length, ...(args.full_buy ? { buys: 'full vs full only' } : {}), kinds, how: 'execute = one lane with 3+ grenades onto the site before the entry; split = 2+ lanes on the site within 12 s; joiners arrived later and are not a lane.' }),
          display: `Classified ${all.length} T rounds of ${scan.team.name} on ${mapName(scan.mapCode)}`,
          link: roundsLink(hit.map((x) => x.r.file))
        };
      }
      case 'player_patterns': {
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const { rounds, network, nameOf } = scan.results.extract;
        const side = args.side === 'T' || args.side === 'CT' ? args.side : 'both';
        const found = playerPatterns(rounds, network, { nameOf, side, player: args.player, fullBuyOnly: !args.all_buys });
        if (!found.length) throw new ToolError(args.player ? `No player matching "${args.player}" with 3+ rounds for ${scan.team.name} on ${mapName(scan.mapCode)}.` : `Too few rounds for ${scan.team.name} on ${mapName(scan.mapCode)}.`);
        return {
          content: fit({
            team: scan.team.name,
            map: mapName(scan.mapCode),
            buys: args.all_buys ? 'all' : 'full buys',
            players: found.map(({ files, ...x }) => x),
            how: 'Each line counts rounds. Write it as habits and what to do about them; keep the counts.'
          }),
          display: `Read how ${found.length === 1 ? found[0].player : `${new Set(found.map((x) => x.player)).size} players`} play ${mapName(scan.mapCode)}`,
          link: roundsLink([...new Set(found.flatMap((x) => x.files))])
        };
      }
      case 'find_weaknesses': {
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const sides = args.side === 'T' || args.side === 'CT' ? [args.side] : ['T', 'CT'];
        const { rounds, network } = scan.results.extract;
        const found = sides.map((side) => findWeaknesses(rounds, network, { side }));
        const out = found.map((w) => ({
          side: w.side,
          baseline: w.baseline.text,
          weaknesses: w.weaknesses.slice(0, 10).map((x) => `${x.text} [${x.kind}, ${x.rounds} rounds]`),
          situations: w.situations.map((x) => x.text)
        }));
        const exploits = opinionsFrom(scan.report()).slice(0, 10).map((o) => o.text);
        const files = found.flatMap((w) => w.weaknesses.slice(0, 3).flatMap((x) => x.files));
        const n = out.reduce((a, o) => a + o.weaknesses.length, 0);
        return {
          content: fit({ team: scan.team.name, map: mapName(scan.mapCode), sides: out, exploits }),
          display: `Found ${n} weakness${n === 1 ? '' : 'es'} for ${scan.team.name} on ${mapName(scan.mapCode)}`,
          link: roundsLink([...new Set(files)])
        };
      }
      case 'review_antistrat_document': {
        const { doc, note: docNote } = await documentOf(args.title, args.id);
        const outline = outlineOfHtml(doc.html || '');
        const subject = args.team ? { team: args.team, maps: args.maps || [] } : subjectOfTitle(doc.title);
        let fresh = [];
        const findings = [];
        let note = '';
        if (subject?.team) {
          try {
            const team = await teamOf(subject.team);
            const maps = await mapsOf(team, subject.maps?.length ? subject.maps : ['all']);
            for (const m of maps) {
              const scan = await teamScan(team.name, m, ctx.onProgress);
              fresh.push(...freshPoints(scan));
              // What "Notes and preparation" may draw on: measured weaknesses and the rule-bot's exploits.
              const { rounds, network } = scan.results.extract;
              for (const side of ['T', 'CT']) {
                for (const x of findWeaknesses(rounds, network, { side }).weaknesses.slice(0, 5)) {
                  findings.push({ side: `${mapName(m)} ${side}`, section: 'Weaknesses', text: x.text, files: x.files });
                }
              }
              for (const o of opinionsFrom(scan.report()).slice(0, 8)) findings.push({ side: mapName(m), section: 'Exploits', text: o.text, files: o.files || [] });
            }
          } catch (err) {
            note = `Not compared with the data: ${err.message}`;
          }
        } else {
          note = 'Not compared with the data: the title does not name a team and maps. Call again with team and maps.';
        }
        const review = reviewOutline(outline, fresh);
        reviews.set(doc.id, { outline, fresh, findings, issues: review.issues.map((x) => x.text) });
        // A new review starts a new rewrite: the next one is a fresh "Reviewed:" copy.
        rewriteCopies.delete(doc.id);
        pendingRewrites.delete(doc.id);
        let n = 0;
        const numbered = outline.map((p) => (p.heading ? `## ${p.side}${p.section ? ` / ${p.section}` : ''}` : `${n++}. ${p.text}`));
        return {
          content: fit({ title: doc.title, id: doc.id, note: [docNote, note].filter(Boolean).join(' '), points: review.points, issue_counts: review.counts, issues: review.issues.map((x) => `[${x.kind}] ${x.text}`), outline: numbered, for_notes: findings.map((f) => `${f.side} ${f.section}: ${f.text}`) }),
          display: `Reviewed "${doc.title}": ${review.issues.length} issue${review.issues.length === 1 ? '' : 's'}`,
          link: '/team/documents'
        };
      }
      case 'rewrite_antistrat_document': {
        const { dest, doc } = await documentOf(args.title, args.id);
        const seen = reviews.get(doc.id);
        if (!seen) throw new ToolError('Review the document first with review_antistrat_document.');
        const replace = args.mode === 'replace';
        const title = replace ? doc.title : `Reviewed: ${String(doc.title).replace(/^reviewed:\s*/i, '')}`;
        const sent = Array.isArray(args.sections) ? args.sections : [];
        // Parts: a long document is sent a few sections at a time and saved by the final call.
        // A section sent again (same side and heading) replaces the earlier one in its place.
        // Sections already saved by an earlier call for this review come first, so a rewrite
        // sent in several calls (with or without final false) grows one document.
        const copy = rewriteCopies.get(doc.id);
        const merged = new Map();
        for (const s of [...(copy?.sections || []), ...(pendingRewrites.get(doc.id) || []), ...sent]) merged.set(`${s?.side || ''}|${s?.heading || ''}`, s);
        const sections = [...merged.values()];
        if (args.final === false) {
          if (!sent.length) throw new ToolError('Send at least one section, or call with final true to save what was sent.');
          pendingRewrites.set(doc.id, sections);
          return {
            content: `Kept ${sent.length} section${sent.length === 1 ? '' : 's'} (${sections.length} so far). Send the next sections, then call again with final true. Nothing is saved yet.`,
            display: `Kept ${sections.length} section${sections.length === 1 ? '' : 's'} of the rewrite`
          };
        }
        let built;
        try {
          // Also allowed: this turn's data tools, and the review's own issues (its corrected numbers).
          const numbers = { text: [...turnNumbers, ...(seen.issues || [])].join(' '), files: [] };
          built = buildRewrite({ title, sections }, [...seen.outline.filter((p) => !p.heading), ...seen.fresh, ...seen.findings, numbers], escapeHtml);
        } catch (err) {
          // Kept, so the model corrects the one point and sends the final call again, not the whole document.
          if (sections.length) pendingRewrites.set(doc.id, sections);
          throw new ToolError(`${err.message}${sent.length ? ' The sections you sent are kept: fix that point in a section sent again with the same heading, or leave it out.' : ''}`);
        }
        pendingRewrites.delete(doc.id);
        const target = replace ? doc.id : copy?.copyId || '';
        const q = replace
          ? `Overwrite "${doc.title}" with the rewritten version (${built.points} points)? The old text is not kept.`
          : `${target ? 'Update' : 'Save'} the rewritten version (${built.points} points) as "${title}" in your team's Documents (${dest.name})?`;
        const ok = (await ctx.confirm?.(q)) ?? true;
        if (!ok) return { content: 'The user declined. Nothing was saved.', display: 'Rewrite not saved (declined)' };
        const saved = await saveTeamDocument(dest.id, target ? { id: target, title, html: built.html } : { title, html: built.html });
        const copyId = target || saved?.document?.id || '';
        rewriteCopies.set(doc.id, { copyId, sections });
        return {
          content: `${target && !replace ? 'Updated' : 'Saved'} "${title}"${copyId ? ` (id ${copyId})` : ''}: ${sections.length} section${sections.length === 1 ? '' : 's'}, ${built.points} points. More sections sent for this document are added to it.`,
          display: `Saved "${title}"`,
          link: '/team/documents'
        };
      }
      case 'database_query': {
        const table = args.table === 'teams' ? 'teams' : 'players';
        const filter = {};
        if (args.map) filter.maps = [mapCodeOf(args.map)];
        if (args.side === 'T' || args.side === 'CT') filter.side = args.side;
        if (args.buy && args.buy !== 'any') filter.econ = BUY_CODE[args.buy];
        if (args.vs_buy && args.vs_buy !== 'any') filter.oppEcon = BUY_CODE[args.vs_buy];
        if (args.result === 'won' || args.result === 'lost') filter.result = args.result;
        if (args.team) filter.teamName = (await teamOf(args.team)).name;
        if (args.date_from) filter.dateFrom = String(args.date_from);
        if (args.date_to) filter.dateTo = String(args.date_to);
        if (args.rank_own) filter.rankOwn = String(args.rank_own);
        if (args.rank_opp) filter.rankOpp = String(args.rank_opp);
        if (Number.isFinite(args.min_rounds) && args.min_rounds > 0) filter.minRounds = args.min_rounds;
        ctx.onProgress?.('Reading the Database…');
        const res = await fetchAggregate(filter, { tables: table, limit: 400 });
        let rows = res[table] || [];
        if (!rows.length) {
          return { content: `No ${table} match these filters.`, display: `Database: no ${table} match` };
        }
        const sortKey = args.sort_by && args.sort_by in rows[0] ? args.sort_by : table === 'players' ? 'rating' : 'avgRating';
        rows = [...rows].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
        const total = rows.length;
        rows = rows.slice(0, Math.max(1, Math.min(40, Math.round(args.limit) || 15)));
        const base = table === 'players' ? PLAYER_COLUMNS : TEAM_COLUMNS;
        const asked = [...new Set([...(Array.isArray(args.columns) ? args.columns : []), ...(args.sort_by ? [args.sort_by] : [])])];
        const extra = asked.flatMap((c) => [c, ...(COLUMN_SAMPLES[c] || [])]);
        const wanted = [...new Set([...base, ...extra])].filter((c) => c in rows[0]);
        const unknown = asked.filter((c) => !(c in rows[0]));
        const info = columnInfo(table);
        const notes = Object.fromEntries(asked.filter((c) => info.has(c) && c in rows[0]).map((c) => [c, info.get(c).about]));
        const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);
        const out = rows.map((r) => Object.fromEntries(wanted.map((c) => [c, round(r[c])])));
        return {
          content: fit({
            table,
            filters: filter,
            sorted_by: sortKey,
            ...(sortKey !== args.sort_by && args.sort_by ? { note: `"${args.sort_by}" is not a column here, so the rows are sorted by ${sortKey}.` } : {}),
            ...(Object.keys(notes).length ? { columns_meaning: notes } : {}),
            ...(unknown.length ? { unknown_columns: unknown, available_columns: [...info.keys()] } : {}),
            rows_total: total,
            ...(total <= rows.length ? { note_complete: `These are all ${total} rows. A larger limit returns the same rows. There is no per-map column: for a best map, call once per map with the "map" filter and compare.` } : {}),
            rows: out
          }),
          display: `Database: ${out.length} of ${total} ${table}, by ${sortKey}`,
          link: '/database'
        };
      }
      case 'list_matches': {
        const { payload } = await library();
        let list = [...payload.demos];
        if (args.map) {
          const code = mapCodeOf(args.map);
          list = list.filter((d) => d.map === code);
        }
        if (args.team) {
          const team = await teamOf(args.team);
          const side = (d) => (teamNameKey(d.name1, d.t1) === team.key ? 1 : teamNameKey(d.name2, d.t2) === team.key ? 2 : 0);
          list = list.filter((d) => side(d));
          if (args.opponent) {
            const opp = await teamOf(args.opponent);
            list = list.filter((d) => (side(d) === 1 ? teamNameKey(d.name2, d.t2) : teamNameKey(d.name1, d.t1)) === opp.key);
          }
        } else if (args.opponent) {
          throw new ToolError('opponent needs team: name both teams.');
        }
        const total = list.length;
        if (!total) return { content: fit({ total: 0, matches: [], note: 'No match in the library fits. list_teams shows the teams and their maps.' }), display: 'No matches found' };
        const limit = Math.max(1, Math.min(30, Math.round(args.limit) || 10));
        if (args.random) {
          for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
          }
        } else list.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
        const rows = list.slice(0, limit).map((d) => ({ match: d.id, label: matchLabel(d), map: MAPS[d.map]?.name || d.map, team1: d.name1 || d.t1, team2: d.name2 || d.t2, date: shortDate(d.uploadedAt, false) }));
        return {
          content: fit({ total, shown: rows.length, ...(args.random ? { picked: 'at random' } : { order: 'newest first' }), matches: rows }),
          display: args.random ? `Picked ${rows[0].label}` : `Found ${total} match${total === 1 ? '' : 'es'}`
        };
      }
      case 'match_summary': {
        const d = await matchById(args.match);
        ctx.onProgress?.('Reading the match…');
        const rounds = await roundsOfMatch(d);
        const label = matchLabel(d);
        if (!rounds.length) {
          return {
            content: fit({ match: d.id, label, note: 'The library has no rounds it can tie to this match (old round names carry no match id). Its rounds can still be found with find_rounds by team and map, but they may mix in other matches between the same teams.' }),
            display: `No rounds for ${label}`
          };
        }
        const name1 = d.name1 || d.t1;
        const name2 = d.name2 || d.t2;
        // Round files name the teams by the per-demo ids; team1 of a round is not always the demo's team 1.
        const winnerName = (r) => {
          const id = r.winner === 1 ? r.team1 : r.team2;
          return id === d.t1 ? name1 : id === d.t2 ? name2 : id;
        };
        const score = { [name1]: 0, [name2]: 0 };
        const half = { [name1]: 0, [name2]: 0 };
        for (const r of rounds) {
          const w = winnerName(r);
          score[w] = (score[w] || 0) + 1;
          if (r.round <= 12) half[w] = (half[w] || 0) + 1;
        }
        const numbers = rounds.map((r) => r.round);
        const missing = [];
        for (let n = 1; n <= Math.max(...numbers); n++) if (!numbers.includes(n)) missing.push(n);
        const a = score[name1];
        const b = score[name2];
        const complete = matchComplete(a, b) && !missing.length;
        let players = [];
        try {
          const agg = await fetchAggregateForRounds(rounds.map((r) => r.file), { tables: 'players', demos: [d.id], limit: 20 });
          const round3 = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v);
          players = (agg.players || [])
            .sort((x, y) => (Number(y.rating) || 0) - (Number(x.rating) || 0))
            .map((p) => ({ name: p.name, team: p.teamLabel, rating: round3(p.rating), kills: p.kills, deaths: p.deaths, adr: round3(p.adr), kast: round3(p.kast), rounds: p.rounds }));
        } catch (err) {
          players = [];
          ctx.onProgress?.(`Player stats failed: ${err.message}`);
        }
        const out = {
          match: d.id,
          label,
          map: MAPS[d.map]?.name || d.map,
          date: shortDate(d.uploadedAt, false),
          score: `${name1} ${a} - ${b} ${name2}`,
          winner: a === b ? 'level' : a > b ? name1 : name2,
          first_half: `${name1} ${half[name1]} - ${half[name2]} ${name2}`,
          rounds_in_library: rounds.length,
          ...(missing.length ? { missing_rounds: missing } : {}),
          complete,
          complete_note: complete
            ? 'A finished match (MR12: first to 13, overtime in blocks of 6 rounds).'
            : `Not a finished score under MR12 (first to 13; 12-12 goes to overtime)${missing.length ? ' and rounds are missing' : ''}: the library may not have the whole match.`,
          round_winners: rounds.map((r) => `${r.round} ${winnerName(r)}`).join(', '),
          players: players.length ? players : 'Player stats could not be read for this match.',
          top_performer: players[0] ? `${players[0].name} (${players[0].team}), rating ${players[0].rating}` : undefined
        };
        return { content: fit(out), display: `${label}: ${out.score}`, link: roundsLink(rounds.map((r) => r.file)) };
      }
      case 'find_rounds': {
        const { payload } = await library();
        const idsOf = (team) => idsOfTeam(payload, team);
        const query = {};
        if (args.map) query.maps = [mapCodeOf(args.map)];
        let team = null;
        let opp = null;
        /** The team's own buy, checked here: a team plays under a different id in each demo, and the server's teamEconomyOf takes one. */
        let teamBuy = null;
        if (args.team) {
          team = await teamOf(args.team);
          query.teams = [...idsOf(team)];
          // The opponent narrows the search; it is checked below, since the server's
          // teams filter keeps a round when either side is in it.
          if (args.opponent) opp = await teamOf(args.opponent);
          if (args.won_by === 'team') query.wonBy = [...idsOf(team)];
          if (args.buy && args.buy !== 'any') teamBuy = BUY_CODE[args.buy];
        } else if (args.opponent) {
          throw new ToolError('opponent needs team: name both teams.');
        }
        if (args.player) {
          const roster = await fetchRoster();
          const q = String(args.player).trim().toLowerCase();
          const hit = (roster?.players || []).find((p) => String(p.n || '').toLowerCase() === q || String(p.k || '').toLowerCase() === q);
          if (!hit) throw new ToolError(`No player called "${args.player}" in the library.`);
          query.players = [hit.i];
        }
        // One match lists all its rounds (a match has at most ~30 plus overtime); a search shows 12 unless asked.
        const limit = args.match ? Math.max(1, Math.min(40, Math.round(args.limit) || 40)) : Math.max(1, Math.min(30, Math.round(args.limit) || 12));
        let list;
        let cap = 0;
        let capped = false;
        let matchDemo = null;
        if (args.match) {
          matchDemo = await matchById(args.match);
          list = await roundsOfMatch(matchDemo);
        } else {
          cap = teamBuy === null && !opp ? 400 : 2000;
          const res = await findRounds(query, cap);
          list = res.rounds || [];
          capped = list.length >= cap;
        }
        if (team) {
          const mine = idsOf(team);
          if (opp) {
            const theirs = idsOf(opp);
            list = list.filter((r) => (mine.has(r.team1) && theirs.has(r.team2)) || (mine.has(r.team2) && theirs.has(r.team1)));
          }
          if (args.won_by === 'opponent') list = list.filter((r) => !mine.has(r.winner === 1 ? r.team1 : r.team2));
          if (teamBuy !== null) list = list.filter((r) => buyBucket(mine.has(r.team1) ? r.econ1 : r.econ2) === teamBuy);
        }
        const names = teamNames(payload);
        const nameOf = (id) => names.get(id) || id;
        const matches = new Map(payload.demos.map((d) => [String(d.id), matchLabel(d)]));
        const total = list.length;
        if (matchDemo) {
          // One match: its rounds in order, each with its half and the score going in.
          const before = scoresBefore(matchDemo, list);
          const winner = winnerNameIn(matchDemo);
          const rows = list.slice(0, limit).map((r) => ({ number: r.round, round: r.file, half: halfOf(r.round), score_before: before.get(r.file), winner: winner(r), buys: `${r.econ1}-${r.econ2}` }));
          return {
            content: fit({
              match: matchDemo.id,
              label: matchLabel(matchDemo),
              total_matching: total,
              shown: rows.length,
              ...(rows.length < total ? { more: `${total - rows.length} more rounds: call again with a larger limit, or read one round by match and number.` } : {}),
              rounds: rows,
              buys: '0 pistol, 1 eco, 2 half, 3 force, 4 full, 5 full with AWP (team 1 of the round file first)'
            }),
            display: `${matchLabel(matchDemo)}: ${total} round${total === 1 ? '' : 's'}`,
            link: roundsLink(list.map((r) => r.file))
          };
        }
        const rows = list.slice(0, limit).map((r) => {
          const match = matchOfFile(r.file);
          return {
            round: r.file,
            label: `${matches.get(match) || `${nameOf(r.team1)} vs ${nameOf(r.team2)}, ${r.mapName}`}, round ${r.round}`,
            match: match || 'unknown (an old round name)',
            map: r.mapName,
            number: r.round,
            team1: nameOf(r.team1),
            team2: nameOf(r.team2),
            winner: nameOf(r.winner === 1 ? r.team1 : r.team2),
            buys: `${r.econ1}-${r.econ2}`
          };
        });
        const distinct = new Set(list.map((r) => matchOfFile(r.file))).size;
        return {
          content: fit({
            total_matching: capped ? `${total}+ (the search stops at ${cap} rounds)` : total,
            from_matches: distinct,
            shown: rows.length,
            ...(rows.length < total ? { more: `${total - rows.length} more: call again with a larger limit (at most 30) or a narrower filter.` } : {}),
            rounds: rows,
            buys: '0 pistol, 1 eco, 2 half, 3 force, 4 full, 5 full with AWP'
          }),
          display: `Found ${total} round${total === 1 ? '' : 's'}${total > rows.length ? `, showing ${rows.length}` : ''}`,
          link: roundsLink(list.map((r) => r.file))
        };
      }
      case 'round_details': {
        const notFound = 'No round with that file. Never write a round file yourself: give match and number, or copy a file from find_rounds exactly.';
        const meta = await fetchRoundMeta(String(args.round || '')).catch((err) => {
          if (/not found/i.test(err?.message || '')) throw new ToolError(notFound);
          throw err;
        });
        if (!meta) throw new ToolError(notFound);
        // Where the round sits in its match: the half and the score going in.
        let place = {};
        const demoId = matchOfFile(args.round);
        if (demoId) {
          try {
            const d = await matchById(demoId);
            place = { match: d.id, half: halfOf(meta.round), score_before: scoresBefore(d, await roundsOfMatch(d)).get(String(args.round)) };
          } catch {
            /* the round still reads without its place in the match */
          }
        }
        const name = new Map((meta.players || []).map((p) => [p.id, p.name]));
        const tickRate = meta.tickRate || 64;
        const clock = (tick) => {
          const left = 115 - (tick - meta.freezeEndTick) / tickRate;
          const s = Math.max(0, Math.round(left));
          return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        };
        const weapons = meta.weapons || [];
        const out = {
          map: meta.mapName,
          round: meta.round,
          ...place,
          team1: `${meta.team1?.name} (${meta.team1Side})`,
          team2: `${meta.team2?.name} (${meta.team2Side})`,
          winner: meta.winner === 1 ? meta.team1?.name : meta.team2?.name,
          buys: { team1: meta.econ1, team2: meta.econ2 },
          players: (meta.players || []).map((p) => `${p.name} (team ${p.team})`),
          kills: (meta.events?.kills || []).map((k) => `${clock(k.tick)} ${name.get(k.attacker) || k.attacker} > ${name.get(k.victim) || k.victim} ${k.weapon}${k.headshot ? ' hs' : ''}`),
          grenades: (meta.events?.grenades || []).slice(0, 60).map((g) => `${clock(g.tick ?? g.throwTick ?? meta.freezeEndTick)} ${name.get(g.player || g.thrower) || g.player || ''} ${weapons[g.weapon] || g.type || g.kind || ''}`.trim()),
          bomb: (meta.events?.bomb || []).map((b) => `${clock(b.tick)} ${b.type || b.event || ''}`.trim())
        };
        return { content: fit(out), display: `Round ${meta.round} on ${meta.mapName}`, link: `/demos?rounds=${encodeURIComponent(String(args.round))}` };
      }
      case 'team_documents': {
        const myTeams = await fetchTeams();
        const team = myTeams?.[0];
        if (!team) throw new ToolError('The user is not in a team, so there are no team documents.');
        const docs = team.documents || [];
        if (!String(args.title || '').trim() && !args.id) {
          const newest = [...docs].sort((a, b) => updatedOf(b) - updatedOf(a));
          return {
            content: fit({
              team: team.name,
              total: docs.length,
              documents: newest.slice(0, 40).map((d) => ({ id: d.id, title: d.title, updated: shortDate(updatedOf(d)) })),
              ...(docs.length > 40 ? { note: `Newest 40 of ${docs.length}. Pass a title to find an older one.` } : {})
            }),
            display: `${docs.length} document${docs.length === 1 ? '' : 's'} in ${team.name}`,
            link: '/team/documents'
          };
        }
        const { doc: full, note: docNote } = await documentOf(args.title, args.id);
        const text = String(full.html || '')
          .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return { content: fit({ title: full.title, id: full.id, ...(docNote ? { note: docNote } : {}), text }), display: `Read "${full.title}"`, link: '/team/documents' };
      }
      case 'team_rankings': {
        const table = await fetchVrsRanks();
        const rows = table instanceof Map ? [...table.values()] : [];
        const q = String(args.query || '').trim().toLowerCase();
        const list = rows
          .filter((r) => !q || String(r.name || '').toLowerCase().includes(q))
          .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
          .slice(0, Math.max(1, Math.min(50, Math.round(args.top) || 20)));
        return { content: fit(list.map((r) => ({ rank: r.rank, team: r.name, points: r.points, region: r.region }))), display: `World ranking: ${list.length} team${list.length === 1 ? '' : 's'}` };
      }
      case 'site_map':
        return { content: fit(SITE_PAGES), display: 'Read the site map' };
      case 'round_value': {
        ctx.onProgress?.('Pricing the round…');
        const r = await roundValueTool({ round: args.round, moments: args.moments });
        return { content: fit(r.out), display: r.display, link: `/demos?rounds=${encodeURIComponent(r.file)}` };
      }
      case 'moment_value': {
        ctx.onProgress?.('Reading the moment…');
        const r = await momentValueTool({ round: args.round, clock: args.clock });
        return { content: fit(r.out), display: r.display, link: `/demos?rounds=${encodeURIComponent(r.file)}` };
      }
      case 'screenshot_round': {
        ctx.onProgress?.('Drawing the round…');
        const shot = await screenshotRound({ round: args.round, clock: args.clock, view: args.view });
        if (!args.show) return shot;
        // Shown to the user as a still they can play on from, which a saved chat can draw again.
        return { ...shot, content: `${shot.content}\n(Shown to the user in the chat.)`, widget: { file: args.round, label: await roundLabelOf(args.round), at: String(args.clock || '1:55') } };
      }
      case 'show_round': {
        const file = String(args.round || '').trim();
        if (!file) throw new ToolError('Give match and number (or a round file from find_rounds).');
        const label = await roundLabelOf(file);
        const widget = { file, label, ...(args.at ? { at: String(args.at) } : {}), ...(args.from ? { from: String(args.from) } : {}), ...(args.to ? { to: String(args.to) } : {}), ...(args.caption ? { caption: String(args.caption).slice(0, 200) } : {}) };
        return {
          content: `Shown to the user: ${label || 'the round'} (match ${matchOfFile(file) || '?'}, number ${Number(args.number) || '?'}; when the user picks this round, use exactly this match and number)${args.at ? `, paused at ${args.at}` : args.from || args.to ? `, ${args.from || '1:55'} to ${args.to || 'the end'}` : ''}. They can play and scrub it. Do not describe the player itself.`,
          display: `Showing ${label || 'a round'}`,
          widget
        };
      }
      case 'strategy_draft': {
        const file = String(args.round || '').trim();
        if (!file) throw new ToolError('Give match and number (or a round file from find_rounds).');
        const side = String(args.side || '').toUpperCase() === 'CT' ? 'CT' : 'T';
        ctx.onProgress?.('Reading the round…');
        const { meta } = await loadRound(file);
        const mapCode = String(meta.map || '').toUpperCase();
        const playerIds = sidePlayers(meta, side);
        if (playerIds.length < 2) throw new ToolError(`No ${side} side in this round.`);
        // Full ticks: a grenade's setpos is where the thrower stood at release.
        const track = new TickTrack(await fetchRoundTicks(file, 1));
        const { network } = await loadMapContext(mapCode);
        const demoId = matchOfFile(file);
        ctx.onProgress?.('Working out who plays which position…');
        const demoRoles = demoId ? ((await getStatsPayload([demoId], { columns: 'roles' }).catch(() => null))?.demos || []).find((x) => String(x.id) === demoId)?.roles || null : null;
        const { columns, seats } = await resolveSeats({
          mapCode,
          side,
          playerIds,
          demoRoles,
          libraryDemos: async () => {
            try {
              const ids = demosForPlayer(await fetchRoster(), playerIds.find(Boolean));
              return ids.length ? (await getStatsPayload(ids, { columns: 'roles' }))?.demos || [] : [];
            } catch {
              return [];
            }
          },
          network
        });
        if (!columns.length) throw new ToolError(`The stratbook has no ${side} columns for ${mapName(mapCode)}.`);
        const timing = timingFor(meta);
        const elapsedOf = (tick) => (Number(tick) - timing.freezeEndTick) / timing.tickRate;
        const ids = new Set(seats.filter(Boolean));
        const sideGrenades = (meta.events?.grenades || []).filter((g) => ids.has(g.player) && Number.isFinite(Number(g.throwTick))).sort((a, b) => Number(a.throwTick) - Number(b.throwTick));
        // The execute: the densest burst of this side's utility (from the clock the user gave, if any).
        // A strategy is that execute, written from the call; how the players walked to their spots
        // before it is not the strategy. The window opens a few seconds before the first grenade.
        const asked = args.from != null && args.from !== '' ? clockArg(args.from, 0) : null;
        const execute = findExecute(sideGrenades.filter((g) => asked == null || elapsedOf(g.throwTick) >= asked - 2).map((g) => ({ t: elapsedOf(g.throwTick), player: g.player })));
        const SETUP_LEAD = 4;
        const windowFrom = asked ?? (execute ? Math.max(0, execute.start - SETUP_LEAD) : 0);
        const windowTo = clockArg(args.to, 115 + 40);
        const callAt = execute ? execute.start : windowFrom;
        const grenades = sideGrenades.filter((g) => elapsedOf(g.throwTick) >= windowFrom - 0.5 && elapsedOf(g.throwTick) <= windowTo);
        const before = sideGrenades.length - grenades.length;
        const nameOf = new Map((meta.players || []).map((p) => [p.id, p.name]));
        const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));
        const scratch = {};
        const namer = createNamer(network, mapCode);
        /** A player's spot at a moment: the painted position he stands on, or '' when dead or unknown. */
        const spotAt = (id, elapsed) => {
          const slot = slotOf.get(id);
          if (slot == null || slot < 0) return '';
          const s = track.sample(slot, timing.freezeEndTick + elapsed * timing.tickRate, scratch);
          if (!s || !Number.isFinite(s.x) || s.alive === false) return '';
          return namer.positionName(s.x, s.y, s.z) || '';
        };
        const originOf = (g) => {
          const slot = slotOf.get(g.player);
          if (slot == null || slot < 0) return null;
          const s = track.sample(slot, Number(g.throwTick), scratch);
          return s && Number.isFinite(s.x) ? { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch } : null;
        };
        const viewTickOf = (g) => Math.max(timing.startTick, Number(g.throwTick) - 0.5 * timing.tickRate);
        const coach = await loadCoachSmokes(mapCode).catch(() => ({ utilities: [] }));
        // A dry run of the archive fold, on an empty archive, only to name each grenade's landing.
        const named = foldRoundUtility({ archive: { map: mapCode, updatedAt: 0, grenades: [] }, grenades, originOf, namer: createNamer(network, mapCode), coachUtilities: coach?.utilities || [], side, roundFile: file, viewTickOf });
        const linkOf = new Map(named.links.map((l) => [l.grenade, l]));
        const clockOfTick = (t) => clockText(115 - (Number(t) - timing.freezeEndTick) / timing.tickRate);
        const throws = grenades.map((g, i) => {
          const l = linkOf.get(g);
          const from = spotAt(g.player, elapsedOf(g.throwTick));
          return { tag: `t${i + 1}`, clock: clockOfTick(g.throwTick), player: nameOf.get(g.player) || g.player, what: [l?.spot, l?.word || g.type].filter(Boolean).join(' '), ...(from ? { thrown_from: from } : {}), linkable: Boolean(l) };
        });
        // Where each column's player waits when the execute is called (a second before the first grenade).
        const setup = columns.map((c, i) => ({ column: c, player: nameOf.get(seats[i]) || '', at: seats[i] ? spotAt(seats[i], Math.max(0, callAt - 1)) || 'dead or unknown' : '' }));
        const dest = await myTeam();
        const ownTeam = side === (meta.team1Side === 'CT' ? 'CT' : 'T') ? 1 : 2;
        const own = buyBucket(ownTeam === 1 ? meta.econ1 : meta.econ2);
        const opp = buyBucket(ownTeam === 1 ? meta.econ2 : meta.econ1);
        const awp = Number(ownTeam === 1 ? meta.econ1 : meta.econ2) === 5;
        const suggested = own === 0 ? 'Pistol' : own === 1 ? 'Eco' : own <= 3 ? 'Force' : opp <= 3 && opp >= 1 ? 'Antiforce' : awp ? 'Full buy + AWP' : 'Full buy';
        const id = `s${(++draftSeq).toString(36)}${Date.now().toString(36).slice(-4)}`;
        drafts.set(id, { file, meta, side, mapCode, network, columns, seats, grenades, throws, originOf, viewTickOf, coach, team: dest });
        while (drafts.size > 6) drafts.delete(drafts.keys().next().value);
        const label = await roundLabelOf(file);
        return {
          content: fit({
            draft: id,
            round: label,
            map: mapName(mapCode),
            side,
            execute: execute
              ? {
                  call_at: clockText(115 - callAt),
                  utility: `${execute.count} grenades from ${execute.throwers} players, ${clockText(115 - execute.start)} to ${clockText(115 - execute.end)}`,
                  window: `${clockText(115 - windowFrom)} to the end`,
                  before_the_call: `${before} grenade${before === 1 ? '' : 's'} thrown earlier, on the way to the setup: not part of this strategy`
                }
              : { call_at: clockText(115 - callAt), note: asked != null ? 'From the clock you gave.' : 'No burst of utility found: the whole round is the window. Ask the user from what clock the strategy starts if it is not clear.' },
            saving_to: `your team's stratbook (${dest.name})`,
            setup_at_call: setup,
            grenades: throws,
            how_to_write:
              'The strategy is the execute, from call_at. Each note: first where the player waits at the call (setup_at_call), then what he does from the call in order, each step with its clock time: every grenade he throws (its time, where he throws it from, linked as <label><!tag>), when he moves and to where, his entry or the angle he holds. Nothing from before call_at (how he got to the setup), no deaths or kills, no "die at".',
            link_format: 'Link every grenade you mention as <label><!tag>, for example <Long smoke><!t2>. Only grenades with linkable true can be linked.',
            call_types: side === 'CT' ? STRAT_CATEGORY_CT : STRAT_CATEGORY_T,
            economy_types: STRAT_ECONOMY,
            suggested_economy: suggested,
            next: `Read the round with round_timeline (same match and number, from ${clockText(115 - windowFrom)}) to see the movement and entry, write one note per column, then call save_strategy.`
          }),
          display: `Drafting a ${side} strategy from ${label || 'the round'}`
        };
      }
      case 'save_strategy': {
        const d = drafts.get(String(args.draft || ''));
        if (!d) throw new ToolError('No such draft. Call strategy_draft first (drafts are kept for this session).');
        const name = String(args.name || '').trim().slice(0, 80);
        if (!name) throw new ToolError('Give the strategy a name.');
        const pick = (list, v, what) => {
          const hit = list.find((x) => x.toLowerCase() === String(v || '').trim().toLowerCase());
          if (!hit) throw new ToolError(`"${v}" is not a ${what}. Use one of: ${list.join(', ')}.`);
          return hit;
        };
        const category = pick(d.side === 'CT' ? STRAT_CATEGORY_CT : STRAT_CATEGORY_T, args.category, 'call type');
        const economy = pick(STRAT_ECONOMY, args.economy, 'economy type');
        const notes = Array.isArray(args.notes) ? args.notes : [];
        const byColumn = new Map();
        for (const n of notes) {
          const col = d.columns.find((c) => c.toLowerCase() === String(n?.column || '').trim().toLowerCase());
          if (!col) throw new ToolError(`"${n?.column}" is not a column. The columns are: ${d.columns.join(', ')}.`);
          byColumn.set(col, String(n.text || '').trim());
        }
        if (![...byColumn.values()].some(Boolean)) throw new ToolError('Write at least one note.');
        const ok = (await ctx.confirm?.(`Save the ${d.side} strategy "${name}" (${category}, ${economy}) to ${d.team.name}'s stratbook?`)) ?? true;
        if (!ok) return { content: 'The user declined. Nothing was saved.', display: 'Strategy not saved (declined)' };
        // The order addStrategy.js keeps: the archive first (it mints the ids the notes link), then the notes.
        ctx.onProgress?.('Saving utility…');
        const stored = await fetchUtilityArchive(d.team.id, d.mapCode).catch(() => null);
        const folded = foldRoundUtility({
          archive: stored || { map: d.mapCode, updatedAt: 0, grenades: [] },
          grenades: d.grenades,
          originOf: d.originOf,
          namer: createNamer(d.network, d.mapCode),
          coachUtilities: d.coach?.utilities || [],
          strategyName: name,
          side: d.side,
          roundFile: d.file,
          viewTickOf: d.viewTickOf
        });
        let links = folded.links;
        if (folded.changed) {
          const saved = await saveUtilityArchive(d.team.id, d.mapCode, folded.archive);
          if (saved?.grenades) links = relinkAgainst(saved, folded, links);
        }
        const idOfTag = new Map();
        d.grenades.forEach((g, i) => {
          const l = links.find((x) => x.grenade === g);
          if (l?.throwId) idOfTag.set(`t${i + 1}`, l.throwId);
        });
        let linked = 0;
        const roleNotes = d.columns.map((c, i) => {
          // A grenade of this column's player named in plain words ("Long smoke") is linked too.
          const own = (d.throws || []).filter((t) => t.linkable && t.player === (d.meta.players || []).find((p) => p.id === d.seats[i])?.name);
          const out = linkStrategyTags(autoLinkGrenades(byColumn.get(c) || '', own), idOfTag);
          linked += out.linked;
          return out.text;
        });
        ctx.onProgress?.('Saving strategy…');
        const origin = typeof location !== 'undefined' ? location.origin : '';
        await saveTeamStrategy(d.team.id, {
          map: d.mapCode,
          side: d.side,
          name,
          category,
          economy,
          description: String(args.description || '').trim().slice(0, 600),
          link2d: origin ? `${origin}/demos?round=${encodeURIComponent(d.file)}` : '',
          roleNotes,
          visibleAll: true
        });
        drafts.delete(String(args.draft));
        const empty = d.columns.filter((c) => !byColumn.get(c));
        return {
          content: `Saved the ${d.side} strategy "${name}" (${category}, ${economy}) to your team's stratbook (${d.team.name}), ${mapName(d.mapCode)}. ${linked} grenade link${linked === 1 ? '' : 's'} in the notes${folded.dropped ? `; ${folded.dropped} grenade${folded.dropped === 1 ? '' : 's'} left out because the utility archive for this map is full` : ''}.${empty.length ? ` Empty columns: ${empty.join(', ')}.` : ''}`,
          display: `Saved strategy "${name}"`,
          link: '/team/stratbook'
        };
      }
      default:
        throw new ToolError(`There is no tool called "${name}".`);
    }
  } catch (err) {
    const known = err instanceof ToolError || err instanceof QueryError;
    return { content: `Error: ${err.message}`, display: `${name} failed: ${err.message}`, error: !known };
  }
}
