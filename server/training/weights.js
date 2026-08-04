// ---------------------------------------------------------------------------
// server/training/weights.js
// The full parameter listing for a model, for the admin panel.
//
// A fitted model is a vector of numbers, and a vector of numbers is not an
// explanation. What makes it inspectable is the surrounding configuration:
// what each weight is called, what range it was allowed to move in, whether the
// optimizer treats it as a linear weight or a curve shape, and which diagnostic
// scenarios it is answerable for.
//
// Two flags matter more than the values themselves, because both were caught by
// hand during fitting and both mean the fit is not to be trusted at that
// parameter:
//
//   atBound     the value is pinned against a limit somebody picked, so the
//               limit is the constraint rather than the data.
//   neverMoved  the value is still exactly its starting guess, which means the
//               corpus contained nothing that could move it.
// ---------------------------------------------------------------------------

import { readChampion } from './champion.js';
import { isModelKind } from './config.js';

/** The two specs, loaded lazily so the server does not pay for both. */
async function specFor(kind) {
  if (kind === 'round') {
    const m = await import('../../src/replays/rounds/roundParamSpec.js');
    const shipped = await import('../../src/replays/rounds/roundModelParams.js');
    return { spec: m.ROUND_PARAM_SPEC, specHash: m.specHash(), shipped: shipped.ROUND_MODEL_PARAMS };
  }
  const m = await import('../../src/replays/duels/paramSpec.js');
  const shipped = await import('../../src/replays/duels/duelModelParams.js');
  return { spec: m.PARAM_SPEC, specHash: m.specHash(), shipped: shipped.DUEL_MODEL_PARAMS };
}

const EPS = 1e-9;

/**
 * Every parameter of a model, with its value and how it is configured.
 *
 * Falls back to the values compiled into this build when nothing has been
 * trained yet, and says which source it used, because "these are the shipped
 * defaults" and "these were fitted on ten thousand rounds" should never look
 * the same on a screen.
 */
export async function modelWeights(kind) {
  if (!isModelKind(kind)) return { error: 'unknown model' };
  const { spec, specHash, shipped } = await specFor(kind);
  const champion = await readChampion(kind);

  // A champion fitted against a different parameter layout cannot be read
  // positionally or by name; its values mean something else.
  const layoutOk = Boolean(champion && champion.specHash === specHash);
  const values = layoutOk ? champion.values : shipped.values || {};
  const source = layoutOk ? 'trained' : champion ? 'shipped (champion layout is stale)' : 'shipped';

  const params = spec.map((p) => {
    const value = Number.isFinite(values[p.name]) ? values[p.name] : p.init;
    return {
      name: p.name,
      value,
      init: p.init,
      min: p.min,
      max: p.max,
      group: p.group,
      buckets: p.buckets || [],
      atBound: Math.abs(value - p.min) < EPS || Math.abs(value - p.max) < EPS,
      neverMoved: Math.abs(value - p.init) < EPS
    };
  });

  return {
    kind,
    specHash,
    source,
    count: params.length,
    atBound: params.filter((p) => p.atBound).length,
    neverMoved: params.filter((p) => p.neverMoved).length,
    trainedOn: layoutOk ? champion.trainedOn : shipped.trainedOn || 0,
    validLoss: layoutOk ? champion.validLoss : shipped.validation?.logLoss ?? null,
    updatedAt: layoutOk ? champion.updatedAt : null,
    params
  };
}
