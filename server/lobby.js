// ---------------------------------------------------------------------------
// server/lobby.js
// Authoritative multiplayer for 1v1 duels. Owns lobbies, the 128 Hz match tick,
// server-side hit registration (via hitscan.js) and "first to X" scoring.
//
// Authority model: clients own their own transform (reported each frame) — fine
// for an aim trainer — but the SERVER is authoritative for hit registration,
// HP, scoring, deaths, respawns and match end. Shots are queued and resolved on
// the tick so every client is judged against the same 128 Hz simulation step.
// ---------------------------------------------------------------------------

import { C2S, S2C } from '../src/multiplayer/protocol.js';
import {
  TICK_MS,
  MAX_PLAYERS,
  RESPAWN_DELAY,
  STAND_EYE,
  eyeOffset,
  SPAWN_GRACE,
  SNAPSHOT_EVERY
} from '../src/multiplayer/constants.js';
import { getMap, spawnFor, pickRandomMap, spawnPair } from '../src/multiplayer/maps.js';
import { resolveShot } from './hitscan.js';
import { pushTransformHistory, sampleTransformAt, lagRewindMs } from './lagComp.js';

const VALID_TARGETS = new Set([0, 13, 30, 60, 100]);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

function freshStats() {
  return { deaths: 0, shots: 0, hits: 0, ttkSum: 0, ttkCount: 0 };
}

