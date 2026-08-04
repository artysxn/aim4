#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pull the painted map geometry (vision blocks, elevated, underpasses, ledges,
// bombsites) from a running aim4 backend into the local zones directory.
//
// The duel model is fitted on who could see whom, and that answer is only as
// good as the geometry behind it. The radar PNG alone gets the building
// outlines and nothing else: no boost, no one-way, none of the hand-painted
// blocks that make Mirage connector different from Mirage mid. Training
// without them would fit a model to a map that does not exist.
//
// The networks are authored in the Sites & Vision editor and live on the
// backend volume, so they have to be fetched once before the first extraction.
//
// Usage:
//   node scripts/fetch-zone-networks.mjs
//   AIM4_API=https://api.aim4.io node scripts/fetch-zone-networks.mjs
//   node scripts/fetch-zone-networks.mjs --dry-run
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZONES_ROOT } from '../server/zonesStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.AIM4_API || 'https://api.aim4.io').replace(/\/$/, '');
const dryRun = process.argv.includes('--dry-run');

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`API=${API}`);
  console.log(`Zones dir=${ZONES_ROOT}`);

  const { maps } = await getJson(`${API}/api/replays/zones`);
  if (!maps?.length) throw new Error('Backend reports no painted maps.');
  console.log(`Painted maps: ${maps.join(', ')}`);

  if (!dryRun) await fs.mkdir(ZONES_ROOT, { recursive: true });

  let written = 0;
  for (const map of maps) {
    const { network } = await getJson(`${API}/api/replays/zones/${map}`);
    if (!network || !Array.isArray(network.visionBlocks)) {
      console.warn(`  ${map}: no network in response, skipped`);
      continue;
    }
    const counts =
      `visionBlocks=${network.visionBlocks.length} ` +
      `elevated=${network.elevated?.length || 0} ` +
      `underpasses=${network.underpasses?.length || 0} ` +
      `ledges=${network.ledges?.length || 0}`;
    if (!network.visionBlocks.length) {
      console.warn(`  ${map}: painted with nothing, ${counts}`);
    }
    if (dryRun) {
      console.log(`  ${map}: ${counts} (dry run)`);
      continue;
    }
    const file = path.join(ZONES_ROOT, `${map}.json`);
    await fs.writeFile(file, JSON.stringify(network), 'utf8');
    console.log(`  ${map}: ${counts} -> ${path.relative(path.join(__dirname, '..'), file)}`);
    written++;
  }

  console.log(dryRun ? 'Dry run, nothing written.' : `Wrote ${written} map networks.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
