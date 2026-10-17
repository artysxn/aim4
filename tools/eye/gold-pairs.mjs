#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/gold-pairs.mjs
// Each manual antistrat in tools/eye/gold/ next to the sheet the rule-based
// generator writes for the same team and map, from the same library.
//
//   node tools/eye/gold-pairs.mjs [--base http://localhost:3784] [out.jsonl]
//
// One line per manual sheet whose team has demos on that map:
//   { team, map, lang, rounds, generated, manual }
//
// Two uses:
//   * fine-tuning: "rewrite the generated sheet the way the coach writes it"
//     (generated -> manual), the example the model most needs
//   * the generators: read the pair side by side to see what the coach
//     noticed that no rule does yet (tools/eye/GENERATOR_GAPS.md)
//
// Runs the same scan and summary the site runs, in Node, against a server's
// API (local mode needs no sign-in).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = (baseAt >= 0 ? args.splice(baseAt, 2)[1] : 'http://localhost:3784').replace(/\/$/, '');
const OUT = args[0] || 'gold-pairs.jsonl';

// The site's modules expect a browser: relative fetches and localStorage.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(typeof url === 'string' && url.startsWith('/') ? BASE + url : url, opts);
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= globalThis;
globalThis.location ??= new URL(BASE);

const SRC = path.join(HERE, '../../src/replays');
const { getStatsPayload } = await import(`${SRC}/statsCache.js`);
const { runAntistratScan } = await import(`${SRC}/analytics/antistratScan.js`);
const { buildSummaryReport, buildSummaryDocHtml, SUMMARY_CATEGORIES } = await import(`${SRC}/analytics/antistratSummary.js`);
const { teamNameKey } = await import(`${SRC}/shared/statsMath.js`);
const { PACE_TYPES } = await import(`${SRC}/analytics/patternDefs.js`);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The sheet as plain text, the way the manual ones read. */
const textOf = (html) =>
  html
    .replace(/<h[123][^>]*>/g, '\n')
    .replace(/<li>/g, '\n- ')
    .replace(/<(p|br)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
    .trim();

const { docs } = JSON.parse(fs.readFileSync(path.join(HERE, 'gold/index.json'), 'utf8'));
const library = (await (await fetch('/api/replays/demos')).json()).demos.filter((d) => d.status === 'ready');
const roster = await (await fetch('/api/replays/roster')).json().catch(() => null);
const properNames = new Map((roster?.players || []).filter((p) => p.i).map((p) => [p.i, p.k || p.n || p.i]));

const out = [];
const sheets = new Map();
for (const g of docs) {
  const want = g.team.toLowerCase();
  const demos = library.filter((d) => d.map === g.map && [d.team1?.name, d.team2?.name].some((n) => (n || '').toLowerCase() === want));
  if (!demos.length) {
    console.log(`skip ${g.file}: no ${g.team} demos on ${g.map} at ${BASE}`);
    continue;
  }
  const key = `${want}|${g.map}`;
  if (!sheets.has(key)) {
    const payload = await getStatsPayload(demos.map((d) => d.id), { columns: ['roundLibrary', 'roles'] });
    const pd = payload.demos.find((d) => [d.name1, d.name2].some((n) => (n || '').toLowerCase() === want));
    const first = (pd.name1 || '').toLowerCase() === want;
    const teamName = first ? pd.name1 : pd.name2;
    const results = await runAntistratScan({
      payload,
      teamKey: first ? teamNameKey(pd.name1, pd.t1) : teamNameKey(pd.name2, pd.t2),
      mapCode: g.map,
      demoIds: demos.map((d) => d.id),
      paceKeys: PACE_TYPES.map((p) => p.key),
      keepRounds: true,
      properNames
    });
    const report = buildSummaryReport({ extract: results.extract, sections: results.sections, mapCode: g.map, teamName });
    const html = buildSummaryDocHtml({ teamName, mapCode: g.map, categories: SUMMARY_CATEGORIES.map((c) => c.key), report }, esc);
    sheets.set(key, { rounds: results.rounds, demos: demos.length, generated: textOf(html) });
  }
  const s = sheets.get(key);
  out.push({ team: g.team, map: g.map, lang: g.lang, demos: s.demos, rounds: s.rounds, generated: s.generated, manual: fs.readFileSync(path.join(HERE, 'gold', g.file), 'utf8') });
  console.log(`pair ${g.file}: ${s.demos} demos, ${s.rounds} rounds`);
}
fs.writeFileSync(OUT, out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
console.log(`${out.length} pairs -> ${OUT}`);
process.exit(0);
