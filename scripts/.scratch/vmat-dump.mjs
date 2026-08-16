import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const want = process.argv.slice(3);
const seen = new Set();
const shaders = new Map();
for (const m of doc.getRoot().listMaterials()) {
  const v = m.getExtras()?.vmat; if (!v) continue;
  shaders.set(v.ShaderName, (shaders.get(v.ShaderName) || 0) + 1);
  for (const w of want) {
    if (v.ShaderName.startsWith(w) && !seen.has(w)) { seen.add(w); console.log('=====', v.Name, v.ShaderName); console.log(JSON.stringify({ Int: v.IntParams, Float: v.FloatParams, Vec: v.VectorParams, Tex: v.TextureParams }, null, 1)); }
  }
}
console.log([...shaders.entries()].sort((a,b)=>b[1]-a[1]));
