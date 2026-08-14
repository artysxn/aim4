#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-collect-prw.mjs
// Collect the belief-value dataset: (observation, pWin_true) pairs.
//
// SIM-PLAN 18.6b use 3, which is 9.14's auxiliary head. The clone teaches
// WHAT to do; this head teaches what the position is WORTH, and it trains on
// the true round-win probability rather than on the round's W/L, because one
// float per decision carries far more signal than one bit per round and it is
// the same currency foresight already prices in.
//
// Where the rows come from: every round, both sides write PRW rows at the
// team frame and at every recall / plant / death / opportunity, and roundEnd
// grades them against the sealed true state (see shared/sim/prw.js). The
// per-bot BC tap fires on a different clock — one sample per arbiter decision
// — so this collector joins them: each observation takes the `pWin_true` of
// the most recent team row at or before its tick, on its own side. A sample
// with no team row yet (the first arbiter decisions of a round) is dropped
// rather than guessed at.
//
// Honesty, restated because this file is the one that writes truth to disk:
// `pWin_true` is god-view and is TRAINING-ONLY, exactly as 9.5's potentials
// are. It never reaches an actor at play time; the head that learns from it
// outputs a value, not a position, and the rows carry no coordinates because
// prw.js allowlists what a row may hold.
//
// Output is JSONL under the sim directory (12.1: never anywhere users see):
// line 1 is the meta record, every other line one sample.
//
// Usage:
//   node scripts/sim-collect-prw.mjs
//   node scripts/sim-collect-prw.mjs --map INF --matches 6 --rounds 12 --seed 40
//   node scripts/sim-collect-prw.mjs --out /tmp/value.jsonl
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { OBSERVE_VERSION, OBSERVATION_SIZE } from '../shared/sim/observe.js';
import { PRW_LOG_VERSION, residualStats } from '../shared/sim/prw.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const MATCHES = Number(flag('matches', 6));
const ROUNDS = Number(flag('rounds', 12));
const SEED = Number(flag('seed', 40));
const OUT = flag(
  'out',
  path.join(REPLAY_ROOT, 'sim', 'datasets', `value-${MAP.toLowerCase()}-s${SEED}x${MATCHES}.jsonl`)
);

async function load(kind, map) {
  return JSON.parse(await fs.readFile(path.join(REPLAY_ROOT, 'sim', kind, `${map}.json`), 'utf8'));
}

/** The last team row at or before `tick`. Rows arrive sorted by tick. */
function valueAt(rows, tick) {
  let at = null;
  for (const r of rows) {
    if (r.tick > tick) break;
    if (Number.isFinite(r.pWin_true)) at = r;
  }
  return at;
}

async function main() {
  const graph = navGraphFromBake(await load('navcache', MAP));
  const angles = loadAngles(await load('angles', MAP));

  const samples = [];
  // Per-round buffer of per-bot decisions, keyed by side: the team rows they
  // join against do not exist until roundEnd has graded them.
  let pending = { T: [], CT: [] };
  const tap = (s) => {
    if (pending[s.side]) pending[s.side].push(s);
  };

  const t0 = Date.now();
  let dropped = 0;
  for (let m = 0; m < MATCHES; m += 1) {
    playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: desireController({ angles, collect: tap }),
      controllerB: desireController({ angles, collect: tap }),
      seed: SEED + m,
      maxRounds: ROUNDS,
      onRound: (round) => {
        for (const team of ['A', 'B']) {
          const side = round.sides?.[team];
          const rows = (round.prw?.[team] || []).slice().sort((a, b) => a.tick - b.tick);
          if (!side || !rows.length) continue;
          for (const s of pending[side] || []) {
            const at = valueAt(rows, s.tick);
            if (!at) {
              dropped += 1;
              continue;
            }
            samples.push({
              obs: s.obs,
              label: s.label,
              side,
              map: s.map || MAP,
              contract: s.contract || null,
              tick: s.tick,
              situation: at.situation || null,
              pWin_true: at.pWin_true,
              pWin_belief: at.pWin_belief,
              residual: at.residual,
              won: round.outcome?.winner === side
            });
          }
        }
        pending = { T: [], CT: [] };
      }
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const meta = {
    type: 'meta',
    v: 1,
    kind: 'value',
    target: 'pWin_true',
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    prwVersion: PRW_LOG_VERSION,
    teacher: 'desire-4.3a',
    map: MAP,
    seed: SEED,
    matches: MATCHES,
    samples: samples.length
  };
  const lines = [JSON.stringify(meta)];
  for (const s of samples) {
    lines.push(
      JSON.stringify({
        obs: s.obs.map((x) => Number(x.toFixed(5))),
        label: s.label,
        side: s.side,
        map: s.map,
        contract: s.contract,
        tick: s.tick,
        situation: s.situation,
        pWin_true: Number(s.pWin_true.toFixed(5)),
        pWin_belief: Number(s.pWin_belief.toFixed(5)),
        residual: Number(s.residual.toFixed(5)),
        won: s.won ? 1 : 0
      })
    );
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${samples.length} samples from ${MATCHES} matches (${secs}s) -> ${OUT}`);
  if (dropped) console.log(`  ${dropped} decisions dropped: no team row yet at that tick`);
  const stats = residualStats(samples);
  console.log(
    `  residual mean ${stats.mean.toFixed(3)}  mae ${stats.mae.toFixed(3)}  ` +
      `overconfident ${stats.over}  underconfident ${stats.under}`
  );
  const mean = samples.reduce((a, s) => a + s.pWin_true, 0) / Math.max(1, samples.length);
  console.log(`  mean pWin_true ${mean.toFixed(3)} (the constant baseline the head must beat)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
