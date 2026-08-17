import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
for (const mat of root.listMaterials()) {
  const t = (tex) => tex ? `${tex.getURI() || tex.getName()} ${tex.getMimeType()} ${tex.getSize()?.join('x')}` : '-';
  console.log('mat', mat.getName());
  console.log('   base', t(mat.getBaseColorTexture()), 'factor', mat.getBaseColorFactor());
  console.log('   normal', t(mat.getNormalTexture()));
  console.log('   mr', t(mat.getMetallicRoughnessTexture()), 'metal', mat.getMetallicFactor(), 'rough', mat.getRoughnessFactor());
  console.log('   occl', t(mat.getOcclusionTexture()), 'emissive', t(mat.getEmissiveTexture()));
  const ex = mat.getExtras()?.vmat || {};
  console.log('   textures', JSON.stringify(ex.TextureParams || ex.Textures || {}));
  console.log('   ints', JSON.stringify(ex.IntParams||{}));
}
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) console.log('prim', m.getName().split('.').pop(), '->', p.getMaterial()?.getName(), 'verts', p.getAttribute('POSITION').getCount());
