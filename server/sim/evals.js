// ---------------------------------------------------------------------------
// server/sim/evals.js
// Admission reports (7.0), listed for the generation browser (6.4).
//
// One directory per run under `sim/evals/<evalId>/`, written by
// scripts/sim-admit.mjs. Read-only here: the browser shows what the pipeline
// decided and never decides anything itself.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ROOT } from '../replays/demoStore.js';

const EVALS_DIR = path.join(ROOT, 'sim', 'evals');
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '');

/**
 * Every admission report, newest first.
 *
 * Trimmed to what a listing needs. The full report, including every gate's
 * reason, is one `readEval` away; sending all of it for a list of thirty runs
 * would be most of a megabyte for a table.
 */
export async function listEvals(limit = 50) {
  let dirs;
  try {
    dirs = await fsp.readdir(EVALS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    try {
      const r = JSON.parse(await fsp.readFile(path.join(EVALS_DIR, d, 'report.json'), 'utf8'));
      out.push({
        evalId: r.evalId || d,
        model: r.model,
        parent: r.parent,
        verdict: r.verdict,
        reason: r.reason,
        maps: r.maps,
        games: r.games,
        elo: r.elo ? { elo: r.elo.elo, lo: r.elo.lo, hi: r.elo.hi } : null,
        // Enough to colour a row without the full gate list.
        failed: r.failed ? r.failed.id : null,
        skipped: r.skipped || [],
        createdAt: r.createdAt,
        elapsedSeconds: r.elapsedSeconds
      });
    } catch {
      /* a run killed mid-write leaves a directory with no report */
    }
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, Math.max(1, Math.min(200, limit)));
}

/** One report in full, gates and all. */
export async function readEval(evalId) {
  try {
    return JSON.parse(
      await fsp.readFile(path.join(EVALS_DIR, safe(evalId), 'report.json'), 'utf8')
    );
  } catch {
    return null;
  }
}
