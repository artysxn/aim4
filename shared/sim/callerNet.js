// ---------------------------------------------------------------------------
// shared/sim/callerNet.js
// The hivemind's head, at runtime (SIM-PLAN 9.25 stages 1 and 4).
//
// `sim-train-caller.py` fits it; this reads the JSON it wrote and runs the
// forward pass. Same discipline as every other artefact here: Python trains,
// JS infers, only JSON crosses, and nothing in the product imports a runtime.
//
// TWO HEADS, because the caller asks two different questions:
//
//   WIN   P(this side wins | picture, call). Trained on both outcomes of every
//         round, which is what `--from demos` exists to supply.
//   CALL  P(call | picture, side). Trained on winning freezes only. A prior
//         over the opening, not a decision — `pickCall` still draws.
//
// WHERE IT PLUGS IN, and where it deliberately does not.
//
// It goes in as `memoryOf` — the function `callValue.js` already takes and
// `caller.useHead` already accepts, whose own comment says stage 4's net
// belongs there. That slot is a BLEND: `blendMemory` caps the head at
// MEMORY_MAX_WEIGHT and ignores it below MEMORY_MIN_N, so a call the net
// barely saw moves the number barely. The support count for each call travels
// in the JSON so that gate stays honest for a net exactly as it does for the
// tabular read it replaces.
//
// It does NOT go in as `model`, the round model in objective.js, and that is
// a decision rather than an omission. `valueOfKill` and `costOfDeath` call
// that function on COUNTERFACTUAL features — the same round with one more body
// down — and objective.js is explicit that the fallback's job is to be right
// about the SIGN of every such delta: "a bot trained against something
// non-monotone would be broken". A net fitted on the pictures that actually
// occurred has no such guarantee off-distribution. So the sign-critical
// arithmetic keeps `fallbackCtWin`, and the net prices the thing it was
// actually trained to price: this call, in this picture, against the others.
//
// Pure. No I/O, no rng, no node imports — the sim shares this file with the
// browser.
// ---------------------------------------------------------------------------

export const CALLER_NET_VERSION = 1;

/**
 * The feature vector, in order. This list is the contract with
 * `sim-train-caller.py`'s FEATURES: same names, same order, or the forward
 * pass is evaluating a different function than the one that was fitted. A
 * loaded model whose `features` disagree is rejected rather than run.
 */
export const CALLER_FEATURES = Object.freeze([
  'side_ct',
  'alive',
  'enemyAlive',
  'manAdv',
  'clock',
  'secondsLeft',
  'planted',
  'bombSecondsLeft',
  'hasKit',
  'rel_none',
  'rel_front',
  'rel_site',
  'rel_behind',
  'econ0',
  'econ1',
  'econ2',
  'econ3',
  'econ4',
  'econ5',
  'isFreeze'
]);

/**
 * The fitted feature list for a model. Everything in CALLER_FEATURES is
 * map-agnostic, which is what lets one caller learn from every map at once; a
 * cross-map model appends a map one-hot after them, in the order it lists in
 * `maps`. A single-map model has no map columns, so old artifacts keep their
 * exact geometry.
 */
export function featuresFor(maps = []) {
  return maps.length > 1
    ? [...CALLER_FEATURES, ...maps.map((m) => `map_${m}`)]
    : [...CALLER_FEATURES];
}

const REL_SLOT = Object.freeze({ front: 1, site: 2, behind: 3 });

/** Below this much training support a call's number is a rumour, not a head. */
export const SUPPORT_MIN = 8;

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

/**
 * A picture as the fitted feature vector. Mirrors `featurize` in the trainer.
 *
 * The belief-model fields a demo cannot supply (`siteExpectedTarget`,
 * `packAtTarget`, `teamBroken`) are not in here at all. They were omitted from
 * the dataset rather than zeroed, so including them at runtime would feed the
 * net an input it never saw fitted.
 *
 * @param {object} picture
 * @param {{event?: string|null, econ?: number|null}} [ctx]
 * @returns {number[]}
 */
