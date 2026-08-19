// ---------------------------------------------------------------------------
// shared/sim3d/flash.js
// What a flashbang does to a pair of eyes.
//
// Port of CS:GO leak `CFlashbangProjectile::Detonate` → `RadiusFlash` →
// `PercentageOfFlashForPlayer` → `CCSPlayer::Blind` / `Deafen`
// (cstrike15_src flashbang_projectile.cpp, cs_player.cpp). Headless, like the
// rest of shared/sim3d: the world is a `trace(from, to)` that returns a Source
// fraction. src/cs3d/nadeEffects.js is the body around it.
//
// Strength. The leak ConVar is `sv_flashbang_strength` default **"3.55"**
// (range 2–8). `Detonate` calls `GetInt()`, which truncates that to **3**.
// Players, the wiki, and CS2's still-quoted 3.55 all treat it as a float, and
// falloff is `flDamage / 3000` so 3 vs 3.55 scales every duration linearly.
// Nothing here had locked GetInt=3 with tests, so this file uses **3.55 as
// GetFloat**. CS2 dumps expose `CFlashbangProjectile` with no public strength
// ConVar; 3.55 remains the number people tune.
//
// HUD. `Blind(hold, fade)` does NOT hold-then-fade the overlay. It stores
// `m_flFlashDuration = fadeTime / 1.4`. The client (`UpdateFlashBangEffect`)
// is full white while more than 3 s remain, then `(left/3)²`. `fadeHold` still
// drives `m_blindUntilTime` (AI / IsBlind). Overlay duration always finishes
// before that, so PostThink zeroing `m_flFlashDuration` when !IsBlind does not
// cut the whiteout short.
// ---------------------------------------------------------------------------

/** Leak `sv_flashbang_strength` default, as GetFloat. See file header. */
export const SV_FLASHBANG_STRENGTH = 3.55;

/** Leak `RadiusFlash` radius. */
export const FLASH_RADIUS = 3000;

/** Leak `FLASH_FRACTION` for each of the three bounce samples. */
export const FLASH_FRACTION = 0.167;

/** Leak `vecSrc.z += 1` so a grenade sitting on the floor still reaches eyes. */
export const FLASH_Z_OFFSET = 1;

/** Sideways sample offset, leak `SIDE_OFFSET`. */
export const FLASH_SIDE_OFFSET = 75;

/** Up sample on the first bounce, leak `vecUp * 50`. */
export const FLASH_UP_OFFSET = 50;

/** `Blind`: networked duration is `fadeTime / 1.4`. */
export const FLASH_DURATION_DIVISOR = 1.4;

/**
 * Client overlay: full white while remaining > this many seconds, then
 * quadratic out. Leak `certainBlindnessTimeThresh`.
 */
export const FLASH_CERTAIN_BLINDNESS = 3;

/** Client flash-in, seconds: `(255 / 45) * (1 / 60)`. */
export const FLASH_BUILD_UP = (255 / 45) * (1 / 60);

const DEG = Math.PI / 180;

export const FLASH_FACING = Object.freeze([
  { minDot: 0.6, fadeTime: 2.5, fadeHold: 1.25 },
  { minDot: 0.3, fadeTime: 1.75, fadeHold: 0.8 },
  { minDot: -0.2, fadeTime: 1.0, fadeHold: 0.5 },
  { minDot: -Infinity, fadeTime: 0.5, fadeHold: 0.25 }
]);

/**
 * Longest overlay the HUD can show: point-blank, looking at it, LOS 1.0.
 * `adj * 2.5 / 1.4`.
 */
export const FLASH_MAX_SECONDS = (SV_FLASHBANG_STRENGTH * 2.5) / FLASH_DURATION_DIVISOR;

