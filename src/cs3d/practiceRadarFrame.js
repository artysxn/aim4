// ---------------------------------------------------------------------------
// src/cs3d/practiceRadarFrame.js
// Build a RadarRenderer frame from the explorer's live world so hold-Q uses
// the same droplets, names, weapons and utility as the 2D timeline.
// ---------------------------------------------------------------------------

import { sceneToSource } from '../../shared/sim3d/units.js';
import {
  FLAG_ALIVE,
  FLAG_AIRBORNE,
  FLAG_DUCKING,
  PLAYER_SLOTS
} from '../replays/shared/tickFormat.js';

const NOW = 1_000_000;
const RATE = 64;

const FX_TYPE = {
  smoke: 'smokegrenade',
  fire: 'molotov',
  he: 'hegrenade',
  flash: 'flashbang',
  decoy: 'decoy'
};

function weaponIndex(weapons, name) {
  const n = String(name || '').replace(/^weapon_/, '');
  if (!n) return 0;
  let i = weapons.indexOf(n);
  if (i < 0) {
    i = weapons.length;
    weapons.push(n);
  }
  return i;
}

function projectilePath(p, throwTick) {
  const path = [];
  const trail = p.trail;
  let tick = throwTick;
  if (trail?.length >= 3) {
    for (let i = 0; i + 2 < trail.length; i += 3) {
      const src = sceneToSource(trail[i], trail[i + 1], trail[i + 2]);
      path.push({ tick, x: src[0], y: src[1], z: src[2] });
      tick += 2;
    }
  }
  const pos = p.sim?.pos;
  if (pos && Number.isFinite(pos.x)) {
    const last = path[path.length - 1];
    if (!last || last.x !== pos.x || last.y !== pos.y) {
      path.push({ tick: Math.min(NOW, tick), x: pos.x, y: pos.y, z: pos.z });
    }
  }
  return path;
}

function liveGrenades(projectiles, nadeEffects) {
  const grenades = [];
  for (const p of projectiles?.live || []) {
    if (p.done || p.sim?.detonated) continue;
    const throwTick = NOW - Math.max(1, p.ticks || Math.round((p.age || 0) * RATE));
    const path = projectilePath(p, throwTick);
    const pos = p.sim?.pos;
    grenades.push({
      type: p.type,
      player: 'you',
      throwTick,
      detonateTick: NOW + 8,
      from: path[0] || pos,
      at: pos,
      path
    });
  }
  for (const fx of nadeEffects?.live || []) {
    const type = fx.type && (fx.kind === 'fire' || fx.kind === 'smoke') ? fx.type : FX_TYPE[fx.kind];
    if (!type) continue;
    const ageTicks = Math.max(0, Math.round((fx.age || 0) * RATE));
    const pos = fx.pos;
    grenades.push({
      type,
      player: 'you',
      throwTick: NOW - ageTicks - 8,
      detonateTick: NOW - ageTicks,
      from: pos,
      at: pos
    });
  }
  return grenades;
}

/**
 * Timeline-shaped frame for practice (no demo loaded).
 * @param {object} o
 */
export function practiceRadarFrame({
  match,
  player,
  src,
  yaw,
  pitch = 0,
  bots,
  projectiles,
  nadeEffects,
  overlay = null
}) {
  const snap = overlay ? { ...match.snapshot(), ...overlay } : match.snapshot();
  const weapons = [];
  const players = [];
  const states = [];
  const feet = overlay && Number.isFinite(overlay.x)
    ? [overlay.x, overlay.y, overlay.z]
    : src;
  const lookYaw = overlay?.yaw != null ? overlay.yaw : yaw;
  const lookPitch = overlay?.pitch != null ? overlay.pitch : pitch;
  const held = overlay?.held || snap.held;
  const side = overlay?.side || snap.side || 'T';
  const hp = overlay?.hp ?? snap.hp ?? 100;
  const dead = overlay?.dead ?? snap.dead;

  const selfId = overlay?.botId != null ? `bot-${overlay.botId}` : 'you';
  const selfName = overlay?.name || 'You';

  players.push({ slot: 0, id: selfId, name: selfName, team: side === 'CT' ? 1 : 2 });
  let flags = dead ? 0 : FLAG_ALIVE;
  if (player?.mode === 'walk' && player.crouched) flags |= FLAG_DUCKING;
  if (player?.mode === 'walk' && player.onGround === false) flags |= FLAG_AIRBORNE;
  states[0] = {
    x: feet[0],
    y: feet[1],
    z: feet[2],
    yaw: lookYaw,
    pitch: lookPitch,
    health: dead ? 0 : hp,
    armor: 0,
    weapon: weaponIndex(weapons, held),
    flags,
    flash: 0,
    side: side === 'CT' ? 'CT' : 'T',
    alive: !dead
  };

  let slot = 1;
  for (const b of bots?.list || []) {
    if (slot >= PLAYER_SLOTS) break;
    if (overlay?.botId === b.id) continue;
    players.push({
      slot,
      id: `bot-${b.id}`,
      name: `Bot ${b.id}`,
      team: b.side === 'CT' ? 1 : 2
    });
    states[slot] = {
      x: b.origin.x,
      y: b.origin.y,
      z: b.origin.z,
      yaw: b.yaw,
      pitch: b.pitch || 0,
      health: b.hp,
      armor: 0,
      weapon: weaponIndex(weapons, b.weapon),
      flags: b.alive ? FLAG_ALIVE : 0,
      flash: 0,
      side: b.side === 'CT' ? 'CT' : 'T',
      alive: Boolean(b.alive)
    };
    slot++;
  }

  return {
    tick: NOW,
    tickRate: RATE,
    states,
    players,
    allPlayers: players,
    events: { kills: [], shots: [], grenades: liveGrenades(projectiles, nadeEffects), bomb: [] },
    weapons,
    teamSides: { 1: 'CT', 2: 'T' },
    highlight: selfId,
    hideDeaths: true,
    mapAlpha: 0.85
  };
}
