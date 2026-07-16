// ---------------------------------------------------------------------------
// server/football.js
// Easter-egg 2D football (soccer). The standalone page /tools/football.html
// connects here over WS at /football. Fully server-authoritative: a fixed-step
// 128 Hz sim (late timers catch up, so skipped ticks never stretch physics)
// of players + ball with substepped impulse collisions, code-joined lobbies with
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
export const FIELD_W = 100;
export const FIELD_H = 62;
const GOAL_H = 19.2; // +20% taller than original 16
export const GOAL_TOP = (FIELD_H - GOAL_H) / 2;
export const GOAL_BOT = GOAL_TOP + GOAL_H;
export const GOAL_DEPTH = 3; // net box behind each goal line

const PLAYER_R = 1.047; // −15% from 1.232
const BALL_R = 1.02; // −15% from 1.2

// Movement. Hold shift to sprint — stamina pool drains while sprinting
// and regenerates while not; running dry "winds" you until partially recovered.
const BASE_SPEED = 10.973; // −5% from 11.55
const SPRINT_SPEED = 19.698; // −5% from 20.735
const MOVE_ACCEL = 12; // 1/s — slower, smoother ramp
const STAMINA_MAX = 4.48; // −30% from 6.4 — meant for short bursts of movement
const STAMINA_REGEN = 0.8; // per second while not sprinting
const STAMINA_STILL_MULT = 1.3; // standing perfectly still recharges 30% faster
const WINDED_RECOVER = 1.28; // stamina needed to un-wind after running dry

// Shooting stamina — separate from sprint. Each kick drains this pool.
const SHOOT_STAMINA_MAX = 56; // was 80 (−30%)
const SHOOT_STAMINA_REGEN = 9; // per second — was 18 (−50%)
const SHOOT_COST_MIN = 14; // weak tap
const SHOOT_COST_MAX = 58; // full-power / charged shot (steep curve)
const SHOOT_MIN_TO_FIRE = 10; // need at least this much to shoot

// Ball. Shot power scales with aim distance (mouse distance = shot power).
// Aiming off the pitch is an automatic full-distance shot, and every shot
// rolls at least SHOT_MIN_DIST (exp-friction ball travel ≈ v0 / friction).
const BALL_FRICTION = 0.72; // 1/s — longer rolls so powered shots carry
const KICK_RANGE = PLAYER_R + BALL_R + 2.0;
const KICK_COOLDOWN_MS = 420;
const KICK_POWER_SCALE = 0.925; // aim distance → power (−7.5%)
const SHOT_MIN_DIST = 14; // minimum roll even with the cursor on the ball
const KICK_MIN = SHOT_MIN_DIST * BALL_FRICTION; // ≈ 10.1
const KICK_MAX = 53.5; // aim-power cap (~74 units of roll); off-pitch aim = this
const BALL_MAX_SPEED = 72; // hard ceiling on ball speed, charged shots included
const KICK_PUSH_SPEED = 5; // very light shove on other players in kick range
const BODY_KICK_PUSH = 8; // kick released into an enemy (no ball) boots them along the aim
const BODY_KICK_TRAP_LOCK_MS = 800; // body-kicked players can't trap for this long
const BOUNCE = 0.88; // pillar-like restitution on posts / field edges
const POST_R = 0.7; // goal-post pillars
const CORNER_R = 0.55; // field-corner pillars
const KICK_BLEND = 0.9; // strong commit to shot direction/power
const CHARGE_TIME = 0.9; // seconds of hold → full charge
const CHARGE_SLOW_MAX = 0.55; // up to 55% slower while fully charged
const CHARGE_POWER_BONUS = 0.35; // extra scale on top of aim+charge floor
const CHARGE_BASE_POWER = 44; // full charge adds this much power even at point-blank aim

// Auto-volley: holding shoot when an opponent's shot comes at you → release.
const INCOMING_SHOT_SPEED = 10;
const INCOMING_SHOT_DOT = 0.2; // ball velocity aligned toward player
const INCOMING_SHOT_MS = 2800;

