import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const re = new RegExp(process.argv[3] || 'awning|canopy|hood|shade', 'i');
let n = 0, tinted = 0;
for (const m of doc.getRoot().listMaterials()) {
  const f = m.getBaseColorFactor();
  if (f[0] !== 1 || f[1] !== 1 || f[2] !== 1) tinted++;
  const v = m.getExtras()?.vmat;
  if (re.test(m.getName()) || re.test(v?.Name || '')) { console.log(m.getName(), '| factor', f.map(x=>+x.toFixed(2)), '| tint', JSON.stringify(v?.VectorParams?.g_vColorTint), '| shader', v?.ShaderName, '| tex', JSON.stringify(v?.TextureParams).slice(0,200)); n++; }
}
console.log('matched', n, 'materials with non-white baseColorFactor:', tinted, 'of', doc.getRoot().listMaterials().length);
// node extras with tint?
let nodeTint = 0; for (const nd of doc.getRoot().listNodes()) { const ex = nd.getExtras(); if (ex && (ex.tint || ex.rendercolor || ex.m_vTintColor)) nodeTint++; }
console.log('nodes with tint extras', nodeTint);
