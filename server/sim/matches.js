// ---------------------------------------------------------------------------
// server/sim/matches.js
// Run a scripted match on the server, store what it produced, serve it back.
//
// Storage is `AIM4_REPLAY_DIR/sim/matches/<id>/`, which keeps sim output under
// the one directory the plan already isolates from everything users can see
// (12.1): nothing here ever lands in the shared library, Demo Manager, or a
// share link. A match is a directory so it is resumable, listable, and
// deletable as a unit:
//
//   match.json            summary: config, score, per-round outcomes
//   round<N>.ticks        tick buffer, parser format, ONLY for sampled rounds
//   round<N>.meta.json    round meta for the viewer, same sampling
//
// One match at a time (14.29's rule): the engine is fast but the API process
// shares its core with everything else the box does, and two concurrent
// matches is the first step toward the training run that starves the parser.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from '../replays/demoStore.js';
import { loadBake, loadPlaybook, loadKnowledgeBake } from './bakes.js';
import { BUILTIN_BRAINS, loadModel } from './models.js';
import { navGraphFromBake } from '../../shared/sim/navGraph.js';
import { loadAngles } from '../../shared/sim/angles.js';
import { playScriptedMatch } from '../../shared/sim/scriptedMatch.js';
import { playVersusMatch, scriptedController } from '../../shared/sim/versusMatch.js';
import { MAX_BRANCH_CALLS, playBranchSet } from '../../shared/sim/branch.js';
import { createOrderQueue } from '../../shared/sim/orders.js';
import { desireController } from '../../shared/sim/desireBot.js';
import { RULES_VERSION } from '../../shared/sim/constants.js';
import { markHumanCalled, markSynthetic } from '../../shared/sim/firewall.js';

const MATCHES_DIR = path.join(ROOT, 'sim', 'matches');

/** The one-at-a-time latch. */
let running = null;

const SKILLS = new Set(['mix', 't3', 'average', 't2', 't1', 'pro']);
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

/**
 * Which brain a side asked for. Anything that is not built in has to be a
 * registered model (models.js), so the set of legal answers is whatever this
 * host actually holds rather than a list compiled into the server: training a
 * gen1 and dropping it in the model directory makes it playable immediately.
 */
function brainName(raw) {
  const name = safe(raw);
  // The harness's old name (operator rename): old records, old habits.
  if (name === 'desire') return 'nomad-1';
  return name || 'scripted';
}

/**
 * Run one match. Clamped server-side: budgets typed into a browser are a
 * suggestion, and the job runner rules (SIM-PLAN 9.2b) say the server owns
 * the ceiling.
 */
