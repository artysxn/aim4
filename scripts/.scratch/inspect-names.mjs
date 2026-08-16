import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const tally = new Map();
const lr = new Map();
let extrasSample = null;
for (const n of root.listNodes()) {
  const nm = n.getName();
  const m = nm.match(/^n(\d+)_lr(\d+)_c(\d+)_(.*)$/);
  if (m) {
    const key = `n${m[1]}_lr${m[2]}`;
    lr.set(key, (lr.get(key) || 0) + 1);
    const kind = m[4].replace(/\d+/g, '#');
    tally.set(kind, (tally.get(kind) || 0) + 1);
  } else {
    const kind = 'OTHER:' + nm.replace(/\d+/g, '#').slice(0, 60);
    tally.set(kind, (tally.get(kind) || 0) + 1);
  }
  const ex = n.getExtras();
  if (!extrasSample && Object.keys(ex).length) extrasSample = { name: nm, ex };
}
console.log('by node/layer', [...lr.entries()]);
console.log('kinds', [...tally.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 60));
console.log('extras sample', JSON.stringify(extrasSample).slice(0, 800));
// mesh extras
let mex = 0;
for (const m of root.listMeshes()) { if (Object.keys(m.getExtras()).length) { if (mex < 3) console.log('mesh extras', m.getName(), JSON.stringify(m.getExtras()).slice(0,400)); mex++; } }
console.log('meshes with extras', mex);
let pex = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { if (Object.keys(p.getExtras()).length) { if (pex < 3) console.log('prim extras', JSON.stringify(p.getExtras()).slice(0,400)); pex++; } }
console.log('prims with extras', pex);
let matex = 0;
for (const m of root.listMaterials()) { if (Object.keys(m.getExtras()).length) { if (matex < 2) console.log('mat extras', m.getName(), JSON.stringify(m.getExtras()).slice(0,1500)); matex++; } }
console.log('mats with extras', matex);
