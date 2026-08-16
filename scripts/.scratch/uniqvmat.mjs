import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const names = new Set(); let n = 0;
  for (const m of doc.getRoot().listMaterials()) { const v = m.getExtras()?.vmat; if (!v) continue; n++; names.add(v.Name); }
  console.log(f.split('/').slice(-1)[0], 'materials', n, 'unique vmats', names.size);
}
