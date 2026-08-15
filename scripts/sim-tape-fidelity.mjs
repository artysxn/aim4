#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-tape-fidelity.mjs
// How much of a match is actually copied from the pros.
//
//   node scripts/sim-tape-fidelity.mjs [--maps INF,DD2] [--matches 4]
//                                      [--rounds 24] [--seed 7] [--compare]
//
// The complaint this answers is "they are not following calls step by step".
// That is a measurable claim and, until the controller carried counters, it
// had no measurement: a tape could be picked, pinned, and then ignored by
// every bot for a whole round with nothing anywhere saying so.
//
// Three numbers, per side per match:
//
//   follow   share of decisions where the tape had a position to offer. Low
//            means the tape ran out (v1 landmarks, or a truncated path) and
//            the bots were freestyling most of the round.
//   error    mean distance between the bot and where the pro stood at that
//            moment. A bot is 32 units wide, so under ~100 is the same line
//            and over ~400 is a different route. High follow with high error
//            is the interesting failure: reading the tape, not obeying it.
//   lineups  mined grenades the engine accepted, over those that came due.
//            The engine refuses a throw from the wrong spot, so this is
//            really "did the bot get to where the pro threw from".
//
// --compare runs the identical seeds against the SHIPPED v1 tapes as well,
// which is the honest way to price the 32 Hz re-mine: same maps, same seeds,
// same bots, the only difference being what the tape can tell them.
// ---------------------------------------------------------------------------

import path from 'node:path';

import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { desireController } from '../shared/sim/desireBot.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { ExperienceIndex } from '../shared/sim/experience.js';
import { indexPlaybook } from '../shared/sim/playbook.js';
import { loadBake, loadPlaybook, loadKnowledgeBake, SHIPPED_DIR } from '../server/sim/bakes.js';
import { openPlaybookFile } from '../server/sim/playbookStore.js';

