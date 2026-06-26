// ---------------------------------------------------------------------------
// multiplayer/maps.js
// Asymmetric 1v1 duel arenas sized for fast engagement: ~12–18 m between
// spawns, peek cover within 2–3 s of running. Cover is 2× original height.
// Movement is limited only by cover collision — no invisible outer bounds.
// ---------------------------------------------------------------------------

import { DEATHMATCH_MAP_DATA } from './deathmatchMapData.js';

const FULL_H = 6.0;
const PEEK_H = 2.4;

function b(x, y, z, w, h, d) {
  return { pos: [x, y, z], size: [w, h, d] };
}

/** Full-height wall each player starts behind (between spawn and mid). */
function spawnWall(x, z, w, d) {
  return b(x, FULL_H / 2, z, w, FULL_H, d);
}

/** Open floor — no cover. Used for the custom tracking duel mode. */
const TRACKING_ARENA = {
  id: 'tracking-arena',
  label: 'Tracking Arena',
  bounds: { minX: -14, maxX: 14, minZ: -14, maxZ: 14 },
  spawns: { A: { pos: [0, 0, 10] }, B: { pos: [0, 0, -10] } },
  boxes: []
};

const MAP_TEMPLATES = [
  {
    id: 'tight-poke',
    label: 'Tight Poke',
    bounds: { minX: -5, maxX: 5, minZ: -7, maxZ: 7 },
    spawns: { A: { pos: [1, 0, 5.5] }, B: { pos: [-1.5, 0, -5.5] } },
    boxes: [
      spawnWall(0.8, 4.2, 2.2, 1.1),
      spawnWall(-1.2, -4.2, 2.2, 1.1),
      b(0.5, FULL_H / 2, 0.2, 1.8, FULL_H, 1.2),
      b(-2.5, PEEK_H / 2, 1.8, 0.9, PEEK_H, 0.5),
      b(2.2, PEEK_H / 2, -1.2, 0.9, PEEK_H, 0.5)
    ]
  },
  {
    id: 'offset-avenue',
    label: 'Offset Avenue',
    bounds: { minX: -6.5, maxX: 6.5, minZ: -8, maxZ: 8 },
    spawns: { A: { pos: [2, 0, 6] }, B: { pos: [-3, 0, -6] } },
    boxes: [
      spawnWall(1.2, 4.5, 2.4, 1.2),
      spawnWall(-2, -4.5, 2.4, 1.2),
      b(-1.2, FULL_H / 2, 0.8, 1.8, FULL_H, 1.2),
      b(2.8, PEEK_H / 2, -0.3, 1.4, PEEK_H, 0.5),
      b(-2.8, PEEK_H / 2, 2.2, 1.1, PEEK_H, 0.5),
      b(0.8, PEEK_H / 2, -3.2, 1.8, PEEK_H, 0.5)
    ]
  },
  {
    id: 'split-pillar',
    label: 'Split Pillar',
    bounds: { minX: -6, maxX: 6, minZ: -7.5, maxZ: 7.5 },
    spawns: { A: { pos: [-2.5, 0, 5.8] }, B: { pos: [3.5, 0, -5.8] } },
    boxes: [
      spawnWall(-1.8, 4.4, 2.2, 1.1),
      spawnWall(2.8, -4.4, 2.2, 1.1),
      b(2.0, FULL_H / 2, 0.6, 1.4, FULL_H, 1.2),
      b(-1.4, FULL_H / 2, -0.8, 1.1, FULL_H, 0.9),
      b(3.5, PEEK_H / 2, 2.5, 0.9, PEEK_H, 0.5),
      b(-3.2, PEEK_H / 2, -2.8, 1.4, PEEK_H, 0.5)
    ]
  },
  {
    id: 'den-kitchen',
    label: 'Den & Kitchen',
    bounds: { minX: -7, maxX: 7, minZ: -8, maxZ: 8 },
    spawns: { A: { pos: [0, 0, 6.2] }, B: { pos: [4.5, 0, -5.8] } },
    boxes: [
      spawnWall(0, 4.6, 2.6, 1.2),
      spawnWall(3.8, -4.4, 2.4, 1.2),
      b(-4.0, FULL_H / 2, 0.8, 2.4, FULL_H, 2.8),
      b(-4.0, PEEK_H / 2, -2.0, 1.1, PEEK_H, 0.5),
      b(1.8, PEEK_H / 2, 1.2, 0.9, PEEK_H, 0.5),
      b(2.2, PEEK_H / 2, -1.8, 0.9, PEEK_H, 0.5)
    ]
  },
  {
    id: 'high-ground',
    label: 'High Ground',
    bounds: { minX: -6.5, maxX: 6.5, minZ: -8, maxZ: 8 },
    spawns: { A: { pos: [0, 0, 6] }, B: { pos: [-4, 0.85, -5.5] } },
    boxes: [
      spawnWall(0, 4.5, 2.6, 1.2),
      spawnWall(-4, -4.2, 2.8, 1.2),
      b(-4, 0.85 / 2, -5.5, 2.8, 0.85, 2.4),
      b(2.2, FULL_H / 2, 0, 1.3, FULL_H, 1.1),
      b(-0.8, PEEK_H / 2, 2.5, 1.5, PEEK_H, 0.5),
      b(3.5, PEEK_H / 2, -2.2, 0.9, PEEK_H, 0.5)
    ]
  },
  {
    id: 'crate-yard',
    label: 'Crate Yard',
    bounds: { minX: -7, maxX: 7, minZ: -8.5, maxZ: 8.5 },
    spawns: { A: { pos: [4.5, 0, 6.2] }, B: { pos: [-5, 0, -6.2] } },
    boxes: [
      spawnWall(3.5, 4.6, 2.4, 1.1),
      spawnWall(-4, -4.6, 2.4, 1.1),
      b(1.2, PEEK_H / 2, 0.2, 1.1, PEEK_H, 1.0),
      b(-2.2, PEEK_H / 2, 1.5, 0.9, PEEK_H, 0.8),
      b(2.8, PEEK_H / 2, -1.8, 0.9, PEEK_H, 0.8),
      b(-0.8, FULL_H / 2, -0.3, 1.2, FULL_H, 0.9),
      b(0.0, FULL_H / 2, 3.2, 2.0, FULL_H, 0.5)
    ]
  },
  {
    id: 'zig-rush',
    label: 'Zig Rush',
    bounds: { minX: -7, maxX: 7, minZ: -8.5, maxZ: 8.5 },
    spawns: { A: { pos: [4, 0, 6.5] }, B: { pos: [-4.5, 0, -6.5] } },
    boxes: [
      spawnWall(3.2, 4.8, 2.4, 1.1),
      spawnWall(-3.5, -4.8, 2.4, 1.1),
      b(-2.5, PEEK_H / 2, 2.8, 1.2, PEEK_H, 0.5),
      b(0.4, PEEK_H / 2, 1.0, 1.2, PEEK_H, 0.5),
      b(2.8, PEEK_H / 2, -0.5, 1.2, PEEK_H, 0.5),
      b(-0.8, PEEK_H / 2, -2.2, 1.2, PEEK_H, 0.5),
      b(-3.8, FULL_H / 2, 0, 0.9, FULL_H, 1.8)
    ]
  },
  {
    id: 'catwalk',
    label: 'Catwalk',
    bounds: { minX: -8, maxX: 8, minZ: -7.5, maxZ: 7.5 },
    spawns: { A: { pos: [-5.5, 0, 5.5] }, B: { pos: [5.5, 0, -5.5] } },
    boxes: [
      spawnWall(-4.5, 4.2, 2.2, 1.1),
      spawnWall(4.5, -4.2, 2.2, 1.1),
      b(5.8, PEEK_H / 2, 0, 0.45, PEEK_H, 5.5),
      b(-1.8, FULL_H / 2, -0.3, 1.5, FULL_H, 1.1),
      b(1.2, PEEK_H / 2, 2.8, 1.6, PEEK_H, 0.5),
      b(-2.8, PEEK_H / 2, -3.0, 1.1, PEEK_H, 0.5)
    ]
  },
  {
    id: 'pinnacle',
    label: 'Pinnacle',
    bounds: { minX: -6.5, maxX: 6.5, minZ: -8, maxZ: 8 },
    spawns: { A: { pos: [3, 0, 6.2] }, B: { pos: [-1.5, 0, -6.2] } },
    boxes: [
      spawnWall(2.2, 4.6, 2.4, 1.1),
      spawnWall(-1.2, -4.6, 2.4, 1.1),
      b(-3.0, FULL_H / 2, 0, 1.6, FULL_H, 1.4),
      b(1.4, PEEK_H / 2, 2.0, 1.0, PEEK_H, 0.5),
      b(2.5, PEEK_H / 2, -1.5, 1.2, PEEK_H, 0.5),
      b(-0.8, PEEK_H / 2, -3.5, 1.8, PEEK_H, 0.5)
    ]
  },
  {
    id: 'open-flank',
    label: 'Open Flank',
    bounds: { minX: -9, maxX: 9, minZ: -9, maxZ: 9 },
    spawns: { A: { pos: [6, 0, 6.5] }, B: { pos: [-7, 0, -6.5] } },
    boxes: [
      spawnWall(4.8, 4.8, 2.6, 1.2),
      spawnWall(-5.5, -4.8, 2.6, 1.2),
      b(-3.5, FULL_H / 2, 1.5, 0.45, FULL_H, 4.5),
      b(1.8, PEEK_H / 2, -0.8, 1.4, PEEK_H, 0.5),
      b(-1.2, PEEK_H / 2, -3.2, 1.1, PEEK_H, 0.5),
      b(4.5, FULL_H / 2, 2.2, 1.0, FULL_H, 0.9)
    ]
  }
];