let nextPlayerId = 1;

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class MultiplayerServer {
  constructor() {
    this.lobbies = new Map(); // code -> lobby
    this.players = new Map(); // id -> player
    this.browsers = new Set(); // players currently viewing the lobby browser
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._lastTick = Date.now();
    this._simTick = 0;
  }

  // ---- Connection lifecycle ----------------------------------------------
  addConnection(ws) {
    const id = nextPlayerId++;
    const player = {
      id,
      ws,
      name: `Player ${id}`,
      lobby: null,
      side: null,
      ready: false,
      // live match state
      transform: { x: 0, y: STAND_EYE, z: 0, yaw: 0, pitch: 0, crouch: 0 },
      hp: 2,
      dead: false,
      respawnAt: 0,
      shotQueue: [],
      history: [],
      rttMs: 0
    };
    this.players.set(id, player);
    this._send(player, { t: S2C.WELCOME, id });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handle(player, msg);
    });
    ws.on('close', () => this._disconnect(player));
    ws.on('error', () => this._disconnect(player));
  }

  _disconnect(player) {
    if (!this.players.has(player.id)) return;
    this.browsers.delete(player);
    this._leaveLobby(player);
    this.players.delete(player.id);
  }

  // ---- Message routing ----------------------------------------------------
  _handle(player, msg) {
    switch (msg.t) {
      case C2S.CREATE:
        return this._create(player, msg);
      case C2S.JOIN:
        return this._join(player, msg);
      case C2S.LEAVE:
        return this._leaveLobby(player, true);
      case C2S.READY:
        return this._setReady(player, !!msg.ready);
      case C2S.CONFIG:
        return this._config(player, msg);
      case C2S.START:
        return this._start(player);
      case C2S.STATE:
        return this._state(player, msg);
      case C2S.SHOOT:
        return this._shoot(player, msg);
      case C2S.CHAT:
        return this._chat(player, msg);
      case C2S.PING:
        return this._ping(player, msg);
      case C2S.LIST:
        this.browsers.add(player);
        return this._sendLobbyList(player);
      case C2S.UNLIST:
        this.browsers.delete(player);
        return;
    }
  }

  _create(player, msg) {
    this._leaveLobby(player);
    this.browsers.delete(player);
    if (msg.name) player.name = String(msg.name).slice(0, 24);

    let code = randomCode();
    while (this.lobbies.has(code)) code = randomCode();

    const target = VALID_TARGETS.has(msg.target) ? msg.target : 13;
    const lobby = {
      code,
      hostId: player.id,
      players: [player],
      mapId: null, // chosen randomly when the match starts / each round
      target,
      isPublic: msg.isPublic !== false, // default public
      started: false,
      scores: {}
    };
    this.lobbies.set(code, lobby);
    player.lobby = lobby;
    player.side = 'A';
    player.ready = false;
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  _join(player, msg) {
    this._leaveLobby(player);
    const code = String(msg.code || '').trim().toUpperCase();
    const lobby = this.lobbies.get(code);
    if (!lobby) return this._send(player, { t: S2C.ERROR, msg: 'Lobby not found.' });
    if (lobby.started) return this._send(player, { t: S2C.ERROR, msg: 'Match already in progress.' });
    if (lobby.players.length >= MAX_PLAYERS) return this._send(player, { t: S2C.ERROR, msg: 'Lobby is full.' });

    if (msg.name) player.name = String(msg.name).slice(0, 24);
    this.browsers.delete(player);
    lobby.players.push(player);
    player.lobby = lobby;
    player.side = 'B';
    player.ready = false;
    this._broadcastLobby(lobby);
    this._pushLobbyList(); // lobby is now full -> drops out of the browser
  }

  _leaveLobby(player, notifySelf = false) {
    const lobby = player.lobby;
    player.lobby = null;
    player.side = null;
    player.ready = false;
    if (!lobby) return;

    lobby.players = lobby.players.filter((p) => p !== player);

    if (lobby.players.length === 0) {
      this.lobbies.delete(lobby.code);
      this._pushLobbyList();
      return;
    }
    // Promote a new host if needed.
    if (lobby.hostId === player.id) lobby.hostId = lobby.players[0].id;

    // A player leaving mid-match aborts it back to the lobby.
    if (lobby.started) {
      lobby.started = false;
      for (const p of lobby.players) {
        p.ready = false;
        this._send(p, { t: S2C.MATCH_END, winnerId: lobby.players[0].id, scores: lobby.scores, aborted: true });
      }
    }
    this._broadcastLobby(lobby);
    this._pushLobbyList(); // a freed slot may re-list this lobby
    if (notifySelf) this._send(player, { t: S2C.PLAYER_LEFT, id: player.id });
  }

  _setReady(player, ready) {
    if (!player.lobby || player.lobby.started) return;
    player.ready = ready;
    this._broadcastLobby(player.lobby);
  }

  _config(player, msg) {
    const lobby = player.lobby;
    if (!lobby || lobby.hostId !== player.id || lobby.started) return;
    if (VALID_TARGETS.has(msg.target)) lobby.target = msg.target;
    if (typeof msg.isPublic === 'boolean') lobby.isPublic = msg.isPublic;
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  _start(player) {
    const lobby = player.lobby;
    if (!lobby || lobby.hostId !== player.id || lobby.started) return;
    if (lobby.players.length < MAX_PLAYERS) {
      return this._send(player, { t: S2C.ERROR, msg: 'Need a second player to start.' });
    }
    if (!lobby.players.every((p) => p.ready || p.id === lobby.hostId)) {
      return this._send(player, { t: S2C.ERROR, msg: 'All players must be ready.' });
    }

    lobby.started = true;
    lobby.mapId = pickRandomMap(lobby.mapId).id;
    lobby.scores = {};
    for (const p of lobby.players) {
      lobby.scores[p.id] = 0;
      p.stats = freshStats();
      p.roundStartAt = Date.now();
    }
    this._pushLobbyList(); // started lobbies leave the browser

    const spawns = this._spawnAll(lobby);
    const stats = this._buildStats(lobby);
    for (const p of lobby.players) {
      this._send(p, {
        t: S2C.MATCH_START,
        mapId: lobby.mapId,
        target: lobby.target,
        spawns,
        scores: lobby.scores,
        stats
      });
    }
  }

  /** Assign + reset spawns for everyone; returns { playerId: {pos,yaw,side} }. */
  _spawnAll(lobby) {
    const map = getMap(lobby.mapId);
    const pair = spawnPair(map);
    const spawns = {};
    for (const p of lobby.players) {
      const sp = pair[p.side] || spawnFor(map, p.side);
      p.transform = { x: sp.pos[0], y: sp.pos[1] + STAND_EYE, z: sp.pos[2], yaw: sp.yaw, pitch: 0, crouch: 0 };
      p.hp = 2;
      p.dead = false;
      p.respawnAt = 0;
      p.shotQueue.length = 0;
      p.history = [];
      p.roundStartAt = Date.now();
      pushTransformHistory(p);
      spawns[p.id] = { pos: sp.pos, yaw: sp.yaw, side: p.side };
    }
    return spawns;
  }

  _state(player, msg) {
    const lobby = player.lobby;
    if (!lobby || !lobby.started || player.dead) return;
    if (Date.now() - player.roundStartAt < SPAWN_GRACE * 1000) return;
    const tr = player.transform;
    if (Number.isFinite(msg.x)) tr.x = msg.x;
    if (Number.isFinite(msg.y)) tr.y = msg.y;
    if (Number.isFinite(msg.z)) tr.z = msg.z;
    if (Number.isFinite(msg.yaw)) tr.yaw = msg.yaw;
    if (Number.isFinite(msg.pitch)) tr.pitch = msg.pitch;
    if (Number.isFinite(msg.crouch)) tr.crouch = Math.max(0, Math.min(1, msg.crouch));
    pushTransformHistory(player);
  }

  _ping(player, msg) {
    if (!Number.isFinite(msg.id)) return;
    this._send(player, { t: S2C.PONG, id: msg.id, ct: msg.ct, st: Date.now() });
  }

  _shoot(player, msg) {
    const lobby = player.lobby;
    if (!lobby || !lobby.started || player.dead) return;
    if (Date.now() - player.roundStartAt < SPAWN_GRACE * 1000) return;
    if (!player.stats) player.stats = freshStats();
    player.stats.shots++;
    const o = [msg.ox, msg.oy, msg.oz];
    const d = [msg.dx, msg.dy, msg.dz];
    if (!o.every(Number.isFinite) || !d.every(Number.isFinite)) return;
    // Normalise direction defensively.
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= len; d[1] /= len; d[2] /= len;
    const rtt = Number.isFinite(msg.rtt) ? Math.max(0, Math.min(800, msg.rtt)) : player.rttMs;
    if (Number.isFinite(msg.rtt)) player.rttMs = rtt;
    player.shotQueue.push({
      o,
      d,
      at: Date.now(),
      rtt,
      victimId: Number.isFinite(msg.victimId) ? msg.victimId : null,
      zone: msg.zone === 'head' || msg.zone === 'body' ? msg.zone : null
    });
  }

  // ---- Authoritative tick -------------------------------------------------
  _tick() {
    const now = Date.now();
    this._lastTick = now;
    this._simTick++;
    for (const lobby of this.lobbies.values()) {
      if (!lobby.started) continue;
      this._resolveShots(lobby);
      this._resolveRespawns(lobby, now);
      for (const p of lobby.players) pushTransformHistory(p, now);
      if (this._simTick % SNAPSHOT_EVERY === 0) {
        this._broadcastSnapshot(lobby, now);
      }
    }
  }

  _resolveShots(lobby) {
    const map = getMap(lobby.mapId);
    for (const shooter of lobby.players) {
      if (!shooter.shotQueue.length) continue;
      const shots = shooter.shotQueue;
      shooter.shotQueue = [];
      if (shooter.dead) continue;

      for (const shot of shots) {
        // Client-reported hit: if their screen showed a hit, accept it.
        if (shot.victimId != null && shot.zone) {
          const victim = lobby.players.find((p) => p.id === shot.victimId);
          if (victim && victim !== shooter && !victim.dead) {
            this._registerHit(lobby, shooter, victim, shot.zone);
            continue;
          }
        }

        const rewind = lagRewindMs(shot.rtt);
        const sampleTimes = [shot.at, shot.at - rewind * 0.35, shot.at - rewind];

        let best = null;
        for (const victim of lobby.players) {
          if (victim === shooter || victim.dead) continue;

          for (const t of sampleTimes) {
            const sample = sampleTransformAt(victim, t);
            const footY = sample.y - eyeOffset(sample.crouch || 0);
            const res = resolveShot(
              shot.o,
              shot.d,
              { x: sample.x, z: sample.z, crouch: sample.crouch, footY },
              map.boxes
            );
            if (res && (!best || res.t < best.res.t)) best = { victim, res };
          }
        }
        if (!best) continue;

        this._registerHit(lobby, shooter, best.victim, best.res.zone);
      }
    }
  }

  _registerHit(lobby, shooter, victim, zone) {
    if (!shooter.stats) shooter.stats = freshStats();
    shooter.stats.hits++;
    this._broadcast(lobby, { t: S2C.HIT, shooterId: shooter.id, victimId: victim.id, zone });
    const damage = zone === 'head' ? 2 : 1;
    victim.hp -= damage;
    if (victim.hp <= 0) this._registerKill(lobby, shooter, victim);
  }

  _registerKill(lobby, shooter, victim) {
    if (!shooter.stats) shooter.stats = freshStats();
    if (!victim.stats) victim.stats = freshStats();
    victim.stats.deaths++;
    const ttkSec = (Date.now() - (shooter.roundStartAt || Date.now())) / 1000;
    shooter.stats.ttkSum += ttkSec;
    shooter.stats.ttkCount++;

    lobby.scores[shooter.id] = (lobby.scores[shooter.id] || 0) + 1;

    const score = lobby.scores[shooter.id];
    const win = lobby.target > 0 && score >= lobby.target;

    // New arena every round — winner or loser, including the match-ending kill.
    lobby.mapId = pickRandomMap(lobby.mapId).id;

    let spawns = null;
    if (!win) {
      spawns = this._spawnAll(lobby);
    } else {
      victim.dead = true;
      victim.hp = 0;
    }

    const stats = this._buildStats(lobby);
    this._broadcast(lobby, {
      t: S2C.KILL,
      shooterId: shooter.id,
      victimId: victim.id,
      scores: { ...lobby.scores },
      mapId: lobby.mapId,
      spawns,
      stats
    });

    if (win) {
      lobby.started = false;
      this._broadcast(lobby, { t: S2C.MATCH_END, winnerId: shooter.id, scores: { ...lobby.scores } });
      for (const p of lobby.players) p.ready = false;
      this._broadcastLobby(lobby);
      this._pushLobbyList(); // back to joinable
    }
  }

  _chat(player, msg) {
    const lobby = player.lobby;
    if (!lobby || !lobby.started) return;
    const text = String(msg.text || '').trim().slice(0, 120);
    if (!text) return;
    this._broadcast(lobby, { t: S2C.CHAT, fromId: player.id, fromName: player.name, text });
  }

  _resolveRespawns(lobby, now) {
    let any = false;
    const map = getMap(lobby.mapId);
    const spawns = {};
    for (const p of lobby.players) {
      if (p.dead && now >= p.respawnAt) {
        const sp = spawnPair(map)[p.side];
        p.transform = { x: sp.pos[0], y: sp.pos[1] + STAND_EYE, z: sp.pos[2], yaw: sp.yaw, pitch: 0, crouch: 0 };
        p.hp = 2;
        p.dead = false;
        p.roundStartAt = Date.now();
        spawns[p.id] = { pos: sp.pos, yaw: sp.yaw, side: p.side };
        any = true;
      }
    }
    if (any) this._broadcast(lobby, { t: S2C.RESPAWN, spawns });
  }

  /** Authoritative per-player match stats for the hold-Tab scoreboard. */
  _buildStats(lobby) {
    const out = {};
    for (const p of lobby.players) {
      const s = p.stats || freshStats();
      const shots = s.shots;
      const hits = s.hits;
      const score = lobby.scores[p.id] || 0;
      out[p.id] = {
        score,
        kills: score,
        deaths: s.deaths,
        shots,
        hits,
        accuracy: shots ? round3(hits / shots) : 0,
        avgTtk: s.ttkCount ? round2(s.ttkSum / s.ttkCount) : null
      };
    }
    return out;
  }

  _broadcastSnapshot(lobby, now) {
    const players = lobby.players.map((p) => ({
      id: p.id,
      x: round2(p.transform.x),
      y: round2(p.transform.y),
      z: round2(p.transform.z),
      yaw: round3(p.transform.yaw),
      pitch: round3(p.transform.pitch),
      crouch: round2(p.transform.crouch),
      dead: p.dead
    }));
    this._broadcast(lobby, { t: S2C.SNAPSHOT, players, st: now });
  }

  // ---- Send helpers -------------------------------------------------------
  _lobbyView(lobby) {
    return {
      code: lobby.code,
      hostId: lobby.hostId,
      mapId: lobby.mapId,
      target: lobby.target,
      isPublic: lobby.isPublic,
      started: lobby.started,
      players: lobby.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready, side: p.side }))
    };
  }

  _broadcastLobby(lobby) {
    const view = this._lobbyView(lobby);
    for (const p of lobby.players) this._send(p, { t: S2C.LOBBY, lobby: view });
  }

  // ---- Lobby browser ------------------------------------------------------
  /** Public, not-started, not-full lobbies for the browser list. */
  _publicLobbies() {
    const out = [];
    for (const lobby of this.lobbies.values()) {
      if (!lobby.isPublic || lobby.started || lobby.players.length >= MAX_PLAYERS) continue;
      const host = lobby.players.find((p) => p.id === lobby.hostId) || lobby.players[0];
      out.push({
        code: lobby.code,
        host: host ? host.name : 'Host',
        map: 'Random maps',
        target: lobby.target,
        players: lobby.players.length,
        max: MAX_PLAYERS
      });
    }
    return out;
  }

  _sendLobbyList(player) {
    this._send(player, { t: S2C.LOBBY_LIST, lobbies: this._publicLobbies() });
  }

  /** Push the refreshed list to everyone currently browsing. */
  _pushLobbyList() {
    if (!this.browsers.size) return;
    const lobbies = this._publicLobbies();
    for (const p of this.browsers) this._send(p, { t: S2C.LOBBY_LIST, lobbies });
  }

  _broadcast(lobby, obj) {
    for (const p of lobby.players) this._send(p, obj);
  }

  _send(player, obj) {
    const ws = player.ws;
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
