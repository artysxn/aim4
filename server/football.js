// ---------------------------------------------------------------------------
// server/football.js
// Easter-egg 2D football (soccer). The standalone page /tools/football.html
// connects here over WS at /football. Fully server-authoritative: a 30 Hz sim
// of players + ball, code-joined lobbies with host-controlled team assignment
// (the host drags players between teams), first to 5 goals wins.
//
// Wire protocol (JSON messages with a `t` field, mirroring the duel server):
//   C2S: create{name,pass?,isPublic?} join{code,name,pass?} leave team{team}
//        setTeam{id,team} config{pass?,isPublic?} start stop list unlist
//        input{u,d,l,r,sp,k,ax,ay} ping{ct}
//   S2C: welcome{id} lobby{code,hostId,inMatch,isPublic,hasPass,players}
//        error{msg,code?} lobbyList{lobbies}
//        start{field,score,goalsToWin,players} state{ph,kt,sc,ball,pl}
//        kick{id,x,y,p} goal{team,byName,og,score} end{score,winner,aborted}
//        pong{ct,st}
// ---------------------------------------------------------------------------

const TICK_HZ = 30;
const TICK_MS = 1000 / TICK_HZ;

// Field, in abstract units. x grows right, y grows down (matches canvas).
export const FIELD_W = 100;
export const FIELD_H = 62;
export const GOAL_TOP = (FIELD_H - 16) / 2; // goal mouth: y 23..39
export const GOAL_BOT = GOAL_TOP + 16;
export const GOAL_DEPTH = 3; // net box behind each goal line

const PLAYER_R = 1.4;
const BALL_R = 1.0;

// Movement. Hold shift to sprint — a 10 s stamina pool drains while sprinting
// and regenerates while not; running dry "winds" you until partially recovered.
const BASE_SPEED = 13;
const SPRINT_SPEED = 19;
const MOVE_ACCEL = 10; // 1/s exponential velocity chase
const STAMINA_MAX = 10; // seconds of continuous sprint
const STAMINA_REGEN = 0.8; // per second while not sprinting
const WINDED_RECOVER = 2; // stamina needed to un-wind after running dry

// Ball. Exponential friction means a kick at speed v rolls v/BALL_FRICTION
// units before stopping — so kick speed = dist(ball→aim) * BALL_FRICTION makes
// the ball come to rest at the shooter's cursor ("mouse distance = shot").
const BALL_FRICTION = 0.9; // 1/s exp decay
const KICK_RANGE = PLAYER_R + BALL_R + 1.2;
const KICK_COOLDOWN_MS = 350;
const KICK_MIN = 8;
const KICK_MAX = 55;
const BOUNCE = 0.7; // wall/post restitution
const DRIBBLE_PUSH = 1.15; // ball inherits this × player velocity on touch

const GOALS_TO_WIN = 5;
const ROOM_CAP = 12;
const KICKOFF_MS = 1500;
const GOAL_PAUSE_MS = 2200;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const TEAMS = new Set(['red', 'blue', 'spec']);

let nextPlayerId = 1;

