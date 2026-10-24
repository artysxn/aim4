// ---------------------------------------------------------------------------
// tools/eye/plays/common.mjs
// What the plays training tools share: the map's zones when this machine has
// them, the baselines (read from out/baselines, or learned from the corpus),
// plays memoised per round, and the tool results exactly as the desktop
// server returns them (server/similar/plays.js), so what the model is trained
// on is what it reads in the app.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

import { MAX_RESULT_CHARS } from '../../../src/replays/eye/eyeTools.js';
import { findPlays, playKeys } from '../../../src/replays/plays/findPlays.js';
import { playsReport } from '../../../src/replays/plays/playTools.js';
import { baselineJson, learnBaseline, parseBaseline } from '../../../src/replays/plays/playMap.js';
import { reviewPlay } from '../../../src/replays/plays/playReview.js';
import { roundMoves } from '../../../src/replays/plays/roundMoves.js';
import { MAPS } from '../../../src/replays/shared/roundId.js';
import { bombSiteCenters } from '../../../src/replays/zones/bombSites.js';
import { positionsAtPoint } from '../../../src/replays/zones/pointInZone.js';
import { getZones } from '../../../server/zonesStore.js';
import { OUT_DIR } from './corpus.mjs';

export const BASELINE_DIR = path.join(OUT_DIR, 'baselines');

/** Callouts and named bombsites from the map's painted zones, when this machine has them. */
export async function zonesFor(map) {
  let network = null;
  try {
    network = await getZones(map);
  } catch {
    network = null;
  }
  if (!network?.positions?.length) return { namer: null, namedSites: null };
  const centers = bombSiteCenters(network, { mapCode: map });
  return {
    namer: (x, y) => positionsAtPoint(x, y, network)[0]?.name || '',
    namedSites: centers.a && centers.b ? { A: centers.a, B: centers.b } : null
  };
}

/** Learn one map's baseline from its rounds. */
export async function learnMap(map, indexes) {
  const { namer, namedSites } = await zonesFor(map);
  return learnBaseline(map, { each: (fn) => indexes.forEach(fn), playsOf: playKeys, namer, namedSites });
}

/**
 * Baselines for every map of the corpus: out/baselines/<MAP>.json when it was
 * built (build-baselines.mjs), else learned now from the corpus.
 */
export async function baselinesFor(corpus, { dir = BASELINE_DIR, learn = true } = {}) {
  const out = new Map();
  for (const [map, indexes] of corpus) {
    const file = path.join(dir, `${map}.json`);
    let b = fs.existsSync(file) ? parseBaseline(fs.readFileSync(file, 'utf8')) : null;
    if (!b && learn) b = await learnMap(map, indexes);
    if (b) out.set(map, b);
  }
  return out;
}

export function writeBaseline(dir, baseline) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${baseline.map}.json`), baselineJson(baseline));
}

/** Plays per round file, per baseline. */
export function playsMemo() {
  const memo = new Map();
  return (index, baseline) => {
    const key = `${baseline.map}:${index.file}`;
    if (!memo.has(key)) memo.set(key, findPlays(index, baseline).plays);
    return memo.get(key);
  };
}

export const mapName = (code) => MAPS[code]?.name || code;

/** A round named the way the eye names one to the user. */
export const roundLabel = (index) => `${index.teams.T?.name || 'T'} vs ${index.teams.CT?.name || 'CT'} on ${mapName(index.map)}, round ${index.round}`;

/** A tool result cut the way the app cuts it: the model is trained on what it is shown. */
export const fit = (value) => {
  const text = JSON.stringify(value);
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}… [cut: the rest did not fit]`;
};

/** round_moves, as the tool returns it. */
export const movesResult = (index, baseline) => roundMoves(index, baseline);

/** round_plays, as the tool returns it (lessons added as the page adds them). */
export function playsResult(index, baseline, plays, { guess = null, lessons = [], usualFrom = '' } = {}) {
  const out = playsReport(index, plays, { guess, usualFrom: usualFrom || `a baseline file (${baseline.rounds} rounds)` });
  if (lessons.length) out.lessons = lessons;
  return out;
}

/** play_review, as the tool returns it. */
export function reviewResult(index, play, pool, baseline, playsOf, { guess = null, lessons = [] } = {}) {
  const review = reviewPlay({ source: index, play, pool, baseline, playsOf: (i) => playsOf(i, baseline), guess });
  const out = { round: index.file, map: index.map, ...review };
  if (lessons.length) out.lessons = lessons;
  return out;
}

/** The plays a perfect reading would guess: what round_plays' check scores 100. */
export const truthGuess = (plays) =>
  plays
    .filter((p) => p.kind !== 'opening' && p.kind !== 'aggression')
    .map((p) => ({ side: p.side, kind: p.kind, ...(p.site ? { site: p.site } : {}), clock: p.clock }));

export function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
