// ---------------------------------------------------------------------------
// server/football.js
// Easter-egg 2D football (soccer). The standalone page /tools/football.html
// connects here over WS at /football. Fully server-authoritative: a 128 Hz sim
// of players + ball with impulse collisions, code-joined lobbies with
// host-controlled team assignment (the host drags players between teams),
// first to 5 goals wins.
//
// Wire protocol (JSON messages with a `t` field, mirroring the duel server):
//   C2S: create{name,pass?,isPublic?} join{code,name,pass?} leave team{team}
//        setTeam{id,team} config{pass?,isPublic?} start stop list unlist
//        input{u,d,l,r,sp,k,st,ax,ay} ping{ct}
//   S2C: welcome{id} lobby{code,hostId,inMatch,isPublic,hasPass,players}
//        error{msg,code?} lobbyList{lobbies}
//        start{field,score,goalsToWin,players} state{ph,kt,sc,ball,pl}
//        kick{id,x,y,p} goal{team,byName,og,score} end{score,winner,aborted}
//        pong{ct,st}
// ---------------------------------------------------------------------------

const TICK_HZ = 128;
const TICK_MS = 1000 / TICK_HZ;

// Field, in abstract units. x grows right, y grows down (matches canvas).
export const FIELD_W = 72;
export const FIELD_H = 45;
const GOAL_H = 14.4; // ~20% taller than old 16×0.72 scale
export const GOAL_TOP = (FIELD_H - GOAL_H) / 2;
export const GOAL_BOT = GOAL_TOP + GOAL_H;
export const GOAL_DEPTH = 2.5; // net box behind each goal line

const PLAYER_R = 1.232; // +10% from 1.12
const BALL_R = 1.2;

// Movement. Hold shift to sprint — stamina pool drains while sprinting
// and regenerates while not; running dry "winds" you until partially recovered.
const BASE_SPEED = 11.55; // +10%
const SPRINT_SPEED = 20.735; // +10%
const MOVE_ACCEL = 12; // 1/s — slower, smoother ramp
const STAMINA_MAX = 8; // was 10 (−20%)
const STAMINA_REGEN = 0.8; // per second while not sprinting
const WINDED_RECOVER = 1.6; // stamina needed to un-wind after running dry

// Shooting stamina — separate from sprint. Each kick drains this pool.
const SHOOT_STAMINA_MAX = 80; // was 100 (−20%)
const SHOOT_STAMINA_REGEN = 18; // per second
const SHOOT_COST_MIN = 14; // weak tap
const SHOOT_COST_MAX = 58; // full-power / charged shot (steep curve)
const SHOOT_MIN_TO_FIRE = 10; // need at least this much to shoot

// Ball. Shot power scales with aim distance (mouse distance = shot power).
const BALL_FRICTION = 0.72; // 1/s — longer rolls so powered shots carry
const KICK_RANGE = PLAYER_R + BALL_R + 2.0;
const KICK_COOLDOWN_MS = 420;
const KICK_POWER_SCALE = 0.775; // was 1.55 (−50%)
const KICK_MIN = 3.5; // was 7 (−50%)
const KICK_MAX = 46; // was 92 (−50%)
const BOUNCE = 0.88; // pillar-like restitution on posts / field edges
const POST_R = 0.7; // goal-post pillars
const CORNER_R = 0.55; // field-corner pillars
const KICK_BLEND = 0.9; // strong commit to shot direction/power
const CHARGE_TIME = 0.9; // seconds of hold → full charge
const CHARGE_SLOW_MAX = 0.55; // up to 55% slower while fully charged
const CHARGE_POWER_BONUS = 0.35; // extra scale on top of aim+charge floor
const CHARGE_BASE_POWER = 44; // full charge adds this much power even at point-blank aim
const CHARGE_MIN_FIRE = 0.04; // tiny tap still counts as a shot

// Auto-volley: holding shoot when an opponent's shot comes at you → release.
const INCOMING_SHOT_SPEED = 10;
const INCOMING_SHOT_DOT = 0.2; // ball velocity aligned toward player
const INCOMING_SHOT_MS = 2800;