function finalizeTeamSpawns(entry) {
  if (Array.isArray(entry)) {
    return entry.map((s) => ({ pos: [...s.pos] }));
  }
  return [{ pos: [...entry.pos] }];
}

function finalizeMap(t) {
  return {
    id: t.id,
    label: t.label,
    bounds: { ...t.bounds },
    spawns: {
      A: finalizeTeamSpawns(t.spawns.A),
      B: finalizeTeamSpawns(t.spawns.B)
    },
    boxes: t.boxes.map((box) => ({
      pos: [...box.pos],
      size: [...box.size]
    }))
  };
}

export const DUEL_MAPS = [finalizeMap(TRACKING_ARENA), ...MAP_TEMPLATES.map(finalizeMap)];

/**
 * Free-for-all Deathmatch arena. Unlike duel maps, boxes KEEP their `rotationY`
 * (rendering + OBB collision + OBB server occlusion all honour it) and all
 * spawns live on team "A" — the shared FFA spawn pool.
 */
export const DEATHMATCH_MAP = {
  id: DEATHMATCH_MAP_DATA.id,
  label: DEATHMATCH_MAP_DATA.label,
  bounds: { ...DEATHMATCH_MAP_DATA.bounds },
  spawns: { A: DEATHMATCH_MAP_DATA.spawns.A.map((s) => ({ pos: [...s.pos] })) },
  boxes: DEATHMATCH_MAP_DATA.boxes.map((b) => ({
    pos: [...b.pos],
    size: [...b.size],
    rotationY: b.rotationY || 0
  }))
};

