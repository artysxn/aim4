// Why do some web_joist_001 prims read as charted and others as chartless?
// Print every TEXCOORD set on each prim of a given vmat, with its range, so the
// real discriminator between a lightmap chart and an incidental second UV is
// visible instead of inferred.
//
//   node scripts/.scratch/chartprobe.mjs web_joist_001

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const want = process.argv[2] || 'web_joist_001';
const FILE = 'server/data/cs3d/raw/maps/nuke/world/maps/de_nuke/world.glb';
const LM_UV_MAX = 0.876;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(FILE);

const vmatOf = (m) => String(m?.getExtras()?.vmat?.Name || m?.getName() || '');
const rows = [];
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial();
    if (!mat) continue;
    const name = vmatOf(mat);
    if (!name.includes(want)) continue;
    const sets = prim
      .listSemantics()
      .filter((s) => /^TEXCOORD_\d+$/.test(s))
      .sort();
    const info = sets.map((s) => {
      const a = prim.getAttribute(s);
      const mn = a.getMin([]);
      const mx = a.getMax([]);
      return `${s}[${mn[0].toFixed(2)},${mn[1].toFixed(2)} .. ${mx[0].toFixed(2)},${mx[1].toFixed(2)}]`;
    });
    // exactly what lightmapUvOf() decides
    let charted = null;
    for (const n of sets
      .map((s) => Number(s.slice(9)))
      .filter((n) => n >= 1)
      .sort((a, b) => b - a)) {
      const a = prim.getAttribute(`TEXCOORD_${n}`);
      const mn = a.getMin([]);
      const mx = a.getMax([]);
      if (mn[0] >= -0.01 && mn[1] >= -0.01 && mx[0] <= LM_UV_MAX && mx[1] <= LM_UV_MAX) {
        charted = n;
        break;
      }
    }
    rows.push({
      mesh: mesh.getName() || '(unnamed)',
      extras: JSON.stringify(mesh.getExtras() || {}).slice(0, 110),
      verdict: charted === null ? 'CHARTLESS' : `charted via TEXCOORD_${charted}`,
      sets: info.join('  ')
    });
  }
}

console.log(`${rows.length} prim(s) on vmats matching "${want}"\n`);
const byVerdict = new Map();
for (const r of rows) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) || 0) + 1);
for (const [k, v] of byVerdict) console.log(`  ${v.toString().padStart(5)}  ${k}`);
console.log('\n--- samples ---');
const seen = new Set();
for (const r of rows) {
  if (seen.has(r.verdict) && seen.size >= 2) continue;
  if (seen.has(r.verdict)) continue;
  seen.add(r.verdict);
  console.log(`\n[${r.verdict}]`);
  console.log(`  mesh   ${r.mesh}`);
  console.log(`  extras ${r.extras}`);
  console.log(`  uv     ${r.sets}`);
}
