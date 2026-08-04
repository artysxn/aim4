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

export const CACHE_DIR = path.join(__dirname, '../round-cache');
export const FEATURE_VERSION = 1;

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
    kt: f.ctHasKit ? 1 : 0
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
      ctHasKit: e.kt === 1
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

export function cacheFileFor(demoName) {
  return path.join(CACHE_DIR, `v${FEATURE_VERSION}`, `${demoName}.jsonl`);
}

/** Every cached round, decoded. */
export async function loadRoundCorpus({ limit = 0, maps = null } = {}) {
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
      rounds.push(decodeRound(row));
    }
    demos.push({ name: name.replace(/\.jsonl$/, ''), header });
  }
  return { rounds, demos };
}
