#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-extract-demos.mjs
// BC samples from selected library demos (SIM-PLAN 9.2c / 9.3).
//
// Selection, never a corpus scan: --demos is an id list. Observations are
// rebuilt from that player's own pose and living teammates; enemy belief is
// zeros because a demo tick is not a Team POV frame. Labels come from the
// feet-only segmenter. The trainer does not change.
//
//   node scripts/sim-extract-demos.mjs --demos abc,def
//   node scripts/sim-extract-demos.mjs --demos abc --out sim/datasets/from-demos.jsonl
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ROOT as REPLAY_ROOT,
  listLibraryUsers,
  readRoundTicks,
  readRoundMeta,
  userKey
} from '../server/replays/demoStore.js';
import { SHARED_LIBRARY } from '../server/replays/auth.js';
import { demoIdFromRoundFile } from '../server/sim/export.js';
import { coverage, segmentTrack } from '../shared/sim/optionSegmenter.js';
import { OPTION_IDS } from '../shared/sim/options.js';
import { OBSERVE_VERSION, OBSERVATION_SIZE, buildObservation, weaponClassOf } from '../shared/sim/observe.js';
import { readHeader, readRecord, PLAYER_SLOTS, FLAG_HAS_HELMET } from '../src/replays/shared/tickFormat.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const DEMOS = String(flag('demos', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = flag(
  'out',
  path.join(REPLAY_ROOT, 'sim', 'datasets', `bc-demos-${DEMOS.slice(0, 3).join('-') || 'none'}.jsonl`)
);
const STRIDE = 8;

async function libraries() {
  let users = [];
  try {
    users = await listLibraryUsers();
  } catch {
    users = [];
  }
  const keys = [];
  const seen = new Set();
  for (const u of [SHARED_LIBRARY, ...users]) {
    const k = userKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

async function stemsFor(user, demoId) {
  const dir = path.join(REPLAY_ROOT, userKey(user), 'rounds');
  let files = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const stems = new Set();
  for (const f of files) {
    if (demoIdFromRoundFile(f) !== demoId) continue;
    const stem = f.replace(/\.(tickz|json\.zst|c100\.bin|bin|json)$/i, '');
    stems.add(stem);
  }
  return [...stems];
}

function tracksFromTicks(bytes, meta) {
  const header = readHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const players = [];
  for (let slot = 0; slot < PLAYER_SLOTS; slot += 1) {
    players.push({ slot, poses: [], events: [], lastHealth: 100, dead: false, side: null });
  }
  const tmp = {};
  for (let row = 0; row < header.tickCount; row += STRIDE) {
    const tick = (header.firstTick || 0) + row;
    for (const p of players) {
      if (p.dead) continue;
      readRecord(view, row, p.slot, tmp);
      if (!tmp.alive) {
        p.dead = true;
        continue;
      }
      p.side = tmp.side === 3 ? 'CT' : 'T';
      p.poses.push({
        tick,
        x: tmp.x,
        y: tmp.y,
        hp: tmp.health,
        armor: tmp.armor,
        helmet: Boolean(tmp.flags & FLAG_HAS_HELMET),
        weapon: tmp.weapon
      });
      if (tmp.health < p.lastHealth) p.events.push({ type: 'damage', tick });
      p.lastHealth = tmp.health;
    }
  }
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

function obsAt(pose, mates, side, planted) {
  const teammates = mates
    .filter((m) => m !== pose)
    .slice(0, 4)
    .map((m) => ({
      dx: (m.x - pose.x) / 4096,
      dy: (m.y - pose.y) / 4096,
      hp: (m.hp || 100) / 100
    }));
  return buildObservation({
    me: {
      x: pose.x,
      y: pose.y,
      hp: pose.hp ?? 100,
      armor: pose.armor ?? 0,
      helmet: Boolean(pose.helmet),
      weaponClass: weaponClassOf(pose.weapon) || 'other',
      hasBomb: false,
      side
    },
    round: {
      elapsed: Math.max(0, (pose.tick || 0) / 64),
      secondsLeft: 115,
      planted: Boolean(planted),
      bombSecondsLeft: 40,
      myEquipAvg: 0,
      enemyEquipAvgBelieved: 0
    },
    myAlive: 1 + teammates.length,
    enemyAliveBelieved: 5,
    belief: { siteExpected: [0, 0], sitePEmpty: [1, 1], splitEntropy: 0, threatAtMe: 0 },
    teammates,
    recency: { sinceSeenSeconds: 30, sinceHeardSeconds: 30 }
  });
}

async function main() {
  if (!DEMOS.length) {
    console.error('sim-extract-demos: pass --demos id,id');
    process.exit(1);
  }
  const users = await libraries();
  const samples = [];
  const histogram = {};
  let tracks = 0;
  let coverages = [];

  for (const id of DEMOS) {
    let found = false;
    for (const user of users) {
      const stems = await stemsFor(user, id);
      if (!stems.length) continue;
      found = true;
      for (const stem of stems) {
        const ticks = await readRoundTicks(user, stem);
        if (!ticks) continue;
        const meta = await readRoundMeta(user, stem).catch(() => null);
        const bytes = ticks instanceof ArrayBuffer ? new Uint8Array(ticks) : ticks;
        for (const p of tracksFromTicks(bytes, meta)) {
          const segments = segmentTrack({ poses: p.poses, events: p.events });
          tracks += 1;
          coverages.push(coverage(segments, p.poses));
          const byTick = p.poses;
          for (const s of segments) {
            histogram[s.option] = (histogram[s.option] || 0) + 1;
            const midTick = Math.floor(((s.startTick || 0) + (s.endTick || 0)) / 2);
            const pose = byTick.find((po) => po.tick >= midTick) || byTick[0];
            samples.push({
              obs: obsAt(
                pose,
                [pose],
                p.side,
                Boolean(meta?.events?.bomb?.some((b) => b.type === 'planted'))
              ),
              label: s.option,
              side: p.side,
              player: `${id}:${p.slot}`
            });
          }
        }
      }
      break;
    }
    if (!found) console.log(`demo ${id}: no round files on this host`);
  }

  const meta = {
    type: 'meta',
    v: 2,
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    vocab: OPTION_IDS,
    players: [...new Set(samples.map((s) => s.player))].sort(),
    teacher: 'demo-segmenter',
    demos: DEMOS,
    samples: samples.length
  };
  const lines = [JSON.stringify(meta)];
  for (const s of samples) {
    lines.push(
      JSON.stringify({
        obs: s.obs.map((x) => Number(x.toFixed(5))),
        label: OPTION_IDS.includes(s.label) ? s.label : 'hold_angle',
        side: s.side,
        player: s.player
      })
    );
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'));
  const meanCov = coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0;
  console.log(`${samples.length} samples from ${DEMOS.length} demos, ${tracks} tracks, coverage ${(meanCov * 100).toFixed(0)}% -> ${OUT}`);
  const total = Object.values(histogram).reduce((a, b) => a + b, 0) || 1;
  for (const [option, n] of Object.entries(histogram).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${option.padEnd(14)} ${String(n).padStart(5)}  ${((n / total) * 100).toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
