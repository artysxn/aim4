// ---------------------------------------------------------------------------
// deathmatchMap.js
// Singleplayer-facing view of the Deathmatch arena. The geometry lives in the
// shared, runtime-agnostic data module (src/multiplayer/deathmatchMapData.js,
// generated from deathmatch.json) so the client scenarios and the Node server
// agree on the exact same walls + spawns. Boxes keep their `rotationY`, so
// rendering, shooting, line-of-sight and collision all honour rotated walls.
// ---------------------------------------------------------------------------

import { DEATHMATCH_MAP_DATA } from '../multiplayer/deathmatchMapData.js';

export const DEATHMATCH_MAP = {
  id: DEATHMATCH_MAP_DATA.id,
  label: DEATHMATCH_MAP_DATA.label,
  bounds: { ...DEATHMATCH_MAP_DATA.bounds },
  spawns: DEATHMATCH_MAP_DATA.spawns.A.map((s) => ({ pos: [...s.pos] })),
  boxes: DEATHMATCH_MAP_DATA.boxes.map((b) => ({
    pos: [...b.pos],
    size: [...b.size],
    rotationY: b.rotationY || 0
  }))
};

/** Floor / grid half-extent for rendering from the map bounds. */
export function deathmatchExtent(map = DEATHMATCH_MAP) {
  const b = map.bounds;
  if (!b) return 48;
  return Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minZ), Math.abs(b.maxZ)) + 4;
}
