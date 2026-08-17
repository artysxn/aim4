import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const want = new Set((process.argv[3]||'root_motion,pelvis,spine_3,head_0,wpn,wpnTip,wpnPivot,ankle_L,ball_L,ankle_R,hand_R,hand_L,attachWorld,wpnAimIntent,eye_target').split(','));
function walk(n, parent) {
  const m = new THREE.Matrix4().fromArray(n.getMatrix());
  const world = parent.clone().multiply(m);
  if (want.has(n.getName())) {
    const t = new THREE.Vector3().setFromMatrixPosition(world);
    console.log(n.getName().padEnd(14), 'T', [t.x,t.y,t.z].map(v=>+v.toFixed(3)));
  }
  for (const c of n.listChildren()) walk(c, world);
}
for (const s of root.listScenes()) for (const n of s.listChildren()) { if (n.getMesh()) continue; for (const c of n.listChildren()) walk(c, new THREE.Matrix4()); }
for (const m of root.listMeshes()) {
  const p = m.listPrimitives()[0].getAttribute('POSITION');
  console.log('mesh', m.getName().split('.').pop(), 'min', p.getMin([]).map(v=>+v.toFixed(2)), 'max', p.getMax([]).map(v=>+v.toFixed(2)));
}