export async function runMatch(params = {}) {
  if (running) {
    return { error: 'busy', running };
  }

  const map = safe(params.map || 'INF').toUpperCase();
  const seed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : 1;
  const maxRounds = Math.max(1, Math.min(60, Number(params.rounds) || 24));
  const skillA = SKILLS.has(params.skillA) ? params.skillA : 'average';
  const skillB = SKILLS.has(params.skillB) ? params.skillB : 'average';
  const brainA = brainName(params.brainA);
  const brainB = brainName(params.brainB);
  // The hivemind half of a generation (9.25). Separate names from the bot
  // brains because they are separate files with separate trainers: a
  // generation is a PAIR, and either half can be swapped to ask what the other
  // is worth.
  const callerA = params.callerA ? safe(params.callerA) : null;
  const callerB = params.callerB ? safe(params.callerB) : null;
  // Replays are the expensive part (~360 kB a round), so the sampling default
  // keeps a handful even when nobody asked, and never everything by accident.
  const recordEvery = Math.max(1, Math.min(100000, Number(params.recordEvery) || 1));
  // Only the in-process caller (the job's CLI wrapper) can pass this; it is
  // how a match started from the panel reports rounds as they land instead of
  // going quiet for its whole duration.
  const onRound = typeof params.onRound === 'function' ? params.onRound : null;
  // 6.1: orders a viewer wants issued, as [{call, side, slots, tick}]. Shared
  // by both controllers because the queue routes by side; a round that gets
  // one is quarantined from every learning path (11.5).
  const orderQueue = Array.isArray(params.orders) && params.orders.length
    ? createOrderQueue(params.orders)
    : null;

  const nav = await loadBake('navcache', map);
  if (!nav) return { error: `no nav bake for ${map}` };
  const anglesBake = await loadBake('angles', map);
  if (!anglesBake) return { error: `no angle catalogue for ${map}` };

  const id = `${map}-${Date.now().toString(36)}-${seed}`;
  running = { id, map, startedAt: Date.now() };

  try {
    const graph = navGraphFromBake(nav.bake);
    const angles = loadAngles(anglesBake.bake);

    const t0 = Date.now();
    // Both brains scripted keeps the original single-loop path (and its exact
    // replay bytes); any other pairing runs through the controller seam.
    const versus = brainA !== 'scripted' || brainB !== 'scripted' || Boolean(callerA || callerB);
    const models = {};
    const modelMeta = {};
    for (const name of [brainA, brainB]) {
      if (BUILTIN_BRAINS.includes(name) || models[name]) continue;
      const loaded = await loadModel(name);
      if (loaded.error) return { error: loaded.error };
      models[name] = loaded.policy;
      modelMeta[name] = loaded.meta;
    }
    // A bot brain and a caller are not interchangeable, and the failure if you
    // swap them is a confusing one deep in the engine rather than a refusal
    // here. Check at the seam instead.
    for (const name of [brainA, brainB]) {
      if (modelMeta[name]?.kind === 'caller') {
        return { error: `${name} is a caller, not a bot brain; pass it as callerA/callerB` };
      }
    }
    const callers = {};
    for (const name of [callerA, callerB]) {
      if (!name || callers[name]) continue;
      const loaded = await loadModel(name);
      if (loaded.error) return { error: loaded.error };
      if (loaded.meta?.kind !== 'caller') {
        return { error: `${name} is not a caller model; pass it as brainA/brainB` };
      }
      // A Cache caller on Mirage would price calls it has never seen against a
      // picture it cannot read. Refuse rather than return numbers. A cross-map
      // head declares its coverage in `maps` and its `map` field says ALL, so
      // the check is containment, not equality.
      const covered = loaded.meta.maps
        ? loaded.meta.maps.includes(map)
        : !loaded.meta.map || loaded.meta.map === map;
      if (!covered) {
        const has = loaded.meta.maps ? loaded.meta.maps.join(', ') : loaded.meta.map;
        return { error: `caller ${name} covers ${has}, not ${map}` };
      }
      callers[name] = loaded.policy;
      modelMeta[name] = loaded.meta;
    }

    // The Nomad's knobs ride in a model file but the brain is builtin: a
    // missing file means default knobs, never a refusal to play.
    for (const name of [brainA, brainB]) {
      if (name !== 'nomad-1' || models[name]) continue;
      const loaded = await loadModel('nomad-1');
      if (!loaded.error && loaded.meta?.kind === 'nomad') {
        models[name] = loaded.policy;
        modelMeta[name] = loaded.meta;
      }
    }

    const playbook = (await loadPlaybook(map))?.index || null;
    const knowledge = (await loadKnowledgeBake(map))?.knowledge || null;
    const brainFactory = (name, callerName) => {
      const callerNet = callerName ? callers[callerName] || null : null;
      if (name === 'scripted') return scriptedController;
      if (name === 'nomad-1') {
        // The test harness: the bare arbiter plus whatever the knobs file
        // turns on. Editing simdata/models/nomad-1.json IS the experiment —
        // no retrain, no rebuild, one aspect at a time.
        return desireController({
          angles,
          playbook,
          knowledge,
          callerNet,
          orders: orderQueue,
          ...(models[name] || {})
        });
      }
      return desireController({
        angles,
        policy: models[name],
        playbook,
        knowledge,
        callerNet,
        orders: orderQueue
      });
    };
    const { match, rounds } = versus
      ? playVersusMatch({
          graph,
          angles,
          map,
          controllerA: brainFactory(brainA, callerA),
          controllerB: brainFactory(brainB, callerB),
          seed,
          maxRounds,
          skillA,
          skillB,
          record: 'events',
          recordEvery,
          replays: true,
          onRound
        })
      : playScriptedMatch({
          graph,
          angles,
          map,
          seed,
          maxRounds,
          skillA,
          skillB,
          record: 'events',
          recordEvery,
          replays: true,
          onRound
        });

    const dir = path.join(MATCHES_DIR, id);
    await fsp.mkdir(dir, { recursive: true });

    let storedRounds = 0;
    for (const r of rounds) {
      if (!r.ticks) continue;
      await fsp.writeFile(path.join(dir, `round${r.round}.ticks`), r.ticks);
      await fsp.writeFile(
        path.join(dir, `round${r.round}.meta.json`),
        JSON.stringify(r.meta)
      );
      const logs = r.brainLogs;
      if (logs && (logs.A?.length || logs.B?.length)) {
        // The motive log is the inspector's soul (6.17): what each side wanted
        // and why, in English, tick by tick. Stored beside the replay so the
        // viewer can scrub both together.
        await fsp.writeFile(
          path.join(dir, `round${r.round}.motives.json`),
          JSON.stringify(markSynthetic({ A: logs.A || [], B: logs.B || [] }))
        );
      }
      // The two PRWs (18.6b): believed and true on the same clock, graded at
      // roundEnd. The inspector draws them under the motive feed, which is
      // the "why" a human can read.
      if (r.prw && (r.prw.A?.length || r.prw.B?.length)) {
        await fsp.writeFile(
          path.join(dir, `round${r.round}.prw.json`),
          // Rounded on the way to disk only: sixteen digits of a particle
          // filter's expected body count is noise, and it is two thirds of
          // the file. The in-memory rows the trainer reads keep full
          // precision, so nothing that grades or calibrates sees this.
          JSON.stringify(markSynthetic({ A: r.prw.A || [], B: r.prw.B || [] }), (k, v) =>
            typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(5)) : v
          )
        );
      }
      // The caller's rows (9.25 stage 3). A handful per round-side against
      // the PRW log's couple of hundred, so this is stored whole: it is the
      // dataset the hivemind trains on and the "what did it decide, and was
      // it right" the scorecard reads.
      if (r.igl && (r.igl.A?.length || r.igl.B?.length)) {
        await fsp.writeFile(
          path.join(dir, `round${r.round}.igl.json`),
          JSON.stringify(markSynthetic({ A: r.igl.A || [], B: r.igl.B || [] }))
        );
      }
      // 6.1: the orders this round was given and what the bots did about them.
      // Stamped human-called on the way to disk, so the file answers the
      // question every learning reader asks without re-deriving it.
      if (r.orders && (r.orders.A || r.orders.B)) {
        await fsp.writeFile(
          path.join(dir, `round${r.round}.orders.json`),
          JSON.stringify(
            markHumanCalled(markSynthetic({ A: r.orders.A || null, B: r.orders.B || null }))
          )
        );
      }
      storedRounds += 1;
    }

    const summary = {
      id,
      map,
      seed,
      rulesVersion: RULES_VERSION,
      skillA,
      skillB,
      brainA,
      brainB,
      callerA,
      callerB,
      // Which weights actually played, so a result stays attributable after
      // the model directory has moved on (9.9).
      models: Object.fromEntries(
        Object.entries(modelMeta).map(([name, meta]) => [
          name,
          { source: meta.source, valAccuracy: meta.valAccuracy, trainedAt: meta.trainedAt }
        ])
      ),
      recordEvery,
      bakeSource: nav.source,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      score: match.state.score,
      winner: match.state.winner || null,
      storedRounds,
      rounds: rounds.map((r) => ({
        round: r.round,
        pistol: r.pistol,
        winner: r.outcome.winner,
        reason: r.outcome.reason,
        kills: r.kills,
        recorded: Boolean(r.ticks),
        score: r.score
      }))
    };
    // The firewall marker (12.1) on the match record too, not only on the
    // rounds: a listing or an API response is then self-describing without
    // anyone having to open a round file to find out what they are holding.
    const record = markSynthetic(summary);
    await fsp.writeFile(path.join(dir, 'match.json'), JSON.stringify(record, null, 2));
    return { ok: true, match: record };
  } catch (err) {
    return { error: err.message || 'match failed' };
  } finally {
    running = null;
  }
}

