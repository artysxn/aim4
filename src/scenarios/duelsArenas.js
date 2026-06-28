// Converts multiplayer duel maps into the arena shape used by DuelsScenario.
import { duelMapPool, spawnFor, yawToward } from '../multiplayer/maps.js';

const DEFAULT_EC_HALF = 0.85;

/** Pick the enemy spawn wall half-width for peek offset math. */
function deriveEcHalf(map, enemyPos) {
  const [ex, , ez] = enemyPos;
  let best = null;
  let bestD = Infinity;
  for (const box of map.boxes) {
    const d = Math.hypot(box.pos[0] - ex, box.pos[2] - ez);
    if (d < bestD && box.size[1] >= 5) {
      bestD = d;
      best = box;
    }
  }
  return best ? best.size[0] / 2 : DEFAULT_EC_HALF;
}

export function flipDuelsArena(arena) {
  const out = structuredClone(arena);
  const oldPlayer = out.player;
  const oldEnemy = out.enemy;
  const enemyPos = [oldEnemy.x, oldEnemy.y ?? 0, oldEnemy.z];

  out.player = {
    pos: [...enemyPos],
    yaw: yawToward(enemyPos, oldPlayer.pos),
    half: oldPlayer.half ?? null
  };
  out.enemy = {
    x: oldPlayer.pos[0],
    z: oldPlayer.pos[2],
    y: oldPlayer.pos[1] ?? 0
  };

  if (out.boxes) {
    for (const box of out.boxes) {
      if (box.role === 'player') box.role = 'enemy';
      else if (box.role === 'enemy') box.role = 'player';
    }
  }

  if (out.peekSide != null) out.peekSide = -out.peekSide;
  return out;
}

export function applyDuelsSide(arena, offensive = false) {
  if (offensive) return flipDuelsArena(arena);
  return structuredClone(arena);
}

export function arenaFromMpMap(map) {
  const playerSpawn = spawnFor(map, 'A');
  const enemySpawn = spawnFor(map, 'B');
  const [ex, ey, ez] = enemySpawn.pos;
  const ecHalf = deriveEcHalf(map, enemySpawn.pos);

  return {
    id: map.id,
    label: map.label,
    mpMap: true,
    bounds: { ...map.bounds },
    player: {
      pos: [...playerSpawn.pos],
      yaw: yawToward(playerSpawn.pos, enemySpawn.pos),
      half: null
    },
    enemy: { x: ex, z: ez, y: ey || 0 },
    ecHalf,
    boxes: map.boxes.map((b) => ({
      pos: [...b.pos],
      size: [...b.size],
      role: 'prop'
    }))
  };
}

export function getDuelsArenaPool(legacyArenas) {
  return [...legacyArenas, ...duelMapPool().map(arenaFromMpMap)];
}

/**
 * @param {number} choice 0 = random, 1..N = fixed index in the combined pool
 * @returns {{ arena: object, index: number }}
 */
export function resolveDuelsArenaChoice(legacyArenas, choice, rng = Math.random) {
  const pool = getDuelsArenaPool(legacyArenas);
  if (choice >= 1 && choice <= pool.length) {
    const index = choice - 1;
    return { arena: pool[index], index };
  }
  const index = Math.floor(rng() * pool.length);
  return { arena: pool[index], index };
}

export function duelsArenaSelectOptions(legacyArenas) {
  const pool = getDuelsArenaPool(legacyArenas);
  const lines = ['<option value="0">Random each run</option>'];
  pool.forEach((a, i) => {
    const tag = a.mpMap ? ' · MP' : '';
    lines.push(`<option value="${i + 1}">${i + 1} · ${a.label}${tag}</option>`);
  });
  return lines.join('\n');
}

export function duelsArenaConfigKey(legacyArenas, choice, runDuration) {
  const pool = getDuelsArenaPool(legacyArenas);
  if (choice >= 1 && choice <= pool.length) {
    const a = pool[choice - 1];
    const id = a.id || a.label.replace(/\s+/g, '-').toLowerCase();
    return `arena_${id}_d${runDuration}`;
  }
  return `arena_rand_d${runDuration}`;
}