// Soft dribble when touching the ball without shooting.
const DRIBBLE_TOUCH_SLACK = 0.2;
const DRIBBLE_MAX_BALL_SPEED = 22; // don't steer hard shots
const DRIBBLE_STRENGTH = 9; // target carry speed (units/s)
const DRIBBLE_EASE = 7; // 1/s — how quickly ball velocity eases toward nudge
const DRIBBLE_MOVE_WEIGHT = 0.72; // movement direction vs cursor
const DRIBBLE_AIM_WEIGHT = 0.28;

// Collision masses / restitution (impulse response).
const PLAYER_MASS = 1;
const BALL_MASS = 0.22;
const PLAYER_RESTITUTION = 0.22; // bodies don't bounce much
const BALL_RESTITUTION = 0.58; // lively ball bounce off players
const COLLISION_FRICTION = 0.1; // tangent damping on contact
const CONTACT_SKIN = 0.05; // forced gap so bodies never share volume
const COLLIDE_ITERS = 8;
const SEPARATE_ITERS = 10;

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

/** Bounce the ball off a static circular pillar (goal post / field corner). */
function bounceBallOffPillar(ball, cx, cy, r) {
  let dx = ball.x - cx;
  let dy = ball.y - cy;
  let d = Math.hypot(dx, dy);
  const min = r + BALL_R + CONTACT_SKIN;
  if (d >= min) return false;
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const pen = min - d;
  ball.x += nx * pen;
  ball.y += ny * pen;
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn < 0) {
    ball.vx -= (1 + BOUNCE) * vn * nx;
    ball.vy -= (1 + BOUNCE) * vn * ny;
  }
  return true;
}

function resolveBallPillars(ball) {
  // Goal posts (bars) — four mouth corners.
  bounceBallOffPillar(ball, 0, GOAL_TOP, POST_R);
  bounceBallOffPillar(ball, 0, GOAL_BOT, POST_R);
  bounceBallOffPillar(ball, FIELD_W, GOAL_TOP, POST_R);
  bounceBallOffPillar(ball, FIELD_W, GOAL_BOT, POST_R);
  // Field corner pillars.
  bounceBallOffPillar(ball, 0, 0, CORNER_R);
  bounceBallOffPillar(ball, FIELD_W, 0, CORNER_R);
  bounceBallOffPillar(ball, 0, FIELD_H, CORNER_R);
  bounceBallOffPillar(ball, FIELD_W, FIELD_H, CORNER_R);
}

function wishDir(q) {
  const i = q.input;
  let wx = (i.r ? 1 : 0) - (i.l ? 1 : 0);
  let wy = (i.d ? 1 : 0) - (i.u ? 1 : 0);
  const len = Math.hypot(wx, wy);
  if (len > 0) {
    wx /= len;
    wy /= len;
  }
  return { wx, wy, len };
}

/** True when another player's recent shot is flying toward this player. */
function isIncomingShot(q, ball, now) {
  if (!ball.shotBy || ball.shotBy === q.id) return false;
  if (now - (ball.shotAt || 0) > INCOMING_SHOT_MS) return false;
  const dx = q.x - ball.x;
  const dy = q.y - ball.y;
  const dist = Math.hypot(dx, dy);
  if (dist > KICK_RANGE || dist < 1e-4) return false;
  const spd = Math.hypot(ball.vx, ball.vy);
  if (spd < INCOMING_SHOT_SPEED) return false;
  const approach = (ball.vx * dx + ball.vy * dy) / (spd * dist);
  return approach >= INCOMING_SHOT_DOT;
}

/**
 * Apply a charged kick from player → ball. Returns powerT (0–1) or null if failed.
 */
