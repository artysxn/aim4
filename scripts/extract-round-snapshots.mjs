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
import { countLibraryDemos, eachLibraryRound } from './lib/serverCorpus.mjs';
import { patchStatus } from '../server/training/status.js';
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
/**
 * Where rounds come from. `samples` reads the local .aim4replay folder and is
 * the default so the CLI workflow is unchanged; `library` reads the server's
 * replay library, which is what server-side training uses and is the only
 * source with enough demos to move the numbers.
 */
const source = arg('--source', 'samples');
/**
 * Progress reporting for the admin panel.
 *
 * Extraction over a server library is the long half of training and can run for
 * many minutes. Without this it reports nothing at all until it finishes, which
 * is indistinguishable from being hung.
 */
const statusFile = arg('--status-file', '');
const statusKind = arg('--status-kind', '');
const dryRun = has('--dry-run');

async function main() {
  let available;
  if (source === 'library') {
    available = await countLibraryDemos();
    if (!available) {
      console.error('No ready demos in the replay library.');
      process.exitCode = 1;
      return;
    }
  } else {
    const packages = await listSamplePackages();
    available = packages.length;
    if (!available) {
      console.error('No .aim4replay packages in sampledemos/.');
      process.exitCode = 1;
      return;
    }
  }
  console.log(`Source: ${source}   demos: ${available}   cache: ${CACHE_DIR} (v${FEATURE_VERSION})`);
  if (!dryRun) await fs.mkdir(path.join(CACHE_DIR, `v${FEATURE_VERSION}`), { recursive: true });

  let demosDone = 0;
  const demosTotal = available;
  const bumpProgress = async () => {
    demosDone++;
    if (!statusFile) return;
    await patchStatus(
      statusFile,
      { stage: 'extracting', demosDone, demosTotal },
      statusKind
    ).catch(() => {});
  };
  if (statusFile) {
    await patchStatus(statusFile, { stage: 'extracting', demosDone: 0, demosTotal }, statusKind).catch(
      () => {}
    );
  }

  const mapCache = new Map();
  const totals = { rounds: 0, samples: 0, exams: 0, decidedSkipped: 0, noWinner: 0, ctWins: 0 };
  let current = null;

  const flush = async () => {
    if (!current) return;
    if (current.skip) {
      current = null;
      await bumpProgress();
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
    await bumpProgress();
  };

  const walk =
    source === 'library'
      ? eachLibraryRound({ limit, match, skipMaps: SKIP_MAPS, onWarn: (m) => console.warn('  ' + m) })
      : eachRound({ limit, match, skipMaps: SKIP_MAPS });

  for await (const { pkg, entry, meta, track } of walk) {
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