const args = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const MAPS = String(flag('maps', 'INF,DD2,MIR') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const MATCHES = Number(flag('matches', 3));
const ROUNDS = Number(flag('rounds', 24));
const SEED = Number(flag('seed', 7));
const COMPARE = has('compare');

/** The shipped v1 tapes, loaded past the local-wins rule so both can be run. */
async function loadShipped(map) {
  try {
    const file = path.join(SHIPPED_DIR, 'playbook', `${map}.jsonl`);
    const { entries, hydrate } = await openPlaybookFile(file);
    const index = indexPlaybook(entries);
    index.hydrate = hydrate;
    return index;
  } catch {
    return null;
  }
}

function blank() {
  return {
    decisions: 0,
    onTape: 0,
    steered: 0,
    errSum: 0,
    errN: 0,
    lineups: 0,
    lineupsDue: 0,
    rounds: 0,
    frzN: 0,
    frzErr: 0,
    lagN: 0,
    lagSum: 0,
    offN: 0,
    offErr: 0,
    offReasonsPre: {},
    offReasonsPost: {}
  };
}

function fold(acc, s) {
  if (!s) return acc;
  acc.decisions += s.decisions;
  acc.onTape += Math.round(s.follow * s.decisions);
  acc.steered += s.steered;
  if (s.errorUnits !== null) {
    acc.errSum += s.errorUnits * s.steered;
    acc.errN += s.steered;
  }
  acc.lineups += s.lineups;
  acc.lineupsDue += s.lineupsDue;
  if (s.freeze?.n) {
    acc.frzN += s.freeze.n;
    acc.frzErr += s.freeze.errorUnits * s.freeze.n;
  }
  if (s.lag?.n) {
    acc.lagN += s.lag.n;
    acc.lagSum += s.lag.seconds * s.lag.n;
  }
  if (s.offPath?.n) {
    acc.offN += s.offPath.n;
    acc.offErr += s.offPath.errorUnits * s.offPath.n;
  }
  for (const [bucket, key] of [
    ['offReasonsPre', 'offReasonsPre'],
    ['offReasonsPost', 'offReasonsPost']
  ]) {
    for (const [why, n] of Object.entries(s[key] || {})) {
      acc[bucket][why] = (acc[bucket][why] || 0) + n;
    }
  }
  return acc;
}

function report(label, a) {
  const follow = a.decisions ? (a.onTape / a.decisions) * 100 : 0;
  const err = a.errN ? a.errSum / a.errN : null;
  const rate = a.lineupsDue ? (a.lineups / a.lineupsDue) * 100 : 0;
  console.log(
    `${label.padEnd(10)} follow ${`${follow.toFixed(1)}%`.padStart(6)}   ` +
      `error ${(err === null ? '  n/a' : `${err.toFixed(0)}u`).padStart(6)}   ` +
      `lineups ${String(a.lineups).padStart(4)}/${String(a.lineupsDue).padEnd(5)} ` +
      `${`${rate.toFixed(0)}%`.padStart(4)}   ` +
      `(${a.decisions.toLocaleString()} decisions)`
  );
  const live = a.lagN + a.offN;
  if (a.frzN + live > 0) {
    const share = (n) => `${((n / Math.max(1, a.frzN + live)) * 100).toFixed(0)}%`;
    console.log(
      `${''.padEnd(10)} of steered: freeze ${share(a.frzN)} at ${a.frzN ? (a.frzErr / a.frzN).toFixed(0) : 0}u | ` +
        `on-path-behind ${share(a.lagN)} by ${a.lagN ? (a.lagSum / a.lagN).toFixed(1) : 0}s | ` +
        `off-path ${share(a.offN)} at ${a.offN ? (a.offErr / a.offN).toFixed(0) : 0}u`
    );
  }
  // The off-tape reasons, so a low follow names its disease: 'end' is a
  // short tape, 'mode'/'retired' a recall, 'local' a fall-off, 'noTrace' a
  // v1 tape with no coordinates.
  for (const [label2, key] of [
    ['off pre: ', 'offReasonsPre'],
    ['off post:', 'offReasonsPost']
  ]) {
    const entries = Object.entries(a[key] || {}).sort((x, y) => y[1] - x[1]);
    if (!entries.length) continue;
    const total = entries.reduce((s2, [, n]) => s2 + n, 0);
    const parts = entries.map(([why, n]) => `${why} ${((n / total) * 100).toFixed(0)}%`);
    console.log(`${''.padEnd(10)} ${label2} ${parts.join(' | ')}  (${total.toLocaleString()})`);
  }
}

async function runOne(map, playbook, graph, angles, knowledge) {
  const acc = blank();
  for (let m = 0; m < MATCHES; m += 1) {
    let ctrlA = null;
    let ctrlB = null;
    const makeA = desireController({
      angles,
      playbook,
      knowledge,
      experience: new ExperienceIndex()
    });
    const makeB = desireController({
      angles,
      playbook,
      knowledge,
      experience: new ExperienceIndex()
    });
    playVersusMatch({
      graph,
      angles,
      map,
      controllerA: () => (ctrlA = makeA()),
      controllerB: () => (ctrlB = makeB()),
      seed: SEED + m,
      maxRounds: ROUNDS,
      record: 'none',
      replays: false
    });
    for (const c of [ctrlA, ctrlB]) {
      if (typeof c?.tapeStats === 'function') fold(acc, c.tapeStats());
    }
    acc.rounds += ROUNDS;
  }
  return acc;
}

console.log(
  `${MAPS.length} maps x ${MATCHES} matches x ${ROUNDS} rounds` +
    `${COMPARE ? ', each run twice (v2 mined paths vs shipped v1 landmarks)' : ''}\n`
);

const totals = { v2: blank(), v1: blank() };
const startedAt = Date.now();

for (const map of MAPS) {
  const nav = await loadBake('navcache', map);
  const anglesBake = await loadBake('angles', map);
  if (!nav || !anglesBake) {
    console.error(`${map}: no bakes, skipped`);
    continue;
  }
  const graph = navGraphFromBake(nav.bake);
  const angles = loadAngles(anglesBake.bake);
  const knowledge = (await loadKnowledgeBake(map))?.knowledge || null;

  const loaded = await loadPlaybook(map);
  const v2 = loaded?.index || null;
  if (!v2) {
    console.error(`${map}: no playbook, skipped`);
    continue;
  }
  console.log(`${map}  (${loaded.source}, ${v2.size} tapes)`);

  const a = await runOne(map, v2, graph, angles, knowledge);
  report('  v2', a);
  fold2(totals.v2, a);

  if (COMPARE) {
    const v1 = await loadShipped(map);
    if (v1) {
      const b = await runOne(map, v1, graph, angles, knowledge);
      report('  v1', b);
      fold2(totals.v1, b);
    } else {
      console.log('  v1        not available');
    }
  }
  console.log('');
}

function fold2(acc, s) {
  for (const k of Object.keys(acc)) {
    if (typeof acc[k] === 'object') {
      for (const [why, n] of Object.entries(s[k] || {})) acc[k][why] = (acc[k][why] || 0) + n;
    } else {
      acc[k] += s[k];
    }
  }
  return acc;
}

console.log('---');
report('total v2', totals.v2);
if (COMPARE) report('total v1', totals.v1);
console.log(`\n${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
