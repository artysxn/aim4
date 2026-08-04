// ---------------------------------------------------------------------------
// replays/duels/duelStats.js
// Per-player duel numbers for the scoreboard.
//
// Two things worth being clear about, because they are easy to confuse.
//
// PFW is how hard the fights were. It is the average chance the model gave a
// player across every active duel they were in, so a low number means they kept
// ending up in bad spots and a high one means they picked their fights or their
// team set them up well. It says nothing about whether they won.
//
// PFO is whether they beat those odds. It is their actual win rate minus what
// was predicted, in percentage points, so it is already adjusted for difficulty:
// a player who only ever takes 80% fights and wins 80% of them scores zero,
// while one who wins half their 30% fights scores strongly positive. This is the
// number that says something about the player rather than their situation.
//
// The two are meant to be read together. PFW alone rewards cowardice and PFO
// alone hides it.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { predictDuel } from './duelModel.js';
import { paramVector } from './duelModelParams.js';
import { extractEpisodes } from './episodes.js';

/** Width of the calibration buckets, in percentage points. */
export const PFO_BUCKET_PCT = 5;

/** @returns {{ players: Map<string, object>, rounds: number, duels: number }} */
export function createDuelStats() {
  return { players: new Map(), rounds: 0, duels: 0 };
}

function entryFor(stats, id, name) {
  let e = stats.players.get(id);
  if (!e) {
    e = {
      id,
      name,
      /** Total duel weight: one per duel, however many snapshots it had. */
      weight: 0,
      /** Sum of the odds the model gave this player, weighted. */
      predSum: 0,
      /** Weighted count of duels they went on to win. */
      wins: 0,
      /** bucket centre -> { weight, wins, predSum } */
      buckets: new Map()
    };
    stats.players.set(id, e);
  }
  if (name && !e.name) e.name = name;
  return e;
}

function addSample(entry, pred, won, weight) {
  entry.weight += weight;
  entry.predSum += pred * weight;
  if (won) entry.wins += weight;

  const centre = Math.round((pred * 100) / PFO_BUCKET_PCT) * PFO_BUCKET_PCT;
  let b = entry.buckets.get(centre);
  if (!b) {
    b = { weight: 0, wins: 0, predSum: 0 };
    entry.buckets.set(centre, b);
  }
  b.weight += weight;
  b.predSum += pred * weight;
  if (won) b.wins += weight;
}

/**
 * Fold one round's duels into the running totals.
 *
 * Only resolved duels count. An engagement that dissolved without a kill has no
 * outcome to compare a prediction against, so including it would drag every
 * player's overperformance toward zero for no reason.
 *
 * @param {object} stats  from createDuelStats
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack} args.track
 * @param {object} args.network   prepared zone network
 * @param {string} args.mapCode
 */
export function addRoundDuels(stats, { meta, track, network, mapCode }) {
  const v = paramVector();
  const bySlot = new Map((meta.players || []).map((p) => [p.slot, p]));
  const { episodes } = extractEpisodes({
    meta,
    track,
    network,
    mapCode,
    roundFile: meta.id || ''
  });

  stats.rounds++;
  for (const ep of episodes) {
    if (ep.winnerSlot === null || !ep.samples.length) continue;
    const a = bySlot.get(ep.aSlot);
    const b = bySlot.get(ep.bSlot);
    if (!a || !b) continue;
    stats.duels++;

    const ea = entryFor(stats, a.id, a.name);
    const eb = entryFor(stats, b.id, b.name);
    const aWon = ep.winnerSlot === ep.aSlot;
    // One duel is one vote for each of its two players, spread evenly over
    // however many moments of it were sampled.
    const w = 1 / ep.samples.length;

    for (const ctx of ep.samples) {
      const p = predictDuel(ctx, v);
      addSample(ea, p, aWon, w);
      addSample(eb, 1 - p, !aWon, w);
    }
  }
}

