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
  SNAPSHOT_EVERY,
  TRACKING_DURATION,
  TRACKING_HEAD_PTS,
  TRACKING_BODY_PTS,
  TRACKING_MAP_ID,
  DEATHMATCH_MAP_ID,
  DEATHMATCH_DURATION,
  maxPlayersForMode
} from '../src/multiplayer/constants.js';
import {
  getMap,
  spawnFor,
  pickRandomMap,
  spawnPair,
  ffaSpawns,
  ffaRespawn,
  yawToward
} from '../src/multiplayer/maps.js';
import { forwardFromYawPitch } from '../src/utils/spawnVisibility.js';
import { resolveShot } from './hitscan.js';
import { pushTransformHistory, sampleTransformAt, lagRewindMs } from './lagComp.js';
import {
  DEFAULT_ELO,
  eloResultsForMatch
} from '../src/multiplayer/elo.js';
import { resolveShotDirection } from '../src/utils/shotAccuracy.js';
import { MatchmakingQueue, createRankedLobby } from './matchmaking.js';

const VALID_TARGETS = new Set([0, 13, 30, 60, 100]);
const VALID_WEAPONS = new Set(['rifle', 'pistol', 'tracking']);
const VALID_MODES = new Set(['duel', 'tracking', 'deathmatch']);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

// Health model: a body shot does 1, so you survive three body hits and die on
// the fourth. Headshots deal full HP, so they are always instantly lethal.
const MAX_HP = 4;
const BODY_DMG = 1;
const HEAD_DMG = MAX_HP;

function lobbyGameMode(lobby) {
  if (lobby.mode && VALID_MODES.has(lobby.mode)) return lobby.mode;
  return lobby.weapon === 'tracking' ? 'tracking' : 'duel';
}

function freshStats() {
  return { deaths: 0, shots: 0, hits: 0, ttkSum: 0, ttkCount: 0 };
}

function isTrackingLobby(lobby) {
  return lobbyGameMode(lobby) === 'tracking';
}

function isDeathmatchLobby(lobby) {
  return lobbyGameMode(lobby) === 'deathmatch';
}

