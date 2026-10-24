// ---------------------------------------------------------------------------
// src/cs3d/threePatches.test.js
// The node-material lookup repair, which only matters in a build nobody runs
// tests against — so this reproduces that build's shape by hand.
//
// three registers `MeshStandardNodeMaterial` under `MeshStandardMaterial.name`
// and looks it up by `material.type`. In dev those are the same string. In a
// minified bundle the class binding is renamed (`uy`, `ul`, `ly`…) and the
// `type` string is not, so every lookup misses and every plain material draws
// as an empty NodeMaterial. That is the black boxes on the deployed maps.
//
// Run: node src/cs3d/threePatches.test.js
// ---------------------------------------------------------------------------

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const THREE = await import('three/webgpu');
const { patchNodeMaterialTypeLookup, patchFrameSubmits } = await import('./threePatches.js');

/** three's own lookup, so the test asserts on the code path the renderer takes. */
const lookup = (renderer, material) => renderer.nodes.library.getMaterialNodeClass(material.type) || null;

const fakeRenderer = (entries) => ({
  nodes: { library: { materialNodes: new Map(entries), getMaterialNodeClass(t) { return this.materialNodes.get(t) || null; } } }
});

// ---- a minified build: every lookup misses, then none do -------------------
{
  // What `addMaterial(MeshStandardNodeMaterial, MeshStandardMaterial)` writes
  // once esbuild has renamed the material classes.
  const renderer = fakeRenderer([
    ['uy', THREE.MeshStandardNodeMaterial],
    ['pr', THREE.MeshBasicNodeMaterial],
    ['hl', THREE.MeshLambertNodeMaterial],
    ['cy', THREE.LineBasicNodeMaterial]
  ]);

  const basic = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  assert.equal(lookup(renderer, basic), null, 'sanity: the minified table cannot be hit by type');

  const fixed = patchNodeMaterialTypeLookup(renderer, THREE);
  assert.ok(fixed >= 4, `expected the table to be repaired, got ${fixed}`);

  assert.equal(lookup(renderer, basic), THREE.MeshBasicNodeMaterial);
  assert.equal(lookup(renderer, new THREE.MeshStandardMaterial()), THREE.MeshStandardNodeMaterial);
  assert.equal(lookup(renderer, new THREE.MeshLambertMaterial()), THREE.MeshLambertNodeMaterial);
  assert.equal(lookup(renderer, new THREE.LineBasicMaterial()), THREE.LineBasicNodeMaterial);
  assert.equal(lookup(renderer, new THREE.SpriteMaterial()), THREE.SpriteNodeMaterial);

  // The mangled keys are left where they were: this adds, it does not rewrite.
  assert.equal(renderer.nodes.library.materialNodes.get('uy'), THREE.MeshStandardNodeMaterial);
}

// ---- an unminified build is left completely alone --------------------------
// The patch must become a no-op the day three keys the table by `type`, or the
// day a build stops renaming classes. Nothing is overwritten either way.
{
  const marker = class NotOurs {};
  const renderer = fakeRenderer([
    ['MeshStandardMaterial', marker],
    ['MeshBasicMaterial', marker],
    ['MeshLambertMaterial', marker],
    ['MeshPhongMaterial', marker],
    ['MeshPhysicalMaterial', marker],
    ['MeshToonMaterial', marker],
    ['MeshNormalMaterial', marker],
    ['MeshMatcapMaterial', marker],
    ['LineBasicMaterial', marker],
    ['LineDashedMaterial', marker],
    ['PointsMaterial', marker],
    ['SpriteMaterial', marker],
    ['ShadowMaterial', marker]
  ]);
  assert.equal(patchNodeMaterialTypeLookup(renderer, THREE), 0, 'a healthy table must be left alone');
  assert.equal(lookup(renderer, new THREE.MeshStandardMaterial()), marker, 'the existing entry must survive');
}

