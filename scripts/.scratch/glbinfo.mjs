import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
console.log('scenes', root.listScenes().length, 'nodes', root.listNodes().length, 'meshes', root.listMeshes().length, 'skins', root.listSkins().length, 'anims', root.listAnimations().length, 'materials', root.listMaterials().length, 'textures', root.listTextures().length);
for (const s of root.listSkins()) console.log('skin', s.getName(), 'joints', s.listJoints().length, 'root', s.getSkeleton()?.getName());
for (const m of root.listMeshes()) {
  const prims = m.listPrimitives();
  const tris = prims.reduce((a,p)=> a + (p.getIndices()?.getCount()||0)/3, 0);
  console.log('mesh', m.getName(), 'prims', prims.length, 'tris', tris, 'attrs', prims[0]?.listSemantics().join(','), 'extras', JSON.stringify(m.getExtras()).slice(0,200));
}
for (const a of root.listAnimations()) console.log('anim', a.getName(), 'channels', a.listChannels().length, 'samplers', a.listSamplers().length, 'dur', Math.max(...a.listSamplers().map(s=>s.getInput()?.getMax([])[0]||0)));
for (const mat of root.listMaterials()) console.log('mat', mat.getName(), 'base', !!mat.getBaseColorTexture(), 'normal', !!mat.getNormalTexture(), 'mr', !!mat.getMetallicRoughnessTexture(), 'alpha', mat.getAlphaMode(), 'extras', JSON.stringify(mat.getExtras()).slice(0,300));
const nodes = root.listNodes();
console.log('node names (first 60):', nodes.slice(0,60).map(n=>n.getName()).join(' | '));
for (const n of nodes) { if (n.getMesh()) console.log('meshnode', n.getName(), 'skin', !!n.getSkin(), 'T', n.getTranslation(), 'R', n.getRotation(), 'S', n.getScale(), 'extras', JSON.stringify(n.getExtras()).slice(0,300)); }
