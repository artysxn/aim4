import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const want = process.argv[3] || 'csgo_environment_blend';
let n = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
  const v = p.getMaterial()?.getExtras()?.vmat; if (!v || !v.ShaderName.startsWith(want)) continue;
  const sem = p.listSemantics();
  const info = { mesh: mesh.getName().slice(0, 50), mat: v.Name.split('/').pop(), sem };
  const col = p.getAttribute('COLOR_0');
  if (col) { const a = col.getArray(); const sz = col.getElementSize(); const norm = col.getNormalized(); let mn = [1e9,1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9,-1e9]; const el = []; for (let i = 0; i < col.getCount(); i++) { col.getElement(i, el); for (let c = 0; c < sz; c++) { mn[c] = Math.min(mn[c], el[c]); mx[c] = Math.max(mx[c], el[c]); } } info.color = { type: col.getType(), comp: col.getComponentType(), norm, min: mn.slice(0, sz).map(x=>+x.toFixed(2)), max: mx.slice(0, sz).map(x=>+x.toFixed(2)) }; }
  for (const s of sem) if (/TEXCOORD/.test(s)) { const a = p.getAttribute(s); info[s] = { min: a.getMin([]).map(x=>+x.toFixed(2)), max: a.getMax([]).map(x=>+x.toFixed(2)) }; }
  console.log(JSON.stringify(info));
  if (++n >= 6) process.exit(0);
}