// ---- it must never throw on a renderer it does not recognise ---------------
// It runs on the boot path, before anything is on screen.
assert.equal(patchNodeMaterialTypeLookup(null, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup({}, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup({ nodes: {} }, THREE), 0);
assert.equal(patchNodeMaterialTypeLookup(fakeRenderer([]), null), 0);

// ---- one submit per frame: every pass still reads what it would have -------
// A model of the WebGPU queue timeline: writeBuffer and every submitted
// command buffer's commands run in the order they reach the queue, and a pass
// reads buffer memory at its place in that order. The frame is the shape three
// produces: each render() writes its uniforms, then submits one pass that
// reads them, and later passes overwrite the same buffer.
{
  const makeDevice = () => {
    const timeline = [];
    const reads = [];
    const device = {
      createBuffer: ({ size, usage }) => ({ size, usage, mem: new Uint8Array(size), destroy() {} }),
      createCommandEncoder: () => {
        const cmds = [];
        return {
          copyBufferToBuffer: (src, so, dst, d0, n) => cmds.push(() => dst.mem.set(src.mem.subarray(so, so + n), d0)),
          finish: () => ({ cmds })
        };
      },
      queue: {
        submits: 0,
        submit(cbs) {
          this.submits++;
          for (const cb of cbs) for (const c of cb.cmds) timeline.push(c);
        },
        writeBuffer(buf, off, data, dataOffset = 0, size) {
          const per = data.BYTES_PER_ELEMENT || 1;
          const n = (size ?? data.length - dataOffset) * per;
          const bytes = new Uint8Array(data.buffer, data.byteOffset + dataOffset * per, n).slice();
          timeline.push(() => buf.mem.set(bytes, off));
        },
        writeTexture() {},
        onSubmittedWorkDone: async () => {}
      }
    };
    const run = () => {
      for (const op of timeline.splice(0)) op();
    };
    /** A pass that reads `buf` as a float when the GPU gets to it. */
    const pass = (tag, buf) => ({ cmds: [() => reads.push([tag, new Float32Array(buf.mem.buffer, 0, 1)[0]])] });
    return { device, run, reads, pass };
  };

  const frame = (gpu, uniform, vertex) => {
    const { device, pass } = gpu;
    for (let i = 1; i <= 5; i++) {
      device.queue.writeBuffer(uniform, 0, new Float32Array([i, 0, 0, 0]));
      if (i === 3) device.queue.writeBuffer(vertex, 16, new Float32Array([7, 7, 7, 7, 9, 9]), 4, 2);
      device.queue.submit([pass(`p${i}`, uniform)]);
    }
  };

  const COPY_DST = 0x0008;
  const plain = makeDevice();
  const pu = plain.device.createBuffer({ size: 64, usage: COPY_DST });
  const pv = plain.device.createBuffer({ size: 64, usage: COPY_DST });
  frame(plain, pu, pv);
  plain.run();

  const batched = makeDevice();
  const fakeRenderer = { backend: { isWebGPUBackend: true, device: batched.device } };
  const frames = patchFrameSubmits(fakeRenderer);
  assert.ok(frames, 'patch applies to a WebGPU backend');
  const bu = batched.device.createBuffer({ size: 64, usage: COPY_DST });
  const bv = batched.device.createBuffer({ size: 64, usage: COPY_DST });
  const before = batched.device.queue.submits;
  frames.run(() => frame(batched, bu, bv));
  batched.run();

  assert.equal(batched.device.queue.submits - before, 1, 'five passes, one submit');
  assert.deepEqual(batched.reads, plain.reads, 'every pass reads the value written for it');
  assert.deepEqual([...batched.reads.map((r) => r[1])], [1, 2, 3, 4, 5]);
  assert.deepEqual(new Float32Array(bv.mem.buffer, 16, 2), new Float32Array(pv.mem.buffer, 16, 2), 'an element-offset write lands the same bytes');
  assert.equal(patchFrameSubmits(fakeRenderer), frames, 'patching twice returns the same instance');

  // Outside a frame nothing is held.
  const n = batched.device.queue.submits;
  batched.device.queue.submit([batched.pass('loose', bu)]);
  assert.equal(batched.device.queue.submits, n + 1);

  // A texture write inside a frame lands after what was recorded before it.
  frames.begin();
  batched.device.queue.submit([batched.pass('a', bu)]);
  batched.device.queue.writeTexture();
  assert.equal(batched.device.queue.submits, n + 2, 'held work is handed over before a texture write');
  frames.end();
  assert.equal(batched.device.queue.submits, n + 2, 'nothing left to submit');

  // Not WebGPU: nothing to patch.
  assert.equal(patchFrameSubmits(null), null);
  assert.equal(patchFrameSubmits({ backend: { isWebGPUBackend: false } }), null);
}

console.log('threePatches.test.js OK');