function applyKick(q, ball, charge, now) {
  if (charge < CHARGE_MIN_FIRE) return null;
  if (now < q.kickAt) return null;
  if ((q.shootStamina ?? 0) < SHOOT_MIN_TO_FIRE) return null;

  const dx = ball.x - q.x;
  const dy = ball.y - q.y;
  if (Math.hypot(dx, dy) > KICK_RANGE) return null;

  // Direction: ball → cursor. Power: player → cursor (aim off-pitch / screen edge = harder shot).
  let ax = q.input.ax - ball.x;
  let ay = q.input.ay - ball.y;
  let dirLen = Math.hypot(ax, ay);
  if (dirLen < 0.5) {
    ax = dx;
    ay = dy;
    dirLen = Math.hypot(ax, ay) || 1;
  }
  const aimDist = Math.hypot(q.input.ax - q.x, q.input.ay - q.y);
  const dist = Math.max(aimDist, dirLen * 0.35);

  // Charge carries most of the power; aim distance still adds reach on top.
  const chargeFloor = charge * charge * CHARGE_BASE_POWER;
  const aimPower = dist * KICK_POWER_SCALE;
  const chargeMul = 1 + charge * CHARGE_POWER_BONUS;
  const powerCap = KICK_MAX * (1 + CHARGE_POWER_BONUS) + CHARGE_BASE_POWER * 0.15;
  const power = clamp((aimPower + chargeFloor) * chargeMul, KICK_MIN, powerCap);
  const powerT = clamp((power - KICK_MIN) / (powerCap - KICK_MIN || 1), 0, 1);
  // Steep cost curve: hard/charged shots burn much more shoot stamina.
  const costT = powerT * powerT;
  const cost = SHOOT_COST_MIN + (SHOOT_COST_MAX - SHOOT_COST_MIN) * costT;
  if (q.shootStamina < cost * 0.55) return null;
  q.shootStamina = Math.max(0, q.shootStamina - cost);

  const blend = KICK_BLEND + (1 - KICK_BLEND) * powerT * 0.5;
  const kvx = (ax / dirLen) * power;
  const kvy = (ay / dirLen) * power;
  ball.vx = ball.vx * (1 - blend) + kvx * blend;
  ball.vy = ball.vy * (1 - blend) + kvy * blend;
  ball.lastKickId = q.id;
  ball.shotBy = q.id;
  ball.shotAt = now;
  q.kickAt = now + KICK_COOLDOWN_MS;
  q.charge = 0;
  return powerT;
}

/** Soft carry: ease ball velocity toward move-biased aim while touching. */
function applyDribble(q, ball, dt) {
  const dx = ball.x - q.x;
  const dy = ball.y - q.y;
  const dist = Math.hypot(dx, dy);
  if (dist > PLAYER_R + BALL_R + DRIBBLE_TOUCH_SLACK) return;

  const ballSpd = Math.hypot(ball.vx, ball.vy);
  if (ballSpd > DRIBBLE_MAX_BALL_SPEED) return;

  const { wx, wy, len } = wishDir(q);
  let mx = q.vx;
  let my = q.vy;
  let mLen = Math.hypot(mx, my);
  if (mLen < 0.4 && len > 0) {
    mx = wx;
    my = wy;
    mLen = 1;
  } else if (mLen >= 0.4) {
    mx /= mLen;
    my /= mLen;
  } else {
    // Standing still — light push along contact normal away from feet is enough via physics.
    return;
  }

  let ax = q.input.ax - ball.x;
  let ay = q.input.ay - ball.y;
  let aLen = Math.hypot(ax, ay);
  if (aLen > 0.5) {
    ax /= aLen;
    ay /= aLen;
  } else {
    ax = mx;
    ay = my;
  }

  let nx = mx * DRIBBLE_MOVE_WEIGHT + ax * DRIBBLE_AIM_WEIGHT;
  let ny = my * DRIBBLE_MOVE_WEIGHT + ay * DRIBBLE_AIM_WEIGHT;
  const nLen = Math.hypot(nx, ny) || 1;
  nx /= nLen;
  ny /= nLen;

  const target = DRIBBLE_STRENGTH * (0.55 + 0.45 * Math.min(1, mLen / (SPRINT_SPEED || 1)));
  const ease = 1 - Math.exp(-DRIBBLE_EASE * dt);
  ball.vx += (nx * target - ball.vx) * ease;
  ball.vy += (ny * target - ball.vy) * ease;
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

/**
 * Fully separate two circles so they never share volume (plus CONTACT_SKIN gap).
 * Returns true if a correction was applied.
 */
function separateCircles(a, b, ra, rb, ma, mb) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  const min = ra + rb + CONTACT_SKIN;
  if (d >= min) return false;
  if (d < 1e-6) {
    dx = 1;
    dy = 0;
    d = 1;
  }
  const nx = dx / d;
  const ny = dy / d;
  const invA = 1 / ma;
  const invB = 1 / mb;
  const invSum = invA + invB;
  const overlap = min - d;
  // Full correction — never leave residual penetration.
  const corr = overlap / invSum;
  a.x -= nx * corr * invA;
  a.y -= ny * corr * invA;
  b.x += nx * corr * invB;
  b.y += ny * corr * invB;
  return true;
}

