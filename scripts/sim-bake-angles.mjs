#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-bake-angles.mjs
// The angle catalogue: what can be seen from where, and who can see you there.
//
// SIM-PLAN 6.8 asks for this and lists the fields. What it does not say, and
// what turned out to matter most, is that **none of the visibility work needs
// writing**. The timeline viewer already answers "what can this player see"
// exactly, including smokes, elevated layers, underpasses, and one-way ledges,
// and the possession system already rasterizes that answer onto a lattice:
//
//   visibilityCone()      the visibility polygon        (visibilityPolygon.js)
//   castViewerCone()      bound to a map's geometry     (zoneOverlay.js)
//   rasterizeConeInto()   polygon -> control field      (controlField.js)
//
// So the catalogue is a bake over functions that already ship, which is worth
// far more than a faster bespoke raycaster: the bots' idea of what is visible
// and the page's idea of what is visible are the same code, and the honesty
// guarantee in 5.4 (POV shows exactly what the bot was given) holds by
// construction rather than by test.
//
// Note the two grids, deliberately not unified:
//
//   the nav lattice   256x256, a cell is 4 radar pixels (~20 world units),
//                     matching pathDistance.js so geodesic distances agree
//                     with every other distance in the project
//   the control field 157x157, a cell is a fixed 32 world units, matching
//                     the possession system so visibility agrees with the page
//
// They answer different questions and callers convert through world
// coordinates. Forcing one grid would make one of the two subsystems disagree
// with its own analysis stack, which is the thing this project cannot afford.
//
// Usage:
//   node scripts/sim-bake-angles.mjs
//   node scripts/sim-bake-angles.mjs --map INF --yaws 16
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { getZones, listZoneMaps } from '../server/zonesStore.js';
import {
  castViewerCone,
  getCachedLos,
  hasControlField,
  prepareControlField,
  registerRadarMask
} from '../src/replays/zones/zoneOverlay.js';
import {
  SIDE_T,
  createControlField,
  getFieldGeometry,
  rasterizeConeInto,
  resetControlField
} from '../src/replays/zones/controlField.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadRadarMask } from './lib/radarMask.mjs';

const OUT_DIR = path.join(REPLAY_ROOT, 'sim', 'angles');
const NAV_DIR = path.join(REPLAY_ROOT, 'sim', 'navcache');

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf('--map');
  return i >= 0 ? String(args[i + 1] || '').toUpperCase() : null;
})();
const YAWS = (() => {
  const i = args.indexOf('--yaws');
  return i >= 0 ? Number(args[i + 1]) || 16 : 16;
})();

export const ANGLES_VERSION = 1;

/**
 * One catalogue entry per (anchor, yaw sector).
 *
 * Anchors rather than a 32-unit grid of candidate spots, for v1. The plan's
 * enumeration (every stance spot inside every anchor radius) produces ~2,000
 * entries a map and is the right end state; starting from the painted
 * positions gives the same *shape* of data at a twentieth of the bake cost,
 * and every consumer is written against the entry shape rather than against
 * how many there are. Widening the spot set later changes one loop.
 */
