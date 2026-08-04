// ---------------------------------------------------------------------------
// server/training/config.js
// Where training keeps its state, and what a run is allowed to ask for.
//
// Everything lives on the replay volume rather than in the repo, for the same
// reason zonesStore does: a deploy replaces the container filesystem, and
// throwing away an extracted corpus (tens of minutes of work) or the reigning
// champion weights on every deploy would make the feature useless.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, for locating the trainer scripts. */
export const REPO_ROOT = path.join(__dirname, '../..');

const REPLAY_ROOT =
  process.env.AIM4_REPLAY_DIR || path.join(REPO_ROOT, 'server/data/replays');

/** Everything training owns, on the persistent volume. */
export const TRAINING_ROOT = process.env.AIM4_TRAINING_DIR || path.join(REPLAY_ROOT, 'training');
/** Fitted weights, read by the public runtime-params endpoint. */
export const MODELS_ROOT = process.env.AIM4_MODELS_DIR || path.join(REPLAY_ROOT, 'models');

/** The two models that can be trained. */
export const MODEL_KINDS = ['duel', 'round'];

export function isModelKind(kind) {
  return MODEL_KINDS.includes(kind);
}

/**
 * Worker threads a training run may use.
 *
 * Deliberately low by default. The trainer will happily saturate every core,
 * and it shares the box with the API server; a training run that makes the site
 * unresponsive is not a feature anyone wants switched on.
 */
export const DEFAULT_WORKERS = Number(process.env.AIM4_TRAIN_WORKERS || 4);

/** Heap for the child, matching the npm scripts' --max-old-space-size. */
export const WORKER_HEAP_MB = Number(process.env.AIM4_TRAIN_HEAP_MB || 8192);

/**
 * Bounds on what an admin can request. Generous, but a typo in the admin form
 * should not be able to queue a month of compute.
 */
export const MAX_GENERATIONS = 500;
export const DEFAULT_GENERATIONS = 30;

export function paths(kind) {
  const dir = path.join(TRAINING_ROOT, kind);
  return {
    dir,
    status: path.join(dir, 'status.json'),
    lock: path.join(dir, 'run.pid'),
    log: path.join(dir, 'run.log'),
    champion: path.join(MODELS_ROOT, `${kind}.json`)
  };
}

/** The child entry point for a training run. */
export const TRAINER_CLI = path.join(REPO_ROOT, 'scripts/train-model-server.mjs');
