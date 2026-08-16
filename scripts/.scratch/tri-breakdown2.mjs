import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import crypto from 'node:crypto';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const hashes = new Map();
const meshTris = new Map();
const el = [0,0,0];
for (const mesh of root.listMeshes()) {
  let tris = 0; const h = crypto.createHash('md5');
  for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices(); const pos = p.getAttribute('POSITION'); if (!pos || !idx) continue;
    const ia = idx.getArray(); tris += ia.length / 3;
    const buf = new Float32Array(ia.length * 3);
    for (let i = 0; i < ia.length; i++) { pos.getElement(ia[i], el); buf[i*3] = el[0]; buf[i*3+1] = el[1]; buf[i*3+2] = el[2]; }
    h.update(Buffer.from(buf.buffer)); h.update(String(p.getMaterial()?.getName()));
  }
  meshTris.set(mesh, tris);
  const key = h.digest('hex');
  const e = hashes.get(key) || { count: 0, tris, name: mesh.getName() };
  e.count++; hashes.set(key, e);
}
let uniqTris = 0, dupTris = 0, uniq = 0, total = 0;
const top = [];
for (const [k, e] of hashes) { uniq++; uniqTris += e.tris; dupTris += e.tris * (e.count - 1); total += e.tris * e.count; if (e.count > 1) top.push(e); }
top.sort((a,b) => b.tris*(b.count-1) - a.tris*(a.count-1));
console.log('meshes', root.listMeshes().length, 'unique', uniq, 'total tris', Math.round(total/1000)+'k', 'unique tris', Math.round(uniqTris/1000)+'k', 'dup tris', Math.round(dupTris/1000)+'k');
console.log(top.slice(0, 12).map(e => `${e.count}x ${Math.round(e.tris)} ${e.name}`).join('\n'));
