#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-collect-rl.mjs
// Collect (obs, action, reward) trajectories from desire self-play.
//
// SIM-PLAN 9.4's rollout is the data path generations 1+ train on: the same
// desire-vs-desire pairing collect-bc uses, plus the 9.5 reward written next
// to each decision. The BC tap already emits {obs, label, side, map, tick};
// this file keeps that tap and prices each sample with potential-based
// ΔΦ_round (γΦ′ − Φ) between consecutive collect ticks for that side.
// Terminal R_win (±1) lands on the last sample of the round for that side
// and sets done=1, which is what discountedReturns / the numpy PPO trainer
// need to cut episodes. Sparse objective events (plant, defuse) ride along
// when the engine logged them in the window; a later generation can fill in
// damage, trades, and coach hits without changing the JSONL schema.
//
// SIM-PLAN 9.10's τ is recorded on the meta line, not mixed here. The trainer
// remixes if a sample ever carries both ownReward and teamReward; this spine
// writes the team scalar as `reward` and lets --tau stay a training knob.
//
// Actors never see Φ. featuresFromEngine is god-view and stays in this
// process. desireBot.js is not this file's to change.
//
// Output is JSONL under the sim directory (12.1):
//   line 1  {type:'meta', v:1, kind:'rl', obsVersion, obsSize, vocab, gamma, beta, tau}
//   then    {obs, label, reward, side, map, player, done}
//
// Usage:
//   node scripts/sim-collect-rl.mjs
//   node scripts/sim-collect-rl.mjs --map INF --matches 4 --rounds 8 --seed 40 --tau 0.3
//   node scripts/sim-collect-rl.mjs --out /tmp/rl.jsonl
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import { loadBake } from '../server/sim/bakes.js';
import { navGraphFromBake } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { playVersusMatch } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { OBSERVE_VERSION, OBSERVATION_SIZE } from '../shared/sim/observe.js';
import { OPTION_IDS } from '../shared/sim/options.js';
import {
  DEFAULT_BETA,
  GAMMA,
  potentialRound,
  shaped,
  stepReward,
  terminalReward
} from '../shared/sim/reward.js';

export function parseCollectArgs(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const map = String(flag('map', 'INF')).toUpperCase();
  const matches = Number(flag('matches', 6));
  const rounds = Number(flag('rounds', 12));
  const seed = Number(flag('seed', 40));
  const tau = Number(flag('tau', 0.3));
  const out = flag(
    'out',
    path.join(REPLAY_ROOT, 'sim', 'datasets', `rl-${map.toLowerCase()}-s${seed}x${matches}.jsonl`)
  );
  return { map, matches, rounds, seed, tau, out };
}

function objectiveFromEvents(events, side) {
  const out = [];
  for (const e of events) {
    if (e.type === 'bomb_planted' && side === 'T') out.push('plant');
    if (e.type === 'bomb_defused' && side === 'CT') out.push('defuse');
  }
  return out;
}

/** Capture the live engine so the collect tap can read god-view Φ. */
function withEngine(factory, box, onRoundStart) {
  return () => {
    const inner = factory();
    return {
      name: inner.name,
      log: inner.log,
      roundStart(ctx) {
        box.engine = ctx.engine;
        if (onRoundStart) onRoundStart(ctx.engine);
        inner.roundStart(ctx);
      },
      tick(ctx) {
        box.engine = ctx.engine;
        inner.tick(ctx);
      }
    };
  };
}

/**
 * Desire vs desire, one JSONL of RL samples.
 * @param {ReturnType<typeof parseCollectArgs>} opts
 */
