import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [slug, file] = [process.argv[2], process.argv[3]];
const txt = fs.readFileSync(`server/data/cs3d/raw/maps/${slug}/ents/maps/${file}/entities/default_ents.vents`, 'utf8');
const ents = [];
for (const block of txt.split(/^====\d+====\s*$/m)) { const e = {}; for (const raw of block.split('\n')) { const m = raw.replace(/\r$/, '').match(/^(\S+)\s+(.*)$/); if (!m) continue; let v = m[2].trim(); if (/^resource_name:/.test(v)) v = v.replace(/^resource_name:/, ''); if (/^".*"$/.test(v)) v = v.slice(1, -1); if (/^\[.*\]$/.test(v)) v = v.slice(1,-1).split(',').map(Number); else if (v === 'true' || v === 'false') v = v === 'true'; e[m[1]] = v; } if (e.classname) ents.push(e); }
const dis = ents.filter(e => e.startdisabled === true && e.model);
console.log('startdisabled with model:', dis.length, dis.slice(0, 5).map(e => `${e.classname} ${e.origin} ${String(e.model).split('/').pop()}`));
const doc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${file}/world_physics.glb`);
const K = 0.0254;
let matched = 0;
for (const e of dis) {
  const [ox, oy, oz] = e.origin; const want = [oy * K, oz * K, ox * K];
  let best = null;
  for (const n of doc.getRoot().listNodes()) { if (!n.getMesh()) continue; const t = n.getTranslation(); const d = Math.hypot(t[0]-want[0], t[1]-want[1], t[2]-want[2]); if (!best || d < best.d) best = { d, name: n.getName(), t }; }
  if (best && best.d < 0.05) matched++;
  else console.log('no match', e.classname, e.origin, best && [best.name, best.d.toFixed(3), best.t.map(v=>v.toFixed(2))]);
}
console.log('matched', matched, '/', dis.length);
// also world.glb render nodes: do the disabled meshes' nodes have translation == origin?
const wdoc = await io.read(`server/data/cs3d/raw/maps/${slug}/world/maps/${file}/world.glb`);
let wm = 0, wt = 0;
for (const n of wdoc.getRoot().listNodes()) { const m = n.getMesh(); if (!m) continue; const ex = m.getExtras(); if (!(ex.startdisabled === '1' || ex.startdisabled === 1 || ex.startdisabled === true)) continue; wt++; const t = n.getTranslation(); const hit = dis.find(e => Math.hypot(e.origin[1]*K - t[0], e.origin[2]*K - t[1], e.origin[0]*K - t[2]) < 0.05); if (hit) wm++; else console.log('render node no ent match', n.getName(), t.map(v=>v.toFixed(2))); }
console.log('render disabled meshes', wt, 'matched to ents', wm);
