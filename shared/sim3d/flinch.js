// ---------------------------------------------------------------------------
// shared/sim3d/flinch.js
// The view punch and blood magnitude CCSPlayer::TraceAttack writes when a
// bullet (or blast) hits a player. Ported from
// game/server/cstrike15/cs_player.cpp — the numbers are the game's, not a
// guess at how a hit should feel.
//
//   mp_flinch_punch_scale   3
//   damage_impact_heavy     40     FX_CS_BloodSpray's heavy / medium split
//   damage_impact_medium    20
//   phys_playerscale        10     ragdoll impulse from the same hit
//   phys_headshotscale      1.3
//
// TraceAttack writes m_aimPunchAngle (raw). The camera still reads it through
// weapon_recoil_scale, same as spray punch. Helmet and kevlar cut the punch
// the way the leak does: helmet blocks the head snap, armor swaps the chest
// scale from −0.1 to −0.005. Arms and legs do not punch (those lines are
// commented out in the game).
// ---------------------------------------------------------------------------

/** [docs] `mp_flinch_punch_scale`. */
export const MP_FLINCH_PUNCH_SCALE = 3;

/** [docs] `damage_impact_heavy` — FX_CS_BloodSpray. */
export const DAMAGE_IMPACT_HEAVY = 40;
/** [docs] `damage_impact_medium`. */
export const DAMAGE_IMPACT_MEDIUM = 20;

/** [docs] `phys_playerscale`. Multiplies the bullet impulse on the ragdoll. */
export const PHYS_PLAYERSCALE = 10;
/** [docs] `phys_headshotscale`. */
export const PHYS_HEADSHOTSCALE = 1.3;

const GROUP = {
  generic: 'generic',
  head: 'head',
  chest: 'chest',
  stomach: 'stomach',
  leftarm: 'leftarm',
  rightarm: 'rightarm',
  leftleg: 'leftleg',
  rightleg: 'rightleg'
};

export function hitgroupName(group) {
  const g = String(group || '').toLowerCase();
  if (g === 'head') return GROUP.head;
  if (g === 'chest') return GROUP.chest;
  if (g === 'stomach') return GROUP.stomach;
  if (g === 'leftarm' || g === 'rightarm' || g === 'arm' || g === 'arms') {
    return g === 'rightarm' ? GROUP.rightarm : GROUP.leftarm;
  }
  if (g === 'leftleg' || g === 'rightleg' || g === 'leg' || g === 'legs') {
    return g === 'rightleg' ? GROUP.rightleg : GROUP.leftleg;
  }
  return GROUP.generic;
}

/** CS hitgroup index 0..7, or the string player_hurt already used. */
const HITGROUP_INDEX = [
  GROUP.generic,
  GROUP.head,
  GROUP.chest,
  GROUP.stomach,
  GROUP.leftarm,
  GROUP.rightarm,
  GROUP.leftleg,
  GROUP.rightleg
];

/**
 * `player_hurt.hitgroup` as the name TraceAttack switches on. Demos store a
 * number (1 = head) or a string; both come out the same.
 */
export function hurtHitgroup(raw) {
  if (raw == null || raw === '') return '';
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n < HITGROUP_INDEX.length && String(raw).trim() !== '') {
    if (String(raw).trim() === String(n)) return HITGROUP_INDEX[n];
  }
  const g = hitgroupName(raw);
  return g === GROUP.generic && String(raw).toLowerCase() !== 'generic' ? '' : g;
}

function clampPitch(x, cap) {
  return x < cap ? cap : x;
}

/**
 * The delta TraceAttack adds to `m_aimPunchAngle`, degrees
 * `{ pitch, yaw, roll }` (Source: +pitch looks down, +roll is z).
 *
 * @param {object} o
 * @param {string} [o.hitgroup]
 * @param {number} o.damage  health damage after armour split
 * @param {number} [o.armor]
 * @param {boolean} [o.helmet]
 * @param {boolean} [o.blast]
 * @param {() => number} [o.random]  −1..1 for the head roll; tests pass a stub
 */
export function flinchPunch({
  hitgroup = 'chest',
  damage = 0,
  armor = 0,
  helmet = false,
  blast = false,
  random = Math.random
} = {}) {
  const scale = MP_FLINCH_PUNCH_SCALE;
  const flDamage = Math.max(0, Number(damage) || 0);
  const out = { pitch: 0, yaw: 0, roll: 0 };
  if (!(flDamage > 0)) return out;

  if (blast) {
    // No armour: replace pitch. Armour: no punch, and TraceAttack also skips blood.
    if ((Number(armor) || 0) > 0) return out;
    out.pitch = clampPitch(scale * flDamage * -0.1, scale * -4);
    return out;
  }

  const group = hitgroupName(hitgroup);
  if (group === GROUP.head) {
    if (helmet) return out;
    out.pitch = clampPitch(scale * flDamage * -0.5, scale * -12);
    let roll = scale * flDamage * (random() * 2 - 1);
    const cap = scale * 9;
    if (roll < -cap) roll = -cap;
    else if (roll > cap) roll = cap;
    out.roll = roll;
    return out;
  }

  if (group === GROUP.chest || group === GROUP.stomach || group === GROUP.generic) {
    const flAng = (Number(armor) || 0) <= 0 ? -0.1 : -0.005;
    out.pitch = clampPitch(scale * flDamage * flAng, scale * -4);
    return out;
  }

  // Arms / legs: the punch is commented out in cs_player.cpp.
  return out;
}

/**
 * `CEffectData.m_flMagnitude` for `csblood`. Armour halves it; a helmet spark
 * (head + helmet) forces it to 1, which FX_CS_BloodSpray reads as the tiny
 * `blood_impact_light_headshot` puff.
 */
export function bloodMagnitude({ damage = 0, armor = 0, hitgroup = '', helmet = false } = {}) {
  let mag = Math.max(0, Number(damage) || 0);
  if ((Number(armor) || 0) > 0) mag *= 0.5;
  if (hitgroupName(hitgroup) === GROUP.head && helmet) mag = 1;
  return mag;
}

/** Particle system name DispatchParticleEffect would pick. */
export function bloodEffectName(magnitude) {
  const mag = Number(magnitude) || 0;
  if (mag > DAMAGE_IMPACT_HEAVY) return 'blood_impact_heavy';
  if (mag >= DAMAGE_IMPACT_MEDIUM) return 'blood_impact_medium';
  if (mag > 1) return 'blood_impact_light';
  return 'blood_impact_light_headshot';
}

/**
 * Bullet impulse on the ragdoll, Source frame. TraceAttack multiplies the
 * ammo force by phys_playerscale, and again by phys_headshotscale on a head
 * hit. We do not have the ammo table, so the force is `dir × damage` before
 * those scales — the same shape, a number the ragdoll can tune against.
 *
 * @returns {{ x: number, y: number, z: number }}
 */
export function ragdollImpulse(dir, damage, { headshot = false } = {}) {
  const d = Math.max(0, Number(damage) || 0);
  let k = d * PHYS_PLAYERSCALE;
  if (headshot) k *= PHYS_HEADSHOTSCALE;
  const x = Number(dir?.x) || 0;
  const y = Number(dir?.y) || 0;
  const z = Number(dir?.z) || 0;
  const len = Math.hypot(x, y, z) || 1;
  return { x: (x / len) * k, y: (y / len) * k, z: (z / len) * k };
}