export async function collectRl(opts) {
  const MAP = String(opts.map || 'INF').toUpperCase();
  const MATCHES = Number(opts.matches ?? 6);
  const ROUNDS = Number(opts.rounds ?? 12);
  const SEED = Number(opts.seed ?? 40);
  const TAU = Number.isFinite(Number(opts.tau)) ? Number(opts.tau) : 0.3;
  const OUT =
    opts.out ||
    path.join(REPLAY_ROOT, 'sim', 'datasets', `rl-${MAP.toLowerCase()}-s${SEED}x${MATCHES}.jsonl`);

  const nav = await loadBake('navcache', MAP);
  if (!nav) {
    console.error(`no nav bake for ${MAP}`);
    process.exit(1);
  }
  const ang = await loadBake('angles', MAP);
  if (!ang) {
    console.error(`no angle catalogue for ${MAP}`);
    process.exit(1);
  }
  const graph = navGraphFromBake(nav.bake);
  const angles = loadAngles(ang.bake);

  const samples = [];
  const box = { engine: null };

  const tap = (book) => {
    let atTick = -1;
    let atSide = null;
    let seat = 0;
    let batchReward = 0;
    return (s) => {
      if (s.tick !== atTick || s.side !== atSide) {
        atTick = s.tick;
        atSide = s.side;
        seat = 0;
        const engine = box.engine;
        if (!engine) {
          batchReward = 0;
        } else {
          const nextPhi = potentialRound(engine, s.side);
          const prev = book.prevPhi[s.side];
          const from = book.eventAt[s.side] || 0;
          const events = objectiveFromEvents(engine.state.events.slice(from), s.side);
          book.eventAt[s.side] = engine.state.events.length;
          const priced = stepReward({
            prevPhi: prev == null ? nextPhi : prev,
            nextPhi,
            side: s.side,
            events
          });
          book.prevPhi[s.side] = nextPhi;
          batchReward = priced.team;
        }
      }
      const row = {
        obs: s.obs,
        label: s.label,
        reward: batchReward,
        side: s.side,
        map: s.map,
        player: `${s.side}${seat}`,
        done: 0
      };
      samples.push(row);
      book.bySide[s.side].push(row);
      seat += 1;
    };
  };

  const t0 = Date.now();
  for (let m = 0; m < MATCHES; m += 1) {
    const book = {
      prevPhi: { T: null, CT: null },
      bySide: { T: [], CT: [] },
      eventAt: { T: 0, CT: 0 }
    };
    const resetBook = (engine) => {
      book.prevPhi.T = potentialRound(engine, 'T');
      book.prevPhi.CT = potentialRound(engine, 'CT');
      book.bySide = { T: [], CT: [] };
      book.eventAt = { T: engine.state.events.length, CT: engine.state.events.length };
    };
    const closeRound = (winner, engine) => {
      for (const side of ['T', 'CT']) {
        const list = book.bySide[side];
        if (!list.length) continue;
        const last = list[list.length - 1];
        if (engine && book.prevPhi[side] != null) {
          const endPhi = potentialRound(engine, side);
          last.reward += shaped(book.prevPhi[side], endPhi);
        }
        last.reward += terminalReward(winner, side);
        last.done = 1;
        for (const row of list) row.win = winner === side ? 1 : 0;
      }
    };

    playVersusMatch({
      graph,
      angles,
      map: MAP,
      controllerA: withEngine(desireController({ angles, collect: tap(book), searchEnabled: false }), box, resetBook),
      controllerB: withEngine(desireController({ angles, collect: tap(book), searchEnabled: false }), box, resetBook),
      seed: SEED + m,
      maxRounds: ROUNDS,
      onStep({ engine }) {
        box.engine = engine;
      },
      onRound(round) {
        closeRound(round.outcome.winner, box.engine);
        if (box.engine) {
          book.prevPhi = { T: null, CT: null };
          book.eventAt = { T: 0, CT: 0 };
        }
      }
    });
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const meta = {
    type: 'meta',
    v: 1,
    kind: 'rl',
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    vocab: OPTION_IDS,
    gamma: GAMMA,
    beta: [...DEFAULT_BETA],
    tau: TAU,
    teacher: 'desire-p3d',
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
        reward: Number(s.reward.toFixed(6)),
        side: s.side,
        map: s.map,
        player: s.player,
        done: s.done,
        win: s.win ?? 0
      })
    );
  }
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, lines.join('\n'));

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${samples.length} samples from ${MATCHES} matches (${secs}s) -> ${OUT}`);
}

function invokedAsMain() {
  const self = fileURLToPath(import.meta.url);
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.normalize(self) === path.normalize(path.resolve(argv1));
}

if (invokedAsMain()) {
  collectRl(parseCollectArgs(process.argv.slice(2))).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