/** Player cap for this lobby's mode (duel/tracking = 2, deathmatch = FFA). */
function lobbyMaxPlayers(lobby) {
  return maxPlayersForMode(lobbyGameMode(lobby));
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
    this.matchmaking = new MatchmakingQueue(this);
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._lastTick = Date.now();
    this._simTick = 0;
  }

  // ---- Connection lifecycle ----------------------------------------------
  _isSpawnProtected(player, now = Date.now()) {
    return now - (player.roundStartAt || 0) < SPAWN_GRACE * 1000;
  }

  /** Eye positions + look vectors for spawn visibility (excludes respawning player). */
  _ffaViewers(lobby, excludeId = null) {
    const viewers = [];
    for (const p of lobby.players) {
      if (p.dead || p.id === excludeId || this._isSpawnProtected(p)) continue;
      const tr = p.transform;
      viewers.push({
        eye: [tr.x, tr.y, tr.z],
        dir: forwardFromYawPitch(tr.yaw, tr.pitch || 0),
        hFov: 90
      });
    }
    return viewers;
  }

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
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      shotQueue: [],
      history: [],
      rttMs: 0,
      inQueue: false,
      queueElo: DEFAULT_ELO,
      queueJoinedAt: null,
      userId: null
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
    this.matchmaking.remove(player);
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
      case C2S.RETURN_LOBBY:
        return this._returnToLobby(player);
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
      case C2S.QUEUE:
        return this.matchmaking.enqueue(player, msg);
      case C2S.DEQUEUE:
        return this.matchmaking.dequeue(player, true);
    }
  }

  _create(player, msg) {
    this.matchmaking.remove(player);
    this._leaveLobby(player);
    this.browsers.delete(player);
    if (msg.name) player.name = String(msg.name).slice(0, 24);

    let code = randomCode();
    while (this.lobbies.has(code)) code = randomCode();

    const target = VALID_TARGETS.has(msg.target) ? msg.target : 13;
    const weapon = VALID_WEAPONS.has(msg.weapon) ? msg.weapon : 'rifle';
    const mode = VALID_MODES.has(msg.mode)
      ? msg.mode
      : weapon === 'tracking'
        ? 'tracking'
        : 'duel';
    const lobby = {
      code,
      hostId: player.id,
      players: [player],
      mapId: null, // chosen when the match starts / each round
      target,
      weapon,
      mode,
      isPublic: msg.isPublic !== false, // default public
      started: false,
      scores: {},
      matchEndsAt: null
    };
    this.lobbies.set(code, lobby);
    player.lobby = lobby;
    player.side = 'A';
    player.ready = false;
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  _join(player, msg) {
    this.matchmaking.remove(player);
    this._leaveLobby(player);
    const code = String(msg.code || '').trim().toUpperCase();
    const lobby = this.lobbies.get(code);
    if (!lobby) return this._send(player, { t: S2C.ERROR, msg: 'Lobby not found.' });
    if (lobby.started) return this._send(player, { t: S2C.ERROR, msg: 'Match already in progress.' });
    if (lobby.players.length >= lobbyMaxPlayers(lobby)) return this._send(player, { t: S2C.ERROR, msg: 'Lobby is full.' });

    if (msg.name) player.name = String(msg.name).slice(0, 24);
    this.browsers.delete(player);
    lobby.players.push(player);
    player.lobby = lobby;
    // Sides only matter for paired 1v1 maps; FFA deathmatch ignores them.
    player.side = isDeathmatchLobby(lobby) ? null : 'B';
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

  /** End an active match and send everyone back to the pre-match lobby. */
  _returnToLobby(player) {
    const lobby = player.lobby;
    if (!lobby || !lobby.started) return;

    lobby.started = false;
    lobby.matchEndsAt = null;
    for (const p of lobby.players) {
      p.ready = false;
      p.dead = false;
      p.hp = MAX_HP;
      p.shotQueue.length = 0;
      p.respawnAt = 0;
    }

    this._broadcast(lobby, {
      t: S2C.MATCH_END,
      winnerId: null,
      scores: { ...lobby.scores },
      aborted: true,
      returnToLobby: true
    });
    this._broadcastLobby(lobby);
    this._pushLobbyList();
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
    if (VALID_WEAPONS.has(msg.weapon)) lobby.weapon = msg.weapon;
    if (VALID_MODES.has(msg.mode) && lobby.players.length <= maxPlayersForMode(msg.mode)) {
      lobby.mode = msg.mode;
      // Re-tag sides so FFA toggles on/off cleanly.
      lobby.players.forEach((p, i) => {
        p.side = isDeathmatchLobby(lobby) ? null : i === 0 ? 'A' : 'B';
      });
    }
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  _start(player) {
    const lobby = player.lobby;
    if (!lobby || lobby.hostId !== player.id || lobby.started) return;
    if (lobby.isMatchmade) return this._beginMatch(lobby);
    if (lobby.players.length < MAX_PLAYERS) {
      return this._send(player, { t: S2C.ERROR, msg: 'Need a second player to start.' });
    }
    if (!lobby.players.every((p) => p.ready || p.id === lobby.hostId)) {
      return this._send(player, { t: S2C.ERROR, msg: 'All players must be ready.' });
    }

    this._beginMatch(lobby);
  }

  /** Start a ranked or custom lobby match (shared setup). */
  _beginMatch(lobby) {
    lobby.started = true;
    const tracking = isTrackingLobby(lobby);
    const deathmatch = isDeathmatchLobby(lobby);
    lobby.mapId = tracking
      ? TRACKING_MAP_ID
      : deathmatch
        ? DEATHMATCH_MAP_ID
        : pickRandomMap(lobby.mapId).id;
    lobby.matchEndsAt = tracking
      ? Date.now() + TRACKING_DURATION * 1000
      : deathmatch && DEATHMATCH_DURATION > 0
        ? Date.now() + DEATHMATCH_DURATION * 1000
        : null;
    lobby.scores = {};
    for (const p of lobby.players) {
      lobby.scores[p.id] = 0;
      p.stats = freshStats();
      p.roundStartAt = Date.now();
    }
    this._pushLobbyList();

    const spawns = this._spawnAll(lobby);
    const stats = this._buildStats(lobby);
    for (const p of lobby.players) {
      const opp = lobby.players.find((x) => x.id !== p.id);
      const startMsg = {
        t: S2C.MATCH_START,
        mapId: lobby.mapId,
        target: lobby.target,
        weapon: lobby.weapon,
        gameMode: lobbyGameMode(lobby),
        spawns,
        scores: lobby.scores,
        stats,
        isMatchmade: !!lobby.isMatchmade
      };
      if (tracking) {
        startMsg.duration = TRACKING_DURATION;
        startMsg.matchEndsAt = lobby.matchEndsAt;
      }
      if (deathmatch && lobby.matchEndsAt) {
        startMsg.matchEndsAt = lobby.matchEndsAt;
      }
      if (lobby.isMatchmade && opp) {
        startMsg.opponentName = opp.name;
        startMsg.opponentElo = lobby.mmElos?.[opp.id];
        startMsg.yourElo = lobby.mmElos?.[p.id];
      }
      this._send(p, startMsg);
    }
  }

  /** Pair two queued players into a ranked duel and start immediately. */
  _startRankedDuel(pA, pB) {
    let code = randomCode();
    while (this.lobbies.has(code)) code = randomCode();

    const lobby = createRankedLobby(code, pA, pB);
    this.lobbies.set(code, lobby);
    pA.lobby = lobby;
    pB.lobby = lobby;
    pA.side = 'A';
    pB.side = 'B';
    pA.ready = true;
    pB.ready = true;

    for (const p of lobby.players) {
      this._send(p, { t: S2C.LOBBY, lobby: this._lobbyView(lobby) });
    }
    this._beginMatch(lobby);
  }

  /** Assign + reset spawns for everyone; returns { playerId: {pos,yaw,side} }. */
  _spawnAll(lobby) {
    const map = getMap(lobby.mapId);
    const spawns = {};
    const deathmatch = isDeathmatchLobby(lobby);
    const ffa = deathmatch ? ffaSpawns(map, lobby.players.length) : null;
    const pair = deathmatch ? null : spawnPair(map);
    lobby.players.forEach((p, i) => {
      const sp = deathmatch
        ? ffa[i]
        : pair[p.side] || spawnFor(map, p.side);
      const yaw = deathmatch ? yawToward(sp.pos, [0, 0, 0]) : sp.yaw;
      p.transform = { x: sp.pos[0], y: sp.pos[1] + STAND_EYE, z: sp.pos[2], yaw, pitch: 0, crouch: 0 };
      p.hp = MAX_HP;
      p.dead = false;
      p.respawnAt = 0;
      p.shotQueue.length = 0;
      p.history = [];
      p.roundStartAt = Date.now();
      pushTransformHistory(p);
      spawns[p.id] = { pos: sp.pos, yaw, side: p.side };
    });
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
    const aim = [
      Number.isFinite(msg.aimDx) ? msg.aimDx : msg.dx,
      Number.isFinite(msg.aimDy) ? msg.aimDy : msg.dy,
      Number.isFinite(msg.aimDz) ? msg.aimDz : msg.dz
    ];
    if (!o.every(Number.isFinite) || !aim.every(Number.isFinite)) return;

    const aimLen = Math.hypot(aim[0], aim[1], aim[2]) || 1;
    aim[0] /= aimLen;
    aim[1] /= aimLen;
    aim[2] /= aimLen;

    const accState = {
      onGround: msg.onGround !== false,
      speedHoriz: Number.isFinite(msg.speedHoriz) ? Math.max(0, msg.speedHoriz) : 0
    };
    const seed = Number.isFinite(msg.spreadSeed) ? msg.spreadSeed >>> 0 : 0;
    const tracking = isTrackingLobby(lobby);
    const resolved = tracking
      ? { x: aim[0], y: aim[1], z: aim[2] }
      : resolveShotDirection(aim, accState, seed);
    const d = [resolved.x, resolved.y, resolved.z];
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
    // Relay shot origin + impact so other clients can draw a matching tracer.
    const fired = {
      t: S2C.SHOT_FIRED,
      shooterId: player.id,
      x: player.transform.x,
      y: player.transform.y,
      z: player.transform.z,
      ox: o[0], oy: o[1], oz: o[2]
    };
    if ([msg.ex, msg.ey, msg.ez].every(Number.isFinite)) {
      fired.ex = msg.ex;
      fired.ey = msg.ey;
      fired.ez = msg.ez;
    }
    if ([msg.mx, msg.my, msg.mz].every(Number.isFinite)) {
      fired.mx = msg.mx;
      fired.my = msg.my;
      fired.mz = msg.mz;
    }
    this._broadcast(lobby, fired);
  }

  // ---- Authoritative tick -------------------------------------------------
  _tick() {
    const now = Date.now();
    this._lastTick = now;
    this._simTick++;
    for (const lobby of this.lobbies.values()) {
      if (!lobby.started) continue;
      if (isTrackingLobby(lobby) && lobby.matchEndsAt && now >= lobby.matchEndsAt) {
        this._endTrackingMatch(lobby);
        continue;
      }
      if (isDeathmatchLobby(lobby) && lobby.matchEndsAt && now >= lobby.matchEndsAt) {
        this._endDeathmatchMatch(lobby);
        continue;
      }
      this._resolveShots(lobby);
      if (isDeathmatchLobby(lobby)) this._resolveDeathmatchRespawns(lobby, now);
      else if (!isTrackingLobby(lobby)) this._resolveRespawns(lobby, now);
      for (const p of lobby.players) pushTransformHistory(p, now);
      if (this._simTick % SNAPSHOT_EVERY === 0) {
        this._broadcastSnapshot(lobby, now);
      }
    }
  }

  _resolveShots(lobby) {
    const map = getMap(lobby.mapId);
    const tracking = isTrackingLobby(lobby);
    for (const shooter of lobby.players) {
      if (!shooter.shotQueue.length) continue;
      const shots = shooter.shotQueue;
      shooter.shotQueue = [];
      if (shooter.dead && !tracking) continue;

      for (const shot of shots) {
        // Client-reported hit: if their screen showed a hit, accept it.
        if (shot.victimId != null && shot.zone) {
          const victim = lobby.players.find((p) => p.id === shot.victimId);
          if (victim && victim !== shooter && (!victim.dead || tracking)) {
            if (!tracking && this._isSpawnProtected(victim)) continue;
            if (tracking) this._registerTrackingHit(lobby, shooter, victim, shot.zone);
            else this._registerHit(lobby, shooter, victim, shot.zone);
            continue;
          }
        }

        const rewind = lagRewindMs(shot.rtt);
        const sampleTimes = [shot.at, shot.at - rewind * 0.35, shot.at - rewind];

        let best = null;
        for (const victim of lobby.players) {
          if (victim === shooter || (victim.dead && !tracking)) continue;
          if (!tracking && this._isSpawnProtected(victim)) continue;

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

        if (tracking) this._registerTrackingHit(lobby, shooter, best.victim, best.res.zone);
        else this._registerHit(lobby, shooter, best.victim, best.res.zone);
      }
    }
  }

  _registerTrackingHit(lobby, shooter, victim, zone) {
    if (!shooter.stats) shooter.stats = freshStats();
    shooter.stats.hits++;
    const points = zone === 'head' ? TRACKING_HEAD_PTS : TRACKING_BODY_PTS;
    lobby.scores[shooter.id] = (lobby.scores[shooter.id] || 0) + points;
    const stats = this._buildStats(lobby);
    this._broadcast(lobby, {
      t: S2C.HIT,
      shooterId: shooter.id,
      victimId: victim.id,
      zone,
      points,
      scores: { ...lobby.scores },
      stats
    });
  }

  _endTrackingMatch(lobby) {
    if (!lobby.started) return;
    lobby.started = false;
    lobby.matchEndsAt = null;

    let winnerId = null;
    let best = -Infinity;
    let tied = false;
    for (const p of lobby.players) {
      const s = lobby.scores[p.id] || 0;
      if (s > best) {
        best = s;
        winnerId = p.id;
        tied = false;
      } else if (s === best) {
        tied = true;
      }
    }
    if (tied) winnerId = null;

    this._broadcast(lobby, {
      t: S2C.MATCH_END,
      winnerId,
      scores: { ...lobby.scores },
      gameMode: 'tracking',
      timedOut: true
    });
    for (const p of lobby.players) p.ready = false;
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  /** FFA respawns: each dead player returns after the delay, away from the living. */
  _resolveDeathmatchRespawns(lobby, now) {
    const map = getMap(lobby.mapId);
    const spawns = {};
    let any = false;
    for (const p of lobby.players) {
      if (!p.dead || now < p.respawnAt) continue;
      const others = lobby.players
        .filter((x) => x !== p && !x.dead)
        .map((x) => [x.transform.x, 0, x.transform.z]);
      const viewers = this._ffaViewers(lobby, p.id);
      const sp = ffaRespawn(map, others, viewers);
      const yaw = yawToward(sp.pos, [0, 0, 0]);
      p.transform = { x: sp.pos[0], y: sp.pos[1] + STAND_EYE, z: sp.pos[2], yaw, pitch: 0, crouch: 0 };
      p.hp = MAX_HP;
      p.dead = false;
      p.respawnAt = 0;
      p.roundStartAt = now;
      p.history = [];
      pushTransformHistory(p, now);
      spawns[p.id] = { pos: sp.pos, yaw, side: p.side };
      any = true;
    }
    if (any) this._broadcast(lobby, { t: S2C.RESPAWN, spawns });
  }

  /** End a FFA deathmatch — highest score wins (frag target hit or time up). */
  _endDeathmatchMatch(lobby, winnerId = null) {
    if (!lobby.started) return;
    lobby.started = false;
    lobby.matchEndsAt = null;

    if (winnerId == null) {
      let best = -Infinity;
      let tied = false;
      for (const p of lobby.players) {
        const s = lobby.scores[p.id] || 0;
        if (s > best) {
          best = s;
          winnerId = p.id;
          tied = false;
        } else if (s === best) {
          tied = true;
        }
      }
      if (tied) winnerId = null;
    }

    this._broadcast(lobby, {
      t: S2C.MATCH_END,
      winnerId,
      scores: { ...lobby.scores },
      gameMode: 'deathmatch'
    });
    for (const p of lobby.players) p.ready = false;
    this._broadcastLobby(lobby);
    this._pushLobbyList();
  }

  _registerHit(lobby, shooter, victim, zone) {
    if (this._isSpawnProtected(victim)) return;
    if (!shooter.stats) shooter.stats = freshStats();
    shooter.stats.hits++;
    this._broadcast(lobby, { t: S2C.HIT, shooterId: shooter.id, victimId: victim.id, zone });
    const damage = zone === 'head' ? HEAD_DMG : BODY_DMG;
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

    // ---- Free-for-all: only the victim dies + respawns; the arena is fixed. ----
    if (isDeathmatchLobby(lobby)) {
      victim.dead = true;
      victim.hp = 0;
      victim.respawnAt = Date.now() + RESPAWN_DELAY * 1000;
      const stats = this._buildStats(lobby);
      this._broadcast(lobby, {
        t: S2C.KILL,
        shooterId: shooter.id,
        victimId: victim.id,
        scores: { ...lobby.scores },
        stats
      });
      if (win) this._endDeathmatchMatch(lobby, shooter.id);
      return;
    }

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
      const endMsg = {
        t: S2C.MATCH_END,
        winnerId: shooter.id,
        scores: { ...lobby.scores },
        isMatchmade: !!lobby.isMatchmade
      };
      if (lobby.isMatchmade && lobby.mmElos) {
        endMsg.elo = eloResultsForMatch(lobby.players, shooter.id, lobby.mmElos);
        for (const p of lobby.players) {
          const r = endMsg.elo[p.id];
          if (r) p.queueElo = r.newElo;
        }
      }
      this._broadcast(lobby, endMsg);
      for (const p of lobby.players) p.ready = false;
      if (lobby.isMatchmade) {
        this.lobbies.delete(lobby.code);
        for (const p of lobby.players) {
          p.lobby = null;
          p.side = null;
        }
      } else {
        this._broadcastLobby(lobby);
        this._pushLobbyList();
      }
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
        p.hp = MAX_HP;
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
    const snap = { t: S2C.SNAPSHOT, players, st: now };
    if (isTrackingLobby(lobby) && lobby.matchEndsAt) snap.matchEndsAt = lobby.matchEndsAt;
    this._broadcast(lobby, snap);
  }

  // ---- Send helpers -------------------------------------------------------
  _lobbyView(lobby) {
    return {
      code: lobby.code,
      hostId: lobby.hostId,
      mapId: lobby.mapId,
      target: lobby.target,
      weapon: lobby.weapon || 'rifle',
      gameMode: lobbyGameMode(lobby),
      maxPlayers: lobbyMaxPlayers(lobby),
      isPublic: lobby.isPublic,
      started: lobby.started,
      isMatchmade: !!lobby.isMatchmade,
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
      if (!lobby.isPublic || lobby.started || lobby.players.length >= lobbyMaxPlayers(lobby)) continue;
      const host = lobby.players.find((p) => p.id === lobby.hostId) || lobby.players[0];
      out.push({
        code: lobby.code,
        host: host ? host.name : 'Host',
        map: isTrackingLobby(lobby) ? 'Tracking' : isDeathmatchLobby(lobby) ? 'Deathmatch' : 'Random maps',
        target: lobby.target,
        weapon: lobby.weapon || 'rifle',
        gameMode: lobbyGameMode(lobby),
        players: lobby.players.length,
        max: lobbyMaxPlayers(lobby)
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
