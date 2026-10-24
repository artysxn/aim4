#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/plays/build-baselines.mjs
// Learn what is default on each map: where each side usually stands, per
// economy and per ten seconds of the clock, how unusual a round's shape is,
// and how often each kind of play is run (src/replays/plays/playMap.js).
//
//   node --max-old-space-size=8192 tools/eye/plays/build-baselines.mjs [corpus flags] [--publish]
//
// Corpus flags: see corpus.mjs (--dir, --rounds-dir, --base/--token, --maps,
// --per-map). The more rounds, the better the eye knows a default from a play;
// a few hundred rounds a map is a start, a few thousand is good.
//
// Writes tools/eye/plays/out/baselines/<MAP>.json. With --publish also copies
// them to public/eye/play-baselines/, where the desktop app's server reads
// them instead of learning a baseline from the library on the first question.
// When this machine has the painted zone networks (scripts/fetch-zone-networks.mjs),
// places get their real callouts and the bombsites their real names.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusOptions, flagOf, loadCorpus } from './corpus.mjs';
import { BASELINE_DIR, learnMap, mapName, writeBaseline } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { flag, has } = flagOf();
const outDir = flag('--out', BASELINE_DIR);

const corpus = await loadCorpus(corpusOptions());
if (!corpus.size) {
  console.error('No rounds found. Point --dir, --rounds-dir or --base at a library.');
  process.exit(1);
}
for (const [map, indexes] of corpus) {
  const t0 = Date.now();
  const b = await learnMap(map, indexes);
  writeBaseline(outDir, b);
  const sites = b.anchors.sites ? `sites from ${b.anchors.sitesFrom}` : 'no plants: no bombsites';
  const named = Object.values(b.cells).some((c) => c.name) ? 'callouts from the zones' : 'no zones on this machine: places named from spawns and sites';
  console.log(`${mapName(map)}: ${indexes.length} rounds, ${Object.keys(b.cells).length} cells, ${sites}, ${named} (${Date.now() - t0} ms)`);
  if (has('--publish')) {
    const pub = path.join(here, '../../../public/eye/play-baselines');
    fs.mkdirSync(pub, { recursive: true });
    fs.copyFileSync(path.join(outDir, `${map}.json`), path.join(pub, `${map}.json`));
  }
}
console.log(`-> ${outDir}${has('--publish') ? ' and public/eye/play-baselines' : ''}`);
