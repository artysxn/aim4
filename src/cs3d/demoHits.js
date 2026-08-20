// ---------------------------------------------------------------------------
// src/cs3d/demoHits.js
// Playback of CCSPlayer::TraceAttack from a recorded round: the same punch,
// blood and ragdoll map practice writes on a live shot, driven by the demo's
// player_hurt log and only while the playhead moves forward.
//
// A seek / rewind returns nothing, matching consumeShots. Corpse ragdolls
// therefore start on the killing tick during playback and the held death clip
// still covers a scrub onto an already-dead body.
// ---------------------------------------------------------------------------

import { sourceToScene } from '../../shared/sim3d/units.js';
import {
  flinchPunch,
  bloodMagnitude,
  ragdollImpulse,
  hitgroupName,
  hurtHitgroup
} from '../../shared/sim3d/flinch.js';
import { PUNCH_DECAY_EXP, PUNCH_DECAY_LIN, RECOIL_SCALE, VIEW_RECOIL_TRACKING } from '../../shared/sim3d/recoil.js';
import { rayAabb, botBox, hitgroupFromHeight } from './practiceBots.js';
import { EYE_STAND, EYE_DUCK } from '../../shared/sim3d/constants.js';
import { FLAG_HAS_HELMET, FLAG_DUCKING } from '../replays/shared/tickFormat.js';
import { bulletDirection } from '../../shared/sim3d/inaccuracy.js';

/** Events with `tick` in (from, to], empty on a seek or rewind. */
export function consumeForward(list, from, to, rate) {
  if (!list?.length || from == null || !(to > from) || to - from > rate) return [];
  const out = [];
  for (const e of list) {
    if (e.tick > from && e.tick <= to) out.push(e);
  }
  return out;
}

export function isBlastWeapon(weapon) {
  const w = String(weapon || '')
    .replace(/^weapon_/, '')
    .toLowerCase();
  return w === 'hegrenade';
}

export function slotOfPlayer(players, id) {
  if (id == null || id === '') return -1;
  const p = (players || []).find((x) => x.id === id);
  return p?.slot ?? -1;
}

function duckOf(s) {
  if (!s) return 0;
  return s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
}

function chestOf(s) {
  const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duckOf(s);
  return { x: s.x, y: s.y, z: s.z + eye * 0.7 };
}

function shotOnTick(shots, attackerId, tick) {
  if (!shots?.length || !attackerId) return null;
  let best = null;
  for (const sh of shots) {
    if (sh.tick !== tick) continue;
    if (sh.player !== attackerId && sh.attacker !== attackerId) continue;
    best = sh;
  }
  return best;
}

function nadeAt(grenades, attackerId, tick) {
  if (!grenades?.length) return null;
  for (const g of grenades) {
    if (g.type !== 'hegrenade') continue;
    if (g.player !== attackerId) continue;
    if (g.detonateTick === tick && g.at) return g.at;
  }
  return null;
}

/**
 * Point, direction and hitgroup for one player_hurt, Source frame.
 *
 * Prefers a traced `fx` from the same tick's bullet (fireDemoShot). Otherwise
 * the attacker's recorded shot, an HE detonation, or attacker → victim.
 */
export function resolveDemoHit(ev, { players = [], states = [], shots = [], grenades = [], fx = null } = {}) {
  const slot = slotOfPlayer(players, ev.victim);
  const s = slot >= 0 ? states[slot] : null;
  const blast = isBlastWeapon(ev.weapon);
  const armor = Number(s?.armor) || 0;
  const helmet = !!(s && s.flags & FLAG_HAS_HELMET);
  let group = hurtHitgroup(ev.hitgroup);
  let point = fx?.point || null;
  let dir = fx?.dir || null;
  if (!group && fx?.group) group = fx.group;

  if (!dir) {
    const sh = shotOnTick(shots, ev.attacker, ev.tick);
    if (sh && Number.isFinite(sh.yaw)) dir = bulletDirection(sh.pitch || 0, sh.yaw || 0);
  }
  if (!dir && blast) {
    const at = nadeAt(grenades, ev.attacker, ev.tick);
    if (at && s) dir = { x: s.x - at.x, y: s.y - at.y, z: s.z - at.z };
  }
  if (!dir && s) {
    const attSlot = slotOfPlayer(players, ev.attacker);
    const a = attSlot >= 0 ? states[attSlot] : null;
    if (a) dir = { x: s.x - a.x, y: s.y - a.y, z: s.z - a.z };
  }
  if (!dir) dir = { x: 1, y: 0, z: 0 };

  if (!point && s && dir) {
    const duck = duckOf(s);
    const eyeH = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
    const origin = s;
    const box = botBox({ x: origin.x, y: origin.y, z: origin.z });
    const attSlot = slotOfPlayer(players, ev.attacker);
    const a = attSlot >= 0 ? states[attSlot] : null;
    const from = a
      ? { x: a.x, y: a.y, z: a.z + eyeH }
      : { x: origin.x - dir.x * 64, y: origin.y - dir.y * 64, z: origin.z + eyeH };
    const span = 4096;
    const to = { x: from.x + dir.x * span, y: from.y + dir.y * span, z: from.z + dir.z * span };
    const hit = rayAabb(from, to, box.min, box.max);
    if (hit) {
      point = hit.point;
      if (!group) group = hitgroupFromHeight(hit.point.z - origin.z);
    }
  }
  if (!point && s) point = chestOf(s);
  if (!group) group = blast ? 'chest' : 'chest';

  return {
    slot,
    group,
    armor,
    helmet,
    blast,
    point,
    dir,
    damage: Math.max(0, Number(ev.hp ?? ev.damage) || 0)
  };
}

