// Run: node shared/sim/knowledgeBake.test.js
//
// The knowledge reader is a lookup with a sample-size floor. Tiny fixture:
// exact keys hit, thin rows fall through, a version mismatch throws.

import { KNOWLEDGE_VERSION, MIN_ROWS } from './demoContracts.js';
import { clockCovers, loadKnowledge } from './knowledgeBake.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const dist = { n: 12, mean: 12, sd: 2, p10: 8, p50: 12, p90: 16 };

const json = {
  v: KNOWLEDGE_VERSION,
  map: 'INF',
  rounds: 20,
  wonRounds: 20,
  tables: {
    'INF|T|default|banana': {
      n: 20,
      occupancy: [{ anchor: 'banana', share: 0.8, yaw: 90, seconds: 8 }],
      utility: [
        {
          type: 'smokegrenade',
          from: 'banana',
          at: 'ct',
          n: 10,
          share: 0.5,
          clock: dist
        }
      ],
      spacing: { apps: { n: 10, mean: 800, sd: 50, p10: 700, p50: 800, p90: 900 } }
    },
    'INF|T|default|any': {
      n: 3,
      occupancy: [{ anchor: 'mid', share: 1, yaw: 0, seconds: 4 }],
      utility: [],
      spacing: {}
    }
  }
};

{
  let threw = false;
  try {
    loadKnowledge({ v: KNOWLEDGE_VERSION + 1, map: 'INF', tables: {} });
  } catch {
    threw = true;
  }
  assert(threw, 'a stale bake is refused');
}

const k = loadKnowledge(json);

{
  const angles = k.anglesFor({ map: 'INF', side: 'T', call: 'default', contract: 'banana' });
  assert(angles[0].anchor === 'banana' && angles[0].yaw === 90, 'exact key hits occupancy');
  const util = k.utilityFor({ map: 'INF', side: 'T', call: 'default', contract: 'banana' });
  assert(util[0].type === 'smokegrenade' && util[0].from === 'banana', 'and utility');
  const spacing = k.spacingFor({ map: 'INF', side: 'T', call: 'default', contract: 'banana' });
  assert(spacing.apps.mean === 800, 'and spacing');
}

{
  const thin = k.tablesFor({ map: 'INF', side: 'T', call: 'default', contract: 'unknown' });
  assert(thin && thin.n < MIN_ROWS, 'a thin fallback is returned, not invented');
  assert(thin.occupancy[0].anchor === 'mid', 'it is the default|any row');
}

{
  assert(clockCovers(dist, 12), 'the median is inside the window');
  assert(clockCovers(dist, 8), 'p10 is inside');
  assert(!clockCovers(dist, 1), 'well before p10 is outside');
  assert(clockCovers(null, 40), 'a missing Dist is a match');
}

console.log('knowledgeBake: ok');
