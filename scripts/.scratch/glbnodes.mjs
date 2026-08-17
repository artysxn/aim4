import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const depth = Number(process.argv[3] || 3);
function walk(n, d, pre) {
  if (d > depth) return;
  console.log(pre + n.getName(), 'T', n.getTranslation().map(v=>+v.toFixed(4)), 'R', n.getRotation().map(v=>+v.toFixed(4)), 'S', n.getScale().map(v=>+v.toFixed(4)), n.getMesh() ? '[mesh]' : '', n.getSkin() ? '[skin]' : '');
  for (const c of n.listChildren()) walk(c, d+1, pre + '  ');
}
for (const s of root.listScenes()) for (const n of s.listChildren()) walk(n, 0, '');
const anim = root.listAnimations()[0];
if (anim) {
  const chans = anim.listChannels();
  const paths = {};
  for (const c of chans) { const k = c.getTargetPath(); paths[k] = (paths[k]||0)+1; }
  console.log('anim', anim.getName(), 'channel paths', paths);
  const s0 = chans[0].getSampler();
  console.log('sampler0 interp', s0.getInterpolation(), 'in count', s0.getInput().getCount(), 'first times', Array.from(s0.getInput().getArray().slice(0,5)));
  const rootCh = chans.find(c => c.getTargetNode()?.getName() === 'root_motion' && c.getTargetPath()==='translation');
  if (rootCh) console.log('root_motion translation first/last', Array.from(rootCh.getSampler().getOutput().getArray().slice(0,3)), Array.from(rootCh.getSampler().getOutput().getArray().slice(-3)));
  const pelv = chans.find(c => c.getTargetNode()?.getName() === 'pelvis' && c.getTargetPath()==='translation');
  if (pelv) console.log('pelvis translation first', Array.from(pelv.getSampler().getOutput().getArray().slice(0,3)));
}
