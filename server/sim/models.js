// ---------------------------------------------------------------------------
// server/sim/models.js
// The model registry: which brains this host can put on the map, and where
// each of them came from.
//
// SIM-PLAN 9.9 asks for a registry the server loads, the admin can inspect,
// and the UI can pick from per match ("Gen 12 vs Gen 8"). This is that, and it
// deliberately copies bakes.js rather than inventing a second convention,
// because a model is the same KIND of artefact as a bake: derived data, small,
// versioned, produced off-line, and useless to a deployed /sim if it only ever
// existed on the machine that trained it.
//
//   simdata/models/           committed, ships with every deploy
//   AIM4_REPLAY_DIR/sim/models/   written by the trainer, wins when present
//
// The override direction is the whole point of the training loop: artysan
// trains on the 4090, the new weights land in the local directory, and the
// next match uses them without a deploy or a restart. Shipping a model is then
// a deliberate act (copy it into simdata/models/ and commit), which is the
// correct amount of friction for a file that changes how every bot behaves.
//
// Two differences from bakes.js, both because a model can be WRONG in ways a
// bake cannot:
//
//   Entries are validated through loadPolicy at listing time, so a model
//   trained against an older observation layout shows up in the panel as
//   broken with its reason, instead of failing when a match is already running.
//
//   The cache is mtime-keyed rather than permanent. Re-training bc0 replaces a
//   file in place, and a registry that had to be restarted to notice would
//   make the local training loop feel broken.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ROOT as REPLAY_ROOT } from '../replays/demoStore.js';
import { loadPolicy } from '../../shared/sim/policy.js';
import { loadPolicyNet } from '../../shared/sim/policyNet.js';
import { loadCallerNet } from '../../shared/sim/callerNet.js';
import {
  LINEAGE,
  TEST_TIER,
  compareModelNames,
  parseModelId,
  resolveModelName
} from '../../shared/sim/modelNames.js';

/**
 * Wrap a demo-trained net in the interface the bot already speaks.
 *
 * desireBot already keeps a per-slot observation history and passes
 * `{player, map, contract, history}` to probs(), because policy.js v3 wants
 * the same thing. So this adapter is thin on purpose: it forwards that context
 * and adds nothing. Keeping a second history here would silently ignore the
 * bot's own and desynchronize the two.
 *
 * One honest mismatch: the bot's history is sampled at the DECISION cadence,
 * while training built its windows at 4 Hz. The encoder therefore sees 1.5 s
 * of play where it was trained on 3 s. `[fix: resample the bot's ring to 4 Hz,
 * or train the next generation against the decision cadence]`
 */
function adaptPolicyNet(net) {
  return {
    kind: 'policyNet',
    vocab: net.vocab,
    probs(obs, ctx = {}) {
      const c = typeof ctx === 'string' ? { player: ctx } : ctx;
      return net.probs(obs, {
        history: c.history || [],
        map: c.map,
        call: c.call,
        contract: c.contract,
        player: c.player
      });
    },
    forward(obs, ctx = {}) {
      const c = typeof ctx === 'string' ? { player: ctx } : ctx;
      return net.forward(obs, {
        history: c.history || [],
        map: c.map,
        call: c.call,
        contract: c.contract,
        player: c.player
      });
    }
  };
}

