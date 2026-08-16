import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
let totVerts = 0, totUniq = 0, totTris = 0, n = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const pos = p.getAttribute('POSITION'), nrm = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0'), idx = p.getIndices();
  if (!pos || !idx) continue;
  const ia = idx.getArray(); const used = new Set(ia); const keys = new Set(); const e = [];
  for (const i of used) { pos.getElement(i, e); const k = [Math.round(e[0]*16), Math.round(e[1]*16), Math.round(e[2]*16)]; if (nrm) { nrm.getElement(i, e); k.push(Math.round(e[0]*64), Math.round(e[1]*64), Math.round(e[2]*64)); } if (uv) { uv.getElement(i, e); k.push(Math.round(e[0]*2048), Math.round(e[1]*2048)); } keys.add(k.join(',')); }
  totVerts += used.size; totUniq += keys.size; totTris += ia.length/3; if (++n > 3000) break;
}
console.log('prims', n, 'tris', totTris, 'used verts', totVerts, 'unique(quantized) verts', totUniq, 'ratio', (totUniq/totVerts).toFixed(2));
