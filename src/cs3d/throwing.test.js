// Run: node src/cs3d/throwing.test.js
//
// The perfect-jumpthrow flag is stamped at button-up, not at projectile spawn,
// because the 199 ms window is jump → release.

import { ThrowControl, THROW_RELEASE_TICKS } from './throwing.js';
import { TICK_DT } from '../../shared/sim3d/constants.js';
import { PERFECT_JUMPTHROW_WINDOW } from '../../shared/sim3d/grenade.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function throwOnce(jumpState) {
  let got = null;
  const c = new ThrowControl({
    jumpState,
    onThrow: (p) => {
      got = p;
    }
  });
  c.setWeapon('smokegrenade');
  c.button('primary', true);
  c.button('primary', false);
  let t = 0;
  while (t < THROW_RELEASE_TICKS * TICK_DT + 0.05 && !got) {
    c.update(TICK_DT);
    t += TICK_DT;
  }
  return got;
}

{
  const p = throwOnce(() => ({ secondsSinceJump: 0, jumpHeldOnGround: false }));
  assert(p && p.perfectJumpThrow, 'release on the jump tick is perfect');
}

{
  const p = throwOnce(() => ({ secondsSinceJump: PERFECT_JUMPTHROW_WINDOW, jumpHeldOnGround: false }));
  assert(p && p.perfectJumpThrow, 'release at 199 ms is perfect');
}

{
  const p = throwOnce(() => ({ secondsSinceJump: 0.2, jumpHeldOnGround: false }));
  assert(p && !p.perfectJumpThrow, 'release at 200 ms is not perfect');
}

{
  const p = throwOnce(() => ({ secondsSinceJump: Infinity, jumpHeldOnGround: true }));
  assert(p && p.perfectJumpThrow, 'same-tick jump still on the ground is perfect');
}

{
  const p = throwOnce(() => ({ secondsSinceJump: Infinity, jumpHeldOnGround: false }));
  assert(p && !p.perfectJumpThrow, 'a standing throw is not a jumpthrow');
}

{
  if (THROW_RELEASE_TICKS !== 6) throw new Error(`spawn delay is ${THROW_RELEASE_TICKS} ticks, expected 6`);
  const dt = THROW_RELEASE_TICKS * TICK_DT;
  if (Math.abs(dt - 0.1) > 0.01) throw new Error(`spawn delay is ${dt}s, expected ~0.1`);
}

console.log('throwing.test: ok');
