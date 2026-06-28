// ---------------------------------------------------------------------------
// server/matchmaking.js — ranked queue + auto-start duels
// ---------------------------------------------------------------------------

import { S2C } from '../src/multiplayer/protocol.js';
import { DEFAULT_ELO, clampElo } from '../src/multiplayer/elo.js';
import { MM_SCORE_TARGET } from '../src/multiplayer/constants.js';

/** Starting |ΔElo| allowed when pairing — instant match on enqueue when within this band. */
const MM_INITIAL_ELO_RANGE = 100;
/** Extra Elo range per interval (both players must fit within the tighter of their ranges). */
const MM_ELO_RANGE_STEP = 25;
const MM_ELO_RANGE_INTERVAL_MS = 10_000;
const MM_MAX_ELO_RANGE = 600;
/** After this wait, pair the closest-Elo duo even if still outside range. */
const MM_FORCE_PAIR_MS = 120_000;
const MM_PAIR_POLL_MS = 3_000;

function queueWaitMs(player, now = Date.now()) {
  return Math.max(0, now - (player.queueJoinedAt || now));
}

/** Max |ΔElo| this player will accept at the given queue time. */
export function maxEloDiffForWait(waitMs) {
  const steps = Math.floor(waitMs / MM_ELO_RANGE_INTERVAL_MS);
  return Math.min(MM_MAX_ELO_RANGE, MM_INITIAL_ELO_RANGE + steps * MM_ELO_RANGE_STEP);
}

function maxEloDiff(player, now = Date.now()) {
  return maxEloDiffForWait(queueWaitMs(player, now));
}

/**
 * Pair the closest-Elo duo whose ratings fit each other's widening search range.
 * Falls back to closest pair if either player has waited longer than MM_FORCE_PAIR_MS.
 */
function findBestPair(queue, now = Date.now()) {
  if (queue.length < 2) return null;

  let best = null;
  let bestDiff = Infinity;

  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const diff = Math.abs(queue[i].queueElo - queue[j].queueElo);
      const allowed = Math.min(maxEloDiff(queue[i], now), maxEloDiff(queue[j], now));
      if (diff > allowed) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = [queue[i], queue[j]];
      }
    }
  }
  if (best) return best;

  let force = null;
  let forceDiff = Infinity;
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const diff = Math.abs(queue[i].queueElo - queue[j].queueElo);
      const longestWait = Math.max(queueWaitMs(queue[i], now), queueWaitMs(queue[j], now));
      if (longestWait < MM_FORCE_PAIR_MS) continue;
      if (diff < forceDiff) {
        forceDiff = diff;
        force = [queue[i], queue[j]];
      }
    }
  }
  return force;
}

export class MatchmakingQueue {
  /** @param {import('./lobby.js').MultiplayerServer} server */
  constructor(server) {
    this.server = server;
    this.players = [];
    this._pairTimer = setInterval(() => {
      if (this.players.length) this._notifyAll();
      this._tryPair();
    }, MM_PAIR_POLL_MS);
  }

  enqueue(player, msg) {
    const s = this.server;
    if (player.lobby) {
      return s._send(player, { t: S2C.ERROR, msg: 'Leave your lobby before queuing.' });
    }

    s.browsers.delete(player);
    if (msg.name) player.name = String(msg.name).slice(0, 24);
    if (msg.userId) player.userId = String(msg.userId).slice(0, 36);
    player.queueElo = clampElo(msg.elo ?? player.queueElo ?? DEFAULT_ELO);

    if (!player.inQueue) {
      player.inQueue = true;
      player.queueJoinedAt = Date.now();
      this.players.push(player);
    }

    this._notify(player);
    this._notifyAll();
    this._tryPair();
  }

  dequeue(player, notify = false) {
    if (!player.inQueue) return;
    player.inQueue = false;
    player.queueJoinedAt = null;
    this.players = this.players.filter((p) => p !== player);
    if (notify) {
      this._notify(player);
      this._notifyAll();
    }
  }

  remove(player) {
    this.dequeue(player, false);
  }

  _notify(player) {
    const waitMs = player.inQueue ? queueWaitMs(player) : 0;
    this.server._send(player, {
      t: S2C.QUEUE_STATUS,
      inQueue: player.inQueue,
      queueSize: this.players.length,
      elo: player.queueElo,
      searchRange: player.inQueue ? maxEloDiffForWait(waitMs) : null
    });
  }

  _notifyAll() {
    for (const p of this.players) this._notify(p);
  }

  _tryPair() {
    const pair = findBestPair(this.players);
    if (!pair) return;

    const [pA, pB] = pair;
    this.dequeue(pA, false);
    this.dequeue(pB, false);
    this.server._startRankedDuel(pA, pB);
  }
}

/** Build a private ranked lobby object (first to MM_SCORE_TARGET). */
export function createRankedLobby(code, pA, pB) {
  return {
    code,
    hostId: pA.id,
    players: [pA, pB],
    mapId: null,
    target: MM_SCORE_TARGET,
    isPublic: false,
    isMatchmade: true,
    started: false,
    scores: {},
    mmElos: {
      [pA.id]: pA.queueElo,
      [pB.id]: pB.queueElo
    }
  };
}
