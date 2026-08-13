// Run: node shared/sim/layers.test.js
//
// SIM-PLAN 20.3. The properties a wrong layer graph or a leaky spend would
// break:
//
//   the same graph and the same gates bake the same layer graph twice
//   complexity is monotone in pathway count, for any plausible weights
//   legalLayerActions never spends more smokes (or heavy) than we have
//   poke is legal with one body; five-man is not
//   pickLayerAction is deterministic, and the heuristic is a first-match
//     rather than a shuffle

import { ZONE } from './zones.js';
import {
  DEFAULT_COVER,
  LAYERS_VERSION,
  PACES,
  PROTOCOLS,
  buildLayerGraph,
  layerAction,
  layerGraph,
  legalLayerActions,
  libraryLabel,
  pickLayerAction,
  zoneComplexity
} from './layers.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ANCHORS = ['spawn', 'mid', 'site'];
const NEIGHBOURS = {
  spawn: ['mid'],
  mid: ['spawn', 'site'],
  site: ['mid']
};
const GATES = {
  spawn: ['mid'],
  mid: ['spawn', 'site'],
  site: ['mid']
};

// ---- the tables exist and match the plan ------------------------------------

{
  assert(LAYERS_VERSION === 1, 'version is the bake generation');
  assert(PROTOCOLS[0] === 'poke' && PROTOCOLS.includes('three-man') && PROTOCOLS.includes('five-man'), 'protocol names are the plan');
  assert(PACES.includes('rush') && PACES.includes('full-exec') && PACES.includes('slow-default'), 'paces are 6.20');
  assert(PACES.includes('default') && PACES.includes('pop') && PACES.includes('contact'), 'all six paces');
}

// ---- same graph + gates => same layer graph ---------------------------------

{
  const a = layerGraph({ anchors: ANCHORS, neighbours: NEIGHBOURS, gates: GATES });
  const b = layerGraph({ anchors: ANCHORS, neighbours: NEIGHBOURS, gates: GATES });
  assert(same(a, b), 'the bake is deterministic');
  assert(a.nodes.length === 3, 'one node per named zone');
  assert(
    a.nodes.every((n) => same(n, b.nodes.find((m) => m.id === n.id))),
    'and each node matches'
  );

  // Insertion order of anchors must not matter.
  const shuffled = layerGraph({
    anchors: ['site', 'spawn', 'mid'],
    neighbours: NEIGHBOURS,
    gates: GATES
  });
  assert(same(a, shuffled), 'node order is by id, not by insertion');
}

{
  const anchors = new Map([
    ['spawn', { world: { x: 0, y: 0 }, level: 'default' }],
    ['mid', { world: { x: 1, y: 0 }, level: 'default' }],
    ['site', { world: { x: 2, y: 0 }, level: 'catwalk' }]
  ]);
  const a = buildLayerGraph({ anchors }, { neighbours: NEIGHBOURS, gates: GATES });
  const b = buildLayerGraph({ anchors }, { neighbours: NEIGHBOURS, gates: GATES });
  assert(same(a, b), 'buildLayerGraph is deterministic too');

  const byId = Object.fromEntries(a.nodes.map((n) => [n.id, n]));
  assert(byId.mid.complexity.pathways > byId.spawn.complexity.pathways, 'mid has more pathways than spawn');
  assert(byId.site.complexity.heightDelta > 0, 'site sits on a different level from its neighbour');
  assert(byId.spawn.complexity.heightDelta === 0, 'spawn and mid share a level');
  assert(byId.spawn.complexity.offAngles === 0, 'no catalogue: off-angles default to 0');
  assert(byId.spawn.complexity.cover === DEFAULT_COVER, 'no catalogue: cover defaults');
}

// ---- complexity rises with pathway count ------------------------------------

{
  const low = zoneComplexity({ neighboursCount: 1, heightDelta: 0, offAngleCount: 0, coverDensity: 0.5 });
  const high = zoneComplexity({ neighboursCount: 4, heightDelta: 0, offAngleCount: 0, coverDensity: 0.5 });
  assert(high.score > low.score, 'more pathways is more complex');
  assert(high.pathways > low.pathways, 'and the pathway field itself rises');

  // Holding pathways fixed, the other ingredients still move the score, so
  // the pathway term is not the only term. They must not reverse the
  // pathway ordering at any plausible magnitude.
  const still = zoneComplexity({ neighboursCount: 4, heightDelta: 0, offAngleCount: 0, coverDensity: 0 });
  assert(still.score > low.score, 'pathway dominance survives a cover of zero');
}