const ALL_MAPS = [...DUEL_MAPS, DEATHMATCH_MAP];

export const DEFAULT_MAP_ID = 'tight-poke';

/** Duel rotation — excludes the tracking-only empty arena and the FFA map. */
export function duelMapPool() {
  return DUEL_MAPS.filter((m) => m.id !== 'tracking-arena');
}

export function getMap(id) {
  return ALL_MAPS.find((m) => m.id === id) || DUEL_MAPS[0];
}

/**
 * Distinct spawn points for a free-for-all: greedily picks the spawn farthest
 * from everyone already placed so players don't telefrag on match start.
 */
export function ffaSpawns(map, count) {
  const pool = teamSpawnList(map, 'A');
  const chosen = [];
  const used = new Set();
  for (let n = 0; n < count; n++) {
    let bestIdx = -1;
    let bestGap = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (used.has(i)) continue;
      let gap = Infinity;
      for (const c of chosen) {
        gap = Math.min(gap, Math.hypot(pool[i].pos[0] - c.pos[0], pool[i].pos[2] - c.pos[2]));
      }
      if (chosen.length === 0) gap = Math.random(); // first pick: random seed
      if (gap > bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) bestIdx = Math.floor(Math.random() * pool.length); // pool exhausted → reuse
    used.add(bestIdx);
    chosen.push({ pos: [...pool[bestIdx].pos] });
  }
  return chosen;
}

/** A single FFA spawn far from the given avoid points (for respawns). */
export function ffaRespawn(map, avoid = []) {
  const pool = teamSpawnList(map, 'A');
  let best = pool[0];
  let bestGap = -Infinity;
  for (const sp of pool) {
    let gap = Infinity;
    for (const a of avoid) gap = Math.min(gap, Math.hypot(sp.pos[0] - a[0], sp.pos[2] - a[2]));
    if (!avoid.length) gap = Math.random();
    if (gap > bestGap) {
      bestGap = gap;
      best = sp;
    }
  }
  return { pos: [...best.pos] };
}

/** Pick a random map different from `currentId` when possible. */
export function pickRandomMap(currentId) {
  const pool = duelMapPool();
  const others = currentId ? pool.filter((m) => m.id !== currentId) : pool;
  const pick = others.length ? others : pool;
  return pick[Math.floor(Math.random() * pick.length)];
}

/**
 * Yaw (radians) for a player at `from` to look toward `to`.
 * Matches InputManager convention: yaw 0 = looking down −Z.
 */
export function yawToward(from, to) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return Math.atan2(-dx, -dz);
}

/** All spawn points for one team (always an array after finalizeMap). */
export function teamSpawnList(map, side) {
  const raw = side === 'B' ? map.spawns.B : map.spawns.A;
  if (!raw) return [{ pos: [0, 0, side === 'A' ? 6 : -6] }];
  if (Array.isArray(raw)) {
    return raw.map((s) => ({ pos: [...s.pos] }));
  }
  return [{ pos: [...raw.pos] }];
}

/** One spawn for a side — picked at random when the team has multiple. */
export function spawnFor(map, side) {
  const list = teamSpawnList(map, side);
  const pick = list[Math.floor(Math.random() * list.length)];
  return { pos: [...pick.pos] };
}

/** Both spawns with yaw auto-aimed at the opposing player. */
export function spawnPair(map) {
  const a = spawnFor(map, 'A');
  const b = spawnFor(map, 'B');
  return {
    A: { ...a, yaw: yawToward(a.pos, b.pos) },
    B: { ...b, yaw: yawToward(b.pos, a.pos) }
  };
}

/** Floor / grid half-extent for rendering from map bounds. */
export function mapExtent(map) {
  const b = map.bounds;
  if (!b) return 24;
  return Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) + 6;
}
