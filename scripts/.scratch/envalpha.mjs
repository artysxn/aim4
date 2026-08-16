// Does csgo_environment's g_tColor1 carry a tint mask in its alpha channel?
// Read the exported PNGs for a few materials and report alpha statistics.
// A flat 255 alpha means "no mask"; real variation means it IS the mask.
//
//   node --max-old-space-size=16384 scripts/.scratch/envalpha.mjs inferno

import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
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

const WANT = /trike_body|plaster_facade_01_dirty\.|stone_wall04_plaster03|inferno_shop_front_01|accesspanels_kit_01_tint_default/;
const seen = new Set();
let envWithAlphaVar = 0, envTotal = 0;
const rows = [];
for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat;
  if (!v || !/csgo_environment/.test(String(v.ShaderName))) continue;
  if (seen.has(v.Name)) continue;
  seen.add(v.Name);
  const T = v.TextureParams || {};
  const slot = T.g_tColor1 || T.g_tColor;
  if (!slot) continue;
  const png = path.join(dir, path.basename(String(slot)).replace(/\.vtex$/i, '.png'));
  if (!fs.existsSync(png)) continue;
  envTotal++;
  const img = sharp(png);
  const meta = await img.metadata();
  let line = `${v.Name.split('/').pop().padEnd(48)} ${meta.width}x${meta.height} ch=${meta.channels}`;
  if (meta.channels === 4) {
    const st = await img.stats();
    const a = st.channels[3];
    const varies = a.max - a.min > 8;
    if (varies) envWithAlphaVar++;
    line += `  alpha min=${a.min} max=${a.max} mean=${a.mean.toFixed(1)} sd=${a.stdev.toFixed(1)}  ${varies ? '<-- VARIES (a mask)' : '(flat)'}`;
  } else line += '  no alpha channel';
  if (WANT.test(v.Name)) rows.push(line);
}
console.log(rows.join('\n'));
console.log(`\n${envWithAlphaVar} of ${envTotal} environment colour maps have a varying alpha channel`);
