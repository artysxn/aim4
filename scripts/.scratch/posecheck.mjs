// Apply a packed clip's first frame to the packed model skeleton by bone name and print world joint positions.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import * as THREE from 'three';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
await MeshoptDecoder.ready;
const model = await io.read('server/data/cs3d/pack/players/' + (process.argv[2] || 'tm_phoenix.glb'));
const anims = await io.read('server/data/cs3d/pack/players/' + (process.argv[3] || 'anims_rifle.glb'));
const clipName = process.argv[4] || 'run_n';
const frameT = Number(process.argv[5] || 0);
const clip = anims.getRoot().listAnimations().find(a => a.getName() === clipName);
if (!clip) throw new Error('no clip ' + clipName + ' in ' + anims.getRoot().listAnimations().map(a=>a.getName()).join(','));
// pose per bone name at time t
const pose = new Map();
for (const ch of clip.listChannels()) {
  const n = ch.getTargetNode().getName(); const p = ch.getTargetPath(); const s = ch.getSampler();
  const inp = s.getInput(), out = s.getOutput(); const t = []; for (let i=0;i<inp.getCount();i++) t.push(inp.getElement(i,[])[0]);
  let i1 = 0; while (i1 < t.length - 1 && t[i1 + 1] < frameT) i1++;
  const val = out.getElement(i1, []);
  if (!pose.has(n)) pose.set(n, {}); pose.get(n)[p] = val;
}
const nodes = model.getRoot().listNodes();
const root = model.getRoot().listScenes()[0].listChildren().find(n => !n.getMesh());
console.log('model root', root.getName(), 'R', root.getRotation().map(v=>+v.toFixed(3)), 'S', root.getScale());
const want = new Set(['root_motion','pelvis','spine_3','head_0','hand_L','hand_R','ankle_L','ankle_R','ball_L','wpn','eyeball_l']);
let matched = 0, unmatched = [];
const modelNames = new Set(nodes.map(n=>n.getName()));
for (const n of pose.keys()) { if (modelNames.has(n)) matched++; else unmatched.push(n); }
console.log('clip bones matched', matched, '/', pose.size, 'unmatched:', unmatched.join(','));
function walk(n, parent, depth) {
  const p = pose.get(n.getName()) || {};
  const t = new THREE.Vector3().fromArray(p.translation || n.getTranslation());
  const q = new THREE.Quaternion().fromArray(p.rotation || n.getRotation());
  const local = new THREE.Matrix4().compose(t, q, new THREE.Vector3(1,1,1));
  const world = parent.clone().multiply(local);
  if (want.has(n.getName())) { const w = new THREE.Vector3().setFromMatrixPosition(world); console.log(n.getName().padEnd(12), [w.x,w.y,w.z].map(v=>+v.toFixed(2)).join(', ')); }
  for (const c of n.listChildren()) walk(c, world, depth+1);
}
// under root_motion, in the model root frame (Source frame)
for (const c of root.listChildren()) walk(c, new THREE.Matrix4(), 0);
