#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-bake-map.mjs
// Bake the per-map data the simulation runs on, once, into a file it can load.
//
// Three inputs, three different homes, which is why this script exists at all:
//
//   the walkable lattice   from the radar PNG in public/maps/radar
//   the named anchors      from the painted zone networks on the backend
//                          volume (pull them with fetch-zone-networks.mjs)
//   the spawn points       derived from the demo library, so a machine without
//                          demos has none and has to ask the API for them
//
// A dev machine has the first and, after a fetch, the second. It does not have
// the third, and a round cannot start without spawns. So the bake reads the
// local library when there is one and falls back to the live API when there is
// not, and records which it used, because a bake built from a stale API answer
// is a different artefact from one built from the library and should not
// silently look identical.
//
// Refuses rather than warns when a map is not fit to train on. SIM-PLAN 14.3:
// under five spawns a side is not a pool, it is a duplicate waiting to happen,
// and a generation trained on a lying map is worse than a missing map.
//
// Usage:
//   node scripts/sim-bake-map.mjs
//   node scripts/sim-bake-map.mjs --map INF
//   node scripts/sim-bake-map.mjs --dry-run
//   AIM4_API=https://api.aim4.io node scripts/sim-bake-map.mjs
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { getZones, listZoneMaps } from '../server/zonesStore.js';
import { calibrationFor } from '../src/replays/viewer/mapCalibration.js';
import { pointInPiece } from '../src/replays/zones/zoneGeom.js';
import { buildNavGraph, packMask } from '../shared/sim/navGraph.js';
import { RULES_VERSION } from '../shared/sim/constants.js';
import { loadRadarMask } from './lib/radarMask.mjs';

const API = (process.env.AIM4_API || 'https://api.aim4.io').replace(/\/$/, '');
const OUT_DIR = path.join(REPLAY_ROOT, 'sim', 'navcache');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = (() => {
  const i = args.indexOf('--map');
  return i >= 0 ? String(args[i + 1] || '').toUpperCase() : null;
})();

/** Bake format version. Bump when the shape below changes; bakes are cached. */
const BAKE_VERSION = 3;

/** Minimum spawn points per side before a map is fit to run (SIM-PLAN 14.3). */
const MIN_SPAWNS_PER_SIDE = 5;

/**
 * Spawns from the local demo library, or null when there is no library.
 * Kept separate from the API path so the source is always known.
 */
async function localSpawns(mapCode) {
  try {
    const { spawnsForMap } = await import('../server/replays/spawnPoints.js');
    const { listDemos, readRoundMeta, userDir } = await import('../server/replays/demoStore.js');
    const { SHARED_LIBRARY } = await import('../server/replays/auth.js');
    const io = { listDemos, readRoundMeta, userDir };
    const records = await listDemos(SHARED_LIBRARY).catch(() => []);
    if (!records?.length) return null;
    const spawns = await spawnsForMap(io, SHARED_LIBRARY, records, mapCode);
    return spawns?.length ? spawns : null;
  } catch {
    return null;
  }
}

