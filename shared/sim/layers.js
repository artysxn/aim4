// ---------------------------------------------------------------------------
// shared/sim/layers.js
// The map-independent macro action: convert this layer with this protocol.
//
// SIM-PLAN 20.3. Today the Playstyle AI picks a per-map string out of
// roundLibrary.js (13 to 21 calls, none of which mean anything on the next
// map). Chapter 1's rhythm is the entire T side of the game, and it is the
// same decision everywhere: spend resources to convert an Unknown into a
// Risk, take deeper control to convert the previous Risk into a Safe, repeat
// until you are at the site. Chapter 9 generalizes it, Chapter 12 adds that
// the same conversion can be done with two, three, four, or five bodies, and
// the choice is a prioritization. That is a better action space than a string:
//
//   LayerAction = { convert, protocol, pace, spend, keep, abort }
//
// Three consequences the rest of the stack is already waiting for:
//
//   TRANSFER. Convert-this-layer-with-this-protocol-for-this-price is the
//   same decision on Inferno and on Ancient. A 200 k-parameter Playstyle net
//   can learn the theory once instead of learning seven vocabularies.
//
//   THE LIBRARY CALL BECOMES A LABEL, NOT THE DECISION. A sequence of layer
//   conversions produces a round that classifyRoundTypes still tags as
//   `b-split`. `libraryLabel` is that tag's input: `${protocol} ${convert}`,
//   a name a human can read, never a thing the policy enumerates. Both
//   vocabularies stay, which is the same resolution 6.20 reached for
//   formations.
//
//   UTILITY IS A BUDGET WITH A RESERVE, AT THE POINT OF DECISION. `spend`
//   and `keep` are chapter 2 and chapter 11 made structural: the decision to
//   take a layer and the decision about what to have left at 0:35 are the
//   SAME decision, which is precisely what the document says and precisely
//   what a call string splits apart.
//
// THE LAYER GRAPH is baked per map alongside the nav graph. Nodes are named
// zones (anchor ids). Edges come from gates: which zone an enemy has to take
// before they can take this one, the same relation zones.js already asks
// `gates(z)` for. Each node carries a complexity descriptor from chapter 1
// (pathway count, height delta, off-angle count, cover density). That
// descriptor is computed from geometry rather than authored per map, so a
// new map inherits the theory the day its zones are painted. `buildLayerGraph`
// is the convenience that reads a navGraph-shaped `{ anchors }` plus a
// neighbour and gate catalogue and fills the descriptor in; off-angles and
// cover wait on the angle catalogue and default when it is not supplied.
//
// Protocol names here are the plan's LayerAction.protocol values (`three-man`,
// `poke`, ...). protocols.js speaks the same procedures under snake_case
// ids (`three_man_take`); the dash form is the macro vocabulary, the
// snake_case form is the composite-option vocabulary, and they are not
// mixed. Pace names are 6.20's six, already in patternDefs.js.
//
// Pure: no I/O, no clock, no rng. Same graph and same gates always produce
// the same layer graph, because a bake that drifted between two runs of the
// same map would be a second map.
// ---------------------------------------------------------------------------

import { ZONE, frontier as frontierOf } from './zones.js';

export const LAYERS_VERSION = 1;

/** LayerAction.protocol. Dash form, matching 20.3 rather than protocols.js. */
export const PROTOCOLS = Object.freeze(['poke', 'two-man', 'three-man', 'four-man', 'five-man']);

/** 6.20's six paces, already the pattern-finder's vocabulary. */
export const PACES = Object.freeze(['rush', 'pop', 'contact', 'full-exec', 'default', 'slow-default']);

/** Bodies a protocol needs before it is even a candidate. poke is one. */
export const PROTOCOL_BODIES = Object.freeze({
  poke: 1,
  'two-man': 2,
  'three-man': 3,
  'four-man': 4,
  'five-man': 5
});

/**
 * What a protocol WANTS to spend, before the inventory clamps it. Three-man
 * is "three bodies and one grenade" (20.5); poke is a body and nothing else.
 * The rest scale up from there. `[calibrate all]`
 */
