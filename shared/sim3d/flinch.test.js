// Run: node shared/sim3d/flinch.test.js
import assert from 'node:assert/strict';
import {
  flinchPunch,
  bloodMagnitude,
  bloodEffectName,
  ragdollImpulse,
  hurtHitgroup,
  MP_FLINCH_PUNCH_SCALE,
  PHYS_PLAYERSCALE,
  PHYS_HEADSHOTSCALE
} from './flinch.js';

const scale = MP_FLINCH_PUNCH_SCALE;

{
  const p = flinchPunch({ hitgroup: 'chest', damage: 30, armor: 0 });
  assert.equal(p.pitch, scale * 30 * -0.1);
  assert.equal(p.yaw, 0);
  assert.equal(p.roll, 0);
}

{
  const p = flinchPunch({ hitgroup: 'chest', damage: 30, armor: 100 });
  assert.equal(p.pitch, scale * 30 * -0.005, 'kevlar uses the tiny −0.005 scale');
}

{
  const p = flinchPunch({ hitgroup: 'head', damage: 40, helmet: false, random: () => 0.5 });
  assert.equal(p.pitch, scale * -12, '40 dmg head already hits the scale × −12 clamp');
  assert.equal(p.roll, 0, 'random 0.5 maps to 0 roll');
}

{
  const p = flinchPunch({ hitgroup: 'head', damage: 100, helmet: false, random: () => 1 });
  assert.equal(p.pitch, scale * -12, 'head pitch clamps at scale × −12');
  assert.equal(p.roll, scale * 9, 'head roll clamps at scale × 9');
}

{
  const p = flinchPunch({ hitgroup: 'head', damage: 40, helmet: true });
  assert.equal(p.pitch, 0, 'helmet blocks the head snap');
  assert.equal(p.roll, 0);
}

{
  const p = flinchPunch({ hitgroup: 'leftarm', damage: 40, armor: 0 });
  assert.equal(p.pitch, 0, 'arms do not punch (commented out in TraceAttack)');
}

{
  const p = flinchPunch({ blast: true, damage: 50, armor: 0 });
  assert.equal(p.pitch, scale * -4, 'blast pitch clamps at scale × −4');
}

{
  const p = flinchPunch({ blast: true, damage: 50, armor: 50 });
  assert.equal(p.pitch, 0, 'armour blast does not punch');
}

{
  assert.equal(bloodMagnitude({ damage: 40, armor: 0 }), 40);
  assert.equal(bloodMagnitude({ damage: 40, armor: 50 }), 20);
  assert.equal(bloodMagnitude({ damage: 80, hitgroup: 'head', helmet: true }), 1);
  assert.equal(bloodEffectName(41), 'blood_impact_heavy');
  assert.equal(bloodEffectName(20), 'blood_impact_medium');
  assert.equal(bloodEffectName(10), 'blood_impact_light');
  assert.equal(bloodEffectName(1), 'blood_impact_light_headshot');
}

{
  assert.equal(hurtHitgroup(1), 'head');
  assert.equal(hurtHitgroup(2), 'chest');
  assert.equal(hurtHitgroup('head'), 'head');
  assert.equal(hurtHitgroup(''), '');
}

{
  const f = ragdollImpulse({ x: 1, y: 0, z: 0 }, 30, { headshot: false });
  assert.equal(f.x, 30 * PHYS_PLAYERSCALE);
  const h = ragdollImpulse({ x: 0, y: 1, z: 0 }, 30, { headshot: true });
  assert.equal(h.y, 30 * PHYS_PLAYERSCALE * PHYS_HEADSHOTSCALE);
}

console.log('flinch.test.js ok');
