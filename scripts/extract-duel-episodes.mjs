#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Walk the parsed demos in sampledemos/ and cache every labelled duel.
//
// This is the slow half of training, and it only has to happen once. Fitting
// then reads the cache instead of re-deriving line of sight for four hundred
// rounds on every generation.
//
// Needs the painted map geometry present locally:
//   node scripts/fetch-zone-networks.mjs
//
// Usage:
//   node scripts/extract-duel-episodes.mjs
//   node scripts/extract-duel-episodes.mjs --limit 2 --force
//   node scripts/extract-duel-episodes.mjs --demo mirage --dry-run
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { extractEpisodes } from '../src/replays/duels/episodes.js';
import { eachRound, listSamplePackages } from './lib/sampledemoPackages.mjs';
import { countLibraryDemos, eachLibraryRound } from './lib/serverCorpus.mjs';
import {
  CACHE_DIR,
  FEATURE_VERSION,
  SKIP_MAPS,
  cacheFileFor,
  encodeEpisode,
  prepareMap
} from './lib/duelCorpus.mjs';

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

  const mapCache = new Map();
  const totals = {
    rounds: 0,
    gunKills: 0,
    labelled: 0,
    recovered: 0,
    recoveredUnsighted: 0,
    killsWithoutEpisode: 0,
    censored: 0,
    snapshots: 0
  };

  /** Buffered per demo so a cache file is only written once it is complete. */
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
      const body = [JSON.stringify(header), ...current.lines].join('\n') + '\n';
      await fs.writeFile(cacheFileFor(current.name), body, 'utf8');
    }
    const s = current.stats;
    const cov = s.gunKills ? (1 - s.killsWithoutEpisode / s.gunKills) * 100 : 100;
    console.log(
      `  ${current.name.padEnd(34)} ${current.map}  rounds=${String(current.rounds).padStart(3)}` +
        `  duels=${String(s.labelled).padStart(4)}  snapshots=${String(s.snapshots).padStart(5)}` +
        `  coverage=${cov.toFixed(1)}%`
    );
    current = null;
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
          console.log(`  ${pkg.name.padEnd(34)} cached, skipping`);
          current = { name: pkg.name, map: pkg.map, rounds: 0, lines: [], stats: null, skip: true };
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
          stats: {
            gunKills: 0,
            labelled: 0,
            recovered: 0,
            recoveredUnsighted: 0,
            killsWithoutEpisode: 0,
            censored: 0,
            snapshots: 0
          }
        };
      }
    }
    if (current.skip) continue;

    const network = await prepareMap(pkg.map, mapCache);
    const { episodes, stats } = extractEpisodes({
      meta,
      track,
      network,
      mapCode: pkg.map,
      roundFile: entry.file,
      stride
    });

    current.rounds++;
    totals.rounds++;
    for (const k of Object.keys(current.stats)) {
      current.stats[k] += stats[k];
      totals[k] += stats[k];
    }
    // Only resolved fights are stored. An unresolved standoff has no label, so
    // it cannot contribute to the loss, and keeping forty thousand of them
    // would triple the cache to no purpose.
    // `stats.snapshots` counts every episode the walk saw, including the
    // unresolved ones that are about to be dropped. Only what is actually
    // written is training data, so that is what gets reported.
    current.stats.snapshots -= stats.snapshots;
    totals.snapshots -= stats.snapshots;
    for (const ep of episodes) {
      if (ep.winnerSlot === null) continue;
      current.lines.push(JSON.stringify(encodeEpisode(ep)));
      current.stats.snapshots += ep.samples.length;
      totals.snapshots += ep.samples.length;
    }
  }
  await flush();

  const cov = totals.gunKills ? (1 - totals.killsWithoutEpisode / totals.gunKills) * 100 : 100;
  console.log('\n--- totals ---');
  console.log(`rounds                 ${totals.rounds}`);
  console.log(`gun duels in the demos ${totals.gunKills}`);
  console.log(`labelled duels cached  ${totals.labelled}`);
  console.log(`  recovered by rescan  ${totals.recovered}`);
  console.log(`  kept on kill only    ${totals.recoveredUnsighted}`);
  console.log(`unresolved (dropped)   ${totals.censored}`);
  console.log(`duels lost entirely    ${totals.killsWithoutEpisode}`);
  console.log(`training snapshots     ${totals.snapshots}`);
  console.log(`KILL COVERAGE          ${cov.toFixed(1)}%`);
  if (dryRun) console.log('\nDry run, nothing written.');
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
