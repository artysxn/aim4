// ---------------------------------------------------------------------------
// server/similar/plays.js
// The eye's play tools, answered by the desktop app's own server beside the
// Similar Rounds scan (scan.js), from the same indexes.
//
//   plays    what each side did in a round: default or play, when, by whom,
//            and what each did to the win chance (src/replays/plays/findPlays.js);
//            with `guess`, the eye's own guess checked against it; with
//            `moves`, the unlabelled round it guesses from (roundMoves.js)
//   review   one play judged against the rounds most like it
//            (src/replays/plays/playReview.js)
//
// Both need the map's baseline: what a side usually does there. A baseline
// file wins when there is one (AIM4_PLAYS_DIR, then the one shipped in
// public/eye/play-baselines, built by tools/eye/plays/build-baselines.mjs on a
// whole library); otherwise it is learned here from the map's rounds in the
// library this server can read, once per map, and kept for 12 hours.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { learnBaseline, parseBaseline } from '../../src/replays/plays/playMap.js';
import { elapsedOf, findPlays, playKeys } from '../../src/replays/plays/findPlays.js';
import { playsReport } from '../../src/replays/plays/playTools.js';
import { reviewPlay } from '../../src/replays/plays/playReview.js';
import { roundMoves } from '../../src/replays/plays/roundMoves.js';
import { econBucket, econClass } from '../../src/replays/similar/roundSimilarity.js';
import { collectIndexes, listMapRounds, sourceIndex } from './scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIRS = [process.env.AIM4_PLAYS_DIR, path.join(here, '../../public/eye/play-baselines')].filter(Boolean);
/** A baseline learned here is learned again after this. */
const LIVE_TTL_MS = 12 * 60 * 60 * 1000;
/** Rounds a live baseline reads at most: plenty to know a map's defaults. */
const MAX_BASELINE_ROUNDS = 4000;

/** @type {Map<string, { baseline: object, at: number, from: string }>} */
const baselines = new Map();
/** @type {Map<string, Promise<object>>} */
const learning = new Map();
/** Plays per round, per baseline: a review reads the same rounds again and again. */
const playsMemo = new WeakMap();

function playsWith(baseline) {
  let memo = playsMemo.get(baseline);
  if (!memo) playsMemo.set(baseline, (memo = new Map()));
  return (index) => {
    let p = memo.get(index.file);
    if (!p) memo.set(index.file, (p = findPlays(index, baseline).plays));
    return p;
  };
}

/** For tests. */
export function clearBaselines() {
  baselines.clear();
  learning.clear();
}

async function baselineFile(map) {
  for (const dir of BASELINE_DIRS) {
    try {
      const b = parseBaseline(await fs.readFile(path.join(dir, `${map}.json`), 'utf8'));
      if (b) return { baseline: b, from: `a baseline file (${b.rounds} rounds)` };
    } catch {
      // Not there: the next place, then learn it.
    }
  }
  return null;
}

/**
 * The map's baseline: kept, from a file, or learned from the library.
 * @param {{ api: object, map: string, signal?: AbortSignal, emit?: (e: object) => void }} args
 */
export async function baselineFor({ api, map, signal, emit = () => {} }) {
  const kept = baselines.get(map);
  if (kept && Date.now() - kept.at < LIVE_TTL_MS) return kept;
  const file = await baselineFile(map);
  if (file) {
    const entry = { ...file, at: Date.now() };
    baselines.set(map, entry);
    return entry;
  }
  if (!learning.has(map)) {
    const job = (async () => {
      emit({ type: 'phase', phase: 'baseline' });
      const files = (await listMapRounds(api, { map }, signal)).slice(-MAX_BASELINE_ROUNDS);
      emit({ type: 'start', total: files.length, purpose: 'learning what is usual on this map' });
      const indexes = await collectIndexes({ api, files, signal, onProgress: (done, total) => emit({ type: 'progress', done, total }) });
      const baseline = await learnBaseline(map, { each: (fn) => indexes.forEach(fn), playsOf: playKeys });
      const entry = { baseline, at: Date.now(), from: `${indexes.length} rounds in your library` };
      baselines.set(map, entry);
      return entry;
    })();
    learning.set(map, job);
    job.finally(() => learning.delete(map)).catch(() => {});
  }
  return learning.get(map);
}

/** What the plays tool answers for a round. */
export async function playsFor({ api, ask, emit = () => {}, signal }) {
  emit({ type: 'phase', phase: 'source' });
  const source = await sourceIndex(api, ask.file, signal);
  const { baseline, from } = await baselineFor({ api, map: source.map, signal, emit });
  const plays = playsWith(baseline)(source);
  const out = { type: 'done', ...playsReport(source, plays, { guess: ask.guess, usualFrom: from }) };
  if (ask.moves) out.moves = roundMoves(source, baseline);
  emit(out);
  return out;
}

/** The play a request names: an id (T2), a clock inside it (1:05), or words of its label. */
export function pickPlay(plays, named) {
  const text = String(named || '').trim();
  if (!text) return null;
  const id = /^(T|CT)\s*(\d+)$/i.exec(text);
  if (id) return plays.find((p) => p.id === `${id[1].toUpperCase()}${id[2]}`) || null;
  const e = elapsedOf(text);
  if (e != null) {
    const inside = plays.filter((p) => e >= p.start - 3 && e <= p.end + 3 && p.kind !== 'opening');
    return inside.sort((a, b) => Math.abs(a.start - e) - Math.abs(b.start - e))[0] || null;
  }
  const words = text.toLowerCase();
  return plays.find((p) => p.label.toLowerCase().includes(words)) || plays.find((p) => words.includes(p.kind)) || null;
}

/** What the review tool answers for one play of a round. */
export async function reviewFor({ api, ask, emit = () => {}, signal }) {
  emit({ type: 'phase', phase: 'source' });
  const source = await sourceIndex(api, ask.file, signal);
  const { baseline } = await baselineFor({ api, map: source.map, signal, emit });
  const playsOf = playsWith(baseline);
  const plays = playsOf(source);
  const play = pickPlay(plays, ask.play);
  if (!play) {
    const list = plays.map((p) => `${p.id} ${p.label} (${p.clock})`).join('; ');
    throw Object.assign(new Error(`No play "${ask.play}" in this round. Its plays: ${list || 'none read'}.`), { status: 404 });
  }
  // The map's rounds in the same economy for that side: the scan's gate does the rest.
  emit({ type: 'phase', phase: 'list' });
  const bucket = econBucket(econClass(source.teams[play.side]?.econ));
  const files = (await listMapRounds(api, { map: source.map, economies: bucket == null ? [] : [bucket] }, signal)).filter((f) => f !== source.file);
  emit({ type: 'start', total: files.length, purpose: 'reading similar rounds' });
  const pool = await collectIndexes({ api, files, signal, onProgress: (done, total) => emit({ type: 'progress', done, total }) });
  const review = reviewPlay({ source, play, pool, baseline, playsOf, guess: ask.guess || null });
  const out = { type: 'done', round: source.file, map: source.map, ...review };
  emit(out);
  return out;
}