const gunzip = promisify(zlib.gunzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Committed models, relative to the repo root. */
export const SHIPPED_DIR = path.join(__dirname, '..', '..', 'simdata', 'models');
/** Locally trained models, which win when they exist. */
export const LOCAL_DIR = path.join(REPLAY_ROOT, 'sim', 'models');

/** The brains that are not files: the scripted baseline and the P3b arbiter. */
// `nomad-1` is the test harness — the bare desire arbiter plus the knobs in
// its model file (kind `nomad`), for testing one aspect at a time. `desire`
// is its old name, kept so shipped match records and old CLI habits still
// resolve; the seams map it forward.
export const BUILTIN_BRAINS = Object.freeze(['scripted', 'nomad-1', 'desire']);

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');

/** name -> {mtimeMs, source, file, json, policy, error} */
const cache = new Map();

async function readJson(file) {
  const bytes = await fsp.readFile(file);
  if (file.endsWith('.gz')) return JSON.parse((await gunzip(bytes)).toString('utf8'));
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * Files that live in the model directory without being models.
 *
 * `*.manifest.json` already falls out of the scan regex (the dot is not in the
 * name character class), but the miners drop a `progress.json` beside their
 * output, and a bookkeeping file listed as a broken brain is a permanent red
 * mark in the panel for something that is working correctly.
 */
const SIDECARS = new Set(['progress', 'index']);

/** Where a model of this name would be read from, local first. */
function candidates(name) {
  return [
    { file: path.join(LOCAL_DIR, `${name}.json`), source: 'local' },
    { file: path.join(LOCAL_DIR, `${name}.json.gz`), source: 'local' },
    { file: path.join(SHIPPED_DIR, `${name}.json`), source: 'shipped' },
    { file: path.join(SHIPPED_DIR, `${name}.json.gz`), source: 'shipped' }
  ];
}

/**
 * Load a registered model, validated.
 *
 * @param {string} rawName
 * @returns {Promise<{policy: object, meta: object}|{error: string}>}
 */
export async function loadModel(rawName) {
  // Legacy ids resolve to what they became (modelNames.js). Shipped match
  // records, scorecard frozen refs, and job defaults all still say `bc0`, and
  // a rename that orphaned those would make old results unattributable — the
  // one thing 9.9 asks this registry to prevent.
  const name = safe(resolveModelName(rawName));
  if (!name) return { error: 'model: no name' };

  for (const c of candidates(name)) {
    let stat;
    try {
      stat = await fsp.stat(c.file);
    } catch {
      continue; // not at this source; try the next
    }

    const hit = cache.get(name);
    if (hit && hit.file === c.file && hit.mtimeMs === stat.mtimeMs) {
      return hit.error ? { error: hit.error } : { policy: hit.policy, meta: hit.meta };
    }

    try {
      const json = await readJson(c.file);
      // Three artefact families now: the small policy.js clone, the bigger
      // demo-trained policyNet, and the caller head. Dispatch on `kind` so a
      // net trained tonight is playable tonight, instead of listed as broken
      // for lacking a field it was never supposed to have — which is exactly
      // what happened to the first caller model, rejected for having no
      // `obsVersion` when a caller has never observed a tick in its life.
      const policy =
        json?.kind === 'caller'
          ? loadCallerNet(json)
          : json?.kind === 'nomad'
            ? Object.freeze({ ...(json.knobs || {}) })
            : json?.kind === 'policyNet'
              ? adaptPolicyNet(loadPolicyNet(json))
              : loadPolicy(json);
      const meta = describe(name, json, c, stat);
      cache.set(name, { file: c.file, mtimeMs: stat.mtimeMs, policy, meta });
      return { policy, meta };
    } catch (err) {
      // A file that exists and does not load is an error, not a miss: falling
      // through to the shipped copy would silently run different weights than
      // the ones the operator just installed.
      const error = `model ${name}: ${err.message}`;
      cache.set(name, { file: c.file, mtimeMs: stat.mtimeMs, error });
      return { error };
    }
  }
  return { error: `model ${name}: not on this host` };
}

/**
 * What this model is called, for anything with a screen.
 *
 * A file that does not parse as a scheme name still gets a display string —
 * its own name — rather than being left blank. An unnameable file is exactly
 * the one somebody is trying to find.
 */
function naming(name) {
  const p = parseModelId(name);
  return {
    display: p ? p.display : name,
    lineage: p ? p.lineage : null,
    tier: p ? p.tier : null,
    variant: p ? p.variant : null,
    major: p ? p.major : null,
    minor: p ? p.minor : null
  };
}

/** The inspectable summary: everything the panel shows about a model. */
function describe(name, json, c, stat) {
  const layers = Array.isArray(json.layers) ? json.layers : [];
  if (json?.kind === 'nomad') {
    // The harness has no weights, no accuracy, no dataset: its whole state
    // is the knobs, so that is what the panel shows.
    return {
      name,
      ...naming(name),
      source: c.source,
      kind: 'nomad',
      v: json.v ?? null,
      knobs: json.knobs || {},
      notes: json.notes || null,
      bytes: stat.size,
      trainedAt: stat.mtime.toISOString(),
      ok: true
    };
  }
  if (json?.kind === 'caller') {
    // A caller is graded on different things than a bot, so it reports
    // different things: no observation version, no option vocabulary, and a
    // win-head accuracy that is over ROUND-SIDES rather than over ticks.
    return {
      name,
      ...naming(name),
      source: c.source,
      kind: 'caller',
      v: json.v ?? null,
      map: json.map || null,
      // A cross-map head lists what it was fitted over; the match seam checks
      // coverage against this rather than demanding one exact map.
      maps: Array.isArray(json.maps) && json.maps.length ? json.maps : null,
      calls: Array.isArray(json.calls) ? json.calls.length : 0,
      teacher: 'demos',
      dataset: json.dataset || null,
      valAccuracy: json.trained?.valAccuracy?.win ?? null,
      callAccuracy: json.trained?.valAccuracy?.call ?? null,
      // The floor the win head had to clear: the (side, call) lookup table
      // this net exists to replace. Listed next to the score because the
      // score alone cannot say whether the net earned its keep.
      tableFloor: json.trained?.floors?.table ?? null,
      valLogloss: json.trained?.valLogloss?.win ?? null,
      rows: json.trained?.rows ?? null,
      hasCallHead: Boolean(json.call),
      bytes: stat.size,
      trainedAt: stat.mtime.toISOString(),
      ok: true
    };
  }
  if (json?.kind === 'policyNet') {
    return {
      name,
      ...naming(name),
      source: c.source,
      kind: 'policyNet',
      v: json.v ?? null,
      obsVersion: json.obsVersion ?? null,
      vocab: Array.isArray(json.vocab?.option) ? json.vocab.option.length : 0,
      teacher: 'demos',
      dataset: json.trained?.samples ? `${json.trained.samples} samples` : null,
      // The demo trainer writes `trained.valAccuracy` as a per-head map;
      // `accuracies` was the field this once expected and never the one that
      // got written, so every policyNet has been listed as unscored.
      valAccuracy: json.trained?.valAccuracy?.option ?? json.trained?.accuracies?.option ?? null,
      calls: Object.keys(json.embed?.call?.keys || {}).length,
      contracts: Object.keys(json.embed?.contract?.keys || {}).length,
      players: Object.keys(json.embed?.player?.keys || {}).length,
      parameters: json.trained?.parameters ?? null,
      bytes: stat.size,
      trainedAt: stat.mtime.toISOString(),
      ok: true
    };
  }
  return {
    name,
    ...naming(name),
    source: c.source,
    v: json.v ?? null,
    obsVersion: json.obsVersion ?? null,
    vocab: Array.isArray(json.vocab) ? json.vocab.length : 0,
    teacher: json.teacher || null,
    dataset: json.dataset || null,
    valAccuracy: json.valAccuracy ?? null,
    embedDim: json.embed?.dim ?? 0,
    embedPlayers: json.embed?.players ? Object.keys(json.embed.players).length : 0,
    hidden: layers.slice(0, -1).map((l) => l.W?.length || 0),
    bytes: stat.size,
    trainedAt: stat.mtime.toISOString(),
    ok: true
  };
}

/**
 * Every model this host can offer, both sources, newest-looking first.
 * A model that fails to load is listed WITH its reason rather than hidden:
 * "bc0 is missing" and "bc0 was trained against observation v1" are different
 * problems and the panel should not have to guess which one it has.
 */
export async function listModels() {
  const seen = new Map();
  const scan = async (dir, source) => {
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^([A-Za-z0-9_-]+)\.json(\.gz)?$/.exec(f);
      if (!m || SIDECARS.has(m[1]) || seen.has(m[1])) continue;
      seen.set(m[1], source);
    }
  };
  await scan(LOCAL_DIR, 'local');
  await scan(SHIPPED_DIR, 'shipped');

  const out = [];
  for (const name of seen.keys()) {
    const loaded = await loadModel(name);
    if (loaded.error) {
      out.push({ name, ...naming(name), ok: false, error: loaded.error, source: seen.get(name) });
    } else {
      out.push(loaded.meta);
    }
  }
  // Lineage, then tier, then version (modelNames.js) rather than alphabetical,
  // which used to put gen1 ahead of gen9 and bc0 ahead of both.
  out.sort((a, b) => compareModelNames(a.name, b.name));
  return out;
}

/** Is this a brain a match may be asked to play? */
export async function isBrain(name) {
  if (BUILTIN_BRAINS.includes(name)) return true;
  const loaded = await loadModel(name);
  // A caller loads fine and is still not a brain. Answering true here let a
  // caller-as-brain job fork and die 147ms later in the engine; the job
  // runner's whole contract is that a typo answers the click instead.
  return !loaded.error && loaded.meta?.kind !== 'caller';
}

/** The other half of the seam: a name that must be a caller, checked early. */
export async function isCaller(name) {
  const loaded = await loadModel(name);
  return !loaded.error && loaded.meta?.kind === 'caller';
}

/** Tests and the trainer invalidate through here. */
export function clearModelCache() {
  cache.clear();
}

/**
 * Generation manifests (9.9): genN.json next to genN.manifest.json.
 * Exploiters in the pool are listed but shipped=false.
 */
export async function listGenerations() {
  const models = await listModels();
  const gens = [];
  // Already sorted by lineage/tier/version, so "the one before this" is simply
  // the previous entry in the same lineage. That is what `parent` meant when
  // every model was genN, and it keeps meaning it now that they have names.
  const previous = new Map();

  for (const m of models) {
    // Anything the scheme can name is a generation of one of the two brains.
    // A file it cannot name is a one-off and is left out of the lineage view
    // rather than being wedged into it with a made-up number.
    if (!m.lineage) continue;
    // The Nomad is a harness, not a generation: it wanders beside the ladder
    // and would otherwise sit "before" Navaja 1 and shift every ordinal.
    if (m.tier === TEST_TIER) continue;

    let manifest = null;
    for (const dir of [LOCAL_DIR, SHIPPED_DIR]) {
      try {
        manifest = JSON.parse(await fsp.readFile(path.join(dir, `${m.name}.manifest.json`), 'utf8'));
        break;
      } catch {
        /* no manifest beside this copy */
      }
    }

    const prior = previous.get(m.lineage) || null;
    const ordinal = prior ? prior.gen + 1 : 0;
    const entry = {
      name: m.name,
      display: m.display,
      lineage: m.lineage,
      tier: m.tier,
      variant: m.variant,
      ok: m.ok,
      source: m.source,
      valAccuracy: m.valAccuracy,
      // Manifests were written before the rename and still name their parent
      // and league in the old vocabulary, so those strings resolve too. A
      // lineage view that says a model descends from `bc0` while listing no
      // such model is a graph with a dangling edge.
      parent: manifest?.parent ? resolveModelName(manifest.parent) : (prior?.name ?? null),
      gen: manifest?.gen ?? ordinal,
      shipped: m.source === 'shipped',
      // The league a candidate is measured against. Defaults to the frozen
      // references plus whatever it descends from, which for the very first
      // model of a lineage is just the references.
      league: (manifest?.league || [prior?.name, 'scripted'].filter(Boolean)).map((n) =>
        resolveModelName(n)
      )
    };
    gens.push(entry);
    previous.set(m.lineage, entry);
  }
  return gens;
}
