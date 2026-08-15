#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/sim-synth-tape.mjs
// Tape-following and knife-out fidelity on a machine with NO v2 corpus.
//
//   node scripts/sim-synth-tape.mjs [--map INF] [--rounds 4] [--seed 11]
//                                   [--json]
//
// `npm run sim:tape` measures the REAL corpus and is the number that counts.
// But the 9.8 GB v2 mine lives on one machine, and on any other the shipped
// v1 tapes carry no coordinates at all — follow reads 0.0% by construction,
// so the harness cannot tell a regression from a missing file.
//
// This builds a SYNTHETIC v2 playbook instead: real routes mined from the nav
// graph itself (spawn -> site, resampled at a pro's pace, tail-padded to a
// realistic hold), handed to the same caller/desireBot/translator stack. The
// absolute numbers are not the corpus's numbers. What it gives is a fast,
// portable, deterministic A/B: change the follow machinery, run this, see the
// direction move. It caught the committed-path stomp (pre-contact knife
// 0.1% -> 16.7%) that the real harness could not see on this machine.
//
// Per live tick it separates what the layers each did:
//   intent.knife   the bot asked (desireBot -> translator)
//   body.knifeOut  the engine granted
//   moveTo         the bot is being steered at all
// split at first contact, plus the controller's own tapeStats().
//
// NOTE: a probe like this lived in a session scratchpad twice and was lost
// twice on a workstation switch. It lives in the repo now.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { playVersusMatch, scriptedController } from '../shared/sim/versusMatch.js';
import { desireController } from '../shared/sim/desireBot.js';
import { navGraphFromBake, findPath } from '../shared/sim/navGraph.js';
import { loadAngles } from '../shared/sim/angles.js';
import { indexPlaybook } from '../shared/sim/playbook.js';
import { PHASE } from '../shared/sim/engine.js';
import { ROOT as REPLAY_ROOT } from '../server/replays/demoStore.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const MAP = String(flag('map', 'INF')).toUpperCase();
const ROUNDS = Number(flag('rounds', 4));
const SEED = Number(flag('seed', 11));
const AS_JSON = args.includes('--json');

const load = async (kind) =>
  JSON.parse(await readFile(path.join(REPLAY_ROOT, 'sim', kind, `${MAP}.json`), 'utf8'));

let graph = null;
let angles = null;
try {
  graph = navGraphFromBake(await load('navcache'));
  angles = loadAngles(await load('angles'));
} catch {
  console.log(`sim-synth-tape: skipped (no bake for ${MAP})`);
  process.exit(0);
}

// ---- the synthetic v2 tape -------------------------------------------------

const PATH_HZ = 8;
/** A pro's travel pace: knife-out running, which is the point of the test. */
const SPEED = 230;
/** Tapes end in a HOLD, not at the site door — the real corpus medians ~71 s. */
const PAD_SECONDS = 80;