export const PROTOCOL_SPEND = Object.freeze({
  poke: Object.freeze({ smoke: 0, flash: 0, molotov: 0 }),
  'two-man': Object.freeze({ smoke: 0, flash: 1, molotov: 0 }),
  'three-man': Object.freeze({ smoke: 1, flash: 1, molotov: 0 }),
  'four-man': Object.freeze({ smoke: 1, flash: 2, molotov: 1 }),
  'five-man': Object.freeze({ smoke: 2, flash: 2, molotov: 1 })
});

/** The abort clause 20.3 writes on the LayerAction itself. */
export const DEFAULT_ABORT = 'on_contact>=2 | util_spent>budget | clock<0:50';

/** Cover density when the catalogue has not been supplied. `[calibrate]` */
export const DEFAULT_COVER = 0.5;

/** How much each chapter-1 ingredient weighs in the complexity score. `[calibrate all]` */
export const COMPLEXITY_WEIGHTS = Object.freeze({
  pathways: 1,
  heightDelta: 0.5,
  offAngles: 0.25,
  cover: 0.5
});

/**
 * Seconds remaining below which pickLayerAction protects the reserve with a
 * poke rather than a take. Chapter 11's 0:35 is the late-round read; this is
 * a little earlier, so the decision happens while there is still a decision.
 * `[calibrate]`
 */
export const KEEP_CLOCK = 40;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);

