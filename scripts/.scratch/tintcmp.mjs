// Compare every tint-related vmat param between two maps, to find why one
// renders tint differently from the other.
//
//   node --max-old-space-size=16384 scripts/.scratch/tintcmp.mjs nuke inferno

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const NAME = { nuke: 'de_nuke', dust2: 'de_dust2', inferno: 'de_inferno', mirage: 'de_mirage' };
const isWhite = (v) => !v || (Math.abs(v[0] - 1) < 1e-3 && Math.abs(v[1] - 1) < 1e-3 && Math.abs(v[2] - 1) < 1e-3);

async function scan(slug) {
  const doc = await io.read(
    `server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}/world.glb`
  );
  const out = {
    materials: 0,
    shaders: new Map(),
    F_TINT_MASK: 0,
    g_tTintMask: 0,
    g_vColorTint_nonwhite: 0,
    g_vLayer2Tint_nonwhite: 0,
    g_vLayer2Tint_present: 0,
    F_LAYERS: 0,
    baseColorFactor_nonwhite: 0,
    tintExamples: []
  };
  for (const m of doc.getRoot().listMaterials()) {
    const v = m.getExtras()?.vmat;
    if (!v) continue;
    out.materials++;
    const sh = String(v.ShaderName || '?');
    out.shaders.set(sh, (out.shaders.get(sh) || 0) + 1);
    const I = v.IntParams || {};
    const V = v.VectorParams || {};
    const T = v.TextureParams || {};
    if (I.F_TINT_MASK === 1) out.F_TINT_MASK++;
    if (T.g_tTintMask) out.g_tTintMask++;
    if (Number(I.F_LAYERS) >= 1) out.F_LAYERS++;
    if (!isWhite(V.g_vColorTint)) out.g_vColorTint_nonwhite++;
    if (V.g_vLayer2Tint) out.g_vLayer2Tint_present++;
    if (!isWhite(V.g_vLayer2Tint)) {
      out.g_vLayer2Tint_nonwhite++;
      if (out.tintExamples.length < 6) {
        out.tintExamples.push(
          `${String(v.Name).split('/').pop()}  layer2Tint=[${V.g_vLayer2Tint.slice(0, 3).map((x) => x.toFixed(3))}]`
        );
      }
    }
    const bc = m.getBaseColorFactor();
    if (bc && !isWhite(bc)) out.baseColorFactor_nonwhite++;
  }
  return out;
}

const [a, b] = [process.argv[2] || 'nuke', process.argv[3] || 'inferno'];
const A = await scan(a);
const B = await scan(b);

const keys = [
  'materials',
  'F_TINT_MASK',
  'g_tTintMask',
  'g_vColorTint_nonwhite',
  'g_vLayer2Tint_present',
  'g_vLayer2Tint_nonwhite',
  'F_LAYERS',
  'baseColorFactor_nonwhite'
];
console.log('field'.padEnd(26) + a.padEnd(12) + b);
for (const k of keys) console.log(k.padEnd(26) + String(A[k]).padEnd(12) + B[k]);

for (const [label, o] of [[a, A], [b, B]]) {
  console.log(`\n--- ${label} top shaders ---`);
  console.log(
    [...o.shaders.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([s, n]) => `  ${String(n).padStart(4)}  ${s}`)
      .join('\n')
  );
  if (o.tintExamples.length) console.log(`  layer2Tint examples:\n${o.tintExamples.map((e) => '   ' + e).join('\n')}`);
}
