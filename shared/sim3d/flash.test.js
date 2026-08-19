// Run: node shared/sim3d/flash.test.js
//
// RadiusFlash / PercentageOfFlashForPlayer / Blind overlay against the CS:GO
// leak numbers. The throw and the bounce live in grenade.test.js and are not
// this file's business.

import {
  SV_FLASHBANG_STRENGTH,
  FLASH_RADIUS,
  FLASH_FRACTION,
  FLASH_Z_OFFSET,
  FLASH_DURATION_DIVISOR,
  FLASH_CERTAIN_BLINDNESS,
  FLASH_MAX_SECONDS,
  FLASH_BUILD_UP,
  percentageOfFlashForPlayer,
  radiusFlashForPlayer,
  facingMultipliers,
  deafenAmount,
  applyBlind,
  flashOverlayAlpha,
  vectorAngles,
  angleVectorsRightUp
} from './flash.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

const open = () => ({ fraction: 1, endpos: null });

function blocked(from, to, frac = 0.4) {
  return {
    fraction: frac,
    endpos: {
      x: from.x + (to.x - from.x) * frac,
      y: from.y + (to.y - from.y) * frac,
      z: from.z + (to.z - from.z) * frac
    }
  };
}

// ---- constants the leak wrote down ---------------------------------------
{
  close(SV_FLASHBANG_STRENGTH, 3.55, 0, 'GetFloat 3.55, not GetInt 3');
  close(FLASH_RADIUS, 3000, 0, 'RadiusFlash radius');
  close(FLASH_FRACTION, 0.167, 0, 'FLASH_FRACTION');
  close(FLASH_Z_OFFSET, 1, 0, 'vecSrc.z += 1');
  close(FLASH_DURATION_DIVISOR, 1.4, 0, 'Blind fadeTime /= 1.4');
  close(FLASH_MAX_SECONDS, (3.55 * 2.5) / 1.4, 1e-12, 'point-blank overlay');
}

// ---- z+1: a grenade on the floor is measured from 1 unit up --------------
{
  const got = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: 0, y: 0, z: 64 },
    forward: { x: 0, y: 0, z: -1 },
    trace: () => open()
  });
  close(got.src.z, 1, 0, 'flash origin is lifted one unit');
  close(got.distance, 63, 1e-9, 'eye 64u above a floor grenade is 63u from src');
}

// ---- falloff: adj = damage - dist * (damage / 3000) ----------------------
{
  const dist = 600;
  const got = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: dist, y: 0, z: 1 },
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  close(got.adjustedDamage, 3.55 - dist * (3.55 / 3000), 1e-12, 'linear falloff');
  close(got.distance, dist, 1e-12, 'distance is eye to lifted src');
}

// ---- damage is zero at 3000u ---------------------------------------------
{
  const edge = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: FLASH_RADIUS, y: 0, z: 1 },
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  assert(edge === null, 'adj is 0 at exactly 3000u');
  const past = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: FLASH_RADIUS + 1, y: 0, z: 1 },
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  assert(past === null, 'and nothing past that');
  const inside = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: FLASH_RADIUS - 1, y: 0, z: 1 },
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  assert(inside && inside.adjustedDamage > 0, 'one unit inside still blinds');
}

// ---- facing buckets ------------------------------------------------------
{
  const m = (d) => facingMultipliers(d);
  close(m(1).fadeTime, 2.5, 0, 'looking at it: fade 2.5');
  close(m(1).fadeHold, 1.25, 0, 'looking at it: hold 1.25');
  close(m(0.6).fadeTime, 2.5, 0, '0.6 is still the looking-at bucket');
  close(m(0.599).fadeTime, 1.75, 0, 'just under 0.6 is side');
  close(m(0.3).fadeHold, 0.8, 0, '0.3 hold 0.8');
  close(m(0.299).fadeTime, 1.0, 0, 'just under 0.3');
  close(m(-0.2).fadeHold, 0.5, 0, '-0.2 hold 0.5');
  close(m(-0.201).fadeTime, 0.5, 0, 'facing away: fade 0.5');
  close(m(-1).fadeHold, 0.25, 0, 'facing away: hold 0.25');
}

