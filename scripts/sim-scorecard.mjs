#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-scorecard.mjs
// Grade a candidate against the pro population and the frozen references
// (SIM-PLAN 9.17, 9.18). Four verdicts, never merged.
//
//   node scripts/sim-scorecard.mjs
//   node scripts/sim-scorecard.mjs --metrics '{"macro":0.6,...}'
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';
import {
  AXES,
  FROZEN_REFS,
  scorecard,
  correctionTerm,
  fourVerdicts
} from '../shared/sim/scorecard.js';
import { contractGate } from '../shared/sim/contracts.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

function parseMetrics(raw) {
  if (!raw) {
    return Object.fromEntries(AXES.map((a) => [a, 0.5]));
  }
  return { ...Object.fromEntries(AXES.map((a) => [a, 0.5])), ...JSON.parse(raw) };
}

async function loadBaselines() {
  const p = path.join(REPLAY_ROOT, 'sim', 'baselines', 'index.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return { library: 'not available', axes: {}, frozen: {} };
  }
}

async function main() {
  const baselines = await loadBaselines();
  const metrics = parseMetrics(flag('metrics', null));
  const team = scorecard(metrics, baselines.axes);
  const perBot = { role: 'team', ...team };
  const bc0 = scorecard(baselines.frozen?.bc0 || metrics, baselines.axes);
  const correction = correctionTerm(team, bc0);
  team.correction = correction.stated;

  const compliance = Number(flag('compliance', '1'));
  const eloDelta = Number(flag('elo', '0'));
  const exploitability = Number(flag('exploit', '0.5'));
  const examRegret = Number(flag('regret', '0'));
  const contract = contractGate({ compliance, elo: 1000 + eloDelta });

  const verdicts = fourVerdicts({
    eloDelta,
    card: team,
    honesty: {
      belief: flag('belief', '1') !== '0',
      aim: flag('aim', '1') !== '0',
      ks: flag('ks', '1') !== '0',
      determinism: flag('determinism', '1') !== '0'
    },
    exploitability,
    examRegret,
    contractPass: contract.pass,
    tierCentroids: baselines.tiers || null
  });

  const report = {
    team,
    perBot,
    correction: correction.stated,
    library: team.library,
    frozen: FROZEN_REFS,
    contract,
    verdicts
  };
  console.log(JSON.stringify(report, null, 2));
  if (team.library === 'not available') {
    console.log('library baselines: not available; scored against frozen references');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