function sortedIds(ids) {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function anchorIds(anchors) {
  if (!anchors) return [];
  if (typeof anchors.keys === 'function' && typeof anchors.get === 'function' && !Array.isArray(anchors)) {
    return [...anchors.keys()];
  }
  if (Array.isArray(anchors)) {
    return anchors.map((a) => (typeof a === 'string' ? a : a.id));
  }
  return Object.keys(anchors);
}

function lookupAnchor(anchors, id) {
  if (!anchors) return null;
  if (typeof anchors.get === 'function') return anchors.get(id) ?? null;
  if (Array.isArray(anchors)) {
    const hit = anchors.find((a) => a === id || a?.id === id);
    return typeof hit === 'string' ? { id: hit } : hit || null;
  }
  return anchors[id] ?? null;
}

/** neighbours / gates as a function, a Map, or a plain object of arrays. */
function listOf(src, id) {
  if (!src) return [];
  if (typeof src === 'function') {
    const v = src(id);
    return Array.isArray(v) ? v : [];
  }
  if (typeof src.get === 'function') {
    const v = src.get(id);
    return Array.isArray(v) ? v : [];
  }
  const v = src[id];
  return Array.isArray(v) ? v : [];
}

function nades(counts) {
  return Object.freeze({
    smoke: Math.max(0, finite(counts?.smoke, 0)),
    flash: Math.max(0, finite(counts?.flash, 0)),
    molotov: Math.max(0, finite(counts?.molotov, 0))
  });
}

// ---------------------------------------------------------------------------
// Complexity: computed from geometry, never authored per map
// ---------------------------------------------------------------------------

/**
 * Chapter 1's complexity descriptor for one zone, from the ingredients the
 * geometry actually has. Pathways are neighbour count. Height is a delta,
 * not a level name. Off-angles come from the catalogue's rarity tail.
 * Cover is a density. The score is a monotone combination so a zone with
 * more ways in is always the more expensive one to convert, for any
 * plausible recalibration of the weights.
 *
 * @param {object} args
 * @param {number} args.neighboursCount
 * @param {number} args.heightDelta
 * @param {number} args.offAngleCount
 * @param {number} args.coverDensity
 * @returns {{pathways:number, heightDelta:number, offAngles:number, cover:number, score:number}}
 */
export function zoneComplexity({
  neighboursCount = 0,
  heightDelta = 0,
  offAngleCount = 0,
  coverDensity = DEFAULT_COVER
} = {}) {
  const pathways = Math.max(0, finite(neighboursCount, 0));
  const height = Math.max(0, finite(heightDelta, 0));
  const offAngles = Math.max(0, finite(offAngleCount, 0));
  const cover = clamp01(finite(coverDensity, DEFAULT_COVER));
  const w = COMPLEXITY_WEIGHTS;
  const score = pathways * w.pathways + height * w.heightDelta + offAngles * w.offAngles + cover * w.cover;
  return { pathways, heightDelta: height, offAngles, cover, score };
}

function complexityOf(id, { neighbours, complexity, anchors }) {
  if (typeof complexity === 'function') return complexity(id);
  if (complexity && typeof complexity.get === 'function' && complexity.get(id)) return complexity.get(id);
  if (complexity && complexity[id]) return complexity[id];
  const neigh = listOf(neighbours, id);
  let heightDelta = 0;
  const self = lookupAnchor(anchors, id);
  const myLevel = self?.level ?? 'default';
  for (const n of neigh) {
    const other = lookupAnchor(anchors, n);
    if ((other?.level ?? myLevel) !== myLevel) {
      heightDelta = 1;
      break;
    }
  }
  return zoneComplexity({
    neighboursCount: neigh.length,
    heightDelta,
    offAngleCount: 0,
    coverDensity: DEFAULT_COVER
  });
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Build the layer graph from named zones, their neighbours, and their gates.
 *
 * Nodes are sorted by id and each node's gate list is sorted, so the same
 * inputs always serialize the same way. Edges run FROM a gate TO the zone
 * it gates: walking the edge is converting the next layer.
 *
 * @param {object} args
 * @param {Iterable|Map|object} args.anchors
 * @param {object|Map|Function} [args.neighbours]
 * @param {object|Map|Function} [args.gates]
 * @param {object|Map|Function} [args.complexity]  per-id descriptors; computed if omitted
 */
export function layerGraph({ anchors, neighbours = null, gates = null, complexity = null } = {}) {
  const ids = sortedIds(anchorIds(anchors));
  const nodes = ids.map((id) =>
    Object.freeze({
      id,
      gates: sortedIds(listOf(gates, id)),
      complexity: Object.freeze(complexityOf(id, { neighbours, complexity, anchors }))
    })
  );
  const edges = [];
  for (const node of nodes) {
    for (const g of node.gates) edges.push(Object.freeze({ from: g, to: node.id }));
  }
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return Object.freeze({ version: LAYERS_VERSION, nodes: Object.freeze(nodes), edges: Object.freeze(edges) });
}

/**
 * Convenience: a navGraph-like `{ anchors: Map<id,{world,level}> }` plus the
 * neighbour and gate catalogues. Neighbour counts become pathways. heightDelta
 * is 0 unless a neighbour lives on a different level. Off-angles default to 0
 * and cover to DEFAULT_COVER when no catalogue is supplied.
 *
 * @param {{anchors: Map<string, {world?:object, level?:string}>}} graph
 * @param {object} args
 * @param {object|Map|Function} args.neighbours
 * @param {object|Map|Function} args.gates
 * @param {object} [args.catalogue]  optional `{ offAngles: {id:n}, cover: {id:n} }`
 */
export function buildLayerGraph(graph, { neighbours, gates, catalogue = null } = {}) {
  const anchors = graph?.anchors;
  const complexity = {};
  for (const id of anchorIds(anchors)) {
    const neigh = listOf(neighbours, id);
    const self = lookupAnchor(anchors, id);
    const myLevel = self?.level ?? 'default';
    let heightDelta = 0;
    for (const n of neigh) {
      const other = lookupAnchor(anchors, n);
      if ((other?.level ?? myLevel) !== myLevel) {
        heightDelta = 1;
        break;
      }
    }
    const offAngleCount =
      catalogue?.offAngles?.[id] ?? catalogue?.offAngleCount?.[id] ?? catalogue?.[id]?.offAngles ?? 0;
    const coverDensity =
      catalogue?.cover?.[id] ?? catalogue?.coverDensity?.[id] ?? catalogue?.[id]?.cover ?? DEFAULT_COVER;
    complexity[id] = zoneComplexity({
      neighboursCount: neigh.length,
      heightDelta,
      offAngleCount,
      coverDensity
    });
  }
  return layerGraph({ anchors, neighbours, gates, complexity });
}

// ---------------------------------------------------------------------------
// LayerAction
// ---------------------------------------------------------------------------

function assertProtocol(protocol) {
  if (!PROTOCOLS.includes(protocol)) throw new Error(`layers: unknown protocol ${protocol}`);
}

function assertPace(pace) {
  if (!PACES.includes(pace)) throw new Error(`layers: unknown pace ${pace}`);
}

/**
 * A frozen LayerAction. spend and keep are `{ smoke, flash, molotov }` counts,
 * each >= 0. Missing fields default rather than fail: a caller assembling a
 * candidate should not have to restate the abort clause every time.
 *
 * @param {object} args
 * @param {string} args.convert
 * @param {string} [args.protocol]
 * @param {string} [args.pace]
 * @param {{smoke?:number, flash?:number, molotov?:number}} [args.spend]
 * @param {{smoke?:number, flash?:number, molotov?:number}} [args.keep]
 * @param {string} [args.abort]
 */
export function layerAction({
  convert,
  protocol = 'poke',
  pace = 'default',
  spend = null,
  keep = null,
  abort = DEFAULT_ABORT
} = {}) {
  assertProtocol(protocol);
  assertPace(pace);
  if (!convert) throw new Error('layers: LayerAction needs a convert target');
  return Object.freeze({
    convert,
    protocol,
    pace,
    spend: nades(spend),
    keep: nades(keep),
    abort
  });
}

/**
 * The library call as a LABEL. A sequence of these is what classifyRoundTypes
 * will tag; a single action is not a map-specific string like `a-execute`.
 */
export function libraryLabel(action) {
  if (!action) return '';
  return `${action.protocol} ${action.convert}`;
}

// ---------------------------------------------------------------------------
// Candidates, and a cheap pick
// ---------------------------------------------------------------------------

function classOf(classification, z) {
  if (!classification) return null;
  if (typeof classification.get === 'function') return classification.get(z);
  return classification[z] ?? null;
}

function convertTargets({ classification, frontier, gates }) {
  if (Array.isArray(frontier)) return frontier.filter(Boolean);
  if (classification && gates) return frontierOf(classification, typeof gates === 'function' ? gates : (z) => listOf(gates, z));
  if (!classification) return [];
  const out = [];
  const entries = typeof classification.keys === 'function' ? classification.keys() : Object.keys(classification);
  for (const z of entries) {
    if (classOf(classification, z) === ZONE.UNKNOWN) out.push(z);
  }
  return sortedIds(out);
}

function aliveCount(alive) {
  if (Array.isArray(alive)) return alive.length;
  return Math.max(0, Math.round(finite(alive, 0)));
}

/**
 * Inventory as per-type counts. A ledger-shaped `{ ourHeavy, ourLight }` is
 * a POOL: smokes and molotovs draw from the same heavy number, flashes from
 * light. Per-type fields, when present, win.
 */
function availableNades(utility) {
  if (!utility) {
    return { smoke: Infinity, flash: Infinity, molotov: Infinity, heavy: Infinity, heavyPool: false };
  }
  const typed = Number.isFinite(utility.smoke) || Number.isFinite(utility.flash) || Number.isFinite(utility.molotov);
  if (typed) {
    const smoke = Math.max(0, finite(utility.smoke, 0));
    const flash = Math.max(0, finite(utility.flash, 0));
    const molotov = Math.max(0, finite(utility.molotov, 0));
    return { smoke, flash, molotov, heavy: smoke + molotov, heavyPool: false };
  }
  const heavy = Math.max(0, finite(utility.ourHeavy, 0));
  const light = Math.max(0, finite(utility.ourLight, 0));
  return { smoke: heavy, flash: light, molotov: heavy, heavy: heavy, heavyPool: true };
}

function clampSpend(want, avail) {
  if (avail.heavyPool) {
    const smoke = Math.min(want.smoke, avail.heavy);
    const molotov = Math.min(want.molotov, Math.max(0, avail.heavy - smoke));
    const flash = Math.min(want.flash, avail.flash);
    return { smoke, flash, molotov };
  }
  return {
    smoke: Math.min(want.smoke, avail.smoke),
    flash: Math.min(want.flash, avail.flash),
    molotov: Math.min(want.molotov, avail.molotov)
  };
}

function leftover(avail, spend) {
  if (avail.heavyPool) {
    const remainingHeavy = Math.max(0, avail.heavy - spend.smoke - spend.molotov);
    return { smoke: remainingHeavy, flash: Math.max(0, avail.flash - spend.flash), molotov: remainingHeavy };
  }
  if (!Number.isFinite(avail.smoke)) return { smoke: 0, flash: 0, molotov: 0 };
  return {
    smoke: Math.max(0, avail.smoke - spend.smoke),
    flash: Math.max(0, avail.flash - spend.flash),
    molotov: Math.max(0, avail.molotov - spend.molotov)
  };
}

function heavyOf(utility) {
  if (!utility) return Infinity;
  if (Number.isFinite(utility.ourHeavy)) return utility.ourHeavy;
  return Math.max(0, finite(utility.smoke, 0) + finite(utility.molotov, 0));
}

function smokeOf(utility) {
  if (!utility) return Infinity;
  if (Number.isFinite(utility.smoke)) return utility.smoke;
  if (Number.isFinite(utility.ourHeavy)) return utility.ourHeavy;
  return 0;
}

/**
 * Candidate LayerActions for the current frontier.
 *
 * Convert targets are the frontier unknowns. Protocol is sized by alive
 * count (five alive makes five-man possible; one alive makes only poke).
 * poke is always legal on a frontier. Spend is clamped so it cannot exceed
 * `utility.ourHeavy` / `utility.ourLight` (or per-type counts, when given).
 *
 * Order is deterministic: frontier order (caller-supplied, otherwise sorted
 * unknowns), then PROTOCOLS order. pickLayerAction relies on that.
 *
 * @param {object} args
 * @param {Map<string,string>|object} args.classification
 * @param {string[]} [args.frontier]
 * @param {object} [args.utility]  ledger-shaped `{ ourHeavy, ourLight }` or per-type counts
 * @param {number|number[]} [args.alive]
 * @param {object|Map|Function} [args.gates]  used only when frontier is omitted
 * @returns {Array<object>}
 */
export function legalLayerActions({ classification, frontier = null, utility = null, alive = 5, gates = null } = {}) {
  const targets = convertTargets({ classification, frontier, gates });
  const n = aliveCount(alive);
  const avail = availableNades(utility);
  const out = [];
  for (const convert of targets) {
    for (const protocol of PROTOCOLS) {
      if (n < PROTOCOL_BODIES[protocol]) continue;
      const spend = clampSpend(PROTOCOL_SPEND[protocol], avail);
      out.push(
        layerAction({
          convert,
          protocol,
          pace: 'default',
          spend,
          keep: leftover(avail, spend),
          abort: DEFAULT_ABORT
        })
      );
    }
  }
  return out;
}

/**
 * Cheap heuristic over a candidate list. Deterministic: the first candidate
 * that matches, else candidates[0].
 *
 *   utility thin (no heavy left), or the clock inside KEEP_CLOCK
 *     -> poke, so the reserve stays a reserve
 *   three-man present and we have a smoke
 *     -> that three-man (chapter 12's unit of ground conversion)
 *   else
 *     -> candidates[0], which is the first frontier's cheapest protocol
 *
 * @param {Array<object>} candidates
 * @param {object} [args]
 * @param {number} [args.clock]     seconds remaining; omitted means early
 * @param {object} [args.utility]
 */
export function pickLayerAction(candidates, { clock = Infinity, utility = null } = {}) {
  if (!candidates?.length) return null;
  const first = (pred) => {
    for (const c of candidates) if (pred(c)) return c;
    return null;
  };
  const thin = heavyOf(utility) < 1;
  const late = Number.isFinite(clock) && clock < KEEP_CLOCK;
  if (thin || late) return first((c) => c.protocol === 'poke') || candidates[0];
  if (smokeOf(utility) >= 1) return first((c) => c.protocol === 'three-man') || candidates[0];
  return candidates[0];
}
