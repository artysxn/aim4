// Where does the tint on Inferno's csgo_environment materials come from, and
// is it one we are inventing? Compares the glTF baseColorFactor (which the
// loader applies to the whole surface) against the vmat's own g_vColorTint.
//
//   node --max-old-space-size=16384 scripts/.scratch/envtint.mjs inferno

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const slug = process.argv[2] || 'inferno';
const NAME = { nuke: 'de_nuke', dust2: 'de_dust2', inferno: 'de_inferno' };

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}/world.glb`);

const white = (v) => !v || (Math.abs(v[0] - 1) < 1e-3 && Math.abs(v[1] - 1) < 1e-3 && Math.abs(v[2] - 1) < 1e-3);
const fam = (s) => (/environment/.test(s) ? 'environment' : /complex/.test(s) ? 'complex' : 'other');

const stats = {};
const examples = [];
for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat;
  if (!v) continue;
  const f = fam(String(v.ShaderName || ''));
  const s = (stats[f] ||= { n: 0, bcfTinted: 0, vmatTinted: 0, bothWhite: 0, overlayMask: 0, modelTint: 0 });
  s.n++;
  const V = v.VectorParams || {};
  const I = v.IntParams || {};
  const F = v.FloatParams || {};
  const bcf = m.getBaseColorFactor();
  const bcfT = !white(bcf);
  const vmT = !white(V.g_vColorTint);
  if (bcfT) s.bcfTinted++;
  if (vmT) s.vmatTinted++;
  if (!bcfT && !vmT) s.bothWhite++;
  if (Number.isFinite(I.g_nColorOverlayTintMask)) s.overlayMask++;
  if (Number.isFinite(F.g_flModelTintAmount)) s.modelTint++;
  // the interesting case: glTF says tinted but the vmat says white
  if (f === 'environment' && bcfT && !vmT && examples.length < 8) {
    examples.push(
      `${String(v.Name).split('/').pop().padEnd(46)} bcf=[${bcf.slice(0, 3).map((x) => x.toFixed(3)).join(',')}] vmatTint=white`
    );
  }
}

for (const [f, s] of Object.entries(stats)) {
  console.log(
    `${f.padEnd(12)} n=${String(s.n).padStart(4)}  baseColorFactor tinted=${String(s.bcfTinted).padStart(4)}` +
      `  g_vColorTint tinted=${String(s.vmatTinted).padStart(4)}  both white=${String(s.bothWhite).padStart(4)}` +
      `  hasOverlayMaskParam=${String(s.overlayMask).padStart(4)}  hasModelTintAmount=${String(s.modelTint).padStart(4)}`
  );
}
if (examples.length) console.log('\nenvironment: glTF tinted but vmat tint is white\n  ' + examples.join('\n  '));
