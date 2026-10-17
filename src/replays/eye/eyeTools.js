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
//   find_rounds                search the library's rounds (teams, players, map, buys)
//   round_details              one round's record: kills, grenades, bomb, score
//   team_documents             list and read the user's team documents
//   team_rankings              the VRS world ranking
//   site_map                   every page of the site, with links to cite
//   find_weaknesses            where a team loses on a map and side, measured and ranked
//   review_antistrat_document  check a document against the data and itself
//   rewrite_antistrat_document save a reorganised version (asks the user first)
//   queue_antistrat_documents  several teams and maps, one document each, in a row
//                              (asks the user once)
//   screenshot_round           (vision only) one moment of a round, as a picture
// ---------------------------------------------------------------------------

import {
  fetchAggregate,
  fetchRoster,
  fetchRoundMeta,
  fetchTeamDocument,
  fetchTeams,
  fetchVrsRanks,
  findRounds,
  saveTeamDocument
} from '../api.js';
import { screenshotRound } from './eyeVision.js';
import { getStatsPayload } from '../statsCache.js';
import { MAPS } from '../shared/roundId.js';
import { teamNameKey } from '../shared/statsMath.js';
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

/** A tool's answer is cut to this many characters before the model reads it. */
const MAX_RESULT_CHARS = 12000;

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
        'Count one team\'s rounds on one map that match conditions, optionally grouped. Returns how many rounds were considered, how many matched, and the groups with win counts. ' +
        CONDITION_HELP,
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          map: { type: 'string' },
          side: { type: 'string', enum: ['T', 'CT', 'any'] },
          buy: { type: 'string', enum: ['full', 'force', 'half', 'eco', 'pistol', 'any'], description: "The team's buy." },
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
      description: "Write antistrat documents for a team on one or more maps into the user's team Documents, in one document. The user is asked to confirm first.",
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          maps: { type: 'array', items: { type: 'string' } },
          style: { type: 'string', enum: ['full', 'outline', 'sixpack'] }
        },
        required: ['team', 'maps']
      }
    }
  }
];

const BUYS = ['full', 'force', 'half', 'eco', 'pistol', 'any'];
const BUY_CODE = { eco: 0, pistol: 1, half: 2, force: 3, full: 4 };

/** The Database's columns an answer usually needs; others can be named in `columns`. */
const PLAYER_COLUMNS = ['name', 'teamLabel', 'rounds', 'rating', 'kast', 'adr', 'kills', 'deaths', 'kd', 'impact', 'openKills', 'openDeaths', 'a4r', 'a4aim', 'utilDmgPerRound', 'flashHitRate', 'awpAccuracy'];
const TEAM_COLUMNS = ['name', 'rounds', 'matches', 'avgRating', 'winrate', 'ctWinrate', 'tWinrate'];

