#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-grind.mjs
// 6.2: matches at the machine ceiling, unattended, to fill the index.
//
// This is not a spectator feature (11.5). Grind is the same match loop with
// everything a viewer needs switched off — no tick buffers, no meta, no motive
// files, nothing written per round — so the only cost is the simulation itself
// and the only product is EXPERIENCE (18.4): what the bots learned from having
// played, carried match to match and checkpointed to disk.
//
// Three things it is careful about, because an unattended job that gets any of
// them wrong wastes a night:
//
//   IT SAYS WHERE IT IS.   A run measured in hours prints a line per match
//                          with a rate and an ETA, and writes progress.json.
//   IT SURVIVES A STOP.    SIGINT finishes the match in flight, checkpoints,
//                          and exits clean. Re-running resumes from the file.
//   IT STAYS DETERMINISTIC. `--verify` replays match 1 against a fresh index
//                          and compares outcome signatures, which is 6.2's
//                          own acceptance line: same seed still hashes.
//
// The index carried across matches is CAREER and calibration only. Session
// scope is dropped between matches by endSession(), because what was true
// about one opponent tonight is not what the next match should be told.
//
// Usage:
//   node scripts/sim-grind.mjs --map INF --matches 200
//   node scripts/sim-grind.mjs --map ANC --matches 500 --brain paracord-1 \
//     --caller igl-paracord-1 --rounds 24
//   node scripts/sim-grind.mjs --map INF --matches 20 --verify
//   node scripts/sim-grind.mjs --map INF --matches 200 --fresh   # ignore the file
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadBake, loadPlaybook, loadKnowledgeBake } from '../server/sim/bakes.js';
import { loadModel, BUILTIN_BRAINS } from '../server/sim/models.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { ExperienceIndex } from '../shared/sim/experience.js';
import { markSynthetic } from '../shared/sim/firewall.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const MAP = String(flag('map', 'INF')).toUpperCase();
const MATCHES = Math.max(1, Number(flag('matches', 100)));
const ROUNDS = Math.max(1, Math.min(60, Number(flag('rounds', 24))));
const SEED = Number(flag('seed', 1));
const BRAIN = flag('brain', 'nomad-1');
const BRAIN_B = flag('brain-b', null) || BRAIN;
const CALLER = flag('caller', null);
const SKILL_A = flag('skill-a', 'average');
const SKILL_B = flag('skill-b', 'average');
const VERIFY = has('verify');
const FRESH = has('fresh');
// The call bandit is off by default in desireController and ON by default
// here, because it is the thing that writes the career ledger: with it off a
// grind fills the calibration table and leaves `career` at zero, which is a
// night of matches that taught the next match nothing about openings.
const BANDIT = !has('no-bandit');
const OUT_DIR = path.join(REPLAY_ROOT, 'sim', 'experience');
const INDEX_FILE = path.join(OUT_DIR, 'career.json');
const PROGRESS_FILE = path.join(OUT_DIR, 'grind.progress.json');
/** Matches between checkpoints. A crash costs at most this much learning. */
const CHECKPOINT_EVERY = 10;

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}

/**
 * What a match came out as, as one comparable string.
 *
 * Score alone would call two different matches identical. This is every
 * round's winner and reason in order, which is the coarsest thing that cannot
 * match by accident and the finest thing that does not depend on recording.
 */
