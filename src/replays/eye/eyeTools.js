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
// ---------------------------------------------------------------------------

import { fetchRoster, fetchTeams, saveTeamDocument } from '../api.js';
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

/** Cut a result to what fits the model's context, saying so when it was cut. */
function fit(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the rest did not fit]`;
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
        const maps = (Array.isArray(args.maps) ? args.maps : [args.maps]).filter(Boolean).map(mapCodeOf);
        if (!maps.length) throw new ToolError('Name at least one map.');
        const style = ['full', 'outline', 'sixpack'].includes(args.style) ? args.style : 'full';
        const mapNames = maps.map((m) => MAPS[m]?.name || m).join(', ');
        const myTeams = await fetchTeams();
        const dest = myTeams?.[0];
        if (!dest) throw new ToolError('The user is not in a team, so there is nowhere to save documents.');
        const ok = (await ctx.confirm?.(`Create a ${style} antistrat document for ${team.name} on ${mapNames} in ${dest.name}'s Documents?`)) ?? false;
        if (!ok) return { content: 'The user declined. Nothing was created.', display: 'Document not created (declined)' };
        const specs = [];
        for (const m of maps) {
          const scan = await teamScan(team.name, m, ctx.onProgress);
          specs.push({ teamName: team.name, mapCode: m, categories: SUMMARY_CATEGORIES.map((c) => c.key), report: scan.report(), links: false });
        }
        const html =
          style === 'sixpack'
            ? buildSixpackDocHtml(specs, escapeHtml)
            : specs.map((s) => (style === 'outline' ? buildOutlineDocHtml(s, escapeHtml) : buildSummaryDocHtml(s, escapeHtml))).join('<hr>');
        const title = `${style === 'sixpack' ? 'Sixpack' : style === 'outline' ? 'Outline' : 'Summary'}: ${team.name} on ${mapNames}`;
        await saveTeamDocument(dest.id, { title, html });
        return { content: `Saved "${title}" to ${dest.name}'s Documents.`, display: `Saved "${title}"`, link: '/team/documents' };
      }
      default:
        throw new ToolError(`There is no tool called "${name}".`);
    }
  } catch (err) {
    const known = err instanceof ToolError || err instanceof QueryError;
    return { content: `Error: ${err.message}`, display: `${name} failed: ${err.message}`, error: !known };
  }
}