async function apiSpawns(mapCode) {
  const res = await fetch(`${API}/api/replays/spawns?map=${encodeURIComponent(mapCode)}`, {
    headers: { accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`spawns ${mapCode} -> HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.spawns) ? body.spawns : [];
}

async function bakeMap(mapCode) {
  const problems = [];

  const cal = calibrationFor(mapCode);
  if (!cal) return { mapCode, ok: false, problems: ['no radar calibration'] };

  // Stacked maps have a floor plan per level. Nuke's split is the calibration's
  // lowerZ, and a body's level follows from its z, so both lattices are baked
  // and the engine picks per body rather than per map.
  const masks = { default: await loadRadarMask(mapCode, 'default') };
  if (!masks.default) return { mapCode, ok: false, problems: ['no radar PNG'] };
  if (cal.lowerZ !== undefined) {
    masks.lower = await loadRadarMask(mapCode, 'lower');
    if (!masks.lower) problems.push('stacked map with no lower radar');
  }

  const graph = buildNavGraph(mapCode, masks, cal);
  for (const [level, n] of Object.entries(graph.walkableByLevel)) {
    if (n < 2000) problems.push(`only ${n} walkable cells on ${level}`);
  }

  const net = await getZones(mapCode);
  const positions = net?.positions || [];
  if (!positions.length) problems.push('no painted positions (run fetch-zone-networks.mjs)');
  const anchors = graph.attachPositions(positions, pointInPiece);
  if (anchors.empty.length) {
    problems.push(`${anchors.empty.length} positions cover no walkable ground: ${anchors.empty.join(', ')}`);
  }

  let spawns = await localSpawns(mapCode);
  let spawnSource = 'library';
  if (!spawns) {
    spawns = await apiSpawns(mapCode).catch((err) => {
      problems.push(`spawn fetch failed: ${err.message}`);
      return [];
    });
    spawnSource = 'api';
  }

  const perSide = { T: 0, CT: 0 };
  for (const s of spawns) if (perSide[s.side] !== undefined) perSide[s.side] += 1;
  for (const side of ['T', 'CT']) {
    if (perSide[side] < MIN_SPAWNS_PER_SIDE) {
      problems.push(`${perSide[side]} ${side} spawns, need ${MIN_SPAWNS_PER_SIDE}`);
    }
  }

  // Every spawn has to resolve onto stand-able ground, or a round starts with a
  // body inside geometry, and a body inside geometry cannot move at all.
  const unresolved = [];
  for (const s of spawns) {
    if (!graph.nearestWalkable(s.x, s.y)) unresolved.push(s.id);
  }
  if (unresolved.length) problems.push(`spawns off the mask: ${unresolved.join(', ')}`);

  const coverage = graph.anchorCoverage();
  const transitions = graph.transitionCells();
  if (graph.levels.length > 1 && !transitions.length) {
    problems.push('stacked map with no cells walkable on both levels: the floors cannot be traversed');
  }

  return {
    mapCode,
    ok: problems.length === 0,
    problems,
    graph,
    anchors,
    spawns,
    spawnSource,
    coverage
  };
}

function serialize(r) {
  return {
    v: BAKE_VERSION,
    rulesVersion: RULES_VERSION,
    map: r.mapCode,
    bakedAt: new Date().toISOString(),
    calibration: r.graph.cal,
    cellUnits: r.graph.cellUnits,
    walkableCells: r.graph.walkableCells,
    // The lattice as base64, which is 65 kB per map rather than the 400 kB a
    // JSON array of ones and zeroes would be.
    grids: Object.fromEntries(
      Object.entries(r.graph.grids).map(([level, g]) => [level, Buffer.from(g).toString('base64')])
    ),
    // Full-resolution solid masks for collision, one bit per pixel: 128 kB a
    // level rather than the megabyte a byte-per-pixel array would cost.
    solid: Object.fromEntries(
      Object.entries(r.graph.solid || {}).map(([level, m]) => [
        level,
        Buffer.from(packMask(m)).toString('base64')
      ])
    ),
    // Validated adjacency: one byte per cell saying which of its eight
    // neighbours a body can actually reach. Without it A* returns routes that
    // are legal cell by cell and impossible to walk.
    edges: Object.fromEntries(
      Object.entries(r.graph.edges || {}).map(([level, e]) => [
        level,
        Buffer.from(e).toString('base64')
      ])
    ),
    walkableByLevel: r.graph.walkableByLevel,
    transitionCells: r.graph.transitionCells().length,
    anchors: [...r.graph.anchors.values()].map((a) => ({
      id: a.id,
      name: a.name,
      level: a.level,
      cx: a.cx,
      cy: a.cy,
      world: a.world,
      cells: a.cells
    })),
    spawns: r.spawns,
    spawnSource: r.spawnSource,
    coverage: r.coverage
  };
}

async function main() {
  const painted = await listZoneMaps();
  const maps = only ? [only] : painted;
  if (!maps.length) throw new Error('No painted maps. Run fetch-zone-networks.mjs first.');

  console.log(`API=${API}`);
  console.log(`Out=${OUT_DIR}`);
  console.log(`Maps: ${maps.join(', ')}\n`);

  if (!dryRun) await fs.mkdir(OUT_DIR, { recursive: true });

  let baked = 0;
  let refused = 0;

  for (const mapCode of maps) {
    const r = await bakeMap(mapCode);
    if (!r.graph) {
      console.log(`${mapCode}: REFUSED  ${r.problems.join('; ')}`);
      refused += 1;
      continue;
    }

    const cov = Object.entries(r.coverage)
      .map(([lv, c]) => `${lv} ${Math.round((100 * c.named) / c.walkable)}%`)
      .join(' ');
    const tr = r.graph.levels.length > 1 ? `, ${r.graph.transitionCells().length} transition cells` : '';
    const pruned = Object.values(r.graph.prunedByLevel || {}).reduce((a, b) => a + b, 0);
    const perSide = r.spawns.reduce((acc, s) => ({ ...acc, [s.side]: (acc[s.side] || 0) + 1 }), {});

    console.log(
      `${mapCode}: ${Object.values(r.graph.walkableByLevel).reduce((a, b) => a + b, 0)} cells${tr}, ` +
        `${r.anchors.attached} anchors (${cov}), ` +
        (pruned ? `${pruned} dead cells pruned, ` : '') +
        `spawns T${perSide.T || 0}/CT${perSide.CT || 0} from ${r.spawnSource}`
    );
    for (const p of r.problems) console.log(`  ! ${p}`);

    if (!r.ok) {
      console.log(`  REFUSED: not fit to train on`);
      refused += 1;
      continue;
    }
    if (dryRun) continue;

    const file = path.join(OUT_DIR, `${mapCode}.json`);
    await fs.writeFile(file, JSON.stringify(serialize(r)), 'utf8');
    const kb = Math.round((await fs.stat(file)).size / 1024);
    console.log(`  -> ${path.basename(file)} (${kb} kB)`);
    baked += 1;
  }

  console.log(
    dryRun ? '\nDry run, nothing written.' : `\nBaked ${baked} map(s), refused ${refused}.`
  );
  if (refused && !baked) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
