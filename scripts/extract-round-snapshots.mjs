#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Walk the parsed demos in sampledemos/ and cache one labelled snapshot per
// second of every round, plus the three exam moments.
//
// Needs the painted map geometry present locally:
//   node scripts/fetch-zone-networks.mjs
//
// Usage:
//   node scripts/extract-round-snapshots.mjs
//   node scripts/extract-round-snapshots.mjs --limit 2 --force
//   node scripts/extract-round-snapshots.mjs --demo mirage --dry-run
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { extractRoundSnapshots } from '../src/replays/rounds/roundSnapshots.js';
import { buildZonePresence } from '../src/replays/zones/zoneOverlay.js';
import { eachRound, listSamplePackages } from './lib/sampledemoPackages.mjs';
import { prepareMap } from './lib/duelCorpus.mjs';
import {
  CACHE_DIR,
  FEATURE_VERSION,
  SKIP_MAPS,
  cacheFileFor,
  encodeRound
} from './lib/roundCorpus.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const limit = Number(arg('--limit', 0)) || 0;
const match = arg('--demo', '') || '';
const stride = Number(arg('--stride', 0)) || undefined;
const force = has('--force');
const dryRun = has('--dry-run');

async function main() {
  const packages = await listSamplePackages();
  if (!packages.length) {
    console.error('No .aim4replay packages in sampledemos/.');
    process.exitCode = 1;
    return;
  }
  console.log(`Packages: ${packages.length}   cache: ${CACHE_DIR} (v${FEATURE_VERSION})`);
  if (!dryRun) await fs.mkdir(path.join(CACHE_DIR, `v${FEATURE_VERSION}`), { recursive: true });

  const mapCache = new Map();
  const totals = { rounds: 0, samples: 0, exams: 0, decidedSkipped: 0, noWinner: 0, ctWins: 0 };
  let current = null;

  const flush = async () => {
    if (!current) return;
    if (current.skip) {
      current = null;
      return;
    }
    if (!dryRun) {
      const header = {
        header: true,
        featureVersion: FEATURE_VERSION,
        demo: current.name,
        map: current.map,
        rounds: current.rounds,
        stats: current.stats
      };
      await fs.writeFile(
        cacheFileFor(current.name),
        [JSON.stringify(header), ...current.lines].join('\n') + '\n',
        'utf8'
      );
    }
    const s = current.stats;
    console.log(
      `  ${current.name.padEnd(40)} ${current.map}  rounds=${String(current.rounds).padStart(3)}` +
        `  snapshots=${String(s.samples).padStart(5)}  exams=${String(s.exams).padStart(3)}` +
        `  CT won ${((s.ctWins / Math.max(1, current.rounds)) * 100).toFixed(0)}%`
    );
    current = null;
  };

  for await (const { pkg, entry, meta, track } of eachRound({
    limit,
    match,
    skipMaps: SKIP_MAPS
  })) {
    if (!current || current.name !== pkg.name) {
      await flush();
      if (!force && !dryRun) {
        try {
          await fs.access(cacheFileFor(pkg.name));
          console.log(`  ${pkg.name.padEnd(40)} cached, skipping`);
          current = { name: pkg.name, map: pkg.map, rounds: 0, lines: [], skip: true };
        } catch {
          current = null;
        }
      }
      if (!current) {
        current = {
          name: pkg.name,
          map: pkg.map,
          rounds: 0,
          lines: [],
          stats: { samples: 0, exams: 0, decidedSkipped: 0, noWinner: 0, ctWins: 0 }
        };
      }
    }
    if (current.skip) continue;

    const network = await prepareMap(pkg.map, mapCache);
    // Possession needs the round's own presence pass; it is the same one the
    // viewer's map control overlay builds.
    let presence = null;
    try {
      presence = buildZonePresence({ meta, track, network, mapCode: pkg.map });
    } catch {
      presence = null;
    }

    const { samples, stats } = extractRoundSnapshots({
      meta,
      track,
      network,
      mapCode: pkg.map,
      presence,
      stride
    });
    if (!samples.length) {
      current.stats.noWinner += stats.noWinner || 0;
      continue;
    }

    current.rounds++;
    totals.rounds++;
    current.stats.samples += stats.samples;
    current.stats.exams += stats.exams;
    current.stats.decidedSkipped += stats.decidedSkipped;
    if (meta.winnerSide === 'CT') current.stats.ctWins++;
    totals.samples += stats.samples;
    totals.exams += stats.exams;
    totals.decidedSkipped += stats.decidedSkipped;
    if (meta.winnerSide === 'CT') totals.ctWins++;

    current.lines.push(
      JSON.stringify(
        encodeRound({
          demo: pkg.name,
          map: pkg.map,
          round: meta.round,
          roundId: entry.file,
          winnerSide: meta.winnerSide,
          samples
        })
      )
    );
  }
  await flush();

  console.log('\n--- totals ---');
  console.log(`rounds                 ${totals.rounds}`);
  console.log(`snapshots              ${totals.samples}`);
  console.log(`exam moments           ${totals.exams}`);
  console.log(`skipped (round over)   ${totals.decidedSkipped}`);
  console.log(`CT win rate            ${((totals.ctWins / Math.max(1, totals.rounds)) * 100).toFixed(1)}%`);
  if (dryRun) console.log('\nDry run, nothing written.');
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