/**
 * Circle–circle impulse collision: hard separate, then normal impulse + friction.
 */
function collideCircles(a, b, ra, rb, ma, mb, restitution) {
  if (!separateCircles(a, b, ra, rb, ma, mb)) return false;

  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy) || 1;
  const nx = dx / d;
  const ny = dy / d;
  const invA = 1 / ma;
  const invB = 1 / mb;
  const invSum = invA + invB;

  const rvx = (b.vx ?? 0) - (a.vx ?? 0);
  const rvy = (b.vy ?? 0) - (a.vy ?? 0);
  const velN = rvx * nx + rvy * ny;
  if (velN < 0) {
    const j = -(1 + restitution) * velN / invSum;
    a.vx = (a.vx ?? 0) - j * nx * invA;
    a.vy = (a.vy ?? 0) - j * ny * invA;
    b.vx = (b.vx ?? 0) + j * nx * invB;
    b.vy = (b.vy ?? 0) + j * ny * invB;

    const tx = -ny;
    const ty = nx;
    const velT = rvx * tx + rvy * ty;
    const jtMax = Math.abs(j) * COLLISION_FRICTION;
    const jt = clamp(-velT / invSum, -jtMax, jtMax);
    a.vx -= jt * tx * invA;
    a.vy -= jt * ty * invA;
    b.vx += jt * tx * invB;
    b.vy += jt * ty * invB;
  }
  return true;
}

function clampPlayer(q) {
  q.x = clamp(q.x, PLAYER_R, FIELD_W - PLAYER_R);
  q.y = clamp(q.y, PLAYER_R, FIELD_H - PLAYER_R);
}