// ---- LayerAction shape, library label is a label ----------------------------

{
  const a = layerAction({
    convert: 'banana_lower',
    protocol: 'three-man',
    pace: 'default',
    spend: { smoke: 1, flash: 1, molotov: 0 },
    keep: { smoke: 2, flash: 0, molotov: 2 }
  });
  assert(a.convert === 'banana_lower' && a.protocol === 'three-man', 'fields land');
  assert(a.spend.smoke === 1 && a.keep.smoke === 2, 'spend and keep are counts');
  assert(libraryLabel(a) === 'three-man banana_lower', 'the library call is protocol plus convert');
  assert(Object.isFrozen(a) && Object.isFrozen(a.spend), 'frozen so a pick cannot mutate a candidate');
}

// ---- legalLayerActions: bodies size the protocol, spend cannot exceed -------

const classification = new Map([
  ['spawn', ZONE.SAFE],
  ['mid', ZONE.RISK],
  ['site', ZONE.UNKNOWN]
]);

{
  const one = legalLayerActions({
    classification,
    frontier: ['site'],
    utility: { ourHeavy: 5, ourLight: 5 },
    alive: 1
  });
  assert(one.length > 0, 'a frontier with one body still has a candidate');
  assert(
    one.every((a) => a.protocol === 'poke'),
    'poke is legal with 1 body'
  );
  assert(
    one.every((a) => a.protocol !== 'five-man'),
    'five-man is not'
  );
  assert(
    one.every((a) => a.convert === 'site'),
    'the convert target is the frontier unknown'
  );
}

{
  const five = legalLayerActions({
    classification,
    frontier: ['site'],
    utility: { ourHeavy: 5, ourLight: 5 },
    alive: 5
  });
  assert(
    five.some((a) => a.protocol === 'five-man'),
    'five alive makes five-man possible'
  );
  assert(
    five.some((a) => a.protocol === 'poke'),
    'and poke stays legal on a full buy'
  );
}

{
  // Property: for any heavy count, no candidate spends more heavy than we
  // have, and no candidate spends more smokes than the pool could be.
  for (let heavy = 0; heavy <= 6; heavy += 1) {
    for (let light = 0; light <= 4; light += 1) {
      const acts = legalLayerActions({
        classification,
        frontier: ['site'],
        utility: { ourHeavy: heavy, ourLight: light },
        alive: 5
      });
      assert(acts.length > 0, 'poke keeps the set non-empty even on empty util');
      for (const a of acts) {
        assert(a.spend.smoke >= 0 && a.spend.flash >= 0 && a.spend.molotov >= 0, 'counts are not negative');
        assert(a.spend.smoke + a.spend.molotov <= heavy, `heavy spend ${a.spend.smoke + a.spend.molotov} exceeds ${heavy}`);
        assert(a.spend.flash <= light, `flash spend ${a.spend.flash} exceeds ${light}`);
        assert(a.spend.smoke <= heavy, 'never spends more smokes than we have');
      }
    }
  }
}

{
  // Per-type inventory is a harder clamp than a pool.
  const acts = legalLayerActions({
    classification,
    frontier: ['site'],
    utility: { smoke: 0, flash: 4, molotov: 2 },
    alive: 5
  });
  for (const a of acts) {
    assert(a.spend.smoke === 0, 'zero smokes in the bag means zero smokes spent');
  }
}

// ---- pickLayerAction is deterministic, and first-match ----------------------

{
  const utility = { ourHeavy: 3, ourLight: 2, smoke: 2 };
  const cands = legalLayerActions({ classification, frontier: ['site'], utility, alive: 5 });
  const ctx = { clock: 90, utility };
  const a = pickLayerAction(cands, ctx);
  const b = pickLayerAction(cands, ctx);
  assert(a === b, 'the same candidate list and the same ctx pick the same object');
  assert(a.protocol === 'three-man', 'a smoke and 3+ alive pick the three-man');
}

{
  const utility = { ourHeavy: 0, ourLight: 0 };
  const cands = legalLayerActions({ classification, frontier: ['site'], utility, alive: 5 });
  const a = pickLayerAction(cands, { clock: 90, utility });
  const b = pickLayerAction(cands, { clock: 90, utility });
  assert(a === b, 'thin utility is deterministic too');
  assert(a.protocol === 'poke', 'thin utility picks poke');
}

{
  assert(pickLayerAction([]) == null, 'an empty candidate list is a null pick');
}

console.log('layers: ok');
