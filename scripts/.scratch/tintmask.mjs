// Inferno has 104 vmats with a tint mask but only 28 survive into the manifest.
// Find where they die: wrong slot name, or a texture that never got exported.
//
//   node --max-old-space-size=16384 scripts/.scratch/tintmask.mjs inferno

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const slug = process.argv[2] || 'inferno';
const NAME = { nuke: 'de_nuke', dust2: 'de_dust2', inferno: 'de_inferno' };
const dir = `server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}`;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(`${dir}/world.glb`);

const exists = (vtex) => {
  if (!vtex) return false;
  const png = path.basename(String(vtex)).replace(/\.vtex$/i, '.png');
  return fs.existsSync(path.join(dir, png));
};

let withFlag = 0;
let withSlot = 0;
let slotResolves = 0;
const slotNames = new Map();
const missing = [];
const shaderOf = new Map();

for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat;
  if (!v) continue;
  const I = v.IntParams || {};
  const T = v.TextureParams || {};
  const flagged = I.F_TINT_MASK === 1 || !!T.g_tTintMask;
  if (!flagged) continue;
  withFlag++;
  // every texture slot whose name mentions a mask, so a differently-named
  // channel shows up rather than being assumed absent
  for (const k of Object.keys(T)) if (/mask/i.test(k)) slotNames.set(k, (slotNames.get(k) || 0) + 1);
  const sh = String(v.ShaderName || '?');
  shaderOf.set(sh, (shaderOf.get(sh) || 0) + 1);
  if (T.g_tTintMask) {
    withSlot++;
    if (exists(T.g_tTintMask)) slotResolves++;
    else if (missing.length < 8) missing.push(`${String(v.Name).split('/').pop()}  ->  ${T.g_tTintMask}`);
  }
}

console.log(`${slug}: ${withFlag} vmat(s) flagged as tint-masked`);
console.log(`  with a g_tTintMask slot : ${withSlot}`);
console.log(`  whose PNG exists on disk: ${slotResolves}`);
console.log(`  PNG MISSING             : ${withSlot - slotResolves}`);
console.log('\n  mask-ish slot names seen:');
for (const [k, n] of [...slotNames.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log('\n  shaders of tint-masked vmats:');
for (const [k, n] of [...shaderOf.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
if (missing.length) console.log('\n  examples with no exported PNG:\n   ' + missing.join('\n   '));