/** Exhaustive positional depenetration for players (+ optional ball). */
function resolveOverlaps(fielded, ball = null) {
  for (let iter = 0; iter < SEPARATE_ITERS; iter++) {
    let moved = false;
    for (let a = 0; a < fielded.length; a++) {
      for (let b = a + 1; b < fielded.length; b++) {
        if (
          separateCircles(
            fielded[a],
            fielded[b],
            PLAYER_R,
            PLAYER_R,
            PLAYER_MASS,
            PLAYER_MASS
          )
        ) {
          moved = true;
          clampPlayer(fielded[a]);
          clampPlayer(fielded[b]);
        }
      }
      if (ball) {
        if (
          separateCircles(
            fielded[a],
            ball,
            PLAYER_R,
            BALL_R,
            PLAYER_MASS,
            BALL_MASS
          )
        ) {
          moved = true;
          clampPlayer(fielded[a]);
        }
      }
    }
    if (!moved) break;
  }
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
      shootStamina: SHOOT_STAMINA_MAX,
      winded: false,
      kickAt: 0,
      charge: 0,
      prevK: false,
      prevSt: false,
      input: { u: false, d: false, l: false, r: false, sp: false, k: false, st: false, ax: 0, ay: 0 }
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
          ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0, lastKickId: 0, shotBy: 0, shotAt: 0 },
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
        i.st = !!msg.st;
        // Allow aiming well outside the pitch so screen-edge aims build power.
        i.ax = clamp(num(msg.ax), -FIELD_W * 2, FIELD_W * 3);
        i.ay = clamp(num(msg.ay), -FIELD_H * 2, FIELD_H * 3);
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
        q.stamina = STAMINA_MAX;
        q.shootStamina = SHOOT_STAMINA_MAX;
        q.winded = false;
        q.charge = 0;
        q.prevK = false;
        q.prevSt = false;
        q.kickAt = 0;
      });
    };
    place(room.players.filter((q) => q.team === 'red'), FIELD_W * 0.28);
    place(room.players.filter((q) => q.team === 'blue'), FIELD_W * 0.72);
    room.ball.x = FIELD_W / 2;
    room.ball.y = FIELD_H / 2;
    room.ball.vx = 0;
    room.ball.vy = 0;
    room.ball.lastKickId = 0;
    room.ball.shotBy = 0;
    room.ball.shotAt = 0;
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

    // Players: stamina, space-hold charge, slowed movement while charging.
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
      q.shootStamina = Math.min(
        SHOOT_STAMINA_MAX,
        (q.shootStamina ?? SHOOT_STAMINA_MAX) + SHOOT_STAMINA_REGEN * dt
      );

      const kDown = !!i.k;
      const canCharge =
        kDown && now >= q.kickAt && (q.shootStamina ?? 0) >= SHOOT_MIN_TO_FIRE;
      if (canCharge) {
        q.charge = Math.min(1, (q.charge || 0) + dt / CHARGE_TIME);
      } else if (kDown) {
        // Holding but on cooldown / no stamina — don't build charge
        q.charge = 0;
      }
      // On release, charge is consumed (or cleared) in the kick pass below.
      q._kReleased = q.prevK && !kDown;
      q.prevK = kDown;

      let speed = sprinting ? SPRINT_SPEED : BASE_SPEED;
      if (kDown && (q.charge || 0) > 0) {
        speed *= 1 - q.charge * CHARGE_SLOW_MAX;
      }
      const k = Math.min(1, MOVE_ACCEL * dt);
      q.vx += (wx * speed - q.vx) * k;
      q.vy += (wy * speed - q.vy) * k;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      clampPlayer(q);
      q.sprinting = sprinting;
    }

    // Player–player impulse collisions.
    for (let iter = 0; iter < COLLIDE_ITERS; iter++) {
      for (let a = 0; a < fielded.length; a++) {
        for (let b = a + 1; b < fielded.length; b++) {
          collideCircles(
            fielded[a],
            fielded[b],
            PLAYER_R,
            PLAYER_R,
            PLAYER_MASS,
            PLAYER_MASS,
            PLAYER_RESTITUTION
          );
          clampPlayer(fielded[a]);
          clampPlayer(fielded[b]);
        }
      }
    }
    resolveOverlaps(fielded);

    // Shots: release after charge, or auto-volley an incoming opponent shot while holding.
    const kickedThisTick = new Set();
    const tryPlayerKick = (q, charge) => {
      const powerT = applyKick(q, ball, charge, now);
      if (powerT == null) return false;
      kickedThisTick.add(q.id);
      this._broadcast(room, {
        t: 'kick',
        id: q.id,
        x: ball.x,
        y: ball.y,
        p: powerT
      });
      return true;
    };

    for (const q of fielded) {
      const holding = !!q.input.k;
      const autoVolley = holding && isIncomingShot(q, ball, now);
      if (!q._kReleased && !autoVolley) continue;

      let charge = q.charge || 0;
      q.charge = 0;
      // Holding into an incoming shot always fires at least a light return.
      if (autoVolley && charge < CHARGE_MIN_FIRE) charge = CHARGE_MIN_FIRE;
      tryPlayerKick(q, charge);
    }

    // Ball integration, then player–ball body collisions (physics carry/bounce).
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    const decay = Math.exp(-BALL_FRICTION * dt);
    ball.vx *= decay;
    ball.vy *= decay;
    if (Math.hypot(ball.vx, ball.vy) < 0.05) {
      ball.vx = 0;
      ball.vy = 0;
    }

    for (let iter = 0; iter < COLLIDE_ITERS; iter++) {
      for (const q of fielded) {
        if (
          collideCircles(
            q,
            ball,
            PLAYER_R,
            BALL_R,
            PLAYER_MASS,
            BALL_MASS,
            BALL_RESTITUTION
          )
        ) {
          clampPlayer(q);
          ball.lastKickId = q.id;
        }
      }
    }

    // Contact auto-volley: shot arrives while you're holding → release into a return.
    for (const q of fielded) {
      if (kickedThisTick.has(q.id)) continue;
      if (!q.input.k) continue;
      if (!isIncomingShot(q, ball, now)) continue;
      let charge = q.charge || 0;
      q.charge = 0;
      if (charge < CHARGE_MIN_FIRE) charge = CHARGE_MIN_FIRE;
      tryPlayerKick(q, charge);
    }

    // Soft dribble nudge (movement-biased toward cursor) when touching without a shot.
    for (const q of fielded) {
      if (kickedThisTick.has(q.id)) continue;
      if (q.input.k && (q.charge || 0) > 0) continue; // charging — don't also dribble-steer
      applyDribble(q, ball, dt);
    }

    // Right-click trap: fully kill ball momentum while in kick range (press edge).
    for (const q of fielded) {
      const stDown = !!q.input.st;
      const stPressed = stDown && !q.prevSt;
      q.prevSt = stDown;
      if (!stPressed) continue;
      if (Math.hypot(ball.x - q.x, ball.y - q.y) > KICK_RANGE) continue;
      ball.vx = 0;
      ball.vy = 0;
      ball.lastKickId = q.id;
    }

    // Pillar bounces: goal posts + field corners, then flat edges.
    for (let i = 0; i < 3; i++) resolveBallPillars(ball);

    if (ball.y < BALL_R) {
      ball.y = BALL_R;
      if (ball.vy < 0) ball.vy = -ball.vy * BOUNCE;
    } else if (ball.y > FIELD_H - BALL_R) {
      ball.y = FIELD_H - BALL_R;
      if (ball.vy > 0) ball.vy = -ball.vy * BOUNCE;
    }

    // Mouth is between the post centers; posts themselves bounce as pillars above.
    const inMouth = ball.y > GOAL_TOP + POST_R * 0.35 && ball.y < GOAL_BOT - POST_R * 0.35;
    if (ball.x < BALL_R) {
      if (inMouth) {
        if (ball.x < -0.5) this._goal(room, 'blue', now);
      } else {
        ball.x = BALL_R;
        if (ball.vx < 0) ball.vx = -ball.vx * BOUNCE;
      }
    } else if (ball.x > FIELD_W - BALL_R) {
      if (inMouth) {
        if (ball.x > FIELD_W + 0.5) this._goal(room, 'red', now);
      } else {
        ball.x = FIELD_W - BALL_R;
        if (ball.vx > 0) ball.vx = -ball.vx * BOUNCE;
      }
    }
    ball.x = clamp(ball.x, -GOAL_DEPTH + BALL_R, FIELD_W + GOAL_DEPTH - BALL_R);
    resolveBallPillars(ball);

    // Final hard depenetration — guarantees no residual clipping after walls.
    resolveOverlaps(fielded, ball);
    for (const q of fielded) clampPlayer(q);
    resolveOverlaps(fielded, ball);
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
      const cdLeft = Math.max(0, (q.kickAt || 0) - now);
      const ready = 1 - Math.min(1, cdLeft / KICK_COOLDOWN_MS);
      // Shoot stamina also gates firing — blend into the ready ring.
      const staminaReady = Math.min(1, (q.shootStamina ?? SHOOT_STAMINA_MAX) / SHOOT_MIN_TO_FIRE);
      const cd = Math.min(ready, staminaReady >= 1 ? 1 : staminaReady * 0.85);
      pl.push({
        i: q.id,
        x: Math.round(q.x * 100) / 100,
        y: Math.round(q.y * 100) / 100,
        s: Math.round(q.stamina * 10) / 10,
        ss: Math.round((q.shootStamina ?? SHOOT_STAMINA_MAX) * 10) / 10,
        r: q.sprinting ? 1 : 0,
        w: q.winded ? 1 : 0,
        cd: Math.round(cd * 100) / 100,
        ch: Math.round((q.charge || 0) * 100) / 100
      });
    }
    this._broadcast(room, {
      t: 'state',
      ph: room.phase,
      kt: room.phase === 'play' ? 0 : Math.max(0, room.phaseUntil - now),
      sc: room.score,
      ball: {
        x: Math.round(room.ball.x * 100) / 100,
        y: Math.round(room.ball.y * 100) / 100,
        vx: Math.round(room.ball.vx * 100) / 100,
        vy: Math.round(room.ball.vy * 100) / 100
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