const near = (origin, n) =>
  [...graph.anchors.values()]
    .map((a) => ({ id: a.id, d: Math.hypot(a.world.x - origin.x, a.world.y - origin.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((a) => a.id);

const tSpawn = graph.spawns.find((s) => s.side === 'T') || { x: 0, y: 0 };
const ctSpawn = graph.spawns.find((s) => s.side === 'CT') || { x: 0, y: 0 };
const tIds = near(tSpawn, 5);
const ctIds = near(ctSpawn, 5);
const siteIds = [...graph.anchors.keys()].filter((id) => /site$/.test(id));
const goalId = siteIds[0] || [...graph.anchors.keys()][20];
const goal = graph.anchor(goalId);

/** A real route to the site, resampled to a flat [x,y,yaw] path at PATH_HZ. */
function pathFor(startId) {
  const a = graph.anchor(startId);
  const from = graph.nearestWalkable(a.world.x, a.world.y, 16, a.level);
  const to = graph.nearestWalkable(goal.world.x, goal.world.y, 16, goal.level);
  const p = findPath(graph, from, to, { maxExpansions: 100000 });
  if (!p) throw new Error(`no path ${startId} -> ${goalId}`);
  const pts = p.cells.map((c) => graph.worldAt(c.cx, c.cy));
  const step = SPEED / PATH_HZ;
  const flat = [];
  let carry = 0;
  let yaw = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const { x: ax, y: ay } = pts[i - 1];
    const { x: bx, y: by } = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg < 1e-6) continue;
    yaw = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    let t = carry;
    while (t < seg) {
      const w = t / seg;
      flat.push(ax + (bx - ax) * w, ay + (by - ay) * w, yaw);
      t += step;
    }
    carry = t - seg;
  }
  flat.push(pts[pts.length - 1].x, pts[pts.length - 1].y, yaw);
  const lx = flat[flat.length - 3];
  const ly = flat[flat.length - 2];
  const lyaw = flat[flat.length - 1];
  while (flat.length / 3 < PAD_SECONDS * PATH_HZ) flat.push(lx, ly, lyaw);
  return flat;
}

const rolesOf = (ids, side) =>
  ids.map((id, i) => {
    const flat = side === 'T' ? pathFor(id) : null;
    const secs = flat ? Math.floor(flat.length / 3 / PATH_HZ) : 8;
    return {
      contract: id,
      steamId: `${side}${i}`,
      awp: i === 3,
      waypoints: [
        [0, id],
        [Math.max(8, secs), side === 'T' ? goalId : id]
      ],
      utility: [],
      ...(flat ? { path: flat, pathHz: PATH_HZ } : {})
    };
  });

const tRoles = rolesOf(tIds, 'T');
const ctRoles = rolesOf(ctIds, 'CT');
// Both econ partitions: playbook.js hard-splits pistol rounds from gun rounds,
// so a one-econ fixture leaves every pistol round with no tape to match and
// reads as a follow failure that is really a fixture hole.
const playbook = indexPlaybook(
  [0, 4].flatMap((econ) => [
    {
      id: `synth-t-e${econ}`,
      map: MAP,
      side: 'T',
      call: 'default',
      econ,
      plant: { site: goalId, t: 40 },
      firstContact: { t: 12, rel: 'front' },
      roles: tRoles
    },
    {
      id: `synth-ct-e${econ}`,
      map: MAP,
      side: 'CT',
      call: 'default',
      econ,
      plant: null,
      firstContact: { t: 10, rel: 'front' },
      roles: ctRoles
    }
  ])
);

// ---- play, measuring every live tick ---------------------------------------

const stats = {
  liveTicks: 0,
  preTicks: 0,
  bodyLive: 0,
  bodyPre: 0,
  knifeIntentPre: 0,
  knifeOutPre: 0,
  knifeOutLive: 0,
  moveToPre: 0
};
let contact = false;
let lastPhase = null;
let ctrl = null;

const factory = desireController({ angles, playbook });
const result = playVersusMatch({
  graph,
  angles,
  map: MAP,
  controllerA: () => {
    ctrl = factory();
    return ctrl;
  },
  controllerB: scriptedController,
  seed: SEED,
  maxRounds: ROUNDS,
  record: 'none',
  onStep: ({ engine }) => {
    const st = engine.state;
    if (st.phase !== PHASE.LIVE) {
      lastPhase = st.phase;
      return;
    }
    // A fresh live phase is a fresh round: contact is sticky WITHIN a round
    // only, exactly like desireBot's own R.contactMade.
    if (lastPhase !== PHASE.LIVE) contact = false;
    lastPhase = PHASE.LIVE;
    contact =
      contact ||
      st.bodies.some(
        (b) => !b.alive || (b.side === 'T' && b.slot <= 4 && b.alive && b.focus !== null)
      );
    stats.liveTicks += 1;
    if (!contact) stats.preTicks += 1;
    for (const b of st.bodies) {
      // Side A holds slots 0-4 and starts T; only its bodies run the brain
      // under test.
      if (!b.alive || b.side !== 'T' || b.slot > 4) continue;
      stats.bodyLive += 1;
      if (b.knifeOut) stats.knifeOutLive += 1;
      if (contact) continue;
      stats.bodyPre += 1;
      if (b.intent.knife) stats.knifeIntentPre += 1;
      if (b.knifeOut) stats.knifeOutPre += 1;
      if (b.intent.moveTo) stats.moveToPre += 1;
    }
  }
});

const tape = ctrl?.tapeStats?.() || null;
if (AS_JSON) {
  console.log(JSON.stringify({ map: MAP, seed: SEED, rounds: ROUNDS, stats, tape }, null, 2));
} else {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  console.log(`${MAP}  ${ROUNDS} rounds, seed ${SEED}  (score A-B ${result.winsA}-${result.winsB})`);
  if (tape) {
    console.log(
      `  follow ${(tape.follow * 100).toFixed(1)}%  ` +
        `error ${tape.errorUnits === null ? 'n/a' : `${tape.errorUnits.toFixed(0)}u`}  ` +
        `(pre ${tape.preContact.n} at ${tape.preContact.errorUnits?.toFixed(0) ?? '-'}u, ` +
        `post ${tape.postContact.n} at ${tape.postContact.errorUnits?.toFixed(0) ?? '-'}u)`
    );
    const fmt = (o) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' | ') || 'none';
    console.log(`  off-tape pre:  ${fmt(tape.offReasonsPre)}`);
    console.log(`  off-tape post: ${fmt(tape.offReasonsPost)}`);
  }
  console.log(`  pre-contact ticks ${pct(stats.preTicks, stats.liveTicks)} of live`);
  console.log(`  pre-contact intent.knife ${pct(stats.knifeIntentPre, stats.bodyPre)}`);
  console.log(`  pre-contact knifeOut     ${pct(stats.knifeOutPre, stats.bodyPre)}   (matches = engine grants every ask)`);
  console.log(`  pre-contact moveTo       ${pct(stats.moveToPre, stats.bodyPre)}`);
  console.log(`  all-live knifeOut        ${pct(stats.knifeOutLive, stats.bodyLive)}`);
}
