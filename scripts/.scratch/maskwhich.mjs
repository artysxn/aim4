// Which channel is csgo_environment's tint mask: colour alpha or height G?
// For each test material print stats of both. The barrel wood is untinted in
// game, so its true mask must be LOW over most of the surface.
//
//   node --max-old-space-size=16384 scripts/.scratch/maskwhich.mjs inferno

import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const slug = process.argv[2] || 'inferno';
const NAME = { nuke: 'de_nuke', dust2: 'de_dust2', inferno: 'de_inferno' };
const dir = `server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}`;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(`${dir}/world.glb`);

const WANT = /trike_body|barrel_kit_01_tint_default_blend|plaster_facade_01_dirty\.|barn_door_01_b_tint_default|stone_wall04_plaster03|accesspanels_kit_01_tint_default/;
const png = (v) => (v ? path.join(dir, path.basename(String(v)).replace(/\.vtex$/i, '.png')) : null);
async function chan(file, c) {
  if (!file || !fs.existsSync(file)) return 'n/a';
  const st = await sharp(file, { limitInputPixels: false }).stats();
  const s = st.channels[c];
  if (!s) return 'n/a';
  return `mean ${s.mean.toFixed(0).padStart(3)} sd ${s.stdev.toFixed(0).padStart(3)} [${s.min}..${s.max}]`;
}
const seen = new Set();
for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat;
  if (!v || !WANT.test(v.Name) || seen.has(v.Name)) continue;
  seen.add(v.Name);
  const T = v.TextureParams || {}, F = v.FloatParams || {}, I = v.IntParams || {};
  console.log(`\n${v.Name.split('/').pop()}  (${String(v.ShaderName).replace('.vfx', '')})`);
  console.log(`  tintMaskBright1 ${F.g_fTintMaskBrightness1 ?? '-'} contrast1 ${F.g_fTintMaskContrast1 ?? '-'} | bright2 ${F.g_fTintMaskBrightness2 ?? '-'} contrast2 ${F.g_fTintMaskContrast2 ?? '-'} | modelTintAmt ${F.g_flModelTintAmount ?? '-'} | bModelTint1 ${I.g_bModelTint1 ?? '-'}`);
  console.log(`  color1.a   ${await chan(png(T.g_tColor1), 3)}`);
  console.log(`  height1.g  ${await chan(png(T.g_tHeight1), 1)}`);
  if (T.g_tColor2) console.log(`  color2.a   ${await chan(png(T.g_tColor2), 3)}`);
  if (T.g_tHeight2) console.log(`  height2.g  ${await chan(png(T.g_tHeight2), 1)}`);
}
