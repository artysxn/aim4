#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-admit.mjs
// 7.0: the admission job. A checkpoint becomes generation N, or the failure
// names the gate.
//
// This is sim-eval's nine gates turned into a pipeline with consequences. The
// differences from the old script are the point:
//
//   IT SCORES ELO, NOT A WIN RATE VS SCRIPTED. Gate 1 is "+25 Elo over the
//   PREVIOUS GENERATION", which is a different question from P4's "beats the
//   scripted baseline 65% of the time". Paired seeds -- same seed, sides
//   swapped -- because that is what makes 400 matches enough.
//
//   IT ACTUALLY RE-RUNS THE SEED. The determinism gate used to report
//   `pass: true, reason: 'held by desireBot.test.js'`, which is a gate that
//   scores a test file rather than this checkpoint. It now replays match one
//   and compares outcome signatures.
//
//   A SKIPPED GATE IS NOT A PASS. Four of the nine need demo-mined bands this
//   host may not have. They come back `skip`, and a run carrying skips is
//   PROVISIONAL, never admitted, unless --allow-skipped says so out loud.
//
//   IT WRITES THE REGISTRY. On a pass, the manifest lands beside the weights
//   and the model becomes a generation. That is the whole job: everything
//   above only decides whether this last step happens.
//
// Usage:
//   node scripts/sim-admit.mjs --model paracord-1 --parent navaja-3
//   node scripts/sim-admit.mjs --model paracord-1 --parent navaja-3 \
//     --maps INF,ANC --matches 40 --allow-skipped
//   node scripts/sim-admit.mjs --model paracord-1 --dry-run
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadBake, loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';
import { loadModel, listGenerations } from '../server/sim/models.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { entropy } from '../shared/sim/surprise.js';
import { markSynthetic } from '../shared/sim/firewall.js';
import {
  ELO_GATE,
  GATE_STATUS,
  VERDICT,
  admit,
  buildManifest,
  eloFromScore,
  gateResult
} from '../shared/sim/admission.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const MODEL = String(flag('model', ''));
const PARENT = flag('parent', null);
const MAPS = String(flag('maps', 'INF')).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
/** Match PAIRS per map. 9.8 asks for 400 games; the default here is a smoke. */
const MATCHES = Math.max(1, Number(flag('matches', 8)));
const ROUNDS = Math.max(1, Math.min(60, Number(flag('rounds', 12))));
const SEED = Number(flag('seed', 100));
const ALLOW_SKIPPED = has('allow-skipped');
const DRY_RUN = has('dry-run');
const EVALS_DIR = path.join(REPLAY_ROOT, 'sim', 'evals');
const MODELS_DIR = path.join(REPLAY_ROOT, 'sim', 'models');