export function callerFeatures(
  picture = {},
  { event = null, econ = null, map = null, maps = [] } = {}
) {
  const f = new Array(featuresFor(maps).length).fill(0);
  const alive = Number.isFinite(picture.alive) ? picture.alive : 5;
  const enemy = Number.isFinite(picture.enemyAlive) ? picture.enemyAlive : 5;
  const planted = Boolean(picture.planted);
  f[0] = picture.side === 'CT' ? 1 : 0;
  f[1] = alive / 5;
  f[2] = enemy / 5;
  f[3] = (alive - enemy) / 5;
  f[4] = (Number(picture.clock) || 0) / 115;
  f[5] = (Number.isFinite(picture.secondsLeft) ? picture.secondsLeft : 115) / 115;
  f[6] = planted ? 1 : 0;
  // An unplanted round has no bomb clock; 1 keeps the feature monotone in
  // "time the CT still has", which is what it means where it means anything.
  f[7] = planted
    ? (Number.isFinite(picture.bombSecondsLeft) ? picture.bombSecondsLeft : 40) / 40
    : 1;
  f[8] = picture.hasKit ? 1 : 0;
  f[9 + (REL_SLOT[picture.contactRel] ?? 0)] = 1;
  if (Number.isFinite(econ) && econ >= 0 && econ <= 5) f[13 + Math.round(econ)] = 1;
  f[19] = event === 'freeze' ? 1 : 0;
  if (maps.length > 1) {
    const i = maps.indexOf(String(map || '').toUpperCase());
    if (i >= 0) f[CALLER_FEATURES.length + i] = 1;
  }
  return f;
}

/** One dense layer, tanh. */
function tanhLayer(x, layer) {
  const { W, b } = layer;
  const out = new Array(W.length);
  for (let i = 0; i < W.length; i += 1) {
    const row = W[i];
    let s = b[i] || 0;
    for (let j = 0; j < row.length; j += 1) s += row[j] * x[j];
    out[i] = Math.tanh(s);
  }
  return out;
}