export function applyTraceHit({
  body = null,
  blood = null,
  damage = 0,
  hitgroup = 'chest',
  armor = 0,
  helmet = false,
  blast = false,
  point = null,
  dir = null,
  kill = false
} = {}) {
  const punch = flinchPunch({ hitgroup, damage, armor, helmet, blast });
  body?.applyFlinch(punch);
  if (blood && point && !(blast && armor > 0)) {
    blood.spawn({
      point,
      dir,
      magnitude: bloodMagnitude({ damage, armor, hitgroup, helmet }),
      damage
    });
  }
  if (kill && body && dir) {
    const impulse = ragdollImpulse(dir, damage, { headshot: hitgroupName(hitgroup) === 'head' });
    const [fx, fy, fz] = sourceToScene(impulse.x, impulse.y, impulse.z);
    const hitPos = point ? scenePoint(point) : null;
    body.startRagdoll({ force: { x: fx, y: fy, z: fz }, hitPos });
  }
  return punch;
}

function scenePoint(p) {
  const [x, y, z] = sourceToScene(p.x, p.y, p.z);
  return { x, y, z };
}

export function killedOnTick(kills, victimId, tick) {
  if (!kills?.length || !victimId) return false;
  for (const k of kills) {
    if (k.victim === victimId && k.tick === tick) return true;
  }
  return false;
}

export function createPovFlinch() {
  return [0, 0, 0];
}

export function addPovFlinch(punch, delta, { replacePitch = false } = {}) {
  if (!punch || !delta) return punch;
  if (replacePitch) punch[0] = delta.pitch || 0;
  else punch[0] += delta.pitch || 0;
  punch[1] += delta.yaw || 0;
  punch[2] += delta.roll || 0;
  return punch;
}

export function decayPovFlinch(punch, dt) {
  const h = Math.abs(dt);
  if (!(h > 0) || !punch) return punch;
  const e = Math.exp(-PUNCH_DECAY_EXP * h);
  punch[0] *= e;
  punch[1] *= e;
  punch[2] *= e;
  const lin = PUNCH_DECAY_LIN * h;
  const mag = Math.hypot(punch[0], punch[1], punch[2]);
  if (mag > lin) {
    const k = 1 - lin / mag;
    punch[0] *= k;
    punch[1] *= k;
    punch[2] *= k;
  } else {
    punch[0] = punch[1] = punch[2] = 0;
  }
  return punch;
}

export function resetPovFlinch(punch) {
  if (!punch) return punch;
  punch[0] = punch[1] = punch[2] = 0;
  return punch;
}

/** Scaled the way aimPunch is: raw × weapon_recoil_scale. */
export function scaledAimPunch(raw, out = [0, 0, 0]) {
  out[0] = (raw[0] || 0) * RECOIL_SCALE;
  out[1] = (raw[1] || 0) * RECOIL_SCALE;
  out[2] = (raw[2] || 0) * RECOIL_SCALE;
  return out;
}

/** Camera share: × scale × 0.45. */
export function scaledCameraPunch(raw, out = [0, 0, 0]) {
  const k = RECOIL_SCALE * VIEW_RECOIL_TRACKING;
  out[0] = (raw[0] || 0) * k;
  out[1] = (raw[1] || 0) * k;
  out[2] = (raw[2] || 0) * k;
  return out;
}
