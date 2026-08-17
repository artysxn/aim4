// ---------------------------------------------------------------------------
// replays/models/runtimeParams.js
// Fitted weights fetched at runtime, with the bundled ones as the floor.
//
// Both models are trained on the server against the whole replay library, which
// is far more data than the committed params were fitted on. But the committed
// params live in a JavaScript module that is compiled into the client bundle,
// so a model trained on Tuesday would not reach a single user until somebody
// rebuilt and redeployed the site. That is a bad enough gap that it would make
// server-side training pointless.
//
// So the weights are fetched instead. The rules:
//
//   - The bundled values are always available immediately, so nothing ever
//     waits on a network call to draw a chart.
//   - A fetched set replaces them only if its `specHash` matches the parameter
//     layout this build actually knows about. A mismatch means the server has
//     been trained against a different set of parameter names, and loading
//     those values positionally would silently scramble the model.
//   - Any failure is silent and leaves the bundled values in place. A model
//     that is slightly out of date is fine; one that throws while drawing is
//     not.
//
// Fetched once per session per model, then cached.
// ---------------------------------------------------------------------------

import { apiBase } from '../api.js';

// Absolute, via apiBase(): the site and the API are different hosts in
// production, so a bare path hits the SPA catch-all rewrite and comes back as
// 200 text/html. The `.catch(() => null)` below then turns that into "no
// runtime weights" without a word, and the models quietly ran on their baked
// defaults on aim4.io while dev — where Vite proxies /api — got the real ones.
const ENDPOINT = () => `${apiBase()}/api/replays/models`;

/** kind -> { values, specHash, ... } once fetched and accepted. */
const runtime = new Map();
/** kind -> in-flight request, so concurrent callers share one fetch. */
const pending = new Map();

/**
 * Ask the server for a model's fitted weights.
 *
 * Resolves to null when there is nothing better than what shipped, which is the
 * normal case before the first server-side training run.
 *
 * @param {'duel'|'round'} kind
 * @param {string} expectedSpecHash  the layout this build understands
 * @returns {Promise<object|null>}
 */
export function loadRuntimeParams(kind, expectedSpecHash) {
  if (runtime.has(kind)) return Promise.resolve(runtime.get(kind));
  if (pending.has(kind)) return pending.get(kind);
  if (typeof fetch !== 'function') return Promise.resolve(null);

  const req = fetch(`${ENDPOINT()}/${kind}`, { credentials: 'omit' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body?.values || typeof body.values !== 'object') return null;
      // A layout mismatch is the one failure worth being loud about in a log:
      // it means the server and the client disagree about what the model is.
      if (expectedSpecHash && body.specHash && body.specHash !== expectedSpecHash) {
        console.warn(
          `[models] ignoring ${kind} weights fitted for spec ${body.specHash}, this build expects ${expectedSpecHash}`
        );
        return null;
      }
      runtime.set(kind, body);
      return body;
    })
    .catch(() => null)
    .finally(() => pending.delete(kind));

  pending.set(kind, req);
  return req;
}

/** Whatever has already been accepted for this model, without fetching. */
export function runtimeParams(kind) {
  return runtime.get(kind) || null;
}

/**
 * Start the fetch and hand back a callback to run when it lands.
 *
 * The params modules cache their vector, so they need telling to rebuild it
 * once better weights arrive rather than being asked every prediction.
 *
 * @param {'duel'|'round'} kind
 * @param {string} specHash
 * @param {() => void} onUpdate
 */
export function primeRuntimeParams(kind, specHash, onUpdate) {
  loadRuntimeParams(kind, specHash).then((body) => {
    if (body) onUpdate?.();
  });
}

/** Test hook. */
export function resetRuntimeParams() {
  runtime.clear();
  pending.clear();
}