function outcomeSignature(rounds) {
  return rounds.map((r) => `${r.round}:${r.outcome.winner}:${r.outcome.reason}:${r.kills}`).join('|');
}

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
  const knowledge = (await loadKnowledgeBake(MAP))?.knowledge || null;

  const models = {};
  const modelMeta = {};
  for (const name of [BRAIN, BRAIN_B]) {
    if (BUILTIN_BRAINS.includes(name) || models[name]) continue;
    const loaded = await loadModel(name);
    if (loaded.error) {
      console.error(loaded.error);
      process.exit(1);
    }
    if (loaded.meta?.kind === 'caller') {
      console.error(`${name} is a caller, not a bot brain; pass it as --caller`);
      process.exit(1);
    }
    models[name] = loaded.policy;
    modelMeta[name] = loaded.meta;
  }
  let callerNet = null;
  if (CALLER) {
    const loaded = await loadModel(CALLER);
    if (loaded.error) {
      console.error(loaded.error);
      process.exit(1);
    }
    if (loaded.meta?.kind !== 'caller') {
      console.error(`${CALLER} is not a caller model`);
      process.exit(1);
    }
    const covered = loaded.meta.maps
      ? loaded.meta.maps.includes(MAP)
      : !loaded.meta.map || loaded.meta.map === MAP;
    if (!covered) {
      const hasMaps = loaded.meta.maps ? loaded.meta.maps.join(', ') : loaded.meta.map;
      console.error(`caller ${CALLER} covers ${hasMaps}, not ${MAP}`);
      process.exit(1);
    }
    callerNet = loaded.policy;
  }

  // ---- the index this run is adding to ------------------------------------
  await fs.mkdir(OUT_DIR, { recursive: true });
  let index = new ExperienceIndex();
  let carried = 0;
  if (!FRESH) {
    try {
      const prev = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));
      index = ExperienceIndex.fromJSON(prev);
      carried = index.career.size;
    } catch (err) {
      // A missing file is the first run. A corrupt or stale-version one is
      // not, and silently starting from zero would throw away a night.
      if (err.code !== 'ENOENT') {
        console.error(`cannot read ${INDEX_FILE}: ${err.message}`);
        console.error('pass --fresh to start a new index deliberately.');
        process.exit(1);
      }
    }
  }

  const mk = (name) =>
    name === 'scripted'
      ? scriptedController
      : desireController({
          angles,
          policy: models[name] || null,
          playbook,
          knowledge,
          callerNet,
          callBandit: BANDIT,
          // The whole point of grinding: one index across every match, so
          // match 200 starts knowing what matches 1-199 cost.
          experience: index
        });

  console.log(`grind ${MAP}: ${MATCHES} matches x ${ROUNDS} rounds, ${BRAIN} vs ${BRAIN_B}` +
    (CALLER ? ` (caller ${CALLER})` : ''));
  console.log(`index ${carried ? `${carried} career rows carried` : 'starting empty'} -> ${INDEX_FILE}`);

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('\nstopping after the match in flight. the index is kept.');
  });

  const startedAt = Date.now();
  let played = 0;
  let rounds = 0;
  let winsA = 0;
  let firstSignature = null;

  const checkpoint = async () => {
    await writeAtomic(INDEX_FILE, JSON.stringify(markSynthetic(index.toJSON())));
    const elapsed = (Date.now() - startedAt) / 1000;
    await writeAtomic(
      PROGRESS_FILE,
      JSON.stringify(
        {
          phase: 'grind',
          map: MAP,
          done: played,
          total: MATCHES,
          percent: Math.round((played / MATCHES) * 1000) / 10,
          rounds,
          careerRows: index.career.size,
          matchesPerSecond: Math.round((played / Math.max(0.001, elapsed)) * 100) / 100,
          elapsedSeconds: Math.round(elapsed),
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  };

  for (let m = 0; m < MATCHES && !stopping; m += 1) {
    const seed = SEED + m;
    const result = playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: mk(BRAIN),
      controllerB: mk(BRAIN_B),
      seed,
      maxRounds: ROUNDS,
      skillA: SKILL_A,
      skillB: SKILL_B,
      // Everything a viewer would want, off. This is the difference between
      // grind and a match: no tick buffers, no meta, nothing per round.
      record: 'none',
      replays: false
    });
    played += 1;
    rounds += result.rounds.length;
    winsA += result.winsA;
    if (m === 0) firstSignature = outcomeSignature(result.rounds);

    // Session scope does not cross a match boundary (18.8). Career does.
    index.endSession();

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = played / Math.max(0.001, elapsed);
    console.log(
      `[${String(played).padStart(5)}/${MATCHES}] ` +
        `${((played / MATCHES) * 100).toFixed(1).padStart(5)}%  ` +
        `${result.winsA}-${result.winsB}  ` +
        `${rounds.toLocaleString()} rounds  ${rate.toFixed(2)} match/s  ` +
        `ETA ${fmtDuration((MATCHES - played) / rate)}  ` +
        `career ${index.career.size.toLocaleString()}`
    );
    if (played % CHECKPOINT_EVERY === 0) await checkpoint();
  }

  await checkpoint();

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(
    `\n${played} matches, ${rounds.toLocaleString()} rounds in ${fmtDuration(elapsed)} ` +
      `(${(rounds / Math.max(0.001, elapsed)).toFixed(1)} rounds/s)`
  );
  console.log(`team A took ${winsA} rounds of ${rounds} (${((winsA / rounds) * 100).toFixed(1)}%)`);
  console.log(`career ${index.career.size.toLocaleString()} rows, ${index.cal.size.toLocaleString()} calibrations -> ${INDEX_FILE}`);

  // ---- 6.2's acceptance line ----------------------------------------------
  if (VERIFY && firstSignature) {
    // Match 1 again, against an index that has learned nothing, exactly as it
    // was at the top of this run. Same seed, same signature, or the grind is
    // not reproducible and nothing built on it can be trusted.
    const fresh = new ExperienceIndex();
    const mkFresh = (name) =>
      name === 'scripted'
        ? scriptedController
        : desireController({
            angles,
            policy: models[name] || null,
            playbook,
            knowledge,
            callerNet,
            callBandit: BANDIT,
            experience: fresh
          });
    const again = playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: mkFresh(BRAIN),
      controllerB: mkFresh(BRAIN_B),
      seed: SEED,
      maxRounds: ROUNDS,
      skillA: SKILL_A,
      skillB: SKILL_B,
      record: 'none',
      replays: false
    });
    const ok = outcomeSignature(again.rounds) === firstSignature;
    console.log(`\nverify: same seed ${ok ? 'still hashes' : 'DIVERGED'}`);
    if (!ok) process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
