#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-bootcamp.mjs
// Bootcamp: a training mode where one team is a metronome (operator spec).
//
// The bootcamp side's IGL calls the SAME round every time — 5A, every round —
// until the trainee wins 8 of the last 10 against it. Then the next drill.
// When every drill on a side has been beaten one at a time, the bootcamp
// mixes them at random for `--mix-rounds` rounds and the trainee has to read
// which question is being asked. Both teams buy from a full purse every
// round: drills are about decisions, not wallets.
//
// The run ends when stage 2 is complete, not when a round budget runs out —
// `--rounds` is a safety ceiling for a trainee that never passes a drill,
// and the report says which of the two stopped it.
//
// The trainee is a REAL model with its in-match learning on — the call
// bandit (EXP3 over openings, 6.10) and the experience index (18.4), which
// are exactly the machinery a held-still pattern exists to feed. The ladder
// never tells the trainee anything; it only holds the pattern still.
//
// Rounds run as consecutive matches (a match ends at 13 or 24 rounds), and
// the split across that boundary is 18.8's: IN-MATCH MEMORY RESETS, EXPERIENCE
// PERSISTS. The trainee gets a fresh EXP3 bandit and tendency tracker every
// match — those are a read on the series being played — while ONE
// ExperienceIndex is carried the whole way, its session scope cleared at each
// boundary and its career scope and calibration table left to accumulate.
//
// That is what makes stage 2 possible at all: recognition is learned across
// many varied rounds, so a trainee that forgot everything every 24 rounds
// would rebuild its read from scratch and a 50-round stage 2 would really be
// two stubs.
//
// Output: one JSON report under sim/bootcamp/ (synthetic-marked, 12.1), and
// a progress line per round.
//
// Usage:
//   node scripts/sim-bootcamp.mjs --map CCH --trainee navaja-3 --caller igl-paracord-lite-1
//   node scripts/sim-bootcamp.mjs --map CCH --rounds 120 --drills cch-a-contact,cch-b-contact
//   node scripts/sim-bootcamp.mjs --map CCH --mix-rounds 100   # longer stage 2
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadBake, loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';
import { loadModel } from '../server/sim/models.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { createBootcamp, BOOTCAMP_MIX_ROUNDS, BOOTCAMP_PHASE } from '../shared/sim/bootcamp.js';
import { ExperienceIndex } from '../shared/sim/experience.js';
import { markSynthetic } from '../shared/sim/firewall.js';
import { Rng } from '../shared/sim/rng.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const MAP = String(flag('map', 'CCH')).toUpperCase();
const TRAINEE = flag('trainee', 'navaja-3');
const CALLER = flag('caller', null);
const BOOTCAMP_BRAIN = flag('bootcamp', 'navaja-3');
const ROUNDS = Number(flag('rounds', 240));
const MIX_ROUNDS = Number(flag('mix-rounds', BOOTCAMP_MIX_ROUNDS));
const SEED = Number(flag('seed', 1));
const SKILL = flag('skill', 'pro');
const MIN_ENTRIES = Number(flag('min-entries', 25));
const DRILLS = String(flag('drills', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  const nav = await loadBake('navcache', MAP);
  const anglesBake = await loadBake('angles', MAP);
  if (!nav || !anglesBake) {
    console.error(`no bakes for ${MAP}`);
    process.exit(1);
  }
  const graph = navGraphFromBake(nav.bake);
  const angles = loadAngles(anglesBake.bake);
  const playbook = (await loadPlaybook(MAP))?.index || null;
  if (!playbook) {
    console.error(`no playbook for ${MAP}: a bootcamp with no drills is a scrim`);
    process.exit(1);
  }
  const knowledge = (await loadKnowledgeBake(MAP))?.knowledge || null;

  const models = {};
  for (const name of [TRAINEE, BOOTCAMP_BRAIN]) {
    if (models[name]) continue;
    const loaded = await loadModel(name);
    if (loaded.error) {
      console.error(loaded.error);
      process.exit(1);
    }
    models[name] = loaded.policy;
  }
  let callerNet = null;
  if (CALLER) {
    const loaded = await loadModel(CALLER);
    if (loaded.error) {
      console.error(loaded.error);
      process.exit(1);
    }
    callerNet = loaded.policy;
  }

  // The drill list: what this map's winners actually ran, most common first,
  // unless the operator names their own. `default` is not a drill — a
  // metronome that plays "whatever" is not holding a pattern still.
  const drills = {};
  for (const side of ['T', 'CT']) {
    const known = new Map(playbook.calls?.[side] || []);
    // A drill this side cannot call is not a drill: the metronome would fall
    // through to `default` and the ladder would be grading a round nobody
    // asked for. Filter per side rather than trusting the flag.
    drills[side] = DRILLS.length
      ? DRILLS.filter((call) => known.has(call))
      : [...known.entries()]
          .filter(([call, n]) => call !== 'default' && (n ?? 0) >= MIN_ENTRIES)
          .map(([call]) => call);
    const dropped = DRILLS.filter((call) => !known.has(call));
    if (dropped.length) {
      console.log(`  note: ${side} cannot call ${dropped.join(', ')} on ${MAP}; not drilled`);
    }
  }
  if (!drills.T.length && !drills.CT.length) {
    console.error(`no calls with ${MIN_ENTRIES}+ tapes on ${MAP}; lower --min-entries`);
    process.exit(1);
  }
  console.log(`bootcamp on ${MAP}: trainee ${TRAINEE}${CALLER ? ` + ${CALLER}` : ''} vs drill-IGL ${BOOTCAMP_BRAIN}`);
  console.log(`  T drills:  ${drills.T.join(', ') || '(none)'}`);
  console.log(`  CT drills: ${drills.CT.join(', ') || '(none)'}`);
  console.log(`  stage 2 (recognition): ${MIX_ROUNDS} rounds per side, ceiling ${ROUNDS} rounds`);

  const camp = createBootcamp({ drills, mixRounds: MIX_ROUNDS });
  const mixRng = new Rng(SEED * 7919 + 13);
  // The one thing that outlives a match in this run (18.8). The bandit and
  // the tracker are rebuilt per match inside the controller; this is not.
  const traineeXp = new ExperienceIndex();

  let played = 0;
  let set = 0;
  const history = [];
  while (played < ROUNDS && !camp.isComplete()) {
    set += 1;
    // In-match memory ends with the match; what was learned does not.
    if (set > 1) traineeXp.endSession();
    // eslint-disable-next-line no-loop-func
    playVersusMatch({
      graph,
      angles,
      map: MAP,
      // Team A is the metronome: same brain quality, but its caller is
      // dictated by the ladder rather than sampling.
      controllerA: desireController({
        angles,
        policy: models[BOOTCAMP_BRAIN],
        playbook,
        knowledge,
        forceCallOf: ({ side }) => camp.drillFor(side, mixRng)
      }),
      // Team B is the trainee, learning on: the bandit reads the pattern.
      controllerB: desireController({
        angles,
        policy: models[TRAINEE],
        playbook,
        knowledge,
        callerNet,
        callBandit: true,
        experience: traineeXp
      }),
      seed: SEED + set,
      // Sized to where the remaining need actually LIVES. Team A meets the T
      // ladder in rounds 1-12 and the CT ladder from round 13, so a match
      // must run deep enough to reach the furthest side that still owes
      // rounds — sizing off a pooled total once starved the CT ladder
      // whenever T finished first, and the run idled to the ceiling.
      maxRounds: Math.max(
        1,
        Math.min(
          24,
          ROUNDS - played,
          Math.max(
            camp.remainingFor('T') > 0 ? Math.min(12, camp.remainingFor('T')) : 0,
            camp.remainingFor('CT') > 0 ? 12 + Math.min(12, camp.remainingFor('CT')) : 0
          )
        )
      ),
      skillA: SKILL,
      skillB: SKILL,
      record: 'none',
      infiniteMoney: true,
      onRound: (round) => {
        played += 1;
        const campSide = round.sides?.A;
        const call =
          round.igl?.A?.find((x) => x.event === 'freeze')?.call ||
          camp.drillFor(campSide) ||
          null;
        const traineeWon = round.outcome?.winner === round.sides?.B;
        const res = camp.record({ side: campSide, call, traineeWon });
        const p = camp.progress(campSide);
        history.push({
          round: played,
          side: campSide,
          call,
          traineeWon,
          phase: res.phase,
          counted: !res.mismatch
        });
        const label = res.mismatch
          ? `not the drill (${res.drill}) — uncounted`
          : res.phase === BOOTCAMP_PHASE.MIXED || res.phase === BOOTCAMP_PHASE.DONE
            ? `MIXED ${p.mixed}/${p.mixRounds}`
            : `${p.drillIndex + 1}/${p.drills} ${p.recentWins}/10 recent`;
        console.log(
          `[${String(played).padStart(4)}] camp ${campSide} ${String(call || '?').padEnd(24)} ` +
            `trainee ${traineeWon ? 'W' : 'L'}  ${label}${res.passed ? '  << DRILL BEATEN' : ''}`
        );
      }
    });
  }

  const summary = camp.summary();
  const complete = camp.isComplete();
  console.log('\n---- bootcamp report ----');
  console.log(
    complete
      ? `finished: every drill beaten, then ${MIX_ROUNDS} rounds of mixed recognition`
      : `stopped at the ${ROUNDS}-round ceiling with drills still standing`
  );
  for (const side of ['T', 'CT']) {
    if (!drills[side].length) continue;
    const s = summary[side];
    console.log(`${side} (phase ${s.phase}):`);
    for (const d of s.drills) {
      console.log(
        `  ${d.call.padEnd(24)} ${String(d.rounds).padStart(4)} rounds  ` +
          `trainee ${d.traineeWinrate}%${d.passedAt ? `  beaten at ${d.passedAt}` : '  UNBEATEN'}`
      );
    }
    // Stage 2's number. Stage 1 teaches each answer; this is where the
    // trainee learns to tell which question it is being asked. Reported
    // apart because the two stages teach different things.
    if (s.mixed.rounds) {
      console.log(
        `  ${'STAGE 2 (mixed)'.padEnd(24)} ${String(s.mixed.rounds).padStart(4)}/${s.mixed.of}      ` +
          `trainee ${s.mixed.traineeWinrate}%`
      );
    }
  }

  const outDir = path.join(REPLAY_ROOT, 'sim', 'bootcamp');
  await fs.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `bootcamp-${MAP}-${Date.now().toString(36)}.json`);
  await fs.writeFile(
    out,
    JSON.stringify(
      markSynthetic({
        v: 1,
        kind: 'bootcamp',
        map: MAP,
        trainee: TRAINEE,
        caller: CALLER,
        bootcamp: BOOTCAMP_BRAIN,
        seed: SEED,
        rounds: played,
        mixRounds: MIX_ROUNDS,
        complete,
        drills,
        summary,
        history
      }),
      null,
      2
    )
  );
  console.log(`\nwrote ${out}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
