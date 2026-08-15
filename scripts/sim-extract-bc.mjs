#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-extract-bc.mjs
// The BC extractor, first pass: rounds in, option-labeled segments out.
//
// SIM-PLAN 9.3's pipeline starts here: behavior cloning learns options, so the
// dataset is (observation, option) pairs, and the half that exists today is
// the option label. This script walks recorded rounds — today the engine's own
// replays, tomorrow the demo library through the identical tick format — and
// runs the feet-only segmenter over every player, reporting the label
// distribution and coverage that decide whether the labels are worth training
// on.
//
// The observation half joins after P3c/P3d land, because it reads belief
// summaries and the macro action space, and labeling the dataset twice is the
// mistake the build order exists to prevent (15).
//
// Usage:
//   node scripts/sim-extract-bc.mjs                    # play + extract
//   node scripts/sim-extract-bc.mjs --map INF --rounds 4 --seed 9
//   node scripts/sim-extract-bc.mjs --out segments.json
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { coverage, segmentTrack } from '../shared/sim/optionSegmenter.js';
import { readHeader, readRecord, PLAYER_SLOTS } from '../src/replays/shared/tickFormat.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const ROUNDS = Number(flag('rounds', 4));
const SEED = Number(flag('seed', 9));
const OUT = flag('out', null);
/** Pose sampling stride in rows; the decision cadence, so labels line up. */
const STRIDE = 8;
/**
 * Tick buffers contain single-row dropouts: one row where every slot decodes
 * as not-alive, with all ten alive again on the next (see the identical
 * constant in sim-mine-playbook.mjs, where the same bug truncated 5.3% of the
 * corpus). A real death lasts the rest of the round, so a gap this short is
 * always the recording and never the player. Rows are engine ticks (64 Hz),
 * sampled every STRIDE.
 */
const DEAD_GRACE_ROWS = Math.max(1, Math.round((1 * 64) / STRIDE));

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

/**
 * One recorded round's tick buffer into per-player pose tracks plus the
 * events the buffer itself attests (health drops; the channel windows come
 * from the round meta). Death ends a track: a corpse has no options.
 */
function tracksFromTicks(bytes, meta) {
  const header = readHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  const players = [];
  for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
    players.push({ slot, poses: [], events: [], lastHealth: 100, dead: false, deadRun: 0 });
  }
  for (let row = 0; row < header.tickCount; row += STRIDE) {
    const tick = (header.firstTick || 0) + row;
    for (const p of players) {
      if (p.dead) continue;
      readRecord(view, row, p.slot, out);
      if (!out.alive) {
        // Poses carry their own ticks, so skipping a dropout leaves a gap in
        // the track, not a shift; only a run past the grace is a death.
        p.deadRun += 1;
        if (p.deadRun > DEAD_GRACE_ROWS) p.dead = true;
        continue;
      }
      p.deadRun = 0;
      p.poses.push({ tick, x: out.x, y: out.y });
      if (out.health < p.lastHealth) p.events.push({ type: 'damage', tick });
      p.lastHealth = out.health;
    }
  }
  // The planter's channel, from the parser-shaped bomb events the sim meta
  // now carries (the planted entry names the player; slots come from roster).
  const planted = meta?.events?.bomb?.find((b) => b.type === 'planted');
  if (planted) {
    const slot = meta.players?.find((pl) => pl.id === planted.player)?.slot;
    const p = slot != null ? players[slot] : null;
    if (p) {
      p.events.push(
        { type: 'plant_start', tick: planted.tick - Math.round(3.2 * 64) },
        { type: 'plant_end', tick: planted.tick }
      );
    }
  }
  return players.filter((p) => p.poses.length > 2);
}

async function main() {
  const graph = navGraphFromBake(await load('navcache', MAP));
  const angles = loadAngles(await load('angles', MAP));

  const t0 = Date.now();
  const { rounds } = playVersusMatch({
    graph,
    angles,
    map: MAP,
    controllerA: desireController({ angles }),
    controllerB: scriptedController,
    seed: SEED,
    maxRounds: ROUNDS,
    replays: true
  });

  const histogram = {};
  const coverages = [];
  const dataset = [];
  let tracks = 0;

  for (const r of rounds) {
    if (!r.ticks) continue;
    for (const p of tracksFromTicks(r.ticks, r.meta)) {
      const segments = segmentTrack({ poses: p.poses, events: p.events });
      tracks += 1;
      coverages.push(coverage(segments, p.poses));
      for (const s of segments) {
        histogram[s.option] = (histogram[s.option] || 0) + 1;
      }
      dataset.push({ round: r.round, slot: p.slot, segments });
    }
  }

  const meanCov = coverages.length
    ? coverages.reduce((a, b) => a + b, 0) / coverages.length
    : 0;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`map ${MAP}, ${rounds.length} rounds, seed ${SEED} (${secs}s)`);
  console.log(`${tracks} player-tracks segmented, mean label coverage ${(meanCov * 100).toFixed(0)}%`);
  const total = Object.values(histogram).reduce((a, b) => a + b, 0);
  for (const [option, n] of Object.entries(histogram).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${option.padEnd(12)} ${String(n).padStart(4)}  ${((n / total) * 100).toFixed(1)}%`);
  }

  if (OUT) {
    await fs.writeFile(OUT, JSON.stringify({ map: MAP, seed: SEED, dataset }, null, 2));
    console.log(`wrote ${dataset.length} labeled tracks to ${OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
