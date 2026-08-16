import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
let i = 0; const cls = new Map();
for (const n of doc.getRoot().listNodes()) { const ex = n.getExtras(); cls.set(n.getName(), (cls.get(n.getName())||0)+1); if (i++ < 4) console.log(n.getName(), JSON.stringify(ex).slice(0, 300), n.getMesh()?.getName()); }
console.log([...cls.entries()]);