TOOLS.push(
  {
    type: 'function',
    function: {
      name: 'database_query',
      description:
        "The Database page: one row per player or per team, pooled over every match that fits the filters. Use it for ratings, ADR, KAST, opening duels, utility damage, AWP accuracy and the like. " +
        `Default player columns: ${PLAYER_COLUMNS.join(', ')}. Default team columns: ${TEAM_COLUMNS.join(', ')}. Name other columns in "columns" (for example mk3, mk4, hits, headshots, tfw, ratingT, ratingCT).`,
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
      name: 'find_rounds',
      description:
        'Search the round library. Returns rounds with their file (for screenshot_round and round_details), map, round number, teams, buys and who won. Filter by team, opponent, player, map, who won and buys.',
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string' },
          opponent: { type: 'string' },
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
      description: "One round's record: the score line, each player, kills with weapons and clock times, grenades thrown, the bomb. Use a file from find_rounds.",
      parameters: { type: 'object', properties: { round: { type: 'string' } }, required: ['round'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'team_documents',
      description: "The user's team documents (antistrat sheets, notes). Without \"title\" lists them; with it reads that document as text.",
      parameters: { type: 'object', properties: { title: { type: 'string' } } }
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
      name: 'site_map',
      description: 'Every page of aim4 and what it shows, with links. Use it to point the user to the right page, or to find which tool covers a question.',
      parameters: { type: 'object', properties: {} }
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
          title: { type: 'string', description: 'The document title, or part of it (team_documents lists them).' },
          team: { type: 'string', description: 'Only when the title does not say which team it is about.' },
          maps: { type: 'array', items: { type: 'string' }, description: 'Only when the title does not say the maps.' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rewrite_antistrat_document',
      description:
        'Save a reorganised and rewritten version of a document you reviewed. Give every section with its points, in the order they should read. Numbers must be copied from the review (the document or its "current data" lines); any other number is refused. Points keep their round links. The user confirms first.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The reviewed document.' },
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
        required: ['title', 'sections']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'queue_antistrat_documents',
      description:
        "Create several antistrat documents in a row: one document per job, each a team on one or more maps. maps can be [\"all\"] for every map the team has at least 3 demos on. The user confirms the whole queue once; a job that fails does not stop the rest.",
      parameters: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              properties: { team: { type: 'string' }, maps: { type: 'array', items: { type: 'string' } }, style: { type: 'string', enum: ['full', 'outline', 'sixpack'] } },
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
          view: { type: 'string', enum: ['players', 'map'], description: 'players (default) zooms onto where the players are; map shows the whole radar.' }
        },
        required: ['round', 'clock']
      }
    }
  }
];

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
async function writeAntistratDoc(team, maps, style, dest, onProgress) {
  const specs = [];
  for (const m of maps) {
    const scan = await teamScan(team.name, m, onProgress);
    specs.push({ teamName: team.name, mapCode: m, categories: SUMMARY_CATEGORIES.map((c) => c.key), report: scan.report(), links: false });
  }
  const html =
    style === 'sixpack'
      ? buildSixpackDocHtml(specs, escapeHtml)
      : specs.map((sp) => (style === 'outline' ? buildOutlineDocHtml(sp, escapeHtml) : buildSummaryDocHtml(sp, escapeHtml))).join('<hr>');
  const title = `${styleTitle(style)}: ${team.name} on ${maps.map(mapName).join(', ')}`;
  await saveTeamDocument(dest.id, { title, html });
  return title;
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

/** A document of the user's team by title: exact, then the only one containing it. */
async function documentOf(title) {
  const dest = await myTeam();
  const docs = dest.documents || [];
  const want = String(title || '').trim().toLowerCase();
  if (!want) throw new ToolError('Name the document (team_documents lists them).');
  const exact = docs.filter((d) => String(d.title || '').toLowerCase() === want);
  const near = exact.length ? exact : docs.filter((d) => String(d.title || '').toLowerCase().includes(want));
  if (!near.length) throw new ToolError(`No document called "${title}". Call team_documents to list them.`);
  if (near.length > 1) throw new ToolError(`"${title}" could be ${near.slice(0, 6).map((d) => `"${d.title}"`).join(', ')}. Use the full title.`);
  const full = (await fetchTeamDocument(dest.id, near[0].id)) || near[0];
  return { dest, doc: full };
}

/** "Summary: NAVI on Nuke, Mirage" -> the team and maps a generated title names. */
function subjectOfTitle(title) {
  const m = String(title || '').match(/^(?:summary|outline|sixpack|reviewed)?:?\s*(.+?)\s+on\s+(.+)$/i);
  if (!m) return null;
  return { team: m[1].replace(/^(summary|outline|sixpack|reviewed):\s*/i, ''), maps: m[2].split(/\s*,\s*|\s+and\s+/) };
}

/** The last review per document: what a rewrite is checked against. */
const reviews = new Map();

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
export async function runTool(name, args = {}, ctx = {}) {
  try {
    switch (name) {
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
        const scan = await teamScan(args.team, args.map, ctx.onProgress);
        const r = runRoundQuery(scan.results.extract.rounds, scan.results.extract.network, args);
        const { files, ...rest } = r;
        const head = `${scan.team.name} on ${MAPS[scan.mapCode]?.name || scan.mapCode}: ${r.matched} of ${r.considered} rounds`;
        return { content: fit({ team: scan.team.name, map: MAPS[scan.mapCode]?.name, ...rest }), display: head, link: roundsLink(files) };
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
          const head = `${p.side} ${p.section}`.trim();
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
        const dest = await myTeam();
        const ok = (await ctx.confirm?.(`Create a ${style} antistrat document for ${team.name} on ${maps.map(mapName).join(', ')} in ${dest.name}'s Documents?`)) ?? false;
        if (!ok) return { content: 'The user declined. Nothing was created.', display: 'Document not created (declined)' };
        const title = await writeAntistratDoc(team, maps, style, dest, ctx.onProgress);
        return { content: `Saved "${title}" to ${dest.name}'s Documents.`, display: `Saved "${title}"`, link: '/team/documents' };
      }
      case 'queue_antistrat_documents': {
        const raw = (Array.isArray(args.jobs) ? args.jobs : []).slice(0, 20);
        if (!raw.length) throw new ToolError('Give at least one job: a team and its maps.');
        const jobs = [];
        for (const j of raw) {
          const team = await teamOf(j.team);
          jobs.push({ team, maps: await mapsOf(team, j.maps), style: STYLES.includes(j.style) ? j.style : 'full' });
        }
        const dest = await myTeam();
        const list = jobs.map((j, i) => `${i + 1}. ${j.team.name} on ${j.maps.map(mapName).join(', ')} (${j.style})`).join('\n');
        const ok = (await ctx.confirm?.(`Create ${jobs.length} antistrat document${jobs.length === 1 ? '' : 's'} in ${dest.name}'s Documents?\n${list}`)) ?? false;
        if (!ok) return { content: 'The user declined. Nothing was created.', display: 'Queue not run (declined)' };
        const done = [];
        const failed = [];
        for (const [i, j] of jobs.entries()) {
          const before = new Set(scans.keys());
          try {
            const title = await writeAntistratDoc(j.team, j.maps, j.style, dest, (label) => ctx.onProgress?.(`Document ${i + 1} of ${jobs.length}: ${label}`));
            done.push(title);
          } catch (err) {
            failed.push(`${j.team.name}: ${err.message}`);
          }
          // A long queue would otherwise hold every scan's rounds in memory.
          for (const k of scans.keys()) if (!before.has(k)) scans.delete(k);
        }
        return {
          content: fit({ saved: done, failed }),
          display: `Saved ${done.length} of ${jobs.length} document${jobs.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}`,
          link: '/team/documents'
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
        const { doc } = await documentOf(args.title);
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
        reviews.set(doc.id, { outline, fresh, findings });
        let n = 0;
        const numbered = outline.map((p) => (p.heading ? `## ${p.side}${p.section ? ` / ${p.section}` : ''}` : `${n++}. ${p.text}`));
        return {
          content: fit({ title: doc.title, note, points: review.points, issue_counts: review.counts, issues: review.issues.map((x) => `[${x.kind}] ${x.text}`), outline: numbered, for_notes: findings.map((f) => `${f.side} ${f.section}: ${f.text}`) }),
          display: `Reviewed "${doc.title}": ${review.issues.length} issue${review.issues.length === 1 ? '' : 's'}`,
          link: '/team/documents'
        };
      }
      case 'rewrite_antistrat_document': {
        const { dest, doc } = await documentOf(args.title);
        const seen = reviews.get(doc.id);
        if (!seen) throw new ToolError('Review the document first with review_antistrat_document.');
        const replace = args.mode === 'replace';
        const title = replace ? doc.title : `Reviewed: ${String(doc.title).replace(/^reviewed:\s*/i, '')}`;
        let built;
        try {
          built = buildRewrite({ title, sections: args.sections }, [...seen.outline.filter((p) => !p.heading), ...seen.fresh, ...seen.findings], escapeHtml);
        } catch (err) {
          throw new ToolError(err.message);
        }
        const q = replace
          ? `Overwrite "${doc.title}" with the rewritten version (${built.points} points)? The old text is not kept.`
          : `Save the rewritten version (${built.points} points) as "${title}" in ${dest.name}'s Documents?`;
        const ok = (await ctx.confirm?.(q)) ?? false;
        if (!ok) return { content: 'The user declined. Nothing was saved.', display: 'Rewrite not saved (declined)' };
        await saveTeamDocument(dest.id, replace ? { id: doc.id, title, html: built.html } : { title, html: built.html });
        return { content: `Saved "${title}" (${built.points} points).`, display: `Saved "${title}"`, link: '/team/documents' };
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
        const wanted = [...new Set([...base, ...(Array.isArray(args.columns) ? args.columns : [])])].filter((c) => c in rows[0]);
        const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);
        const out = rows.map((r) => Object.fromEntries(wanted.map((c) => [c, round(r[c])])));
        return {
          content: fit({ table, filters: filter, sorted_by: sortKey, rows_total: total, rows: out }),
          display: `Database: ${out.length} of ${total} ${table}, by ${sortKey}`,
          link: '/database'
        };
      }
      case 'find_rounds': {
        const { payload } = await library();
        const idsOf = (team) =>
          new Set(
            payload.demos.flatMap((d) => [
              teamNameKey(d.name1, d.t1) === team.key ? d.t1 : '',
              teamNameKey(d.name2, d.t2) === team.key ? d.t2 : ''
            ]).filter(Boolean)
          );
        const query = {};
        if (args.map) query.maps = [mapCodeOf(args.map)];
        let team = null;
        if (args.team) {
          team = await teamOf(args.team);
          query.teams = [...idsOf(team)];
          if (args.opponent) {
            const opp = await teamOf(args.opponent);
            query.teams = [...query.teams, ...idsOf(opp)];
          }
          if (args.won_by === 'team') {
            query.wonBy = query.teams.slice(0, idsOf(team).size);
          }
          if (args.buy && args.buy !== 'any') {
            query.teamEconomyOf = [...idsOf(team)][0];
            query.teamEconomies = [BUY_CODE[args.buy]];
          }
        }
        if (args.player) {
          const roster = await fetchRoster();
          const q = String(args.player).trim().toLowerCase();
          const hit = (roster?.players || []).find((p) => String(p.n || '').toLowerCase() === q || String(p.k || '').toLowerCase() === q);
          if (!hit) throw new ToolError(`No player called "${args.player}" in the library.`);
          query.players = [hit.i];
        }
        const limit = Math.max(1, Math.min(30, Math.round(args.limit) || 12));
        const res = await findRounds(query, 400);
        let list = res.rounds || [];
        if (args.won_by === 'opponent' && team) {
          const mine = idsOf(team);
          list = list.filter((r) => !mine.has(r.winner === 1 ? r.team1 : r.team2));
        }
        const total = list.length;
        const rows = list.slice(0, limit).map((r) => ({
          round: r.file,
          map: r.mapName,
          number: r.round,
          team1: r.team1,
          team2: r.team2,
          winner: r.winner === 1 ? r.team1 : r.team2,
          buys: `${r.econ1}-${r.econ2}`
        }));
        return {
          content: fit({ total_matching: total, shown: rows.length, rounds: rows, buys: '0 eco, 1 pistol, 2 half, 3 force, 4 full, 5 full with AWP' }),
          display: `Found ${total} round${total === 1 ? '' : 's'}${total > rows.length ? `, showing ${rows.length}` : ''}`,
          link: roundsLink(list.map((r) => r.file))
        };
      }
      case 'round_details': {
        const meta = await fetchRoundMeta(String(args.round || ''));
        if (!meta) throw new ToolError('That round was not found. Use a file from find_rounds.');
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
        const want = String(args.title || '').trim().toLowerCase();
        if (!want) {
          return {
            content: fit({ team: team.name, documents: docs.map((d) => ({ title: d.title, updated: d.updatedAt || d.updated || '' })) }),
            display: `${docs.length} document${docs.length === 1 ? '' : 's'} in ${team.name}`,
            link: '/team/documents'
          };
        }
        const doc = docs.find((d) => String(d.title || '').toLowerCase() === want) || docs.find((d) => String(d.title || '').toLowerCase().includes(want));
        if (!doc) throw new ToolError(`No document called "${args.title}". Call team_documents without a title to list them.`);
        const full = (await fetchTeamDocument(team.id, doc.id)) || doc;
        const text = String(full.html || '')
          .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return { content: fit({ title: full.title, text }), display: `Read "${full.title}"`, link: '/team/documents' };
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
      case 'screenshot_round': {
        ctx.onProgress?.('Drawing the round…');
        return await screenshotRound({ round: args.round, clock: args.clock, view: args.view });
      }
      default:
        throw new ToolError(`There is no tool called "${name}".`);
    }
  } catch (err) {
    const known = err instanceof ToolError || err instanceof QueryError;
    return { content: `Error: ${err.message}`, display: `${name} failed: ${err.message}`, error: !known };
  }
}
