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

// Player avatar dimensions — identical to the Duels enemy bot model so remote
// players render (and are hit-tested) exactly like the singleplayer enemy.
export const BODY_R = 0.35; // body cylinder radius (m)
export const BODY_H = 1.3; // standing body height (m)
export const HEAD_R = 0.27; // head sphere radius (m)
export const HEAD_OFFSET = 0.02; // gap between body top and head bottom
export const STAND_EYE = 1.6; // standing eye height (m)
export const CROUCH_EYE = 1.15; // ducked eye height (m)
export const CROUCH_SCALE = 0.55; // body/head vertical squash when fully ducked

/** Vertical squash factor for a given crouch amount (0..1). */
export function crouchScale(crouch) {
  return 1 + (CROUCH_SCALE - 1) * crouch;
}

/** Eye height above feet for a given crouch amount (0..1). */
export function eyeOffset(crouch) {
  return STAND_EYE + (CROUCH_EYE - STAND_EYE) * crouch;
}

/** Head-centre height above the feet for a given crouch amount. */
export function headCenterY(crouch) {
  return BODY_H * crouchScale(crouch) + HEAD_R + HEAD_OFFSET;
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

export const RESPAWN_DELAY = 1.4; // seconds between death and respawn
export const SPAWN_GRACE = 0.5; // seconds after spawn where keyboard movement is locked
export const MAX_PLAYERS = 2; // a duel is 1v1
