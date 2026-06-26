// One-off generator: converts the level-editor export deathmatch.json into a
// plain JS data module that BOTH the Vite client and the plain-Node server can
// import (no JSON import attributes needed). Re-run after editing deathmatch.json:
//   node scripts/gen-deathmatch-map.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const raw = JSON.parse(readFileSync(join(root, 'deathmatch.json'), 'utf8'));

const r = (n) => Math.round(n * 1000) / 1000;
const boxes = (raw.boxes || []).map((b) => ({
  pos: b.pos.map(r),
  size: b.size.map(r),
  rotationY: r(b.rotationY || 0)
}));
const spawnsA = (raw.spawns?.A || []).map((s) => ({ pos: s.pos.map(r) }));

const map = {
  id: 'deathmatch',
  label: raw.label || 'Deathmatch',
  bounds: {
    minX: r(raw.bounds.minX),
    maxX: r(raw.bounds.maxX),
    minZ: r(raw.bounds.minZ),
    maxZ: r(raw.bounds.maxZ)
  },
  spawns: { A: spawnsA },
  boxes
};

const out = `// AUTO-GENERATED from deathmatch.json by scripts/gen-deathmatch-map.mjs — do not edit by hand.
// Shared by the Vite client (scenarios + multiplayer maps) and the Node server.
// Boxes keep their \`rotationY\`; collision + hitscan use the OBB path.

export const DEATHMATCH_MAP_DATA = ${JSON.stringify(map, null, 2)};
`;

writeFileSync(join(root, 'src', 'multiplayer', 'deathmatchMapData.js'), out);
console.log(`Wrote src/multiplayer/deathmatchMapData.js (${boxes.length} boxes, ${spawnsA.length} spawns)`);
