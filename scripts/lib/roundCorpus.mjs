// ---------------------------------------------------------------------------
// scripts/lib/roundCorpus.mjs
// On-disk format for extracted round snapshots.
//
// Extraction is the slow half: every snapshot runs the duel model over every
// open fight on the map, which means the vision stack, which means raycasts. It
// happens once and the result is cached so that fitting, which reads the cache
// hundreds of times, never pays for it again.
//
// Node-only.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the extracted corpus lives.
 *
 * Defaults to the repo for the local CLI workflow. On the server it must sit on
 * the persistent volume beside the replay library and the painted zones, or
 * every deploy would throw away hours of extraction. Same reasoning, and same
 * environment variable, as zonesStore's ZONES_ROOT.
 */
export const CACHE_DIR = process.env.AIM4_TRAIN_CACHE_DIR
  ? path.join(process.env.AIM4_TRAIN_CACHE_DIR, 'round-cache')
  : path.join(__dirname, '../round-cache');
/**
 * 2: bomb geometry, site occupancy, key zone possession and defuse feasibility.
 * 3: bomb distances measured on foot over the walkable raster instead of as
 *    straight lines through walls.
 *
 * The cache is keyed by this, so an older extraction is simply ignored rather
 * than silently fed to a model that now expects different numbers in the same
 * fields.
 */
export const FEATURE_VERSION = 3;

/** Nuke has no painted vision geometry and two floors a flat test cannot split. */
export const SKIP_MAPS = ['NUK'];

const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

export function encodeSnapshot(s) {
  const f = s.f;
  return {
    t: s.tick,
    ph: s.phase,
    x: s.exam || '',
    y: s.y,
    ca: f.ctAlive,
    ta: f.tAlive,
    ce: r3(f.ctEff),
    te: r3(f.tEff),
    eq: r3(f.equipDiff),
    ut: r3(f.utilDiff),
    po: r3(f.possessionDiff),
    de: r3(f.duelEdge),
    od: f.openDuels,
    cd: r3(f.centroidDist),
    nd: r3(f.nearestDist),
    sl: r3(f.secondsLeft),
    pl: f.planted ? 1 : 0,
    bl: r3(f.bombSecondsLeft),
    kt: f.ctHasKit ? 1 : 0,
    // --- v2: the bomb and the ground around it ------------------------------
    be: r3(f.bombDuelEdge),
    cb: r3(f.ctBombDist),
    tb: r3(f.tBombDist),
    bd: r3(f.bombDistDiff),
    ci: f.ctInSite,
    ti: f.tInSite,
    kz: r3(f.keyZoneNet),
    ds: r3(f.defuseSlack),
    di: f.defuseImpossible ? 1 : 0
  };
}

export function decodeSnapshot(e) {
  return {
    tick: e.t,
    phase: e.ph,
    exam: e.x || '',
    y: e.y,
    f: {
      ctAlive: e.ca,
      tAlive: e.ta,
      ctEff: e.ce,
      tEff: e.te,
      equipDiff: e.eq,
      utilDiff: e.ut,
      possessionDiff: e.po,
      duelEdge: e.de,
      openDuels: e.od,
      centroidDist: e.cd,
      nearestDist: e.nd,
      secondsLeft: e.sl,
      planted: e.pl === 1,
      bombSecondsLeft: e.bl,
      ctHasKit: e.kt === 1,
      bombDuelEdge: e.be || 0,
      ctBombDist: e.cb || 0,
      tBombDist: e.tb || 0,
      bombDistDiff: e.bd || 0,
      ctInSite: e.ci || 0,
      tInSite: e.ti || 0,
      keyZoneNet: e.kz || 0,
      defuseSlack: e.ds || 0,
      defuseImpossible: e.di === 1
    }
  };
}

/** One round as a cache line: its identity plus every snapshot taken from it. */
export function encodeRound({ demo, map, round, roundId, winnerSide, samples }) {
  return {
    d: demo,
    m: map,
    r: round,
    id: roundId,
    w: winnerSide,
    s: samples.map(encodeSnapshot)
  };
}

export function decodeRound(e) {
  return {
    demo: e.d,
    map: e.m,
    round: e.r,
    roundId: e.id,
    winnerSide: e.w,
    // One round is one vote however many times it was sampled, so a long round
    // cannot outweigh a short one just by lasting.
    weight: e.s.length ? 1 / e.s.length : 0,
    samples: e.s.map(decodeSnapshot)
  };
}

/**
 * Cache filenames come from demo names, which on a server library are whatever
 * the uploader called the file. Anything that is not plainly safe becomes an
 * underscore so a name can never escape the cache directory or break on a
 * filesystem that dislikes it.
 */
export function cacheKey(demoName) {
  return String(demoName || 'unnamed')
    .replace(/\.(dem|aim4replay)$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);
}

export function cacheFileFor(demoName) {
  return path.join(CACHE_DIR, `v${FEATURE_VERSION}`, `${cacheKey(demoName)}.jsonl`);
}

/**
 * Demo names in the corpus, from each file's header line only.
 *
 * Cheap: one line read per demo rather than a full parse. It exists so the
 * trainer and its workers can derive the same held-out split without either of
 * them having to decode the corpus first, which is what makes it possible for a
 * worker to skip decoding the rounds it does not own.
 */
export async function listCorpusDemos({ limit = 0 } = {}) {
  const dir = path.join(CACHE_DIR, `v${FEATURE_VERSION}`);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  if (limit) names = names.slice(0, limit);

  const demos = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    const nl = text.indexOf('\n');
    const first = nl >= 0 ? text.slice(0, nl) : text;
    try {
      const header = JSON.parse(first);
      if (header?.header && header.demo) demos.push(String(header.demo));
    } catch {
      /* a file without a readable header contributes no demo name */
    }
  }
  return [...new Set(demos)].sort();
}

/**
 * The held-out demos, given every demo name.
 *
 * One definition, used by the trainer and by every worker. If these ever
 * disagreed, workers would be scoring rows the trainer thinks are held out and
 * the reported held-out loss would be quietly meaningless.
 */
export function holdoutSet(names, holdout = 0.2) {
  const sorted = [...names].sort();
  const count = Math.max(1, Math.round(sorted.length * holdout));
  return new Set(sorted.slice(0, count));
}

/** Every cached round, decoded. */
export async function loadRoundCorpus({ limit = 0, maps = null, keepRound = null } = {}) {
  const dir = path.join(CACHE_DIR, `v${FEATURE_VERSION}`);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    throw new Error(`No cache at ${dir}. Run: node scripts/extract-round-snapshots.mjs`);
  }
  if (limit) names = names.slice(0, limit);

  const rounds = [];
  const demos = [];
  /** Position in the undecoded stream, so sharding is stable across workers. */
  let index = 0;
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    let header = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.header) {
        header = row;
        continue;
      }
      if (maps?.length && !maps.includes(row.m)) continue;
      // Decoding is the expensive half, so a caller that only wants a slice
      // says so before it happens rather than after. A training worker owning
      // one shard of four would otherwise build the whole corpus and throw
      // three quarters of it away, in a thread sharing the process heap with
      // every other worker doing exactly the same thing.
      const keep = !keepRound || keepRound(row, index);
      index++;
      if (!keep) continue;
      rounds.push(decodeRound(row));
    }
    demos.push({ name: name.replace(/\.jsonl$/, ''), header });
  }
  return { rounds, demos };
}
