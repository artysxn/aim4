import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const slug = process.argv[2], file = process.argv[3];
const man = JSON.parse(fs.readFileSync(`server/data/cs3d/pack/${slug}/manifest.json`, 'utf8'));
const nobase = man.materials.filter(m => !m.base);
console.log('materials', man.materials.length, 'without base', nobase.length, 'tris without base', nobase.reduce((a,m)=>a+m.tris,0), 'of', man.materials.reduce((a,m)=>a+m.tris,0));
nobase.sort((a,b)=>b.tris-a.tris);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${file}/world.glb`);
const byName = new Map();
for (const m of doc.getRoot().listMaterials()) byName.set(m.getExtras()?.vmat?.Name, m.getExtras().vmat);
for (const m of nobase.slice(0, 25)) {
  const v = byName.get(m.name) || {};
  console.log(m.tris, m.name, m.shader, JSON.stringify(v.TextureParams || {}).slice(0, 400));
}
// shader tally for nobase
const t = new Map(); for (const m of nobase) t.set(m.shader, (t.get(m.shader)||0)+m.tris);
console.log([...t.entries()].sort((a,b)=>b[1]-a[1]));
