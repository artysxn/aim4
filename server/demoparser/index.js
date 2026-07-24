// ---------------------------------------------------------------------------
// demoparser/index.js
// The only entry point the rest of the backend uses. It picks an adapter,
// runs it, and validates the result against the schema before anything is
// written to storage.
//
//   import { parseDemo } from '../demoparser/index.js';
//   const demo = await parseDemo('/path/to/match.dem', { onProgress });
//
// Adapters are registered below. AIM4_DEMO_PARSER selects one by key; the
// default is whichever registered adapter reports itself available, in order.
// See README.md before swapping or upgrading.
// ---------------------------------------------------------------------------

import * as laihoe from './adapters/laihoe.js';
import { validateDemo, SCHEMA_VERSION } from './schema.js';

const ADAPTERS = {
  laihoe
};

export { SCHEMA_VERSION };

export function listAdapters() {
  return Object.entries(ADAPTERS).map(([key, a]) => ({
    key,
    name: a.name,
    version: a.version?.() ?? 'unknown',
    available: a.isAvailable?.() ?? true
  }));
}

/** Resolve the adapter to use, honoring AIM4_DEMO_PARSER when set. */
export function selectAdapter(key = process.env.AIM4_DEMO_PARSER) {
  if (key) {
    const chosen = ADAPTERS[key];
    if (!chosen) {
      throw new Error(
        `Unknown demo parser "${key}". Registered: ${Object.keys(ADAPTERS).join(', ')}`
      );
    }
    return chosen;
  }
  const available = Object.values(ADAPTERS).find((a) => a.isAvailable?.() ?? true);
  return available || Object.values(ADAPTERS)[0];
}

export function parserStatus() {
  const adapter = selectAdapter();
  return {
    name: adapter.name,
    version: adapter.version?.() ?? 'unknown',
    available: adapter.isAvailable?.() ?? true,
    schemaVersion: SCHEMA_VERSION
  };
}

/**
 * Parse a demo into the normalized shape.
 *
 * @param {string} file      absolute path to a .dem
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {string} [opts.adapter]  force one adapter by key
 * @returns {Promise<import('./schema.js').NormalizedDemo>}
 */
export async function parseDemo(file, opts = {}) {
  const adapter = selectAdapter(opts.adapter);
  const demo = await adapter.parseDemo(file, opts);
  const problems = validateDemo(demo);
  if (problems.length) {
    throw new Error(`Parser "${adapter.name}" produced an invalid demo: ${problems.join('; ')}`);
  }
  return demo;
}
