// ---------------------------------------------------------------------------
// replays/dupeScan.js
// Finds and removes duplicate matches in the shared library — the same game
// imported twice (HLTV archive + a Drive folder, a re-uploaded bundle, ...).
//
// "Same name on the same map" is NOT a duplicate: teams re-play maps across
// events constantly. A duplicate is the same GAME, and the same game leaves
// the same rounds behind. A pair is marked duplicate only when ALL of these
// hold:
//   - identical map, identical team names, identical ten players
//   - final score within ±2 rounds per team
//   - ≥80% of rounds won by the same team (round-by-round winner sequence)
//   - at least 2 rounds where ≥90% of sampled (player, time) positions
//     coincide — the same people standing in the same spots at the same
//     seconds of the round, which two genuinely different games never do
//
// The metadata screens cost nothing (records only). Tick buffers are opened
// only for the survivors of the screens, so a library scan is dominated by a
// handful of position reads, not thousands.
//
// Of a confirmed pair, the copy with the LOWER parser revision is deleted;
// at equal revisions the older parse goes. The kept demo's stats index is
// left alone — deleting the loser drops its rounds from every table.
// ---------------------------------------------------------------------------

import {
  FLAG_ALIVE,
  HEADER_BYTES,
  PLAYER_SLOTS,
  RECORD_BYTES,
  readHeader
} from '../../src/replays/shared/tickFormat.js';
import { SHARED_LIBRARY } from './auth.js';
import { deleteDemo, listDemos, readRoundMeta, readRoundTicks } from './demoStore.js';
import { forgetDemoIndex } from './statsIndex.js';
import { libraryStatsIo } from './autoIndex.js';

/** Per-team final-score difference still considered "the same score". */
export const SCORE_TOLERANCE = 2;
/** Fraction of shared rounds that must be won by the same team. */
export const WINNER_AGREEMENT = 0.8;
/** Fraction of sampled positions that must coincide for a round to count
 *  as identical. */
export const ROUND_IDENTITY = 0.9;
/** Rounds that must be identical before the pair is a duplicate. */
export const MIN_IDENTICAL_ROUNDS = 2;
/** Raw position delta (quarter-units) treated as "the same spot": 16 raw =
 *  4 game units, generous enough for parser-revision jitter, far under any
 *  real gameplay difference. */
const POS_TOLERANCE_RAW = 16;
/** Seconds after freeze end to sample positions at. Spread through the
 *  round so an early-save and a late-execute both contribute. */
const SAMPLE_OFFSETS_S = [5, 10, 20, 30, 45];
/** Tick reads are the only real cost; cap them per pair. Two identical
 *  rounds end the search early anyway. */
const MAX_ROUND_CHECKS = 8;
/** Shared rounds required before the winner-sequence test means anything. */
const MIN_SHARED_ROUNDS = 8;

const norm = (s) => String(s || '').trim().toLowerCase();

/** Identity key for a player: steamid when the demo has one, name otherwise. */
const steamKey = (p) => (p?.steamId ? `s:${p.steamId}` : '');
const nameKey = (p) => `n:${norm(p?.name)}`;

/**
 * Pair up two ten-player lists, steamids first, names for the leftovers.
 * Returns [{a, b}] covering EVERY player of both lists, or null when the
 * rosters differ — which by the rules means "not a duplicate".
 */
export function matchPlayers(listA, listB) {
  const a = Array.isArray(listA) ? listA : [];
  const b = Array.isArray(listB) ? listB : [];
  if (!a.length || a.length !== b.length) return null;
  const bLeft = new Set(b.keys());
  const pairs = [];
  // Steamids are unambiguous; claim those matches first.
  for (const [ai, pa] of a.entries()) {
    const key = steamKey(pa);
    if (!key) continue;
    const bi = b.findIndex((pb, i) => bLeft.has(i) && steamKey(pb) === key);
    if (bi >= 0) {
      bLeft.delete(bi);
      pairs.push({ a: a[ai], b: b[bi] });
    }
  }
  // Anyone unmatched (either list missing steamids) must match by name.
  for (const pa of a) {
    if (pairs.some((p) => p.a === pa)) continue;
    const bi = b.findIndex((pb, i) => bLeft.has(i) && nameKey(pb) === nameKey(pa));
    if (bi < 0) return null;
    bLeft.delete(bi);
    pairs.push({ a: pa, b: b[bi] });
  }
  return bLeft.size === 0 ? pairs : null;
}

/**
 * The free screens: map, teams, players, score, winner sequence — records
 * only, no file IO. Returns null when the pair cannot be a duplicate, or
 * what the position check needs when it might be.
 */
