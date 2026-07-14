// ---------------------------------------------------------------------------
// multiplayer/constants.js
// Shared multiplayer constants imported by BOTH the browser client (via Vite)
// and the Node server. Pure data only — no THREE / no DOM / no Node APIs — so
// the same numbers drive rendering, movement bounds and server hit detection.
// ---------------------------------------------------------------------------

// Authoritative simulation rate. "128 tick" servers, like CS2 competitive.
export const TICK_RATE = 128;
export const TICK_MS = 1000 / TICK_RATE; // 7.8125 ms

// Snapshots to clients — decoupled from sim tick to cut WS bandwidth/CPU load.
export const SNAPSHOT_RATE = 32;
export const SNAPSHOT_EVERY = Math.max(1, Math.round(TICK_RATE / SNAPSHOT_RATE));

// Player collision / movement dimensions (unchanged — movement feel is frozen).
export const BODY_R = 0.35; // movement collision radius + MP body hit cylinder (m)
export const BODY_H = 1.3; // body top used by movement collision (crouch-under checks)
export const HEAD_OFFSET = 0.02; // legacy gap constant (kept for old callers)
export const STAND_EYE = 1.6; // standing eye height (m)
export const CROUCH_EYE = 1.15; // ducked eye height (m)
export const CROUCH_SCALE = 0.55; // movement-collision vertical squash when fully ducked

// CS-true bot hit model (matches src/bots/CSBotModel.js — the skeletal bot).
// Standing head centre ≈ 65 u, crouched ≈ 48 u; the MP server validates hits
// against a sphere/cylinder wrapping the visible skeletal model.
export const HEAD_CENTER_STAND = 1.655; // head capsule centre, standing (m)
export const HEAD_CENTER_CROUCH = 1.21; // head capsule centre, fully ducked (m)
export const HEAD_R = 0.13; // analytic head sphere wrapping the head capsule
export const BODY_TOP_STAND = 1.47; // shoulder line — top of the MP body hit cylinder
export const BODY_TOP_CROUCH = 1.02;

/** Vertical squash factor for a given crouch amount (0..1) — movement collision. */
export function crouchScale(crouch) {
  return 1 + (CROUCH_SCALE - 1) * crouch;
}

/** Eye height above feet for a given crouch amount (0..1). */
export function eyeOffset(crouch) {
  return STAND_EYE + (CROUCH_EYE - STAND_EYE) * crouch;
}

/** Head-capsule centre height above the feet for a given crouch amount. */
export function headCenterY(crouch) {
  return HEAD_CENTER_STAND + (HEAD_CENTER_CROUCH - HEAD_CENTER_STAND) * crouch;
}

/** Top of the MP body hit cylinder above the feet for a given crouch amount. */
export function bodyTopY(crouch) {
  return BODY_TOP_STAND + (BODY_TOP_CROUCH - BODY_TOP_STAND) * crouch;
}

// "First to X" win targets offered in custom-game lobbies. 0 == endless.
export const SCORE_TARGETS = [
  { value: 13, label: 'First to 13' },
  { value: 30, label: 'First to 30' },
  { value: 60, label: 'First to 60' },
  { value: 100, label: 'First to 100' },
  { value: 0, label: 'Endless' }
];

/** Ranked matchmaking duels always use this win target. */
export const MM_SCORE_TARGET = 30;

/** Custom-game tracking duel — empty arena, timed score race. */
export const TRACKING_DURATION = 30; // seconds
export const TRACKING_RPM = 600;
export const TRACKING_HEAD_PTS = 3;
export const TRACKING_BODY_PTS = 2;
export const TRACKING_MAP_ID = 'tracking-arena';

export const RESPAWN_DELAY = 0.35; // deathmatch: align with client death FX, then respawn
/** Seconds after spawn/respawn: no move, no shoot, invulnerable (deathmatch). */
export const SPAWN_GRACE = 0.5;
export const MAX_PLAYERS = 2; // a duel is 1v1

// ---- Free-for-all Deathmatch ---------------------------------------------
export const DEATHMATCH_MAP_ID = 'deathmatch';
export const DEATHMATCH_MAX_PLAYERS = 6; // humans + bots share this cap
export const DEATHMATCH_DURATION = 0; // 0 = no time limit (frag-target only)
export const DEATHMATCH_FRAG_TARGET = 30; // first to N kills wins (custom games)
export const DEATHMATCH_MAX_BOTS = 6; // optional bot fill (added in a later pass)

/** Per-mode player cap. Deathmatch is FFA up to DEATHMATCH_MAX_PLAYERS. */
export function maxPlayersForMode(mode) {
  return mode === 'deathmatch' ? DEATHMATCH_MAX_PLAYERS : MAX_PLAYERS;
}
