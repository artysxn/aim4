// ---------------------------------------------------------------------------
// server/training/champion.js
// The reigning weights for a model, and the rule for replacing them.
//
// Training is one run per press, each on its own seed. A run is only worth
// keeping if it beats what is already deployed, so promotion is a comparison
// rather than an assignment: the champion changes only when a challenger has a
// lower held-out loss, and every attempt is recorded either way. That is what
// makes "total improvement" a real number and what stops a bad seed from
// quietly regressing the live model.
//
// Held-out loss is the only criterion. Not training loss, which always falls,
// and not the exam score, which is linear in confidence and rewards
// overclaiming; that argument is settled in duels/scoring.js.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { paths } from './config.js';

/** Attempts kept per model. Enough to see a trend, bounded so the file stays small. */
const HISTORY_MAX = 60;

/**
 * @typedef {object} Champion
 * @property {string} kind
 * @property {string} specHash    parameter layout the values belong to
 * @property {object} values      name -> weight
 * @property {number} validLoss   held-out log loss, the promotion criterion
 * @property {object} [exams]
 * @property {number} generation  which generation of its run won
 * @property {number} seed
 * @property {number} trainedOn   rounds or duels behind the fit
 * @property {string} updatedAt
 * @property {number} promotions
 * @property {number} baselineLoss  the first champion's loss, for improvement
 * @property {Array} history
 */

export async function readChampion(kind) {
  try {
    const raw = await fs.readFile(paths(kind).champion, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.values) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function write(kind, champion) {
  const file = paths(kind).champion;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(champion, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Offer a finished run to the champion slot.
 *
 * @param {string} kind
 * @param {object} challenger
 * @param {string} challenger.specHash
 * @param {object} challenger.values
 * @param {number} challenger.validLoss
 * @param {number} challenger.generation
 * @param {number} challenger.seed
 * @param {number} challenger.trainedOn
 * @param {object} [challenger.exams]
 * @returns {Promise<{ promoted: boolean, reason: string, improvement: number|null, champion: object }>}
 */
export async function offerChampion(kind, challenger) {
  const current = await readChampion(kind);
  const at = new Date().toISOString();

  const attempt = {
    at,
    seed: challenger.seed,
    generation: challenger.generation,
    validLoss: challenger.validLoss,
    trainedOn: challenger.trainedOn,
    exams: challenger.exams || null,
    promoted: false,
    reason: ''
  };

  if (!Number.isFinite(challenger.validLoss)) {
    attempt.reason = 'run produced no held-out loss';
    if (current) {
      await write(kind, { ...current, history: trim([...(current.history || []), attempt]) });
    }
    return { promoted: false, reason: attempt.reason, improvement: null, champion: current };
  }

  // A layout change invalidates the comparison entirely: the same name can mean
  // a different thing, and loading old values into a new spec would silently
  // scramble them. Treat it as a fresh start rather than a challenger.
  const layoutChanged = Boolean(current && current.specHash !== challenger.specHash);

  if (current && !layoutChanged && challenger.validLoss >= current.validLoss) {
    attempt.reason = `no improvement (${challenger.validLoss.toFixed(5)} vs ${current.validLoss.toFixed(5)})`;
    await write(kind, { ...current, history: trim([...(current.history || []), attempt]) });
    return { promoted: false, reason: attempt.reason, improvement: null, champion: current };
  }

  attempt.promoted = true;
  attempt.reason = current
    ? layoutChanged
      ? 'parameter layout changed, starting a new lineage'
      : `improved by ${(current.validLoss - challenger.validLoss).toFixed(5)}`
    : 'first champion';

  const baselineLoss =
    current && !layoutChanged && Number.isFinite(current.baselineLoss)
      ? current.baselineLoss
      : challenger.validLoss;

  const champion = {
    kind,
    specHash: challenger.specHash,
    values: challenger.values,
    validLoss: challenger.validLoss,
    exams: challenger.exams || null,
    generation: challenger.generation,
    seed: challenger.seed,
    trainedOn: challenger.trainedOn,
    updatedAt: at,
    promotions: (current && !layoutChanged ? current.promotions || 0 : 0) + 1,
    baselineLoss,
    history: trim([...(current && !layoutChanged ? current.history || [] : []), attempt])
  };
  await write(kind, champion);

  return {
    promoted: true,
    reason: attempt.reason,
    improvement: baselineLoss - challenger.validLoss,
    champion
  };
}

function trim(history) {
  return history.slice(-HISTORY_MAX);
}

/** Total improvement since this lineage's first champion, in log loss. */
export function totalImprovement(champion) {
  if (!champion || !Number.isFinite(champion.baselineLoss)) return null;
  return champion.baselineLoss - champion.validLoss;
}