{
  const facing = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: 100, y: 0, z: 1 },
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  close(facing.dot, 1, 1e-9, 'looking at the flash is dot 1');
  const adj = facing.adjustedDamage;
  close(facing.fadeTime, adj * 2.5, 1e-12, 'facing fadeTime = adj * 2.5');
  close(facing.fadeHold, adj * 1.25, 1e-12, 'facing fadeHold = adj * 1.25');
  close(facing.overlayDuration, facing.fadeTime / 1.4, 1e-12, 'overlay is fade/1.4');

  const away = radiusFlashForPlayer({
    origin: { x: 0, y: 0, z: 0 },
    eye: { x: 100, y: 0, z: 1 },
    forward: { x: 1, y: 0, z: 0 },
    trace: () => open()
  });
  close(away.dot, -1, 1e-9, 'back to the flash is dot -1');
  close(away.fadeTime, away.adjustedDamage * 0.5, 1e-12, 'away fadeTime = adj * 0.5');
  close(away.fadeHold, away.adjustedDamage * 0.25, 1e-12, 'away fadeHold = adj * 0.25');
}

// ---- LOS: direct 1.0 vs 0.167 per bounce sample --------------------------
{
  const flash = { x: 0, y: 0, z: 0 };
  const eye = { x: 100, y: 0, z: 0 };
  close(percentageOfFlashForPlayer(flash, eye, () => open()), 1, 0, 'clear direct ray is 1.0');

  const wall = () => blocked(flash, eye);
  close(percentageOfFlashForPlayer(flash, eye, wall), 0, 0, 'every ray blocked is 0');

  const { right, up } = angleVectorsRightUp(0, 0);
  close(right.x, 0, 1e-12, 'yaw 0 right x');
  close(right.y, -1, 1e-12, 'right is -Y when looking +X');
  close(up.z, 1, 1e-12, 'up is +Z when pitch 0');

  // Eye due +X, same height: samples land at (0,0,50), (0,-75,10), (0,75,10).
  function los({ upClear = false, rightClear = false, leftClear = false }) {
    return (from, to) => {
      const fromFlash = Math.hypot(from.x, from.y, from.z) < 1e-6;
      const toEye = Math.hypot(to.x - eye.x, to.y - eye.y, to.z - eye.z) < 1e-6;
      if (fromFlash && toEye) return blocked(from, to);
      if (fromFlash && !toEye) {
        const isUp = Math.abs(to.z - 50) < 0.5 && Math.abs(to.y) < 0.5;
        const isRight = Math.abs(to.y - -75) < 0.5;
        const isLeft = Math.abs(to.y - 75) < 0.5;
        if ((isUp && upClear) || (isRight && rightClear) || (isLeft && leftClear)) {
          return { fraction: 1, endpos: { x: to.x, y: to.y, z: to.z } };
        }
        return blocked(from, to);
      }
      const fromUp = Math.abs(from.z - 50) < 0.5 && Math.abs(from.y) < 0.5;
      const fromRight = Math.abs(from.y - -75) < 0.5;
      const fromLeft = Math.abs(from.y - 75) < 0.5;
      if ((fromUp && upClear) || (fromRight && rightClear) || (fromLeft && leftClear)) {
        return { fraction: 1, endpos: { x: to.x, y: to.y, z: to.z } };
      }
      return blocked(from, to);
    };
  }

  close(percentageOfFlashForPlayer(flash, eye, los({})), 0, 0, 'no bounce samples');
  close(percentageOfFlashForPlayer(flash, eye, los({ upClear: true })), FLASH_FRACTION, 1e-12, 'one sample is 0.167');
  close(
    percentageOfFlashForPlayer(flash, eye, los({ upClear: true, rightClear: true })),
    FLASH_FRACTION * 2,
    1e-12,
    'two samples'
  );
  close(
    percentageOfFlashForPlayer(flash, eye, los({ upClear: true, rightClear: true, leftClear: true })),
    FLASH_FRACTION * 3,
    1e-12,
    'three samples is 0.501'
  );
}