export function screenPair(a, b) {
  if (!a || !b || a.id === b.id) return null;
  if (a.map !== b.map) return null;

  // Team names must be identical; the pair may be stored in either order.
  let orient = 0;
  if (norm(a.team1?.name) === norm(b.team1?.name) && norm(a.team2?.name) === norm(b.team2?.name)) {
    orient = 1;
  } else if (
    norm(a.team1?.name) === norm(b.team2?.name) &&
    norm(a.team2?.name) === norm(b.team1?.name)
  ) {
    orient = -1;
  } else {
    return null;
  }

  if (!matchPlayers(a.players, b.players)) return null;

  // Final score within tolerance, per team, in a's orientation.
  const bs1 = orient === 1 ? b.score?.team1 : b.score?.team2;
  const bs2 = orient === 1 ? b.score?.team2 : b.score?.team1;
  if (
    Math.abs((a.score?.team1 ?? 0) - (bs1 ?? 0)) > SCORE_TOLERANCE ||
    Math.abs((a.score?.team2 ?? 0) - (bs2 ?? 0)) > SCORE_TOLERANCE
  ) {
    return null;
  }

  // Round-by-round winners. Compared over round NUMBERS present in both, so
  // a pistol-fix renumbering on one copy only shifts the window, not the
  // verdict on the overlap.
  const winners = (r) => new Map((r.rounds || []).map((x) => [x.round, x.winner]));
  const wa = winners(a);
  const wb = winners(b);
  const shared = [...wa.keys()].filter((n) => wb.has(n)).sort((x, y) => x - y);
  if (shared.length < MIN_SHARED_ROUNDS) return null;
  let same = 0;
  for (const n of shared) {
    const w = orient === 1 ? wb.get(n) : 3 - wb.get(n);
    if (wa.get(n) === w) same++;
  }
  if (same / shared.length < WINNER_AGREEMENT) return null;

  return { orient, sharedRounds: shared, agreement: same / shared.length };
}

function view(buffer) {
  if (buffer instanceof DataView) return buffer;
  if (Buffer.isBuffer(buffer)) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength);
}

function positionAt(v, header, tick, slot) {
  const row = Math.max(
    0,
    Math.min(
      header.tickCount - 1,
      Math.round((tick - header.firstTick) / (header.stride || 1))
    )
  );
  const o = HEADER_BYTES + row * (header.recordBytes || RECORD_BYTES) * PLAYER_SLOTS + slot * (header.recordBytes || RECORD_BYTES);
  return {
    x: v.getInt16(o, true),
    y: v.getInt16(o + 2, true),
    alive: (v.getUint8(o + 13) & FLAG_ALIVE) !== 0
  };
}

/**
 * How much of one round is the other round: the fraction of sampled
 * (player, time) points where the same player stands in the same spot —
 * or is equally dead. null when the rounds cannot be compared (rosters
 * differ, or too little of either round exists to sample).
 */
export function roundIdentityFraction(metaA, bufA, metaB, bufB) {
  const pairs = matchPlayers(metaA?.players, metaB?.players);
  if (!pairs) return null;
  const vA = view(bufA);
  const vB = view(bufB);
  const hA = readHeader(vA);
  const hB = readHeader(vB);
  const rateA = hA.tickRate || metaA.tickRate || 64;
  const rateB = hB.tickRate || metaB.tickRate || 64;
  const lastA = Math.min(hA.firstTick + (hA.tickCount - 1) * (hA.stride || 1), metaA.endTick || Infinity);
  const lastB = Math.min(hB.firstTick + (hB.tickCount - 1) * (hB.stride || 1), metaB.endTick || Infinity);

  let total = 0;
  let matched = 0;
  let offsetsUsed = 0;
  for (const ds of SAMPLE_OFFSETS_S) {
    const tA = (metaA.freezeEndTick || 0) + ds * rateA;
    const tB = (metaB.freezeEndTick || 0) + ds * rateB;
    // The moment must exist in BOTH rounds, else a short round would score
    // "identical" on its first seconds alone.
    if (tA > lastA || tB > lastB) continue;
    offsetsUsed++;
    for (const { a: pa, b: pb } of pairs) {
      const posA = positionAt(vA, hA, tA, pa.slot);
      const posB = positionAt(vB, hB, tB, pb.slot);
      total++;
      if (posA.alive !== posB.alive) continue;
      if (!posA.alive) {
        matched++; // both dead at the same second: the same round
        continue;
      }
      if (
        Math.abs(posA.x - posB.x) <= POS_TOLERANCE_RAW &&
        Math.abs(posA.y - posB.y) <= POS_TOLERANCE_RAW
      ) {
        matched++;
      }
    }
  }
  // One sampled moment can coincide by luck (everyone at spawn); demand two.
  if (offsetsUsed < 2 || !total) return null;
  return matched / total;
}

