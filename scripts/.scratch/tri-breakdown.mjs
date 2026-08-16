import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import crypto from 'node:crypto';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const cats = new Map();
const hashes = new Map(); // hash -> {count, tris}
let totalTris = 0;
const meshTris = new Map();
for (const mesh of root.listMeshes()) {
  let tris = 0; const h = crypto.createHash('md5');
  for (const p of mesh.listPrimitives()) { const idx = p.getIndices(); const pos = p.getAttribute('POSITION'); if (!pos) continue; tris += idx ? idx.getCount()/3 : pos.getCount()/3; h.update(Buffer.from(pos.getArray().buffer, pos.getArray().byteOffset, pos.getArray().byteLength)); h.update(String(p.getMaterial()?.getName())); }
  meshTris.set(mesh, tris);
  const key = h.digest('hex');
  const e = hashes.get(key) || { count: 0, tris, name: mesh.getName() };
  e.count++; hashes.set(key, e);
}
for (const n of root.listNodes()) {
  const m = n.getMesh(); if (!m) continue;
  const tris = meshTris.get(m) || 0; totalTris += tris;
  const nm = n.getName();
  const cat = nm.match(/agg_prop/) ? 'agg_prop' : nm.match(/agg_merge/) ? 'agg_merge' : nm.match(/agg_nomerge/) ? 'agg_nomerge' : nm.match(/_s_mesh_overlay/) ? 'overlay' : nm.match(/_s_/) ? 'world_s' : 'other';
  const c = cats.get(cat) || { nodes: 0, tris: 0 }; c.nodes++; c.tris += tris; cats.set(cat, c);
}
console.log('total tris', totalTris, 'nodes', root.listNodes().length, 'meshes', root.listMeshes().length);
console.log([...cats.entries()].map(([k,v]) => `${k}: ${v.nodes} nodes, ${Math.round(v.tris/1000)}k tris`).join('\n'));
let uniqTris = 0, dupTris = 0, uniq = 0;
const top = [];
for (const [k, e] of hashes) { uniq++; uniqTris += e.tris; dupTris += e.tris * (e.count - 1); if (e.count > 1) top.push(e); }
top.sort((a,b) => b.tris*b.count - a.tris*a.count);
console.log('unique meshes', uniq, 'unique tris', Math.round(uniqTris/1000)+'k', 'duplicate tris (instances beyond first)', Math.round(dupTris/1000)+'k');
console.log(top.slice(0, 15).map(e => `${e.count}x ${Math.round(e.tris)} ${e.name}`).join('\n'));
