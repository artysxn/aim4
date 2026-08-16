import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const maps = ['dust2','mirage','inferno','nuke','ancient','anubis','cache','overpass','train','vertigo'];
const files = { dust2:'de_dust2', mirage:'de_mirage', inferno:'de_inferno', nuke:'de_nuke', ancient:'de_ancient', anubis:'de_anubis', cache:'de_cache', overpass:'de_overpass', train:'de_train', vertigo:'de_vertigo' };
for (const m of maps) {
  const f = `server/data/cs3d/raw/maps/${m}/world/maps/${files[m]}/world.glb`;
  if (!fs.existsSync(f)) { console.log(m, 'missing'); continue; }
  const doc = await io.read(f);
  const root = doc.getRoot();
  const layers = new Map();
  for (const n of root.listNodes()) {
    const mm = n.getName().match(/^n(\d+)_lr(\d+)/);
    if (mm) layers.set(`n${mm[1]}_lr${mm[2]}`, (layers.get(`n${mm[1]}_lr${mm[2]}`) || 0) + 1);
  }
  let disabled = 0, entMeshes = 0; const dnames = [];
  const classes = new Map();
  for (const mesh of root.listMeshes()) {
    const ex = mesh.getExtras();
    if (!Object.keys(ex).length) continue;
    entMeshes++;
    if (ex.startdisabled === '1' || ex.startdisabled === 1 || ex.startdisabled === true || ex.startdisabled === 'true') { disabled++; if (dnames.length < 6) dnames.push(mesh.getName()); }
    const c = ex.classname || '?';
    classes.set(c, (classes.get(c) || 0) + 1);
  }
  console.log(m, 'layers', [...layers.entries()], 'entMeshes', entMeshes, 'startdisabled', disabled, dnames, 'classes', [...classes.entries()].slice(0,8));
}