/**
 * The paid check: open shared rounds and count identical ones. Stops as soon
 * as the verdict is decided either way.
 */
export async function verifyPair(io, user, a, b, screen) {
  const fileOf = (r) => new Map((r.rounds || []).map((x) => [x.round, x.file]));
  const filesA = fileOf(a);
  const filesB = fileOf(b);
  const rounds = screen.sharedRounds.filter((n) => filesA.has(n) && filesB.has(n));
  // Spread the checks through the match instead of burning the whole budget
  // on the first rounds.
  const step = Math.max(1, Math.floor(rounds.length / MAX_ROUND_CHECKS));
  const picked = [];
  for (let i = 0; i < rounds.length && picked.length < MAX_ROUND_CHECKS; i += step) {
    picked.push(rounds[i]);
  }

  let identical = 0;
  let checked = 0;
  for (const n of picked) {
    if (identical >= MIN_IDENTICAL_ROUNDS) break;
    // Not enough candidates left to reach the bar: the verdict is already no.
    if (identical + (picked.length - checked) < MIN_IDENTICAL_ROUNDS) break;
    try {
      const [metaA, metaB, bufA, bufB] = await Promise.all([
        io.readRoundMeta(user, filesA.get(n)),
        io.readRoundMeta(user, filesB.get(n)),
        io.readRoundTicks(user, filesA.get(n), 1),
        io.readRoundTicks(user, filesB.get(n), 1)
      ]);
      checked++;
      if (!metaA || !metaB || !bufA || !bufB) continue;
      const fraction = roundIdentityFraction(metaA, bufA, metaB, bufB);
      if (fraction != null && fraction >= ROUND_IDENTITY) identical++;
    } catch {
      checked++;
    }
  }
  return { duplicate: identical >= MIN_IDENTICAL_ROUNDS, identical, checked };
}

/**
 * Which copy dies: the lower parser revision, or at equal revisions the
 * older parse. Deterministic on ties so re-running never flip-flops.
 */
export function chooseLoser(a, b) {
  const rev = (r) => Number(r?.parser?.revision) || 0;
  if (rev(a) !== rev(b)) {
    return rev(a) < rev(b)
      ? { keep: b, remove: a, reason: `parser revision ${rev(a)} < ${rev(b)}` }
      : { keep: a, remove: b, reason: `parser revision ${rev(b)} < ${rev(a)}` };
  }
  const at = (r) => Number(r?.parsedAt) || Number(r?.uploadedAt) || 0;
  if (at(a) !== at(b)) {
    return at(a) < at(b)
      ? { keep: b, remove: a, reason: 'older parse' }
      : { keep: a, remove: b, reason: 'older parse' };
  }
  return a.id < b.id
    ? { keep: b, remove: a, reason: 'tie' }
    : { keep: a, remove: b, reason: 'tie' };
}

// ---- the sweep --------------------------------------------------------------

const state = {
  running: false,
  phase: null, // 'screening' | 'verifying'
  startedAt: null,
  finishedAt: null,
  progress: { done: 0, total: 0, etaSeconds: null, deleted: 0 },
  result: null,
  error: null
};

export function dupeScanStatus() {
  return { ...state, progress: { ...state.progress } };
}

export const matchLabel = (r) =>
  `${r.team1?.name || '?'} vs ${r.team2?.name || '?'} (${r.mapName || r.map}, ${r.score?.team1 ?? '?'}:${r.score?.team2 ?? '?'})`;

/** Map + unordered team names: the same bucket the library scan compares inside. */
export function groupKey(r) {
  return `${r?.map || ''}|${[norm(r?.team1?.name), norm(r?.team2?.name)].sort().join('~')}`;
}

/**
 * Find an already-stored demo that is the same GAME as `candidate`.
 *
 * Same screens and position verify as the admin duplicate tool. The incoming
 * copy always loses: this returns the existing record, never the candidate.
 */
