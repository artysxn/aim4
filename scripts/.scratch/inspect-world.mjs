import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const file = process.argv[2];
const doc = await io.read(file);
const root = doc.getRoot();
const scene = root.listScenes()[0];
console.log('scenes', root.listScenes().length, 'nodes', root.listNodes().length, 'meshes', root.listMeshes().length, 'materials', root.listMaterials().length, 'textures', root.listTextures().length);
console.log('root extras', JSON.stringify(root.getExtras()).slice(0,500));
console.log('scene extras', JSON.stringify(scene.getExtras()).slice(0,500));
function walk(n, depth, out) {
  if (depth > 3) return;
  const ex = n.getExtras();
  out.push('  '.repeat(depth) + n.getName() + (n.getMesh() ? ' [mesh]' : '') + ' children=' + n.listChildren().length + (Object.keys(ex).length ? ' extras=' + JSON.stringify(ex).slice(0,300) : ''));
  if (depth < 2) for (const c of n.listChildren().slice(0, 12)) walk(c, depth + 1, out);
}
const out = [];
for (const n of scene.listChildren()) walk(n, 0, out);
console.log(out.join('\n'));
// find nodes with interesting names
const names = new Map();
for (const n of root.listNodes()) {
  const nm = n.getName().replace(/[\d_]+$/, '');
  names.set(nm, (names.get(nm) || 0) + 1);
}
console.log([...names.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 40));
// materials with caustics
for (const m of root.listMaterials()) {
  const t = m.getBaseColorTexture();
  const ex = m.getExtras();
  if ((t && /caustic/i.test(t.getURI() || t.getName())) || /caustic|water/i.test(m.getName())) console.log('MAT', m.getName(), t && (t.getURI()||t.getName()), JSON.stringify(ex).slice(0,600));
}
