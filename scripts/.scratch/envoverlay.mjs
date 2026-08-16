// How csgo_environment applies its tint: distribution of the colour-overlay
// params across every environment material, plus the trike and plaster.
//
//   node --max-old-space-size=16384 scripts/.scratch/envoverlay.mjs inferno

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const slug = process.argv[2] || 'inferno';
const NAME = { nuke: 'de_nuke', dust2: 'de_dust2', inferno: 'de_inferno' };
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}/world.glb`);

const count = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const shared = new Map(), mode = new Map(), mask = new Map(), amount = new Map();
let n = 0;
const seen = new Set();
for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat;
  if (!v || !/csgo_environment/.test(String(v.ShaderName))) continue;
  if (seen.has(v.Name)) continue;
  seen.add(v.Name);
  n++;
  const I = v.IntParams || {}, F = v.FloatParams || {};
  count(shared, String(I.F_SHARED_COLOR_OVERLAY ?? 'unset'));
  count(mode, String(I.g_nColorOverlayMode ?? 'unset'));
  count(mask, String(I.g_nColorOverlayTintMask ?? 'unset'));
  count(amount, String(F.g_flModelTintAmount ?? 'unset'));
  if (/trike_body|plaster_facade_01_dirty/.test(v.Name)) {
    console.log(`\n${v.Name.split('/').pop()}  (${v.ShaderName})`);
    console.log('  F_SHARED_COLOR_OVERLAY', I.F_SHARED_COLOR_OVERLAY, '| g_nColorOverlayMode', I.g_nColorOverlayMode,
      '| g_nColorOverlayTintMask', I.g_nColorOverlayTintMask, '| g_flModelTintAmount', F.g_flModelTintAmount);
    console.log('  overlay B/D contrast', F.g_flOverlayBrightnessContrast, F.g_flOverlayDarknessContrast,
      '| g_bModelTint2', I.g_bModelTint2, '| tex slots:', Object.keys(v.TextureParams || {}).join(' '));
  }
}
const show = (label, m) => console.log(`${label.padEnd(26)} ` + [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join('  '));
console.log(`\n${n} unique environment vmats`);
show('F_SHARED_COLOR_OVERLAY', shared);
show('g_nColorOverlayMode', mode);
show('g_nColorOverlayTintMask', mask);
show('g_flModelTintAmount', amount);
