#!/usr/bin/env node
// The scoreboard's duel columns, checked against a real match.
//
// The load-bearing assertion is the zero sum. Every duel has exactly one winner
// and one loser, and the model's two predictions for it add to 1, so however the
// odds fall, the overperformance of everyone on the server must cancel out to
// nothing. If it does not, then predictions and outcomes are being paired up
// wrongly somewhere, and every PFO on the board is meaningless in a way no
// eyeball test would catch.
//
// Skips when the sample demos or the painted geometry are absent, since neither
// lives in the repo.

import { hasVisionLayers } from '../src/replays/zones/visionLayers.js';
import { getZones } from '../server/zonesStore.js';
import {
  addRoundDuels,
  createDuelStats,
  summarizeDuelStats,
  teamDuelStats
} from '../src/replays/duels/duelStats.js';
import { listSamplePackages, loadPackage } from './lib/sampledemoPackages.mjs';
import { prepareMap } from './lib/duelCorpus.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const files = await listSamplePackages();
if (!files.length) {
  console.log('duel-stats.test.mjs: skipped, no packages in sampledemos/');
  process.exit(0);
}

const pkg = await loadPackage(files[0]);
const zones = await getZones(pkg.map);
if (!zones || !hasVisionLayers(zones)) {
  console.log(`duel-stats.test.mjs: skipped, ${pkg.map} has no painted vision blocks`);
  process.exit(0);
}

const network = await prepareMap(pkg.map);
const stats = createDuelStats();
let roster = [];
for (const entry of pkg.rounds) {
  const { meta, track } = pkg.readRound(entry);
  if (!roster.length) roster = meta.players;
  addRoundDuels(stats, { meta, track, network, mapCode: pkg.map });
}

assert(stats.rounds === pkg.rounds.length, 'every round should be folded in');
assert(stats.duels > 0, 'a match should contain duels');

const summary = summarizeDuelStats(stats);
assert(summary.size > 0, 'summary should hold players');
assert(summary.size <= 12, 'a match has ten players, give or take a coach');

// Ranges. PFW is a probability and PFO is a difference of two, so neither can
// leave its own bounds however the fights went.
for (const [id, s] of summary) {
  assert(s.pfw > 0 && s.pfw < 100, `${id}: PFW out of range (${s.pfw})`);
  assert(s.pfo > -100 && s.pfo < 100, `${id}: PFO out of range (${s.pfo})`);
  assert(s.duels > 0, `${id}: should have duels`);
  assert(Number.isFinite(s.pfw) && Number.isFinite(s.pfo), `${id}: non-finite stat`);
  for (const b of s.buckets) {
    assert(b.centre >= 0 && b.centre <= 100, `${id}: bucket centre out of range`);
    assert(
      Math.abs(b.delta - (b.actual - b.predicted)) < 1e-6,
      `${id}: bucket delta should be actual minus predicted`
    );
  }
}

// The zero sum. One player's overperformance is another's shortfall.
{
  let weight = 0;
  let weighted = 0;
  for (const s of summary.values()) {
    weight += s.duels;
    weighted += s.pfo * s.duels;
  }
  const net = weighted / weight;
  assert(Math.abs(net) < 1e-6, `overperformance must cancel across all players, got ${net}`);
}

// Every duel is counted once for each of its two players, so the total duel
// weight across the board is exactly twice the number of duels.
{
  let total = 0;
  for (const s of summary.values()) total += s.duels;
  assert(
    Math.abs(total - stats.duels * 2) < 1e-6,
    `duel weight should be 2x duels: ${total} against ${stats.duels * 2}`
  );
}

// Teams are the plain average of their members, not a pooled recount.
{
  const teams = teamDuelStats(summary, roster);
  assert(teams.size === 2, 'a match has two sides');
  for (const t of teams.values()) {
    assert(t.members.length > 0, 'a side should have players');
    const pfw = t.members.reduce((s, m) => s + m.pfw, 0) / t.members.length;
    const pfo = t.members.reduce((s, m) => s + m.pfo, 0) / t.members.length;
    assert(Math.abs(t.pfw - pfw) < 1e-9, 'team PFW should be the members averaged');
    assert(Math.abs(t.pfo - pfo) < 1e-9, 'team PFO should be the members averaged');
    assert(t.pfw > 0 && t.pfw < 100, 'team PFW in range');
  }
}

console.log(`duel-stats.test.mjs: ok (${stats.duels} duels over ${stats.rounds} rounds)`);