async function bakeMap(mapCode) {
  const mask = await loadRadarMask(mapCode);
  if (!mask) return { mapCode, ok: false, reason: 'no radar' };
  registerRadarMask(mapCode, mask);

  const network = await getZones(mapCode);
  prepareControlField(network, mapCode, null);
  if (!hasControlField(network)) return { mapCode, ok: false, reason: 'no control field' };

  const geom = getFieldGeometry(mapCode, getCachedLos(mapCode));
  if (!geom) return { mapCode, ok: false, reason: 'no field geometry' };

  let navBake;
  try {
    navBake = JSON.parse(await fs.readFile(path.join(NAV_DIR, `${mapCode}.json`), 'utf8'));
  } catch {
    return { mapCode, ok: false, reason: 'no nav bake, run sim-bake-map.mjs first' };
  }
  const graph = navGraphFromBake(navBake);

  const field = createControlField(geom);
  const entries = [];
  const step = 360 / YAWS;

  for (const anchor of graph.anchors.values()) {
    for (let s = 0; s < YAWS; s += 1) {
      const yaw = -180 + s * step;
      resetControlField(field);
      const ring = castViewerCone({
        viewer: { x: anchor.world.x, y: anchor.world.y, yaw },
        network,
        smokes: null
      });
      if (!ring) continue;
      rasterizeConeInto(field, ring, SIDE_T, 1, 0);

      const cells = [];
      let maxDist = 0;
      for (let i = 0; i < field.tExp.length; i += 1) {
        if (!field.tExp[i]) continue;
        cells.push(i);
        const cx = geom.originX + ((i % geom.cols) + 0.5) * geom.cell;
        const cy = geom.originY + (Math.floor(i / geom.cols) + 0.5) * geom.cell;
        const d = Math.hypot(cx - anchor.world.x, cy - anchor.world.y);
        if (d > maxDist) maxDist = d;
      }
      if (!cells.length) continue;

      entries.push({
        anchor: anchor.id,
        level: anchor.level,
        yaw: Math.round(yaw),
        world: { x: Math.round(anchor.world.x), y: Math.round(anchor.world.y) },
        // Sorted so the transpose and any set intersection can merge-walk.
        cells,
        area: cells.length,
        // Longest sightline from here. This is what separates an AWP angle from
        // a rifle angle, and it is `sniperQuality` in CS's own analysis pass.
        depth: Math.round(maxDist)
      });
    }
  }

  // The exposure transpose: for a cell, which entries can see it. This is the
  // half a bot actually reads. "What am I giving away by standing here" is
  // exposure, not visibility, and the two are only related through this map.
  const exposure = new Map();
  for (let e = 0; e < entries.length; e += 1) {
    for (const cell of entries[e].cells) {
      let list = exposure.get(cell);
      if (!list) {
        list = [];
        exposure.set(cell, list);
      }
      list.push(e);
    }
  }

  return {
    mapCode,
    ok: true,
    geom: {
      cell: geom.cell,
      cols: geom.cols,
      rows: geom.rows,
      count: geom.count,
      originX: geom.originX,
      originY: geom.originY
    },
    entries,
    exposure
  };
}

function serialize(r) {
  return {
    v: ANGLES_VERSION,
    map: r.mapCode,
    bakedAt: new Date().toISOString(),
    yaws: YAWS,
    geom: r.geom,
    entries: r.entries,
    // Flattened as [cell, count, ...entryIds] runs: a plain object keyed by
    // cell would be 24k keys of JSON overhead for the same data.
    exposure: (() => {
      const flat = [];
      for (const [cell, list] of r.exposure) {
        flat.push(cell, list.length, ...list);
      }
      return flat;
    })()
  };
}

async function main() {
  const maps = only ? [only] : await listZoneMaps();
  console.log(`Out=${OUT_DIR}`);
  console.log(`Yaw sectors: ${YAWS}\n`);
  await fs.mkdir(OUT_DIR, { recursive: true });

  for (const mapCode of maps) {
    const t0 = Date.now();
    const r = await bakeMap(mapCode);
    if (!r.ok) {
      console.log(`${mapCode}: skipped (${r.reason})`);
      continue;
    }
    const file = path.join(OUT_DIR, `${mapCode}.json`);
    await fs.writeFile(file, JSON.stringify(serialize(r)), 'utf8');
    const kb = Math.round((await fs.stat(file)).size / 1024);
    const avgArea = Math.round(r.entries.reduce((a, e) => a + e.area, 0) / r.entries.length);
    const deepest = r.entries.reduce((a, e) => (e.depth > a.depth ? e : a), r.entries[0]);
    console.log(
      `${mapCode}: ${r.entries.length} entries, avg ${avgArea} cells seen, ` +
        `longest sightline ${deepest.depth}u from ${deepest.anchor} ` +
        `-> ${kb} kB in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