export async function findIdenticalMatch(io, user, candidate, records) {
  if (!candidate?.id || !Array.isArray(candidate.rounds) || !candidate.rounds.length) {
    return null;
  }
  const key = groupKey(candidate);
  const others = (records || []).filter(
    (r) =>
      r &&
      r.id &&
      r.id !== candidate.id &&
      r.status === 'ready' &&
      Array.isArray(r.rounds) &&
      r.rounds.length &&
      groupKey(r) === key
  );
  for (const other of others) {
    const screen = screenPair(candidate, other);
    if (!screen) continue;
    try {
      const verdict = await verifyPair(io, user, candidate, other, screen);
      if (verdict.duplicate) return other;
    } catch (err) {
      console.warn(`[dupeScan] ${candidate.id} vs ${other.id}: ${err?.message || err}`);
    }
  }
  return null;
}

/** Status line for a cancelled upload. Names the file and the copy already in the library. */
export function duplicateUploadMessage(filename, existing) {
  const name = String(filename || '').trim() || 'That demo';
  return existing ? `${name} already exists (${matchLabel(existing)}).` : `${name} already exists.`;
}

/**
 * If `record` is the same game as something already in this library, delete
 * the incoming copy and return why. No-op when it is unique.
 */
export async function discardDuplicateUpload(user, record, { filename, io } = {}) {
  if (!record?.id) return null;
  const existing = await findIdenticalMatch(
    io || { readRoundMeta, readRoundTicks },
    user,
    record,
    await listDemos(user)
  );
  if (!existing) return null;
  await deleteDemo(user, record.id);
  await forgetDemoIndex(libraryStatsIo, user, record.id).catch(() => {});
  return {
    existing,
    message: duplicateUploadMessage(filename || record.filename, existing)
  };
}

/**
 * Start a scan. `del: false` marks duplicates and reports them without
 * touching anything. Returns { started } or { busy }.
 */
export function startDupeScan({ del = true } = {}) {
  if (state.running) return { busy: true };
  state.running = true;
  state.phase = 'screening';
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.progress = { done: 0, total: 0, etaSeconds: null, deleted: 0 };
  state.result = null;
  state.error = null;

  void (async () => {
    const result = {
      scanned: 0,
      candidates: 0,
      duplicates: 0,
      deleted: 0,
      failed: 0,
      dryRun: !del,
      /** @type {{ kept: string, removed: string, reason: string, removedId: string }[]} */
      pairs: []
    };
    try {
      const records = (await listDemos(SHARED_LIBRARY)).filter(
        (r) => r.status === 'ready' && Array.isArray(r.rounds) && r.rounds.length
      );
      result.scanned = records.length;

      // Group by map + unordered team-name pair so the pair loop only ever
      // compares plausible rematches, not the whole library squared.
      const groups = new Map();
      for (const r of records) {
        const key = groupKey(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }
      const candidates = [];
      for (const group of groups.values()) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const screen = screenPair(group[i], group[j]);
            if (screen) candidates.push({ a: group[i], b: group[j], screen });
          }
        }
      }
      result.candidates = candidates.length;
      state.phase = 'verifying';
      state.progress.total = candidates.length;

      const io = { readRoundMeta, readRoundTicks };
      const removed = new Set();
      const verifyStart = Date.now();
      for (const { a, b, screen } of candidates) {
        // A copy already deleted this run cannot lose twice.
        if (removed.has(a.id) || removed.has(b.id)) {
          state.progress.done++;
          continue;
        }
        try {
          const verdict = await verifyPair(io, SHARED_LIBRARY, a, b, screen);
          if (verdict.duplicate) {
            const { keep, remove, reason } = chooseLoser(a, b);
            result.duplicates++;
            result.pairs.push({
              kept: matchLabel(keep),
              removed: matchLabel(remove),
              removedId: remove.id,
              reason
            });
            if (del) {
              await deleteDemo(SHARED_LIBRARY, remove.id);
              await forgetDemoIndex(libraryStatsIo, SHARED_LIBRARY, remove.id).catch(() => {});
              removed.add(remove.id);
              result.deleted++;
              state.progress.deleted = result.deleted;
            }
          }
        } catch (err) {
          result.failed++;
          console.warn(`[dupeScan] ${a.id} vs ${b.id}: ${err?.message || err}`);
        }
        state.progress.done++;
        const done = state.progress.done;
        if (done > 0 && done < candidates.length) {
          const perPair = (Date.now() - verifyStart) / done;
          state.progress.etaSeconds = Math.round(((candidates.length - done) * perPair) / 1000);
        } else {
          state.progress.etaSeconds = 0;
        }
      }
      state.result = result;
    } catch (err) {
      state.error = String(err?.message || err);
    } finally {
      state.running = false;
      state.phase = null;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return { started: true };
}