if (!MODEL) {
  console.error('sim-admit: --model is required');
  process.exit(1);
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

/** Every round's outcome in order: the coarsest thing that cannot match by luck. */
function signature(rounds) {
  return rounds.map((r) => `${r.round}:${r.outcome.winner}:${r.outcome.reason}:${r.kills}`).join('|');
}

async function main() {
  const startedAt = Date.now();

  // ---- who is being judged, and against whom -----------------------------
  const loaded = await loadModel(MODEL);
  if (loaded.error) {
    console.error(loaded.error);
    process.exit(1);
  }
  if (loaded.meta?.kind === 'caller') {
    console.error(`${MODEL} is a caller. The caller half of a generation is graded by 9.25, not here.`);
    process.exit(1);
  }

  const gens = await listGenerations();
  const mine = gens.find((g) => g.name === MODEL) || null;
  // The parent is the previous generation of the same lineage unless named.
  // Without one there is nothing to measure +25 Elo against, and saying that
  // is better than quietly grading against the scripted baseline instead.
  const parentName = PARENT || mine?.parent || null;
  let parentModel = null;
  if (parentName) {
    const p = await loadModel(parentName);
    if (p.error) {
      console.error(`parent ${parentName}: ${p.error}`);
      process.exit(1);
    }
    parentModel = p.policy;
  }

  const evalId = `${MODEL}-${Date.now().toString(36)}`;
  console.log(`admitting ${MODEL}` + (parentName ? ` against ${parentName}` : ' with no parent'));
  console.log(`${MAPS.join(', ')}, ${MATCHES} pairs x ${ROUNDS} rounds per map`);

  // ---- play the paired matches -------------------------------------------
  let score = 0;
  let games = 0;
  const labels = {};
  const sideWins = { T: 0, CT: 0 };
  const sideGames = { T: 0, CT: 0 };
  const perMap = {};
  let firstSignature = null;
  let firstReplay = null;

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

    const mk = (policy) =>
      policy === 'scripted'
        ? scriptedController
        : desireController({ angles, policy, playbook, knowledge });
    const challenger = mk(loaded.policy);
    const baseline = mk(parentModel || 'scripted');

    let mapScore = 0;
    for (let m = 0; m < MATCHES; m += 1) {
      const seed = SEED + m;
      // Paired: the same seed played both ways round. A checkpoint that only
      // wins from the T side has not beaten anything, and this is what makes
      // that visible instead of averaging it away.
      for (const challengerIsA of [true, false]) {
        const result = playVersusMatch({
          graph,
          angles,
          map,
          controllerA: challengerIsA ? challenger : baseline,
          controllerB: challengerIsA ? baseline : challenger,
          seed,
          maxRounds: ROUNDS,
          record: 'none',
          replays: false
        });
        const mineRounds = challengerIsA ? result.winsA : result.winsB;
        const theirs = challengerIsA ? result.winsB : result.winsA;
        if (mineRounds > theirs) {
          score += 1;
          mapScore += 1;
        } else if (mineRounds === theirs) {
          score += 0.5;
          mapScore += 0.5;
        }
        games += 1;

        // Team A starts T, so the challenger's opening side is known.
        const openingSide = challengerIsA ? 'T' : 'CT';
        sideGames[openingSide] += 1;
        sideWins[openingSide] += mineRounds > theirs ? 1 : mineRounds === theirs ? 0.5 : 0;

        for (const round of result.rounds || []) {
          const log = round.brainLogs?.[challengerIsA ? 'A' : 'B'] || [];
          for (const row of log) labels[row.id] = (labels[row.id] || 0) + 1;
        }
        if (firstSignature === null) {
          firstSignature = signature(result.rounds);
          firstReplay = { map, seed, challengerIsA, graph, angles, challenger, baseline };
        }
      }
      if ((m + 1) % 5 === 0 || m + 1 === MATCHES) {
        const done = MAPS.indexOf(map) * MATCHES + m + 1;
        const total = MAPS.length * MATCHES;
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / Math.max(0.001, elapsed);
        process.stdout.write(
          `\r  ${done}/${total} pairs  ${((done / total) * 100).toFixed(0)}%  ` +
            `ETA ${fmtDuration((total - done) / rate)}   `
        );
      }
    }
    perMap[map] = { score: mapScore, pairs: MATCHES };
  }
  process.stdout.write('\n');

  // ---- score the gates ----------------------------------------------------
  const results = [];

  // 5. Determinism. Replayed for real: same seed, same controllers, same
  // outcome signature, or nothing else in this report means anything.
  {
    const r = playVersusMatch({
      graph: firstReplay.graph,
      angles: firstReplay.angles,
      map: firstReplay.map,
      controllerA: firstReplay.challengerIsA ? firstReplay.challenger : firstReplay.baseline,
      controllerB: firstReplay.challengerIsA ? firstReplay.baseline : firstReplay.challenger,
      seed: firstReplay.seed,
      maxRounds: ROUNDS,
      record: 'none',
      replays: false
    });
    const same = signature(r.rounds) === firstSignature;
    results.push(
      gateResult(
        'determinism',
        same ? GATE_STATUS.PASS : GATE_STATUS.FAIL,
        same
          ? `seed ${firstReplay.seed} on ${firstReplay.map} replayed identically`
          : `seed ${firstReplay.seed} on ${firstReplay.map} DIVERGED on replay`
      )
    );
  }

  // 2. Aim envelope. The motor is clamped by skill.js to the pro envelope at
  // construction, so nothing a checkpoint can learn escapes it: this gate is
  // structural rather than measured, and says so instead of inventing a number.
  results.push(
    gateResult(
      'aim',
      GATE_STATUS.PASS,
      'aim motor is clamped to the 8.2 pro envelope at construction; no policy output can exceed it'
    )
  );

  // 1. Elo vs the parent.
  const elo = eloFromScore(score, games);
  if (!parentName) {
    results.push(
      gateResult(
        'elo',
        GATE_STATUS.SKIP,
        'no parent generation to measure against; +25 Elo is defined against the previous generation'
      )
    );
  } else {
    const pass = elo.lo >= ELO_GATE;
    results.push(
      gateResult(
        'elo',
        pass ? GATE_STATUS.PASS : GATE_STATUS.FAIL,
        `${elo.elo.toFixed(0)} Elo vs ${parentName} ` +
          `(95% CI ${elo.lo.toFixed(0)} to ${elo.hi.toFixed(0)}) over ${games} paired games, gate +${ELO_GATE} on the lower bound`,
        { score, games, rate: elo.rate, elo: elo.elo, lo: elo.lo, hi: elo.hi, perMap }
      )
    );
  }

  // 4. Strategy diversity: entropy floor plus the side band.
  {
    const h = entropy(labels);
    const tRate = sideGames.T ? sideWins.T / sideGames.T : 0.5;
    const ctRate = sideGames.CT ? sideWins.CT / sideGames.CT : 0.5;
    const banded = (r) => r >= 0.35 && r <= 0.65;
    const entropyOk = Object.keys(labels).length ? h >= 1.0 : false;
    const sidesOk = banded(tRate) && banded(ctRate);
    const pass = entropyOk && sidesOk;
    results.push(
      gateResult(
        'diversity',
        Object.keys(labels).length ? (pass ? GATE_STATUS.PASS : GATE_STATUS.FAIL) : GATE_STATUS.SKIP,
        Object.keys(labels).length
          ? `option entropy ${h.toFixed(2)} bits (floor 1.0); T ${(tRate * 100).toFixed(0)}% / ` +
            `CT ${(ctRate * 100).toFixed(0)}% (band 35 to 65)`
          : 'no option log: a scripted side writes none, so diversity cannot be read',
        { entropy: h, tRate, ctRate }
      )
    );
  }

  // 8. Belief quality. The filter runs, but the KL against truth needs the
  // per-tick belief dump 11.3 also wants and nothing writes yet.
  results.push(
    gateResult(
      'belief',
      GATE_STATUS.SKIP,
      'particle-filter KL needs a per-tick belief record; the engine does not write one yet'
    )
  );

  // 9. Exploitability (7.1). Read from the exploiter run rather than computed
  // here: pointing an exploiter at a champion is a job of its own length, and
  // folding it into admission would make every admission pay for it.
  {
    const file = path.join(REPLAY_ROOT, 'sim', 'league', `exploit-${MODEL}.json`);
    let ex = null;
    try {
      ex = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* no run for this checkpoint */
    }
    if (!ex) {
      results.push(
        gateResult(
          'exploitability',
          GATE_STATUS.SKIP,
          `no exploiter run for ${MODEL}; run scripts/sim-exploit.mjs --champion ${MODEL}`
        )
      );
    } else if (ex.champion !== MODEL) {
      // A report for a different model in this model's slot is worse than no
      // report: it would pass a gate on somebody else's evidence.
      results.push(
        gateResult(
          'exploitability',
          GATE_STATUS.SKIP,
          `the exploiter report at ${file} is for ${ex.champion}, not ${MODEL}`
        )
      );
    } else {
      results.push(
        gateResult(
          'exploitability',
          ex.pass ? GATE_STATUS.PASS : GATE_STATUS.FAIL,
          `${ex.reason} (${ex.games} games, ${ex.method}; lower bound)`,
          { winRate: ex.winRate, games: ex.games, method: ex.method, perMap: ex.perMap }
        )
      );
    }
  }

  // 3, 6, 7. The library-banded three. A host with no mined pro baselines
  // cannot score these, and pretending otherwise is what 9.24 forbids.
  for (const [id, what] of [
    ['humanLikeness', 'KS vs demo speed/TTD histograms'],
    ['surprise', 'the two-sided texture band'],
    ['teamPlay', 'trade and untraded-death pro bands']
  ]) {
    results.push(
      gateResult(id, GATE_STATUS.SKIP, `${what} needs mined pro baselines, absent on this host`)
    );
  }

  // ---- the verdict --------------------------------------------------------
  const verdict = admit(results, { allowSkipped: ALLOW_SKIPPED });
  const elapsed = (Date.now() - startedAt) / 1000;

  const report = markSynthetic({
    v: 1,
    kind: 'admission',
    evalId,
    model: MODEL,
    parent: parentName,
    maps: MAPS,
    pairs: MATCHES,
    rounds: ROUNDS,
    seed: SEED,
    games,
    score,
    elo,
    perMap,
    verdict: verdict.verdict,
    reason: verdict.reason,
    failed: verdict.failed,
    skipped: verdict.skipped,
    gates: results,
    elapsedSeconds: Math.round(elapsed),
    createdAt: new Date().toISOString()
  });
  await writeAtomic(path.join(EVALS_DIR, evalId, 'report.json'), JSON.stringify(report, null, 2));

  // ---- say it -------------------------------------------------------------
  console.log('');
  for (const g of results) {
    const mark = g.status === GATE_STATUS.PASS ? 'pass' : g.status === GATE_STATUS.FAIL ? 'FAIL' : 'skip';
    console.log(`  [${mark}] ${g.id.padEnd(15)} ${g.reason}`);
  }
  console.log('');
  console.log(`${verdict.verdict.toUpperCase()}: ${verdict.reason}`);
  console.log(`report -> ${path.join(EVALS_DIR, evalId, 'report.json')} (${fmtDuration(elapsed)})`);

  if (verdict.verdict === VERDICT.REJECTED) {
    process.exit(2);
  }

  // ---- write the registry -------------------------------------------------
  if (DRY_RUN) {
    console.log('dry run: the manifest was not written.');
    return;
  }
  const gen = (mine?.gen ?? 0) || (gens.filter((g) => g.lineage === mine?.lineage).length || 0);
  const manifest = buildManifest({
    name: MODEL,
    parent: parentName,
    gen,
    verdict,
    results,
    league: [parentName, 'scripted'].filter(Boolean),
    elo: parentName ? { vs: parentName, ...elo } : null,
    evalId,
    createdAt: new Date().toISOString()
  });
  const file = path.join(MODELS_DIR, `${MODEL}.manifest.json`);
  await writeAtomic(file, JSON.stringify(markSynthetic(manifest), null, 2));
  console.log(`registry -> ${file}: ${MODEL} is generation ${gen}` +
    (verdict.verdict === VERDICT.PROVISIONAL ? ' (provisional)' : ''));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
