// ---------------------------------------------------------------------------
// replays/training/trainingSources.js
// What the training pages put in front of the bot: a random round, or a
// random team on a map with its antistrat summary already written.
//
// Everything here reads the library the way the rest of the site does
// (the demos listing, round metas and ticks, the stats payload, the antistrat
// scan) so a label is about exactly what a user would see.
// ---------------------------------------------------------------------------

import { fetchDemo, fetchDemos, fetchRoundMeta, fetchRoundTicks, fetchRoster } from '../api.js';
import { getStatsPayload } from '../statsCache.js';
import { TickTrack } from '../tickStore.js';
import { loadMapContext, runAntistratScan } from '../analytics/antistratScan.js';
import { PACE_TYPES } from '../analytics/patternDefs.js';
import { SUMMARY_CATEGORIES, buildSummaryDocHtml, buildSummaryReport } from '../analytics/antistratSummary.js';
import { teamNameKey } from '../shared/statsMath.js';
import { describeRound } from './roundStory.js';

/** A team needs this many demos on a map before its antistrat says anything. */
export const TEAM_MIN_DEMOS = 4;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

let demoList = null;
async function readyDemos() {
  if (!demoList) {
    const lib = await fetchDemos({ limit: 5000 });
    demoList = (lib.demos || []).filter((d) => d.status === 'ready' && d.map);
  }
  return demoList;
}

const mapContexts = new Map();
function mapContext(mapCode) {
  if (!mapContexts.has(mapCode)) mapContexts.set(mapCode, loadMapContext(mapCode));
  return mapContexts.get(mapCode);
}

/**
 * A random round of the library, read and described.
 *
 * @returns {Promise<{ file: string, demoId: string, meta: object, story: object }>}
 */
export async function randomRoundStory({ tries = 6 } = {}) {
  const demos = await readyDemos();
  if (!demos.length) throw new Error('The library has no parsed demos.');
  let lastError = null;
  for (let i = 0; i < tries; i++) {
    try {
      const demo = pick(demos);
      const full = (await fetchDemo(demo.id))?.demo;
      const rounds = (full?.rounds || []).filter((r) => r.file);
      if (!rounds.length) continue;
      const file = pick(rounds).file;
      const meta = await fetchRoundMeta(file);
      const track = new TickTrack(await fetchRoundTicks(file, 16));
      const story = describeRound({ meta, track, ...(await mapContext(meta.map)), file });
      if (story) return { file, demoId: demo.id, meta: { ...meta, file }, story };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not find a round to describe.');
}

/**
 * Every (team, map) with enough demos for an antistrat, from the library
 * listing. A team is keyed the way the antistrat scan keys it.
 */
export async function teamMapChoices(min = TEAM_MIN_DEMOS) {
  const demos = await readyDemos();
  const by = new Map();
  for (const d of demos) {
    for (const t of [d.team1, d.team2]) {
      if (!t?.name) continue;
      const key = `${teamNameKey(t.name, t.id)}|${d.map}`;
      if (!by.has(key)) by.set(key, { teamKey: teamNameKey(t.name, t.id), teamName: t.name, mapCode: d.map, demoIds: [] });
      by.get(key).demoIds.push(d.id);
    }
  }
  return [...by.values()].filter((c) => c.demoIds.length >= min).sort((a, b) => b.demoIds.length - a.demoIds.length);
}

let properNames = null;
async function rosterNames() {
  if (!properNames) {
    try {
      const roster = await fetchRoster();
      properNames = new Map((roster?.players || []).filter((p) => p.i).map((p) => [p.i, p.k || p.n || p.i]));
    } catch {
      properNames = new Map();
    }
  }
  return properNames;
}

/**
 * The antistrat summary for one team on one map, as the sheet and as points:
 * every line of the sheet with the rounds it was written from.
 *
 * @param {{ teamKey: string, teamName: string, mapCode: string, demoIds: string[] }} choice
 * @param {(label: string) => void} [onProgress]
 */
export async function teamSummary(choice, onProgress) {
  onProgress?.('Loading rounds…');
  const payload = await getStatsPayload(choice.demoIds, { columns: ['roundLibrary', 'roles'] });
  const results = await runAntistratScan({
    properNames: await rosterNames(),
    payload,
    teamKey: choice.teamKey,
    mapCode: choice.mapCode,
    demoIds: choice.demoIds,
    paceKeys: PACE_TYPES.map((p) => p.key),
    keepRounds: true,
    onProgress: (done, total) => onProgress?.(`Scanning round ${done} of ${total}…`)
  });
  onProgress?.('Writing the summary…');
  const report = buildSummaryReport({
    extract: results.extract,
    sections: results.sections,
    mapCode: choice.mapCode,
    teamName: choice.teamName
  });
  const html = buildSummaryDocHtml(
    {
      teamName: choice.teamName,
      mapCode: choice.mapCode,
      categories: SUMMARY_CATEGORIES.map((c) => c.key),
      report,
      links: true
    },
    escapeHtml
  );
  return { report, html, points: pointsFromSummaryHtml(html) };
}

/** Round files out of a sheet link: /demos?rounds=a,b,c. */
function filesOfHref(href) {
  const m = /[?&]rounds=([^&#]*)/.exec(href || '');
  if (!m) return [];
  return decodeURIComponent(m[1])
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Every line of a summary sheet built with links on, as a point: the side and
 * section it sits in, its words exactly as the sheet prints them, and the
 * rounds it was written from. A line nested under another is its own point.
 * Lines without rounds (a player's role) say nothing a round could back up and
 * are left out.
 *
 * @param {string} html
 * @returns {Array<{ side: string, section: string, text: string, files: string[] }>}
 */
export function pointsFromSummaryHtml(html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  const root = doc.getElementById('root');
  const out = [];
  let side = '';
  let section = '';
  const own = (node) => {
    // The node's words and links without what is nested under it.
    const clone = node.cloneNode(true);
    clone.querySelectorAll('ul, ol').forEach((x) => x.remove());
    const files = [...clone.querySelectorAll('a')].flatMap((a) => filesOfHref(a.getAttribute('href')));
    return { text: clone.textContent.replace(/\s+/g, ' ').trim(), files: [...new Set(files)] };
  };
  const visit = (node) => {
    for (const child of node.children) {
      const tag = child.tagName;
      if (tag === 'H2') {
        const t = child.textContent || '';
        side = /\bCT SIDE\b/i.test(t) ? 'CT' : /\bT SIDE\b/i.test(t) ? 'T' : t.trim();
        section = '';
      } else if (tag === 'H3') {
        section = child.textContent.replace(/\s+/g, ' ').trim();
      } else if (tag === 'LI' || tag === 'P') {
        const { text, files } = own(child);
        if (text && files.length) out.push({ side, section, text, files });
        visit(child);
      } else visit(child);
    }
  };
  visit(root);
  return out;
}
