#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-ablate.mjs
// 7.7: the A/B/C/D ablation. Is the memory worth anything, with a number.
//
// 18.8 makes a large claim -- that experience accumulates something no amount
// of retraining reproduces -- and then says the honest thing about it:
//
//   "If C beats A, the brief's claim is true in this system and we can say so
//    with a number attached. If C loses to A badly, the memory is decorative
//    and section 18 needs rebuilding rather than defending. Either result is
//    worth having, and this is the only way to find out which one is real."
//
// So this script is built to be capable of embarrassing section 18, and the
// output says plainly which of those two worlds we are in.
//
//   A   gen N weights, EMPTY experience          the weights alone
//   B   gen N weights, full career               Delta_E, the value of memory
//   C   gen N-5 weights, full career             is memory worth 5 generations
//   D   gen N weights, opponent scope only       how much of Delta_E is
//                                                opponent-specific
//
// THE THING THAT MAKES IT A MEASUREMENT. Every arm gets a FRESH COPY of its
// assigned index for every single match. Without that, arm A writes as it
// plays and stops being empty by match three, arm B drifts away from the
// memory it was supposed to be testing, and the comparison measures how fast
// each arm learns rather than what it started with. Four arms, same paired
// seeds, same opponent, differing in exactly two things: weights and memory.
//
// Usage:
//   node scripts/sim-ablate.mjs --model paracord-1 --matches 20
//   node scripts/sim-ablate.mjs --model paracord-1 --old navaja-1 \
//     --opponent nomad-1 --maps INF,ANC --index career.json
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadBake, loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';
import { loadModel, listGenerations } from '../server/sim/models.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { ExperienceIndex } from '../shared/sim/experience.js';
import { eloFromScore } from '../shared/sim/admission.js';
import { markSynthetic } from '../shared/sim/firewall.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const MODEL = String(flag('model', ''));
/** Gen N-5. Resolved from the lineage when not named. */
const OLD = flag('old', null);
/** The common opponent every arm plays. Fixed, or the arms are not comparable. */
const OPPONENT = String(flag('opponent', 'nomad-1'));
const MAPS = String(flag('maps', 'INF')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
const MATCHES = Math.max(1, Number(flag('matches', 12)));
const ROUNDS = Math.max(1, Math.min(60, Number(flag('rounds', 12))));
const SEED = Number(flag('seed', 900));
const INDEX_FILE = flag('index', path.join(REPLAY_ROOT, 'sim', 'experience', 'career.json'));
const OUT = flag('out', null);
/** Below this, Delta_E is noise and the report says so instead of a verdict. */
const MEANINGFUL_ELO = 15;

if (!MODEL) {
  console.error('sim-ablate: --model is required');
  process.exit(1);
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

async function main() {
  const startedAt = Date.now();

  const champ = await loadModel(MODEL);
  if (champ.error) {
    console.error(champ.error);
    process.exit(1);
  }
  const opp = await loadModel(OPPONENT);
  if (opp.error) {
    console.error(`opponent ${OPPONENT}: ${opp.error}`);
    process.exit(1);
  }

  // Gen N-5, or the oldest this lineage has. Naming the shortfall matters:
  // "memory beats two generations of training" is a different claim from
  // "memory beats five", and reporting the second while measuring the first
  // is the kind of overstatement this whole script exists to avoid.
  const gens = await listGenerations();
  const mine = gens.find((g) => g.name === MODEL) || null;
  const lineage = mine ? gens.filter((g) => g.lineage === mine.lineage) : [];
  let oldName = OLD;
  let genGap = 5;
  if (!oldName && mine) {
    const i = lineage.findIndex((g) => g.name === MODEL);
    const target = Math.max(0, i - 5);
    oldName = lineage[target]?.name || null;
    genGap = i - target;
  }
  let oldModel = null;
  let oldLoaded = null;
  if (oldName && oldName !== MODEL) {
    const o = await loadModel(oldName);
    if (o.error) {
      console.error(`old model ${oldName}: ${o.error}`);
      process.exit(1);
    }
    oldLoaded = o;
    oldModel = o.policy;
  }

  // The memory under test.
  let stored = null;
  try {
    stored = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
  } catch {
    console.error(`no experience index at ${INDEX_FILE}. Run a grind first (6.2).`);
    process.exit(1);
  }
  const careerRows = (stored.rows || []).length;
  if (!careerRows) {
    console.error(`${INDEX_FILE} holds no career rows: there is no memory to ablate.`);
    process.exit(1);
  }

  console.log(`ablating ${MODEL} against ${OPPONENT} on ${MAPS.join(', ')}`);
  console.log(`memory: ${careerRows} career rows from ${INDEX_FILE}`);
  console.log(
    oldModel
      ? `arm C uses ${oldName} (${genGap} generation${genGap === 1 ? '' : 's'} back)`
      : 'arm C is SKIPPED: no older generation in this lineage'
  );

  /**
   * A fresh index for one match, built per arm.
   *
   * Arm D is the interesting one to build: the plan asks for "opponent scope
   * only", and what this host persists is the career scope. So the same rows
   * are loaded into the OPPONENT bag instead. That measures the right thing --
   * the same knowledge, read at opponent specificity rather than as general
   * career evidence -- and it is not the same as having mined a genuinely
   * opponent-specific index, which is noted in the report.
   */
  const freshIndex = (arm) => {
    if (arm === 'A') return new ExperienceIndex();
    const idx = ExperienceIndex.fromJSON(stored);
    if (arm === 'D') {
      idx.opponent = idx.career;
      idx.career = new Map();
    }
    return idx;
  };

  // The Nomad is knobs, not weights: its model file configures the bare
  // arbiter rather than carrying a policy. Passed as `policy` it would be
  // called as one, so the loader shape is resolved once, here.
  const brainOpts = (loaded) =>
    loaded.meta?.kind === 'nomad' ? { ...(loaded.policy || {}) } : { policy: loaded.policy };
  const oppOpts = brainOpts(opp);
  const oldOpts = oldLoaded ? brainOpts(oldLoaded) : null;

  const ARMS = [
    { id: 'A', opts: brainOpts(champ), what: `${MODEL}, empty memory` },
    { id: 'B', opts: brainOpts(champ), what: `${MODEL}, full career` },
    ...(oldModel ? [{ id: 'C', opts: oldOpts, what: `${oldName}, full career` }] : []),
    { id: 'D', opts: brainOpts(champ), what: `${MODEL}, opponent scope only` }
  ];

  const scores = {};
  const totalGames = ARMS.length * MAPS.length * MATCHES * 2;
  let played = 0;

  for (const arm of ARMS) {
    let score = 0;
    let games = 0;
    for (const map of MAPS) {
      const nav = await loadBake('navcache', map);
      const anglesBake = await loadBake('angles', map);
      if (!nav || !anglesBake) {
        console.error(`no bakes for ${map}`);
        process.exit(1);
      }
      const graph = navGraphFromBake(nav.bake);
      const angles = loadAngles(anglesBake.bake);
      const playbook = (await loadPlaybook(map))?.index || null;
      const knowledge = (await loadKnowledgeBake(map))?.knowledge || null;

      for (let m = 0; m < MATCHES; m += 1) {
        for (const armIsA of [true, false]) {
          // Fresh per match, both sides. The arm never accumulates, and the
          // opponent never builds a read on it either.
          const armSide = desireController({
            angles,
            playbook,
            knowledge,
            ...arm.opts,
            experience: freshIndex(arm.id)
          });
          const oppSide = desireController({
            angles,
            playbook,
            knowledge,
            ...oppOpts,
            experience: new ExperienceIndex()
          });
          const result = playVersusMatch({
            graph,
            angles,
            map,
            controllerA: armIsA ? armSide : oppSide,
            controllerB: armIsA ? oppSide : armSide,
            // The SAME seeds for every arm. This is what makes four runs a
            // comparison rather than four samples.
            seed: SEED + m,
            maxRounds: ROUNDS,
            record: 'none',
            replays: false
          });
          const mineRounds = armIsA ? result.winsA : result.winsB;
          const theirs = armIsA ? result.winsB : result.winsA;
          if (mineRounds > theirs) score += 1;
          else if (mineRounds === theirs) score += 0.5;
          games += 1;
          played += 1;
        }
        const elapsed = (Date.now() - startedAt) / 1000;
        process.stdout.write(
          `\r  arm ${arm.id}  ${played}/${totalGames} games  ` +
            `ETA ${fmtDuration((totalGames - played) / (played / Math.max(0.001, elapsed)))}   `
        );
      }
    }
    scores[arm.id] = { ...eloFromScore(score, games), score, games, what: arm.what };
  }
  process.stdout.write('\n');

  // ---- what it means ------------------------------------------------------
  const A = scores.A;
  const B = scores.B;
  const C = scores.C || null;
  const D = scores.D;

  const deltaE = B.elo - A.elo;
  const deltaC = C ? C.elo - A.elo : null;
  const opponentShare = deltaE !== 0 ? (D.elo - A.elo) / deltaE : null;

  // The interval on a DIFFERENCE of two independent estimates. Both arms play
  // the same seeds against the same opponent, so this is conservative rather
  // than tight, which is the direction to be wrong in when the conclusion is
  // "section 18 is real".
  const halfWidth = (x) => (x.hi - x.lo) / 2;
  const deltaHalf = Math.sqrt(halfWidth(A) ** 2 + halfWidth(B) ** 2);
  const decisive = Math.abs(deltaE) > deltaHalf && Math.abs(deltaE) >= MEANINGFUL_ELO;

  let claim;
  if (!decisive) {
    claim =
      `INCONCLUSIVE: Delta_E is ${deltaE.toFixed(0)} Elo, inside the +/-${deltaHalf.toFixed(0)} ` +
      `noise of ${A.games} games per arm. Run more matches before believing either story.`;
  } else if (deltaE > 0) {
    claim = `Memory is worth ${deltaE.toFixed(0)} Elo on this pairing (Delta_E).`;
  } else {
    claim = `Memory COSTS ${(-deltaE).toFixed(0)} Elo on this pairing. Section 18 is not paying for itself here.`;
  }

  let cClaim = null;
  if (C) {
    cClaim =
      deltaC > 0
        ? `Arm C beats arm A by ${deltaC.toFixed(0)} Elo: ${genGap} generations of training are ` +
          'worth less than the memory, which is 18.8\'s claim holding.'
        : `Arm C loses to arm A by ${(-deltaC).toFixed(0)} Elo: training beat memory over ` +
          `${genGap} generations. 18.8's claim does not hold on this pairing.`;
  }

  const report = markSynthetic({
    v: 1,
    kind: 'ablation',
    model: MODEL,
    old: oldName,
    genGap,
    opponent: OPPONENT,
    maps: MAPS,
    matches: MATCHES,
    rounds: ROUNDS,
    indexFile: INDEX_FILE,
    careerRows,
    arms: scores,
    deltaE,
    deltaEHalfWidth: deltaHalf,
    decisive,
    deltaC,
    opponentShare,
    // Arm D reads career rows through the opponent bag; the plan's D is a
    // genuinely opponent-mined index. Same knowledge, different specificity.
    dCaveat: 'arm D loads career rows into the opponent scope; it is not an opponent-mined index',
    claim,
    cClaim,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    createdAt: new Date().toISOString()
  });

  const out = OUT || path.join(REPLAY_ROOT, 'sim', 'evals', `ablation-${MODEL}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2));

  console.log('');
  for (const id of ['A', 'B', 'C', 'D']) {
    const s = scores[id];
    if (!s) continue;
    console.log(
      `  ${id}  ${s.score}/${s.games}  ${s.elo.toFixed(0).padStart(5)} Elo  ` +
        `[${s.lo.toFixed(0)}, ${s.hi.toFixed(0)}]  ${s.what}`
    );
  }
  console.log('');
  console.log(claim);
  if (cClaim) console.log(cClaim);
  if (opponentShare != null && decisive) {
    console.log(
      `${(opponentShare * 100).toFixed(0)}% of Delta_E survives as opponent-scoped memory.`
    );
  }
  console.log(`report -> ${out} (${fmtDuration((Date.now() - startedAt) / 1000)})`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