/**
 * Finished per-player numbers.
 *
 * The overall overperformance is computed straight from the totals rather than
 * by averaging the buckets. The two are the same number when the buckets are
 * weighted by how many duels they hold, which they must be: a bucket with one
 * duel in it should not count as much as one with fifty. The buckets are kept
 * so the breakdown can be shown, not because the headline needs them.
 *
 * @returns {Map<string, { pfw: number, pfo: number, duels: number, buckets: Array }>}
 */
export function summarizeDuelStats(stats) {
  const out = new Map();
  for (const [id, e] of stats.players) {
    if (e.weight <= 0) continue;
    out.set(id, {
      id,
      name: e.name,
      duels: e.weight,
      pfw: (e.predSum / e.weight) * 100,
      pfo: ((e.wins - e.predSum) / e.weight) * 100,
      buckets: [...e.buckets]
        .filter(([, b]) => b.weight >= 0.5)
        .sort((x, y) => x[0] - y[0])
        .map(([centre, b]) => ({
          centre,
          duels: b.weight,
          predicted: (b.predSum / b.weight) * 100,
          actual: (b.wins / b.weight) * 100,
          delta: ((b.wins - b.predSum) / b.weight) * 100
        }))
    });
  }
  return out;
}

/**
 * Team numbers: the plain average across the side's players.
 *
 * Averaging the players rather than pooling their duels is deliberate, and it
 * is what was asked for. Pooling would let one player who fought twice as often
 * as the rest speak for the team; averaging gives each of the five an equal say
 * in how the side performed.
 *
 * @param {Map<string, object>} summary  from summarizeDuelStats
 * @param {Array<{id: string, team: number}>} roster
 */
export function teamDuelStats(summary, roster) {
  const teams = new Map();
  for (const p of roster || []) {
    const s = summary.get(p.id);
    if (!s) continue;
    let t = teams.get(p.team);
    if (!t) {
      t = { team: p.team, members: [], pfw: 0, pfo: 0, duels: 0 };
      teams.set(p.team, t);
    }
    t.members.push(s);
    t.duels += s.duels;
  }
  for (const t of teams.values()) {
    const n = t.members.length || 1;
    t.pfw = t.members.reduce((s, m) => s + m.pfw, 0) / n;
    t.pfo = t.members.reduce((s, m) => s + m.pfo, 0) / n;
  }
  return teams;
}

/**
 * Compact per-player totals for one round, for the stats index.
 *
 * Shape: `{ [playerId]: { w, p, n, b } }` where `w` is duel weight, `p` is the
 * sum of predicted odds, `n` is the weighted win count, and `b` is the 5% PFO
 * buckets as `[centre, w, p, n][]`. Aggregation across filtered rounds is then
 * `PFW = p/w` and `PFO = (n-p)/w`, the same formulas summarizeDuelStats uses
 * on a whole match.
 *
 * @returns {Record<string, { w: number, p: number, n: number, b: number[][] }> | null}
 */
export function roundDuelBag({ meta, track, network, mapCode }) {
  if (!meta?.players?.length || !track || !network || !mapCode) return null;
  const stats = createDuelStats();
  addRoundDuels(stats, { meta, track, network, mapCode });
  if (!stats.duels) return {};
  /** @type {Record<string, { w: number, p: number, n: number, b: number[][] }>} */
  const bag = {};
  for (const [id, e] of stats.players) {
    if (e.weight <= 0) continue;
    bag[id] = {
      w: Math.round(e.weight * 1e6) / 1e6,
      p: Math.round(e.predSum * 1e6) / 1e6,
      n: Math.round(e.wins * 1e6) / 1e6,
      b: [...e.buckets]
        .filter(([, b]) => b.weight > 0)
        .map(([centre, b]) => [
          centre,
          Math.round(b.weight * 1e6) / 1e6,
          Math.round(b.predSum * 1e6) / 1e6,
          Math.round(b.wins * 1e6) / 1e6
        ])
    };
  }
  return bag;
}