function len(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function addScaled(a, b, s) {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function copy(p) {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * Source `VectorAngles(forward)` — yaw/pitch in degrees, roll 0.
 * @returns {{pitch:number, yaw:number}}
 */
export function vectorAngles(forward) {
  let yaw;
  let pitch;
  if (forward.y === 0 && forward.x === 0) {
    yaw = 0;
    pitch = forward.z > 0 ? 270 : 90;
  } else {
    yaw = Math.atan2(forward.y, forward.x) / DEG;
    if (yaw < 0) yaw += 360;
    const tmp = Math.hypot(forward.x, forward.y);
    pitch = Math.atan2(-forward.z, tmp) / DEG;
    if (pitch < 0) pitch += 360;
  }
  return { pitch, yaw };
}

/**
 * Source `AngleVectors` right and up (roll 0). Forward is unused by the flash
 * samples.
 * @returns {{right:{x,y,z}, up:{x,y,z}}}
 */
export function angleVectorsRightUp(pitchDeg, yawDeg) {
  const sy = Math.sin(yawDeg * DEG);
  const cy = Math.cos(yawDeg * DEG);
  const sp = Math.sin(pitchDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG);
  return {
    right: { x: sy, y: -cy, z: 0 },
    up: { x: sp * cy, y: sp * sy, z: cp }
  };
}

function rightUpFromFlashToEye(flashPos, eye) {
  const { pitch, yaw } = vectorAngles(sub(eye, flashPos));
  return angleVectorsRightUp(pitch, yaw);
}

function clearLine(tr) {
  return !tr || tr.fraction >= 1;
}

function runTrace(trace, from, to) {
  if (!trace) return { fraction: 1, endpos: copy(to) };
  const tr = trace(from, to);
  if (!tr) return { fraction: 1, endpos: copy(to) };
  const endpos = tr.endpos ? copy(tr.endpos) : copy(to);
  const fraction = Number.isFinite(tr.fraction) ? tr.fraction : 1;
  return { fraction, endpos };
}

function sampleClear(flashPos, offset, eye, trace) {
  const mid = addScaled(flashPos, offset, 1);
  const first = runTrace(trace, flashPos, mid);
  const second = runTrace(trace, first.endpos, eye);
  return clearLine(second);
}

/**
 * Leak `PercentageOfFlashForPlayer`. Direct ray 1.0, else 0.167 per bounce
 * sample that reaches the eye. `trace(from, to)` returns `{ fraction, endpos }`
 * in the Source frame; fraction 1 (or a missing trace) is a miss.
 *
 * The leak filter skips other players, weapons, grenades, and
 * ANIMTAG_FLASHBANG_PASSABLE. The tracer we are handed must already do that:
 * this function does not know about entities.
 */
export function percentageOfFlashForPlayer(flashPos, eye, trace) {
  const direct = runTrace(trace, flashPos, eye);
  if (clearLine(direct) || direct.hitPlayer) return 1;

  const { right, up } = rightUpFromFlashToEye(flashPos, eye);
  let pct = 0;
  if (sampleClear(flashPos, { x: up.x * FLASH_UP_OFFSET, y: up.y * FLASH_UP_OFFSET, z: up.z * FLASH_UP_OFFSET }, eye, trace)) {
    pct += FLASH_FRACTION;
  }
  const side = FLASH_SIDE_OFFSET;
  const up10 = 10;
  if (
    sampleClear(
      flashPos,
      { x: right.x * side + up.x * up10, y: right.y * side + up.y * up10, z: right.z * side + up.z * up10 },
      eye,
      trace
    )
  ) {
    pct += FLASH_FRACTION;
  }
  if (
    sampleClear(
      flashPos,
      { x: -right.x * side + up.x * up10, y: -right.y * side + up.y * up10, z: -right.z * side + up.z * up10 },
      eye,
      trace
    )
  ) {
    pct += FLASH_FRACTION;
  }
  return pct;
}

/** Facing bucket for a view-dot in `[-1, 1]`. */
export function facingMultipliers(dot) {
  for (const row of FLASH_FACING) {
    if (dot >= row.minDot) return { fadeTime: row.fadeTime, fadeHold: row.fadeHold };
  }
  return FLASH_FACING[FLASH_FACING.length - 1];
}

/**
 * Leak `CCSPlayer::Deafen` distance buckets. No DSP here: 1 / 2/3 / 1/3 / 0
 * so a caller can duck audio if it has any. Distances are Source units.
 */
export function deafenAmount(distance) {
  if (!(distance < 1000)) return 0;
  if (distance < 100) return 1;
  if (distance < 500) return 2 / 3;
  return 1 / 3;
}

/**
 * One player inside `RadiusFlash`.
 *
 * @param {object} o
 * @param {{x,y,z}} o.origin     grenade origin (Source), before the +1 z
 * @param {{x,y,z}} o.eye
 * @param {{x,y,z}} o.forward    eye forward, Source, need not be unit
 * @param {Function} [o.trace]   `trace(from, to) -> { fraction, endpos }`
 * @param {number} [o.damage]    `sv_flashbang_strength`
 * @returns {{ fadeHold:number, fadeTime:number, overlayDuration:number, percentage:number, adjustedDamage:number, distance:number, deafen:number, src:{x,y,z} }|null}
 */
export function radiusFlashForPlayer({ origin, eye, forward, trace = null, damage = SV_FLASHBANG_STRENGTH }) {
  const src = { x: origin.x, y: origin.y, z: origin.z + FLASH_Z_OFFSET };
  const percentage = percentageOfFlashForPlayer(src, eye, trace);
  if (!(percentage > 0)) return null;

  const distance = len(src, eye);
  const falloff = damage / FLASH_RADIUS;
  const adjustedDamage = damage - distance * falloff;
  if (!(adjustedDamage > 0)) return null;

  const fx = forward.x;
  const fy = forward.y;
  const fz = forward.z;
  const flen = Math.hypot(fx, fy, fz);
  if (!(flen > 0)) return null;
  const losx = src.x - eye.x;
  const losy = src.y - eye.y;
  const losz = src.z - eye.z;
  const llen = Math.hypot(losx, losy, losz);
  if (!(llen > 0)) return null;
  const dot = (losx * fx + losy * fy + losz * fz) / (llen * flen);
  const mul = facingMultipliers(dot);
  const fadeTime = adjustedDamage * mul.fadeTime * percentage;
  const fadeHold = adjustedDamage * mul.fadeHold * percentage;
  return {
    fadeHold,
    fadeTime,
    overlayDuration: fadeTime / FLASH_DURATION_DIVISOR,
    percentage,
    adjustedDamage,
    distance,
    deafen: deafenAmount(distance),
    src,
    dot
  };
}

/**
 * Leak `CCSPlayer::Blind` networked state. `prev` is the previous flash, or
 * null / a spent one.
 */
export function applyBlind(prev, { fadeHold, fadeTime, startingAlpha = 255 }, now) {
  const oldUntil = prev?.blindUntil ?? Number.NEGATIVE_INFINITY;
  const oldStart = prev?.blindStart ?? 0;
  const oldDuration = prev?.flashDuration ?? 0;
  const blindUntil = Math.max(oldUntil === Number.NEGATIVE_INFINITY ? 0 : oldUntil, now + fadeHold + 0.5 * fadeTime);
  const overlay = fadeTime / FLASH_DURATION_DIVISOR;
  let flashDuration;
  let buildUp;
  if (now > oldUntil) {
    flashDuration = overlay;
    buildUp = true;
  } else {
    const remaining = oldStart + oldDuration - now;
    flashDuration = Math.max(remaining, overlay);
    buildUp = false;
  }
  return {
    blindUntil,
    blindStart: now,
    flashDuration,
    flashBangTime: now + flashDuration,
    flashMaxAlpha: Math.max(prev?.flashMaxAlpha ?? 0, startingAlpha),
    buildUp
  };
}

/**
 * Leak `C_CSPlayer::UpdateFlashBangEffect` overlay alpha, 0..1.
 */
export function flashOverlayAlpha(state, now) {
  if (!state || now >= state.flashBangTime || !(state.flashMaxAlpha > 0)) return 0;
  const start = state.flashBangTime - state.flashDuration;
  const elapsed = Math.max(0, now - start);
  const maxA = state.flashMaxAlpha / 255;
  if (state.buildUp && elapsed < FLASH_BUILD_UP) {
    return Math.min(maxA, (elapsed / FLASH_BUILD_UP) * maxA);
  }
  const left = state.flashBangTime - now;
  if (left > FLASH_CERTAIN_BLINDNESS) return maxA;
  const p = left / FLASH_CERTAIN_BLINDNESS;
  return Math.min(maxA, Math.max(0, p * p * maxA));
}
