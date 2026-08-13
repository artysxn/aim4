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
import { loadBake } from './bakes.js';
import { navGraphFromBake } from '../../shared/sim/navGraph.js';
import { loadAngles } from '../../shared/sim/angles.js';
import { playScriptedMatch } from '../../shared/sim/scriptedMatch.js';
import { RULES_VERSION } from '../../shared/sim/constants.js';

const MATCHES_DIR = path.join(ROOT, 'sim', 'matches');

/** The one-at-a-time latch. */
let running = null;

const SKILLS = new Set(['mix', 't3', 'average', 't2', 't1', 'pro']);
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

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
  // Replays are the expensive part (~360 kB a round), so the sampling default
  // keeps a handful even when nobody asked, and never everything by accident.
  const recordEvery = Math.max(1, Math.min(100000, Number(params.recordEvery) || 1));

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
    const { match, rounds } = playScriptedMatch({
      graph,
      angles,
      map,
      seed,
      maxRounds,
      skillA,
      skillB,
      record: 'events',
      recordEvery,
      replays: true
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
      storedRounds += 1;
    }

    const summary = {
      id,
      map,
      seed,
      rulesVersion: RULES_VERSION,
      skillA,
      skillB,
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
    await fsp.writeFile(path.join(dir, 'match.json'), JSON.stringify(summary, null, 2));
    return { ok: true, match: summary };
  } catch (err) {
    return { error: err.message || 'match failed' };
  } finally {
    running = null;
  }
}

export function runStatus() {
  return running ? { running } : { running: null };
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