// Soft dribble when touching the ball without shooting. Carry speed tracks
// the player's actual speed, so sprint-dribbles knock the ball further ahead.
const DRIBBLE_TOUCH_SLACK = 0.2;
const DRIBBLE_MAX_BALL_SPEED = 28; // don't steer hard shots
const DRIBBLE_STRENGTH = 9; // minimum carry speed (units/s)
const DRIBBLE_CARRY = 1.15; // ball target speed = player speed × this
const DRIBBLE_SPRINT_CARRY = 1.32; // sprinting bounces the ball further out
const DRIBBLE_EASE = 12; // 1/s — quick response to direction changes
const DRIBBLE_MOVE_WEIGHT = 0.72; // movement direction vs cursor
const DRIBBLE_AIM_WEIGHT = 0.28;

// Barely shooting (held < TAP_HOLD_S before release) is a fixed short pass:
// the cursor sets direction only — power ignores cursor distance and is the
// minimum shot threshold (about half the previous tap speed).
const TAP_HOLD_S = 0.2;
const TAP_CHARGE = TAP_HOLD_S / CHARGE_TIME;
const TAP_SHOT_SPEED = KICK_MIN;

// Collision masses / restitution (impulse response).
const PLAYER_MASS = 1;
const BALL_MASS = 0.22;
const PLAYER_RESTITUTION = 0.22; // bodies don't bounce much
const BALL_RESTITUTION = 0.58; // lively ball bounce off players
const COLLISION_FRICTION = 0.1; // tangent damping on contact
const CONTACT_SKIN = 0.05; // forced gap so bodies never share volume
const COLLIDE_ITERS = 3; // impulse iterations per substep
const SEPARATE_ITERS = 10;
// Fixed timestep + movement substeps (haxball-style aggressive scanning):
// the sim always advances in exact 1/TICK_HZ steps — a late timer runs several
// catch-up steps instead of one big stretched one — and within a step bodies
// move in slices small enough that a full-power shot can never pass through
// (or end a frame inside) a player between collision checks.
const MAX_CATCHUP_TICKS = 16; // >125ms behind → drop time instead of spiraling
const SUBSTEP_TRAVEL = 0.4; // max combined ball+player travel per slice
const MAX_SUBSTEPS = 6;
// A shot taken from a trapper's feet breaks their held trap (re-press to trap).
const TRAP_BREAK_SLACK = 0.5;
// While trapping and moving, the ball eases toward a follow point at the feet.
const TRAP_FOLLOW_GAP = 0.15; // clearance beyond player+ball radii
const TRAP_KEEP_RANGE = KICK_RANGE + 2.5; // once trapped, longer leash so the ball chases you
const TRAP_MOVE_MULT = 0.95; // −5% move speed (walk and sprint) while holding trap
const TRAP_POS_EASE = 14; // 1/s — smooth radius / stick-to-player
const TRAP_ANG_EASE = 10; // 1/s — orbit toward crosshair direction
const TRAP_VEL_EASE = 16; // 1/s — match player velocity

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
  const tap = charge < TAP_CHARGE; // barely shot — fixed short pass
  if (now < q.kickAt) return null;
  if ((q.shootStamina ?? 0) < SHOOT_MIN_TO_FIRE) return null;

  const dx = ball.x - q.x;
  const dy = ball.y - q.y;
  if (Math.hypot(dx, dy) > KICK_RANGE) return null;

  // Direction: ball → cursor. Power: player → cursor distance, capped at
  // KICK_MAX — and aiming anywhere off the pitch is always a full-distance shot.
  let ax = q.input.ax - ball.x;
  let ay = q.input.ay - ball.y;
  let dirLen = Math.hypot(ax, ay);
  if (dirLen < 0.5) {
    ax = dx;
    ay = dy;
    dirLen = Math.hypot(ax, ay) || 1;
  }
  const offPitch =
    q.input.ax <= 0 || q.input.ax >= FIELD_W ||
    q.input.ay <= 0 || q.input.ay >= FIELD_H;
  const aimDist = Math.hypot(q.input.ax - q.x, q.input.ay - q.y);
  const dist = Math.max(aimDist, dirLen * 0.35);

  // Charge carries most of the power; aim distance still adds reach on top.
  const chargeFloor = charge * charge * CHARGE_BASE_POWER;
  const aimPower = offPitch ? KICK_MAX : Math.min(dist * KICK_POWER_SCALE, KICK_MAX);
  const chargeMul = 1 + charge * CHARGE_POWER_BONUS;
  const power = tap
    ? TAP_SHOT_SPEED
    : clamp((aimPower + chargeFloor) * chargeMul, KICK_MIN, BALL_MAX_SPEED);
  const powerT = clamp((power - KICK_MIN) / (BALL_MAX_SPEED - KICK_MIN || 1), 0, 1);
  // Steep cost curve: hard/charged shots burn much more shoot stamina.
  // Taps always cost the cheap-flick minimum despite their fixed speed.
  const costT = tap ? 0 : powerT * powerT;
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

