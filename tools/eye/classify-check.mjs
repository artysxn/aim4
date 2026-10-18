#!/usr/bin/env node
// Print how classify_rounds sorts one team's T rounds on a map, round by round,
// to check the execute / split / rush / contact calls against the viewer.
//
//   node tools/eye/classify-check.mjs <team> <MAP> [players] [--base http://localhost:3784]
// With "players", prints player_patterns instead.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const BASE = (baseAt >= 0 ? args.splice(baseAt, 2)[1] : 'http://localhost:3784').replace(/\/$/, '');
const [TEAM, MAP, MODE] = args;
if (!TEAM || !MAP) throw new Error('usage: classify-check.mjs <team> <MAP>');

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(typeof url === 'string' && url.startsWith('/') ? BASE + url : url, opts);
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= globalThis;
globalThis.location ??= new URL(BASE);

const SRC = pathToFileURL(path.join(HERE, '../../src/replays')).href;
const { getStatsPayload } = await import(`${SRC}/statsCache.js`);
const { runAntistratScan } = await import(`${SRC}/analytics/antistratScan.js`);
const { teamNameKey } = await import(`${SRC}/shared/statsMath.js`);
const { PACE_TYPES } = await import(`${SRC}/analytics/patternDefs.js`);
const { classifyRound } = await import(`${SRC}/eye/roundTypes.js`);
const { playerPatterns } = await import(`${SRC}/eye/playerPatterns.js`);

const library = (await (await fetch('/api/replays/demos')).json()).demos.filter((d) => d.status === 'ready');
const roster = await (await fetch('/api/replays/roster')).json().catch(() => null);
const properNames = new Map((roster?.players || []).filter((p) => p.i).map((p) => [p.i, p.k || p.n || p.i]));
const want = TEAM.toLowerCase();
const demos = library.filter((d) => d.map === MAP && [d.team1?.name, d.team2?.name].some((n) => (n || '').toLowerCase() === want));
if (!demos.length) throw new Error(`no ${TEAM} demos on ${MAP}`);
const payload = await getStatsPayload(demos.map((d) => d.id), { columns: ['roundLibrary', 'roles'] });
const pd = payload.demos.find((d) => [d.name1, d.name2].some((n) => (n || '').toLowerCase() === want));
const first = (pd.name1 || '').toLowerCase() === want;
const results = await runAntistratScan({
  payload,
  teamKey: first ? teamNameKey(pd.name1, pd.t1) : teamNameKey(pd.name2, pd.t2),
  mapCode: MAP,
  demoIds: demos.map((d) => d.id),
  paceKeys: PACE_TYPES.map((p) => p.key),
  keepRounds: true,
  properNames
});
const { rounds, network, nameOf } = results.extract;
if (MODE === 'players') {
  for (const x of playerPatterns(rounds, network, { nameOf })) {
    console.log(`
${x.player} (${x.side}, ${x.rounds} rounds)`);
    for (const l of x.how_he_plays) console.log(`  - ${l}`);
    for (const l of x.how_to_play_him) console.log(`  > ${l}`);
  }
  process.exit(0);
}
const counts = {};
for (const r of rounds.filter((x) => x.side === 'T')) {
  const c = classifyRound(r, network, { nameOf, mapCode: MAP });
  const key = c.kind === 'no-hit' ? 'no hit' : `${c.site} ${c.kind}`;
  counts[key] = (counts[key] || 0) + 1;
  const lanes = c.lanes.map((l) => `${l.from}[${l.players.length}]@${l.on_site_at}`).join(' ');
  const join = c.joiners.length ? ` joiners ${c.joiners.map((j) => `${j.from}@${j.at}`).join(',')}` : '';
  console.log(`${r.demoId} r${String(r.round).padStart(2)} ${r.won ? 'W' : 'L'} ${c.label.padEnd(44)} pace=${c.pace.padEnd(12)} util=${c.utility} ${lanes}${join} score=${c.score}`);
}
console.log(counts);
process.exit(0);