export function runStatus() {
  return running ? { running } : { running: null };
}

/**
 * 6.0: run a branch set and store it as a match.
 *
 * Stored as a match on purpose: a branch is a watchable round, and the viewer,
 * the round switcher, and the motive files already know how to show one. Round
 * N of a branch match is call N of the set, and `match.json` says which call
 * each round is, so nothing downstream needs a second reader.
 *
 * @param {object} params  map, seed, calls (array or csv), side, brain,
 *                         caller, brainOpp, skillA, skillB, money
 */
export async function runBranches(params = {}) {
  if (running) {
    return { error: 'busy', running };
  }

  const map = safe(params.map || 'INF').toUpperCase();
  const seed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : 1;
  const side = params.side === 'CT' ? 'CT' : 'T';
  const money = Math.max(800, Math.min(16000, Number(params.money) || 16000));
  const skillA = SKILLS.has(params.skillA) ? params.skillA : 'average';
  const skillB = SKILLS.has(params.skillB) ? params.skillB : 'average';
  const brain = brainName(params.brain || params.brainA);
  const brainOpp = brainName(params.brainOpp || params.brainB || brain);
  const callerName = params.caller || params.callerA ? safe(params.caller || params.callerA) : null;
  // null is the control branch: the side left to choose for itself. The csv
  // spelling for it is the word none.
  const calls = (Array.isArray(params.calls) ? params.calls : String(params.calls || '').split(','))
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .map((c) => (c === 'none' ? null : safe(c)));
  if (!calls.length) return { error: 'branch: no calls' };
  if (calls.length > MAX_BRANCH_CALLS) return { error: `branch: at most ${MAX_BRANCH_CALLS} calls` };

  const nav = await loadBake('navcache', map);
  if (!nav) return { error: `no nav bake for ${map}` };
  const anglesBake = await loadBake('angles', map);
  if (!anglesBake) return { error: `no angle catalogue for ${map}` };

  const id = `BR-${map}-${Date.now().toString(36)}-${seed}`;
  running = { id, map, startedAt: Date.now() };

  try {
    const graph = navGraphFromBake(nav.bake);
    const angles = loadAngles(anglesBake.bake);
    const t0 = Date.now();

    const models = {};
    const modelMeta = {};
    for (const name of [brain, brainOpp]) {
      if (BUILTIN_BRAINS.includes(name) || models[name]) continue;
      const loaded = await loadModel(name);
      if (loaded.error) return { error: loaded.error };
      if (loaded.meta?.kind === 'caller') {
        return { error: `${name} is a caller, not a bot brain; pass it as caller` };
      }
      models[name] = loaded.policy;
      modelMeta[name] = loaded.meta;
    }
    let callerNet = null;
    if (callerName) {
      const loaded = await loadModel(callerName);
      if (loaded.error) return { error: loaded.error };
      if (loaded.meta?.kind !== 'caller') {
        return { error: `${callerName} is not a caller model` };
      }
      const covered = loaded.meta.maps
        ? loaded.meta.maps.includes(map)
        : !loaded.meta.map || loaded.meta.map === map;
      if (!covered) {
        const has = loaded.meta.maps ? loaded.meta.maps.join(', ') : loaded.meta.map;
        return { error: `caller ${callerName} covers ${has}, not ${map}` };
      }
      callerNet = loaded.policy;
      modelMeta[callerName] = loaded.meta;
    }

    const playbook = (await loadPlaybook(map))?.index || null;
    const knowledge = (await loadKnowledgeBake(map))?.knowledge || null;
    // desireController(opts) returns a per-match factory; the branch runner
    // wants one live controller per branch, so the factory is invoked here.
    const mkDesire = (name, forceCall) =>
      name === 'scripted'
        ? scriptedController()
        : desireController({
            angles,
            policy: models[name] || null,
            playbook,
            knowledge,
            callerNet,
            ...(forceCall !== undefined
              ? { forceCallOf: () => forceCall }
              : {})
          })();

    const { branches, savestate, setup } = playBranchSet({
      graph,
      angles,
      map,
      calls,
      side,
      seed,
      money,
      skillA,
      skillB,
      controllerFor: ({ forceCall }) => mkDesire(brain, forceCall),
      opponentFor: () => mkDesire(brainOpp, undefined)
    });

    const dir = path.join(MATCHES_DIR, id);
    await fsp.mkdir(dir, { recursive: true });
    let stored = 0;
    for (let i = 0; i < branches.length; i += 1) {
      const b = branches[i];
      const round = i + 1;
      await fsp.writeFile(path.join(dir, `round${round}.ticks`), b.ticks);
      await fsp.writeFile(path.join(dir, `round${round}.meta.json`), JSON.stringify(b.meta));
      const logs = b.brainLogs;
      if (logs && (logs.A?.length || logs.B?.length)) {
        await fsp.writeFile(
          path.join(dir, `round${round}.motives.json`),
          JSON.stringify(markSynthetic({ A: logs.A || [], B: logs.B || [] }))
        );
      }
      stored += 1;
    }
    // The frozen world every branch decided from. 6.1 restores this; until
    // then it documents that the branches truly shared a prelude.
    await fsp.writeFile(path.join(dir, 'savestate.json'), savestate);

    const record = markSynthetic({
      id,
      kind: 'branch',
      map,
      seed,
      rulesVersion: RULES_VERSION,
      side,
      money,
      skillA,
      skillB,
      brainA: brain,
      brainB: brainOpp,
      callerA: callerName,
      callerB: null,
      models: Object.fromEntries(
        Object.entries(modelMeta).map(([name, meta]) => [
          name,
          { source: meta.source, valAccuracy: meta.valAccuracy, trainedAt: meta.trainedAt }
        ])
      ),
      bakeSource: nav.source,
      createdAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      // A branch set has no score. The per-round rows carry each call and its
      // outcome, which is the comparison the set exists to draw.
      score: null,
      winner: null,
      storedRounds: stored,
      setup,
      rounds: branches.map((b, i) => ({
        round: i + 1,
        call: b.call ?? 'own choice',
        pistol: false,
        winner: b.outcome.winner,
        reason: b.outcome.reason,
        kills: b.kills,
        recorded: true,
        score: null
      }))
    });
    await fsp.writeFile(path.join(dir, 'match.json'), JSON.stringify(record, null, 2));
    return { ok: true, match: record };
  } catch (err) {
    return { error: err.message || 'branch failed' };
  } finally {
    running = null;
  }
}

export async function listMatches() {
  let dirs;
  try {
    dirs = await fsp.readdir(MATCHES_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    try {
      const summary = JSON.parse(
        await fsp.readFile(path.join(MATCHES_DIR, d, 'match.json'), 'utf8')
      );
      out.push(summary);
    } catch {
      /* an interrupted run leaves a directory without a summary; skip it */
    }
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

/** A stored round's tick buffer, or null. */
export async function readRoundTicks(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.ticks`);
  try {
    return await fsp.readFile(p);
  } catch {
    return null;
  }
}

export async function readRoundMeta(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.meta.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** A stored round's decision log ({A, B} motive arrays), or null. */
export async function readRoundMotives(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.motives.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** A stored round's two PRW curves ({A, B} graded row arrays), or null. */
export async function readRoundPrw(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.prw.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** A stored round's IGL rows ({A, B} sealed caller decisions), or null. */
export async function readRoundOrders(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.orders.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

export async function readRoundIgl(matchId, round) {
  const p = path.join(MATCHES_DIR, safe(matchId), `round${Number(round) || 0}.igl.json`);
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}
