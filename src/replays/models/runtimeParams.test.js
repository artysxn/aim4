// Runtime weights must never be able to make the model worse than the ones that
// shipped.
//
// Three failure modes, all of which have to end with the bundled values still
// in use: the endpoint is unreachable, the endpoint answers with nonsense, and
// the endpoint answers with a perfectly valid model fitted against a different
// set of parameter names. The last is the dangerous one, because the values
// would load positionally and silently mean something else.

import { loadRuntimeParams, resetRuntimeParams, runtimeParams } from './runtimeParams.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const stubFetch = (impl) => {
  globalThis.fetch = impl;
};

// A matching spec hash is accepted and cached.
{
  resetRuntimeParams();
  let calls = 0;
  stubFetch(async () => {
    calls++;
    return { ok: true, json: async () => ({ specHash: 'abc', values: { manW: 3 } }) };
  });
  const got = await loadRuntimeParams('round', 'abc');
  assert(got?.values?.manW === 3, 'matching weights are accepted');
  assert(runtimeParams('round')?.values.manW === 3, 'and cached');

  // A second call must not refetch: these are per session, not per prediction.
  await loadRuntimeParams('round', 'abc');
  assert(calls === 1, `fetched ${calls} times, expected 1`);
}

// A mismatched spec hash is refused, loudly but harmlessly.
{
  resetRuntimeParams();
  let warned = '';
  console.warn = (msg) => {
    warned = String(msg);
  };
  stubFetch(async () => ({
    ok: true,
    json: async () => ({ specHash: 'fitted-elsewhere', values: { manW: 99 } })
  }));
  const got = await loadRuntimeParams('round', 'abc');
  console.warn = realWarn;
  assert(got === null, 'a layout mismatch must be refused');
  assert(runtimeParams('round') === null, 'and must not be cached');
  assert(warned.includes('fitted-elsewhere'), `expected a warning, got "${warned}"`);
}

// A dead endpoint is silent and leaves the bundled values in charge.
{
  resetRuntimeParams();
  stubFetch(async () => {
    throw new Error('network down');
  });
  assert((await loadRuntimeParams('round', 'abc')) === null, 'a thrown fetch resolves to null');
  assert(runtimeParams('round') === null, 'nothing cached');
}

// So is a 404, which is the normal state before the first training run.
{
  resetRuntimeParams();
  stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  assert((await loadRuntimeParams('round', 'abc')) === null, 'a 404 resolves to null');
}

// Malformed bodies are refused rather than trusted.
{
  for (const body of [{}, { values: null }, { values: 'nope' }, null]) {
    resetRuntimeParams();
    stubFetch(async () => ({ ok: true, json: async () => body }));
    assert((await loadRuntimeParams('round', 'abc')) === null, `refused: ${JSON.stringify(body)}`);
  }
}

// A body with no spec hash at all is accepted only because the server always
// sends one; the guard is on mismatch, not on absence.
{
  resetRuntimeParams();
  stubFetch(async () => ({ ok: true, json: async () => ({ values: { manW: 1 } }) }));
  assert((await loadRuntimeParams('round', 'abc')) !== null, 'no hash is not a mismatch');
}

// The two models are cached apart.
{
  resetRuntimeParams();
  stubFetch(async (url) => ({
    ok: true,
    json: async () => ({
      specHash: 'abc',
      values: { tag: String(url).endsWith('/duel') ? 'duel' : 'round' }
    })
  }));
  await loadRuntimeParams('duel', 'abc');
  await loadRuntimeParams('round', 'abc');
  assert(runtimeParams('duel').values.tag === 'duel', 'duel cached separately');
  assert(runtimeParams('round').values.tag === 'round', 'round cached separately');
}

// Without fetch at all (node without the global, older runtimes) it is a no-op.
{
  resetRuntimeParams();
  globalThis.fetch = undefined;
  assert((await loadRuntimeParams('round', 'abc')) === null, 'no fetch, no override');
}

globalThis.fetch = realFetch;
console.warn = realWarn;
console.log('runtimeParams.test.js: ok');