function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function cleanName(raw, id) {
  const s = String(raw ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 16);
  return s || `Player ${id}`;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function num(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function cleanPass(raw) {
  return String(raw ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, 24);
}

export class FootballServer {
  constructor() {
    this.players = new Map(); // id -> player
    this.rooms = new Map(); // code -> room
    this.browsers = new Set(); // players watching the public lobby list
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this._lastTick = Date.now();
  }

  // ---- Connection lifecycle ----------------------------------------------
  addConnection(ws) {
    const id = nextPlayerId++;
    const player = {
      id,
      ws,
      name: `Player ${id}`,
      room: null,
      team: 'spec',
      // live sim state
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      stamina: STAMINA_MAX,
      winded: false,
      kickAt: 0,
      input: { u: false, d: false, l: false, r: false, sp: false, k: false, ax: 0, ay: 0 }
    };
    this.players.set(id, player);
    this._send(player, { t: 'welcome', id });

    ws.on('message', (raw) => {
      if (raw.length > 2048) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        this._handle(player, msg);
      } catch (err) {
        console.error('[football]', err);
      }
    });
    ws.on('close', () => {
      this._leave(player);
      this.browsers.delete(player);
      this.players.delete(id);
    });
    ws.on('error', () => {});
  }

  _handle(p, msg) {
    switch (msg.t) {
      case 'create': {
        if (p.room) return;
        p.name = cleanName(msg.name, p.id);
        let code = randomCode();
        while (this.rooms.has(code)) code = randomCode();
        const room = {
          code,
          hostId: p.id,
          players: [p],
          inMatch: false,
          pass: cleanPass(msg.pass), // '' = open lobby
          isPublic: msg.isPublic !== false,
          score: { red: 0, blue: 0 },
          ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0, lastKickId: 0 },
          phase: 'play',
          phaseUntil: 0
        };
        this.rooms.set(code, room);
        p.room = room;
        p.team = 'spec';
        this.browsers.delete(p);
        this._broadcastLobby(room);
        this._broadcastLobbyList();
        break;
      }
      case 'join': {
        if (p.room) return;
        const code = String(msg.code || '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) {
          this._send(p, { t: 'error', msg: 'Lobby not found' });
          return;
        }
        if (room.players.length >= ROOM_CAP) {
          this._send(p, { t: 'error', msg: 'Lobby is full' });
          return;
        }
        if (room.pass) {
          const given = cleanPass(msg.pass);
          if (given !== room.pass) {
            this._send(p, {
              t: 'error',
              code: 'pass',
              joinCode: code,
              msg: given ? 'Wrong password' : 'Password required'
            });
            return;
          }
        }
        p.name = cleanName(msg.name, p.id);
        p.team = 'spec';
        p.room = room;
        room.players.push(p);
        this.browsers.delete(p);
        this._broadcastLobby(room);
        this._broadcastLobbyList();
        // Joining mid-match: drop straight into the game view as a spectator.
        if (room.inMatch) this._send(p, this._startPayload(room));
        break;
      }
      case 'leave': {
        this._leave(p);
        break;
      }
      case 'config': {
        // Host-only lobby settings: password + public listing.
        const room = p.room;
        if (!room || room.inMatch || room.hostId !== p.id) return;
        if ('pass' in msg) room.pass = cleanPass(msg.pass);
        if ('isPublic' in msg) room.isPublic = msg.isPublic !== false;
        this._broadcastLobby(room);
        this._broadcastLobbyList();
        break;
      }
      case 'list': {
        this.browsers.add(p);
        this._send(p, this._lobbyListPayload());
        break;
      }
      case 'unlist': {
        this.browsers.delete(p);
        break;
      }
      case 'team': {
        // Self-selection, lobby only.
        const room = p.room;
        if (!room || room.inMatch) return;
        if (!TEAMS.has(msg.team)) return;
        p.team = msg.team;
        this._broadcastLobby(room);
        break;
      }
      case 'setTeam': {
        // Host drags a player onto a team column.
        const room = p.room;
        if (!room || room.inMatch || room.hostId !== p.id) return;
        if (!TEAMS.has(msg.team)) return;
        const target = room.players.find((q) => q.id === msg.id);
        if (!target) return;
        target.team = msg.team;
        this._broadcastLobby(room);
        break;
      }
      case 'start': {
        const room = p.room;
        if (!room || room.inMatch || room.hostId !== p.id) return;
        const fielded = room.players.filter((q) => q.team !== 'spec');
        if (fielded.length === 0) {
          this._send(p, { t: 'error', msg: 'Put at least one player on a team' });
          return;
        }
        this._startMatch(room);
        break;
      }
      case 'stop': {
        const room = p.room;
        if (!room || !room.inMatch || room.hostId !== p.id) return;
        this._endMatch(room, null, true);
        break;
      }
      case 'input': {
        const i = p.input;
        i.u = !!msg.u;
        i.d = !!msg.d;
        i.l = !!msg.l;
        i.r = !!msg.r;
        i.sp = !!msg.sp;
        i.k = !!msg.k;
        i.ax = clamp(num(msg.ax), -20, FIELD_W + 20);
        i.ay = clamp(num(msg.ay), -20, FIELD_H + 20);
        break;
      }
      case 'ping': {
        this._send(p, { t: 'pong', ct: msg.ct, st: Date.now() });
        break;
      }
      default:
        break;
    }
  }

  _leave(p) {
    const room = p.room;
    if (!room) return;
    p.room = null;
    const idx = room.players.indexOf(p);
    if (idx !== -1) room.players.splice(idx, 1);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      this._broadcastLobbyList();
      return;
    }
    if (room.hostId === p.id) room.hostId = room.players[0].id;
    this._broadcastLobby(room);
    this._broadcastLobbyList();
  }

  // ---- Match flow ----------------------------------------------------------
  _startMatch(room) {
    room.inMatch = true;
    room.score = { red: 0, blue: 0 };
    this._resetPositions(room);
    room.phase = 'kickoff';
    room.phaseUntil = Date.now() + KICKOFF_MS;
    this._broadcast(room, this._startPayload(room));
    this._broadcastLobbyList();
  }

  _startPayload(room) {
    return {
      t: 'start',
      field: { w: FIELD_W, h: FIELD_H, gt: GOAL_TOP, gb: GOAL_BOT, gd: GOAL_DEPTH },
      score: room.score,
      goalsToWin: GOALS_TO_WIN,
      players: room.players.map((q) => ({ id: q.id, name: q.name, team: q.team }))
    };
  }

  _endMatch(room, winner, aborted = false) {
    room.inMatch = false;
    this._broadcast(room, { t: 'end', score: room.score, winner, aborted });
    this._broadcastLobby(room);
    this._broadcastLobbyList();
  }

  _resetPositions(room) {
    const place = (list, x) => {
      const n = list.length;
      const gap = Math.min(10, (FIELD_H - 10) / Math.max(1, n));
      list.forEach((q, i) => {
        q.x = x;
        q.y = FIELD_H / 2 + (i - (n - 1) / 2) * gap;
        q.vx = 0;
        q.vy = 0;
      });
    };
    place(room.players.filter((q) => q.team === 'red'), 30);
    place(room.players.filter((q) => q.team === 'blue'), FIELD_W - 30);
    room.ball.x = FIELD_W / 2;
    room.ball.y = FIELD_H / 2;
    room.ball.vx = 0;
    room.ball.vy = 0;
    room.ball.lastKickId = 0;
  }

  // ---- Simulation -----------------------------------------------------------
  _tick() {
    const now = Date.now();
    const dt = clamp((now - this._lastTick) / 1000, 0.001, 0.1);
    this._lastTick = now;
    for (const room of this.rooms.values()) {
      if (!room.inMatch) continue;
      this._sim(room, dt, now);
      this._broadcastState(room, now);
    }
  }

  _sim(room, dt, now) {
    // Phase transitions: goal pause → reset → kickoff freeze → play.
    if (room.phase !== 'play') {
      if (now >= room.phaseUntil) {
        if (room.phase === 'goal') {
          this._resetPositions(room);
          room.phase = 'kickoff';
          room.phaseUntil = now + KICKOFF_MS;
        } else {
          room.phase = 'play';
        }
      } else if (room.phase === 'goal') {
        // Let the ball settle into the net during the celebration.
        room.ball.x += room.ball.vx * dt;
        room.ball.y += room.ball.vy * dt;
        room.ball.vx *= 0.86;
        room.ball.vy *= 0.86;
      }
      return;
    }

    const fielded = room.players.filter((q) => q.team !== 'spec');
    const ball = room.ball;

    // Players: sprint stamina + velocity chase + integration.
    for (const q of fielded) {
      const i = q.input;
      let wx = (i.r ? 1 : 0) - (i.l ? 1 : 0);
      let wy = (i.d ? 1 : 0) - (i.u ? 1 : 0);
      const len = Math.hypot(wx, wy);
      if (len > 0) {
        wx /= len;
        wy /= len;
      }

      const wantsSprint = i.sp && len > 0;
      const sprinting = wantsSprint && !q.winded && q.stamina > 0;
      if (sprinting) {
        q.stamina = Math.max(0, q.stamina - dt);
        if (q.stamina <= 0) q.winded = true;
      } else {
        q.stamina = Math.min(STAMINA_MAX, q.stamina + STAMINA_REGEN * dt);
        if (q.winded && q.stamina >= WINDED_RECOVER) q.winded = false;
      }

      const speed = sprinting ? SPRINT_SPEED : BASE_SPEED;
      const k = Math.min(1, MOVE_ACCEL * dt);
      q.vx += (wx * speed - q.vx) * k;
      q.vy += (wy * speed - q.vy) * k;
      q.x = clamp(q.x + q.vx * dt, PLAYER_R, FIELD_W - PLAYER_R);
      q.y = clamp(q.y + q.vy * dt, PLAYER_R, FIELD_H - PLAYER_R);
      q.sprinting = sprinting;
    }

    // Player-player separation.
    for (let a = 0; a < fielded.length; a++) {
      for (let b = a + 1; b < fielded.length; b++) {
        const A = fielded[a];
        const B = fielded[b];
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const d = Math.hypot(dx, dy);
        const min = PLAYER_R * 2;
        if (d > 0 && d < min) {
          const push = (min - d) / 2;
          const nx = dx / d;
          const ny = dy / d;
          A.x = clamp(A.x - nx * push, PLAYER_R, FIELD_W - PLAYER_R);
          A.y = clamp(A.y - ny * push, PLAYER_R, FIELD_H - PLAYER_R);
          B.x = clamp(B.x + nx * push, PLAYER_R, FIELD_W - PLAYER_R);
          B.y = clamp(B.y + ny * push, PLAYER_R, FIELD_H - PLAYER_R);
        }
      }
    }

    // Kicks — hold space; fires whenever the ball is in reach and off cooldown.
    for (const q of fielded) {
      if (!q.input.k || now < q.kickAt) continue;
      const dx = ball.x - q.x;
      const dy = ball.y - q.y;
      if (Math.hypot(dx, dy) > KICK_RANGE) continue;
      let ax = q.input.ax - ball.x;
      let ay = q.input.ay - ball.y;
      let dist = Math.hypot(ax, ay);
      if (dist < 0.5) {
        // Cursor on top of the ball: tap it along the player→ball line.
        ax = dx;
        ay = dy;
        dist = Math.hypot(ax, ay) || 1;
      }
      const power = clamp(dist * BALL_FRICTION, KICK_MIN, KICK_MAX);
      ball.vx = (ax / dist) * power;
      ball.vy = (ay / dist) * power;
      ball.lastKickId = q.id;
      q.kickAt = now + KICK_COOLDOWN_MS;
      this._broadcast(room, {
        t: 'kick',
        id: q.id,
        x: ball.x,
        y: ball.y,
        p: (power - KICK_MIN) / (KICK_MAX - KICK_MIN)
      });
    }

    // Dribble: overlapping the ball pushes it out and rolls it ahead of you.
    for (const q of fielded) {
      const dx = ball.x - q.x;
      const dy = ball.y - q.y;
      const d = Math.hypot(dx, dy);
      const min = PLAYER_R + BALL_R;
      if (d > 0 && d < min) {
        const nx = dx / d;
        const ny = dy / d;
        ball.x = q.x + nx * min;
        ball.y = q.y + ny * min;
        const carry = Math.hypot(q.vx, q.vy);
        if (carry > Math.hypot(ball.vx, ball.vy) * 0.8) {
          ball.vx = q.vx * DRIBBLE_PUSH + nx * 2;
          ball.vy = q.vy * DRIBBLE_PUSH + ny * 2;
        }
      }
    }

    // Ball physics + goals.
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    const decay = Math.exp(-BALL_FRICTION * dt);
    ball.vx *= decay;
    ball.vy *= decay;
    if (Math.hypot(ball.vx, ball.vy) < 0.05) {
      ball.vx = 0;
      ball.vy = 0;
    }

    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      ball.vy = Math.abs(ball.vy) * BOUNCE;
    } else if (ball.y > FIELD_H - BALL_R) {
      ball.y = FIELD_H - BALL_R;
      ball.vy = -Math.abs(ball.vy) * BOUNCE;
    }

    const inMouth = ball.y > GOAL_TOP + BALL_R * 0.5 && ball.y < GOAL_BOT - BALL_R * 0.5;
    if (ball.x < BALL_R) {
      if (inMouth) {
        if (ball.x < -0.5) this._goal(room, 'blue', now); // blue scores on the left goal
      } else {
        ball.x = BALL_R;
        ball.vx = Math.abs(ball.vx) * BOUNCE;
      }
    } else if (ball.x > FIELD_W - BALL_R) {
      if (inMouth) {
        if (ball.x > FIELD_W + 0.5) this._goal(room, 'red', now);
      } else {
        ball.x = FIELD_W - BALL_R;
        ball.vx = -Math.abs(ball.vx) * BOUNCE;
      }
    }
    // Keep the ball inside the net box while it crosses the line.
    ball.x = clamp(ball.x, -GOAL_DEPTH + BALL_R, FIELD_W + GOAL_DEPTH - BALL_R);
  }

  _goal(room, team, now) {
    room.score[team]++;
    room.phase = 'goal';
    room.phaseUntil = now + GOAL_PAUSE_MS;
    const kicker = this.players.get(room.ball.lastKickId);
    const og = !!kicker && kicker.team !== 'spec' && kicker.team !== team;
    this._broadcast(room, {
      t: 'goal',
      team,
      byName: kicker ? kicker.name : null,
      og,
      score: room.score
    });
    if (room.score[team] >= GOALS_TO_WIN) {
      // Let the celebration pause play out client-side, then end.
      setTimeout(() => {
        if (room.inMatch && this.rooms.get(room.code) === room) this._endMatch(room, team);
      }, GOAL_PAUSE_MS);
    }
  }

  // ---- Messaging ------------------------------------------------------------
  _broadcastState(room, now) {
    const pl = [];
    for (const q of room.players) {
      if (q.team === 'spec') continue;
      pl.push({
        i: q.id,
        x: Math.round(q.x * 100) / 100,
        y: Math.round(q.y * 100) / 100,
        s: Math.round(q.stamina * 10) / 10,
        r: q.sprinting ? 1 : 0,
        w: q.winded ? 1 : 0
      });
    }
    this._broadcast(room, {
      t: 'state',
      ph: room.phase,
      kt: room.phase === 'play' ? 0 : Math.max(0, room.phaseUntil - now),
      sc: room.score,
      ball: {
        x: Math.round(room.ball.x * 100) / 100,
        y: Math.round(room.ball.y * 100) / 100
      },
      pl
    });
  }

  _broadcastLobby(room) {
    this._broadcast(room, {
      t: 'lobby',
      code: room.code,
      hostId: room.hostId,
      inMatch: room.inMatch,
      isPublic: room.isPublic,
      hasPass: !!room.pass,
      players: room.players.map((q) => ({ id: q.id, name: q.name, team: q.team }))
    });
  }

  _lobbyListPayload() {
    const lobbies = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic) continue;
      const host = this.players.get(room.hostId);
      lobbies.push({
        code: room.code,
        host: host ? host.name : '?',
        players: room.players.length,
        max: ROOM_CAP,
        inMatch: room.inMatch,
        locked: !!room.pass
      });
    }
    return { t: 'lobbyList', lobbies };
  }

  _broadcastLobbyList() {
    if (!this.browsers.size) return;
    const json = JSON.stringify(this._lobbyListPayload());
    for (const q of this.browsers) {
      if (q.ws.readyState === 1) q.ws.send(json);
    }
  }

  _broadcast(room, obj) {
    const json = JSON.stringify(obj);
    for (const q of room.players) {
      if (q.ws.readyState === 1) q.ws.send(json);
    }
  }

  _send(p, obj) {
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj));
  }
}
