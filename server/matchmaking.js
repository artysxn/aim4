// ---------------------------------------------------------------------------
// server/matchmaking.js — ranked queue + auto-start duels
// ---------------------------------------------------------------------------

import { S2C } from '../src/multiplayer/protocol.js';
import { DEFAULT_ELO, clampElo } from '../src/multiplayer/elo.js';
import { MM_SCORE_TARGET } from '../src/multiplayer/constants.js';

/** Pair the two queued players with the closest Elo rating. */
function findBestPair(queue) {
  if (queue.length < 2) return null;
  let best = null;
  let bestDiff = Infinity;
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const diff = Math.abs(queue[i].queueElo - queue[j].queueElo);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = [queue[i], queue[j]];
      }
    }
  }
  return best;
}

export class MatchmakingQueue {
  /** @param {import('./lobby.js').MultiplayerServer} server */
  constructor(server) {
    this.server = server;
    this.players = [];
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
      this.players.push(player);
    }

    this._notify(player);
    this._notifyAll();
    this._tryPair();
  }

  dequeue(player, notify = false) {
    if (!player.inQueue) return;
    player.inQueue = false;
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
    this.server._send(player, {
      t: S2C.QUEUE_STATUS,
      inQueue: player.inQueue,
      queueSize: this.players.length,
      elo: player.queueElo
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
