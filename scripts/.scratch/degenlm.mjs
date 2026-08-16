// A prim whose TEXCOORD_1 collapses to a point still passes lightmapUvOf()'s
// range test (0 is inside [0, 0.876]), so it is classified CHARTED and samples
// one texel of the atlas for its whole surface. If that texel is black, the
// whole model renders black — next to an identical instance that has a real
// chart and looks fine.
//
//   node --max-old-space-size=16384 scripts/.scratch/degenlm.mjs ancient

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const slug = process.argv[2] || 'ancient';
const NAME = {
  ancient: 'de_ancient',
  cache: 'de_cache',
  inferno: 'de_inferno',
  nuke: 'de_nuke',
  dust2: 'de_dust2',
  mirage: 'de_mirage',
  anubis: 'de_anubis'
};
const LM_UV_MAX = 0.876;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${NAME[slug]}/world.glb`);

const vmatOf = (m) => String(m?.getExtras()?.vmat?.Name || m?.getName() || '');
let charted = 0;
let degenerate = 0;
const byMat = new Map();
const samples = [];

for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    if (!mat || prim.getMode() !== 4) continue;
    // exactly lightmapUvOf(): highest TEXCOORD_n (n>=1) inside the atlas range
    let a = null;
    const sets = prim
      .listSemantics()
      .filter((s) => /^TEXCOORD_\d+$/.test(s))
      .map((s) => Number(s.slice(9)))
      .filter((n) => n >= 1)
      .sort((x, y) => y - x);
    for (const n of sets) {
      const t = prim.getAttribute(`TEXCOORD_${n}`);
      const mn = t.getMin([]);
      const mx = t.getMax([]);
      if (mn[0] >= -0.01 && mn[1] >= -0.01 && mx[0] <= LM_UV_MAX && mx[1] <= LM_UV_MAX) { a = t; break; }
    }
    if (!a) continue;
    charted++;
    const mn = a.getMin([]);
    const mx = a.getMax([]);
    const w = mx[0] - mn[0];
    const h = mx[1] - mn[1];
    // A real chart occupies area in the atlas. 1/4096 is one texel.
    if (w < 1 / 4096 || h < 1 / 4096) {
      degenerate++;
      const name = vmatOf(mat);
      byMat.set(name, (byMat.get(name) || 0) + 1);
      if (samples.length < 8) {
        samples.push(`${name.split('/').pop().padEnd(46)} uv1 span ${w.toExponential(1)} x ${h.toExponential(1)}  at [${mn[0].toFixed(4)}, ${mn[1].toFixed(4)}]`);
      }
    }
  }
}

console.log(`${slug}: ${charted} charted prim(s), ${degenerate} with a DEGENERATE chart (collapsed to a point)`);
if (byMat.size) {
  console.log('\n  worst vmats:');
  for (const [n, c] of [...byMat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(c).padStart(4)}  ${n.split('/').pop()}`);
  }
  console.log('\n  samples:\n   ' + samples.join('\n   '));
}