/** The output layer, raw. */
function linearLayer(x, layer) {
  const { W, b } = layer;
  const out = new Array(W.length);
  for (let i = 0; i < W.length; i += 1) {
    const row = W[i];
    let s = b[i] || 0;
    for (let j = 0; j < row.length; j += 1) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function softmax(z) {
  let max = -Infinity;
  for (const v of z) if (v > max) max = v;
  let total = 0;
  const out = z.map((v) => {
    const e = Math.exp(v - max);
    total += e;
    return e;
  });
  return out.map((e) => e / (total || 1));
}

function checkHead(head, who) {
  if (!head) return null;
  if (!Array.isArray(head.layers) || head.layers.length !== 2) {
    throw new Error(`callerNet: ${who} head is not two layers`);
  }
  for (const l of head.layers) {
    if (!Array.isArray(l?.W) || !Array.isArray(l?.b) || l.W.length !== l.b.length) {
      throw new Error(`callerNet: ${who} head has a malformed layer`);
    }
  }
  return head;
}

/**
 * Load and validate a caller model.
 *
 * Rejects rather than adapts. A file whose feature list has drifted from this
 * build's would still multiply and still return a number, and that number
 * would be silently wrong — which is the one failure mode a value head must
 * not have, because nothing downstream can tell a bad price from a good one.
 *
 * @param {object} json
 * @returns {object} the runnable head
 */
export function loadCallerNet(json) {
  if (!json || typeof json !== 'object') throw new Error('callerNet: not an object');
  if (json.kind !== 'caller') throw new Error(`callerNet: kind ${json.kind}, expected caller`);
  if (json.v !== CALLER_NET_VERSION) {
    throw new Error(`callerNet: v${json.v}, this build speaks v${CALLER_NET_VERSION}`);
  }
  // A cross-map model carries the maps it was fitted over, and its feature
  // list is the base plus one column per map. The check stays exact either
  // way: the point is that a disagreement is refused, not that it is tolerated.
  const maps = Array.isArray(json.maps) ? json.maps : [];
  const expected = featuresFor(maps);
  const features = Array.isArray(json.features) ? json.features : [];
  if (features.length !== expected.length || features.some((f, i) => f !== expected[i])) {
    throw new Error('callerNet: feature list does not match this build');
  }
  const calls = Array.isArray(json.calls) ? json.calls : [];
  if (!calls.length) throw new Error('callerNet: no call vocabulary');

  // Which calls each map may answer with. A cross-map head shares one softmax
  // over every map's calls, so without this it could name a Mirage execute on
  // Nuke -- legal in the vocabulary, nonsense on the map.
  const callsByMap = json.callsByMap && typeof json.callsByMap === 'object' ? json.callsByMap : null;

  const win = checkHead(json.win, 'win');
  if (!win) throw new Error('callerNet: no win head');
  if (win.layers[0].W[0].length !== expected.length + calls.length) {
    throw new Error('callerNet: win head input does not match features plus vocabulary');
  }
  const call = checkHead(json.call, 'call');
  if (call && call.layers[1].W.length !== calls.length) {
    throw new Error('callerNet: call head output does not match the vocabulary');
  }

  const index = new Map();
  calls.forEach((c, i) => index.set(`${c.side}:${c.call}`, i));
  const support = json.support || {};
  const bySide = new Map();
  calls.forEach((c, i) => {
    if (!bySide.has(c.side)) bySide.set(c.side, []);
    bySide.get(c.side).push({ ...c, i });
  });

  /** P(this side wins | picture, call), or null when the call is unknown. */
  function winOf(picture, callKey, ctx = {}) {
    const side = picture?.side;
    const i = index.get(`${side}:${callKey || 'default'}`);
    if (i === undefined) return null;
    // Without the map, a cross-map head's one-hot is all zeros and the price
    // that comes back is an average over seven maps wearing this one's call
    // name. That is the silently-wrong number this module exists to refuse,
    // so an absent or unknown map is an error at the call site, not a shrug.
    if (maps.length > 1 && !maps.includes(String(ctx.map || '').toUpperCase())) {
      throw new Error(
        `callerNet: this head covers ${maps.join(', ')} and needs the map in ctx` +
          (ctx.map ? `, got "${ctx.map}"` : ', got none')
      );
    }
    const x = callerFeatures(picture, { ...ctx, maps }).concat(
      calls.map((_, j) => (j === i ? 1 : 0))
    );
    const h = tanhLayer(x, win.layers[0]);
    return { p: clamp01(sigmoid(linearLayer(h, win.layers[1])[0])), n: support[`${side}:${callKey || 'default'}`] || 0 };
  }

  /**
   * The `memoryOf` a caller is handed: `(call) => {n, lower}`, exactly the
   * shape `blendMemory` reads, so the net enters through the same gate the
   * tabular head does and obeys the same weight cap.
   *
   * `lower` is the prediction discounted by its own support — the net's
   * analogue of the Wilson bound. A call seen 11,000 times is barely moved;
   * one seen ninety times is pulled toward the middle, which is what stops a
   * thin cell from talking a caller into a plan.
   */
  function headFor(picture, ctx = {}) {
    return (callKey) => {
      const hit = winOf(picture, callKey, ctx);
      if (!hit || !(hit.n >= SUPPORT_MIN)) return null;
      const se = Math.sqrt(Math.max(1e-9, hit.p * (1 - hit.p)) / hit.n);
      return { n: hit.n, lower: clamp01(hit.p - se), mean: hit.p };
    };
  }

  /**
   * The opening prior: what a winning side tends to call from here, over the
   * calls that side can actually make. Renormalized per side rather than left
   * to the net, so a T caller is never handed probability mass sitting on a CT
   * call it cannot run.
   */
  function callPrior(picture, side = picture?.side, map = json.map) {
    if (!call) return [];
    let legal = bySide.get(side) || [];
    // On a cross-map head the vocabulary spans every map, so the side filter
    // alone would leave Mirage executes on the table during a Nuke round.
    if (callsByMap) {
      const allowed = callsByMap[String(map || '').toUpperCase()];
      if (!Array.isArray(allowed)) {
        // Falling through unmasked here would hand back a plausible-looking
        // prior over every map's calls, and nothing downstream could tell.
        // A cross-map head asked without a map is a wiring bug, so it says so.
        throw new Error(
          `callerNet: this head covers ${maps.join(', ')} and needs the map to mask its calls` +
            (map ? `, got "${map}"` : ', got none')
        );
      }
      const ok = new Set(allowed.map((c) => (typeof c === 'string' ? c : `${c.side}:${c.call}`)));
      legal = legal.filter((c) => ok.has(`${c.side}:${c.call}`));
    }
    if (!legal.length) return [];
    const h = tanhLayer(callerFeatures(picture, { event: 'freeze', map, maps }), call.layers[0]);
    const p = softmax(linearLayer(h, call.layers[1]));
    let total = 0;
    for (const c of legal) total += p[c.i];
    return legal
      .map((c) => ({ call: c.call, p: total > 0 ? p[c.i] / total : 1 / legal.length }))
      .sort((a, b) => b.p - a.p);
  }

  return {
    name: json.name || null,
    map: json.map || null,
    maps,
    kind: 'caller',
    lineage: 'hivemind',
    calls,
    support,
    hasCallHead: Boolean(call),
    trained: json.trained || null,
    winOf,
    headFor,
    callPrior,
    /** The single call this head would open with, for `strategyCall`. */
    topCall(picture, side = picture?.side, map = json.map) {
      return callPrior(picture, side, map)[0]?.call || null;
    }
  };
}