{
  const origin = { x: 0, y: 0, z: 0 };
  const eye = { x: 100, y: 0, z: 1 };
  const full = radiusFlashForPlayer({
    origin,
    eye,
    forward: { x: -1, y: 0, z: 0 },
    trace: () => open()
  });
  const none = radiusFlashForPlayer({
    origin,
    eye,
    forward: { x: -1, y: 0, z: 0 },
    trace: (from, to) => blocked(from, to)
  });
  assert(none === null, 'percentage 0 skips the player');
  close(full.percentage, 1, 0, 'open world is 1.0');
}

// ---- VectorAngles used by the samples ------------------------------------
{
  const a = vectorAngles({ x: 100, y: 0, z: 0 });
  close(a.yaw, 0, 1e-9, '+X is yaw 0');
  close(a.pitch, 0, 1e-9, 'level is pitch 0');
  const b = vectorAngles({ x: 0, y: 100, z: 0 });
  close(b.yaw, 90, 1e-9, '+Y is yaw 90');
}

// ---- Blind overlay: duration = fade/1.4, full white while left > 3s ------
{
  const hit = {
    fadeHold: 4.4375,
    fadeTime: 8.875,
    startingAlpha: 255
  };
  const s = applyBlind(null, hit, 0);
  close(s.flashDuration, 8.875 / 1.4, 1e-12, 'networked duration is fade/1.4');
  close(s.blindUntil, 4.4375 + 0.5 * 8.875, 1e-12, 'IsBlind lasts hold + 0.5 fade');
  assert(s.blindUntil > s.flashDuration, 'IsBlind outlasts the overlay, so PostThink does not cut it');
  close(flashOverlayAlpha(s, FLASH_BUILD_UP), 1, 1e-9, 'after build-up, full white');
  close(flashOverlayAlpha(s, s.flashDuration - FLASH_CERTAIN_BLINDNESS - 0.01), 1, 1e-9, 'still full with >3s left');
  close(flashOverlayAlpha(s, s.flashDuration - 1.5), (1.5 / 3) ** 2, 1e-9, 'last 3s are quadratic');
  close(flashOverlayAlpha(s, s.flashDuration), 0, 0, 'done at bang time');
}

{
  const weak = applyBlind(null, { fadeHold: 0.5, fadeTime: 1.0 }, 0);
  const peak = flashOverlayAlpha(weak, FLASH_BUILD_UP);
  assert(peak < 1, 'a short flash never reaches full white');
  assert(flashOverlayAlpha(weak, 0.0001) < peak, 'build-up starts below the peak');
}

{
  const first = applyBlind(null, { fadeHold: 1, fadeTime: 2 }, 0);
  const second = applyBlind(first, { fadeHold: 1, fadeTime: 4 }, 0.2);
  assert(second.flashDuration >= 4 / 1.4, 'a second flash extends duration');
  assert(second.buildUp === false, 'already-active flash does not rebuild');
}

// ---- deafen buckets ------------------------------------------------------
{
  close(deafenAmount(50), 1, 0, 'DSP 134');
  close(deafenAmount(100), 2 / 3, 0, '100u is 135, not 134');
  close(deafenAmount(499), 2 / 3, 0, 'under 500');
  close(deafenAmount(500), 1 / 3, 0, '500u is 136');
  close(deafenAmount(999), 1 / 3, 0, 'under 1000');
  close(deafenAmount(1000), 0, 0, 'too far, no DSP');
}

console.log('flash.test.js: ok');