/**
 * Hold-to-trap follow: keep the ball on a ring around the player and ease
 * its angle toward the crosshair so it orbits smoothly as you aim.
 */
function applyTrapFollow(q, ball, dt, range = KICK_RANGE) {
  if (Math.hypot(ball.x - q.x, ball.y - q.y) > range) return false;

  const hold = PLAYER_R + BALL_R + TRAP_FOLLOW_GAP;

  // Prefer crosshair direction; fall back to movement / current offset.
  let ax = q.input.ax - q.x;
  let ay = q.input.ay - q.y;
  let aLen = Math.hypot(ax, ay);
  if (aLen < 0.5) {
    const spd = Math.hypot(q.vx, q.vy);
    if (spd > 0.35) {
      ax = q.vx;
      ay = q.vy;
      aLen = spd;
    } else {
      const { wx, wy, len } = wishDir(q);
      if (len > 0) {
        ax = wx;
        ay = wy;
        aLen = 1;
      } else {
        ax = ball.x - q.x;
        ay = ball.y - q.y;
        aLen = Math.hypot(ax, ay) || 1;
      }
    }
  }
  const targetAng = Math.atan2(ay, ax);

  let curAng = Math.atan2(ball.y - q.y, ball.x - q.x);
  let dAng = targetAng - curAng;
  while (dAng > Math.PI) dAng -= Math.PI * 2;
  while (dAng < -Math.PI) dAng += Math.PI * 2;
  const ak = 1 - Math.exp(-TRAP_ANG_EASE * dt);
  curAng += dAng * ak;

  const curR = Math.hypot(ball.x - q.x, ball.y - q.y);
  const rk = 1 - Math.exp(-TRAP_POS_EASE * dt);
  const r = curR + (hold - curR) * rk;

  const targetX = q.x + Math.cos(curAng) * r;
  const targetY = q.y + Math.sin(curAng) * r;
  // Stick tightly to the orbit point so the ball rides with the player.
  const pk = 1 - Math.exp(-TRAP_POS_EASE * dt);
  ball.x += (targetX - ball.x) * pk;
  ball.y += (targetY - ball.y) * pk;

  const vk = 1 - Math.exp(-TRAP_VEL_EASE * dt);
  ball.vx += (q.vx - ball.vx) * vk;
  ball.vy += (q.vy - ball.vy) * vk;
  if (Math.hypot(ball.vx - q.vx, ball.vy - q.vy) < 0.08) {
    ball.vx = q.vx;
    ball.vy = q.vy;
  }

  ball.lastKickId = q.id;
  return true;
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
  const spd = Math.hypot(q.vx, q.vy);
  let mx = q.vx;
  let my = q.vy;
  if (spd < 0.4 && len > 0) {
    mx = wx;
    my = wy;
  } else if (spd >= 0.4) {
    mx /= spd;
    my /= spd;
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

  // Carry speed tracks actual player speed so the ball never lags under your
  // feet mid-run; sprinting knocks it slightly further ahead each touch.
  const carry = q.sprinting ? DRIBBLE_SPRINT_CARRY : DRIBBLE_CARRY;
  const target = Math.max(DRIBBLE_STRENGTH, spd * carry);
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
    this._acc = 0; // fixed-timestep accumulator (seconds)
    this._simNow = Date.now(); // sim clock (ms) — advances in exact TICK_MS steps
    this._tickNo = 0;
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
      trapBroken: false,
      trapHeld: false,
      trapLockUntil: 0,
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
          goalsToWin: GOALS_TO_WIN,
          timeLimitMs: 0, // 0 = no time limit
          playedMs: 0,
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
        if ('goals' in msg) {
          room.goalsToWin = clamp(Math.round(num(msg.goals, GOALS_TO_WIN)), 1, 99);
        }
        if ('timeMin' in msg) {
          // 0 = no time limit.
          room.timeLimitMs = clamp(Math.round(num(msg.timeMin)), 0, 120) * 60000;
        }
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
        // Self-selection. Mid-match, only spectators may hop onto a team
        // (no red↔blue swaps while a game is live).
        const room = p.room;
        if (!room || !TEAMS.has(msg.team)) return;
        if (room.inMatch) {
          if (p.team !== 'spec' || msg.team === 'spec') return;
          p.team = msg.team;
          // Spawn in front of your own goal, at rest and fully recovered.
          p.x = msg.team === 'red' ? 15 : FIELD_W - 15;
          p.y = FIELD_H / 2;
          p.vx = 0;
          p.vy = 0;
          p.stamina = STAMINA_MAX;
          p.shootStamina = SHOOT_STAMINA_MAX;
          p.winded = false;
          p.charge = 0;
          p.prevK = false;
          p.trapBroken = false;
          p.trapHeld = false;
          p.trapLockUntil = 0;
          p.kickAt = 0;
          this._broadcastLobby(room);
          return;
        }
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
    room.playedMs = 0;
    this._resetPositions(room);
    room.phase = 'kickoff';
    room.phaseUntil = this._simNow + KICKOFF_MS;
    this._broadcast(room, this._startPayload(room));
    this._broadcastLobbyList();
  }

  _startPayload(room) {
    return {
      t: 'start',
      field: { w: FIELD_W, h: FIELD_H, gt: GOAL_TOP, gb: GOAL_BOT, gd: GOAL_DEPTH },
      score: room.score,
      goalsToWin: room.goalsToWin,
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
        q.trapBroken = false;
        q.trapHeld = false;
        q.trapLockUntil = 0;
        q.kickAt = 0;
      });
    };
    place(room.players.filter((q) => q.team === 'red'), 30);
    place(room.players.filter((q) => q.team === 'blue'), FIELD_W - 30);
    room.ball.x = FIELD_W / 2;
    room.ball.y = FIELD_H / 2;
    room.ball.vx = 0;
    room.ball.vy = 0;
    room.ball.lastKickId = 0;
    room.ball.shotBy = 0;
    room.ball.shotAt = 0;
  }

  // ---- Simulation -----------------------------------------------------------
  // Fixed timestep: a late timer runs several exact-size catch-up steps rather
  // than one big stretched step, so physics stays identical when ticks skip.
  // The client sees the (larger) gap between snapshots and interpolates it.
  _tick() {
    const now = Date.now();
    const elapsed = (now - this._lastTick) / 1000;
    this._lastTick = now;
    if (elapsed <= 0) return;
    this._acc += elapsed;
    let steps = Math.floor(this._acc * TICK_HZ);
    if (steps <= 0) return;
    this._acc -= steps / TICK_HZ;
    if (steps > MAX_CATCHUP_TICKS) {
      steps = MAX_CATCHUP_TICKS;
      this._acc = 0;
    }
    const dt = 1 / TICK_HZ;
    for (let s = 0; s < steps; s++) {
      this._simNow += TICK_MS;
      this._tickNo++;
      for (const room of this.rooms.values()) {
        if (!room.inMatch) continue;
        // A physics exception in one room must never kill the process (and
        // every other lobby with it) — abort just that match.
        try {
          this._sim(room, dt, this._simNow);
        } catch (err) {
          console.error('[football] sim error', err);
          this._endMatch(room, null, true);
        }
      }
    }
    for (const room of this.rooms.values()) {
      if (room.inMatch) this._broadcastState(room, this._simNow);
    }
  }

  _sim(room, dt, now) {
    // Phase transitions: goal pause → reset → kickoff freeze → play.
    if (room.phase !== 'play') {
      if (now >= room.phaseUntil) {
        if (room.phase === 'goal') {
          // Match point: end here, on the sim clock — never reset into a
          // kickoff after the winning goal.
          const winner =
            room.score.red >= room.goalsToWin ? 'red'
            : room.score.blue >= room.goalsToWin ? 'blue' : null;
          if (winner) {
            this._endMatch(room, winner);
            return;
          }
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

    // Timed match: the clock only runs during live play (kickoff freezes and
    // goal pauses don't consume match time). Leader at full time wins; a tie
    // ends as a draw.
    if (room.timeLimitMs) {
      room.playedMs += dt * 1000;
      if (room.playedMs >= room.timeLimitMs) {
        const winner =
          room.score.red > room.score.blue ? 'red'
          : room.score.blue > room.score.red ? 'blue' : null;
        this._endMatch(room, winner);
        return;
      }
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
        // Standing perfectly still (no input, not sliding) recharges faster.
        const still = len === 0 && Math.hypot(q.vx, q.vy) < 0.5;
        const regen = STAMINA_REGEN * (still ? STAMINA_STILL_MULT : 1);
        q.stamina = Math.min(STAMINA_MAX, q.stamina + regen * dt);
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
      if (i.st) speed *= TRAP_MOVE_MULT;
      const k = Math.min(1, MOVE_ACCEL * dt);
      q.vx += (wx * speed - q.vx) * k;
      q.vy += (wy * speed - q.vy) * k;
      q.sprinting = sprinting;
      // Positions advance in the substepped integrate+collide loop below.
    }

    // Shots: release after charge, or auto-volley an incoming opponent shot while holding.
    const kickedThisTick = new Set();
    const tryPlayerKick = (q, charge) => {
      const powerT = applyKick(q, ball, charge, now);
      if (powerT == null) return false;
      kickedThisTick.add(q.id);
      // The kick also shoves other players in range — very slightly, scaled
      // by proximity and shot power (input easing bleeds it off quickly).
      for (const w of fielded) {
        if (w === q) continue;
        const wdx = w.x - q.x;
        const wdy = w.y - q.y;
        const wd = Math.hypot(wdx, wdy);
        if (wd > KICK_RANGE || wd < 1e-4) continue;
        const f = KICK_PUSH_SPEED * (1 - wd / KICK_RANGE) * (0.6 + 0.4 * powerT);
        w.vx += (wdx / wd) * f;
        w.vy += (wdy / wd) * f;
      }
      // A shot taken from someone's feet overrides their held trap — the ball
      // flies, and they must release and re-press to trap again.
      for (const w of fielded) {
        if (!w.input.st || w.trapBroken) continue;
        if (w === q || Math.hypot(ball.x - w.x, ball.y - w.y) <= KICK_RANGE + TRAP_BREAK_SLACK) {
          w.trapBroken = true;
        }
      }
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

      const charge = q.charge || 0;
      q.charge = 0;
      // An uncharged release (or auto-volley) fires as a tap-speed return.
      if (tryPlayerKick(q, charge)) continue;
      // A swing that misses the ball still boots enemies in kick range along
      // the shot direction and locks their trap briefly — a tackle that can
      // knock a dribbler off the ball.
      if (q._kReleased && now >= q.kickAt) {
        // Push along the aim direction; fall back to away-from-kicker.
        const ax = q.input.ax - q.x;
        const ay = q.input.ay - q.y;
        const aLen = Math.hypot(ax, ay);
        let hit = false;
        for (const w of fielded) {
          if (w.team === q.team) continue;
          const wdx = w.x - q.x;
          const wdy = w.y - q.y;
          const wd = Math.hypot(wdx, wdy);
          if (wd > KICK_RANGE || wd < 1e-4) continue;
          const f = BODY_KICK_PUSH * (0.5 + 0.5 * charge);
          const nx = aLen > 0.5 ? ax / aLen : wdx / wd;
          const ny = aLen > 0.5 ? ay / aLen : wdy / wd;
          w.vx += nx * f;
          w.vy += ny * f;
          w.trapLockUntil = now + BODY_KICK_TRAP_LOCK_MS;
          hit = true;
        }
        if (hit) q.kickAt = now + KICK_COOLDOWN_MS;
      }
    }

    // Soft dribble nudge (movement-biased toward cursor) when touching without a shot.
    for (const q of fielded) {
      if (kickedThisTick.has(q.id)) continue;
      if (q.input.st && !q.trapBroken) continue; // trap follow owns the ball
      if (q.input.k && (q.charge || 0) > 0) continue; // charging — don't also dribble-steer
      applyDribble(q, ball, dt);
    }

    // Hold-to-trap: while the button is held and the ball is in reach, ease it
    // along with the player (smooth follow). A shot from your feet breaks the
    // hold until you release and press again.
    const trappers = [];
    for (const q of fielded) {
      if (!q.input.st) {
        q.trapBroken = false;
        q.trapHeld = false;
        continue;
      }
      if (q.trapBroken || now < (q.trapLockUntil || 0) || kickedThisTick.has(q.id)) {
        q.trapHeld = false;
        continue;
      }
      trappers.push(q);
    }
    const applyTraps = (stepDt) => {
      // Closest trapper wins if several overlap the ball. Engaging needs the
      // ball in kick range; once held, a longer leash keeps it following you.
      let best = null;
      let bestD = Infinity;
      for (const q of trappers) {
        const d = Math.hypot(ball.x - q.x, ball.y - q.y);
        const reach = q.trapHeld ? TRAP_KEEP_RANGE : KICK_RANGE;
        if (d <= reach && d < bestD) {
          best = q;
          bestD = d;
        }
      }
      for (const q of trappers) q.trapHeld = q === best;
      if (best) applyTrapFollow(best, ball, stepDt, TRAP_KEEP_RANGE);
    };
    applyTraps(dt);

    // Hard ceiling on ball speed no matter how kicks and impulses stack up.
    const ballSpd = Math.hypot(ball.vx, ball.vy);
    if (ballSpd > BALL_MAX_SPEED) {
      const f = BALL_MAX_SPEED / ballSpd;
      ball.vx *= f;
      ball.vy *= f;
    }

    // Integrate + collide in slices small enough that a full-power shot can't
    // pass through (or end a frame inside) a body between collision checks.
    let maxPlayerSpd = 0;
    for (const q of fielded) {
      maxPlayerSpd = Math.max(maxPlayerSpd, Math.hypot(q.vx, q.vy));
    }
    const travel = (Math.hypot(ball.vx, ball.vy) + maxPlayerSpd) * dt;
    const nSub = clamp(Math.ceil(travel / SUBSTEP_TRAVEL), 1, MAX_SUBSTEPS);
    const h = dt / nSub;
    const decay = Math.exp(-BALL_FRICTION * h);

    for (let s = 0; s < nSub; s++) {
      for (const q of fielded) {
        q.x += q.vx * h;
        q.y += q.vy * h;
        clampPlayer(q);
      }
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      ball.vx *= decay;
      ball.vy *= decay;

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

      applyTraps(h); // held trap follows / swallows the ball as it arrives

      // Pillar bounces: goal posts + field corners, then flat edges.
      resolveBallPillars(ball);

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

      resolveOverlaps(fielded, ball);
      if (room.phase !== 'play') return; // goal scored — celebration takes over
    }

    if (Math.hypot(ball.vx, ball.vy) < 0.05) {
      ball.vx = 0;
      ball.vy = 0;
    }

    // Contact auto-volley: shot arrives while you're holding → release into a return.
    for (const q of fielded) {
      if (kickedThisTick.has(q.id)) continue;
      if (!q.input.k) continue;
      if (!isIncomingShot(q, ball, now)) continue;
      const charge = q.charge || 0;
      q.charge = 0;
      tryPlayerKick(q, charge);
    }

    // Final hard depenetration — a broadcast frame never contains overlap.
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
    // On match point, _sim ends the match when the goal pause elapses.
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
      tk: this._tickNo, // gaps here = skipped/caught-up ticks; client interpolates
      ph: room.phase,
      kt: room.phase === 'play' ? 0 : Math.max(0, room.phaseUntil - now),
      sc: room.score,
      tl: room.timeLimitMs ? Math.max(0, Math.round(room.timeLimitMs - room.playedMs)) : -1,
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
      goals: room.goalsToWin,
      timeMin: room.timeLimitMs / 60000,
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
