// ---------------------------------------------------------------------------
// src/cs3d/fastBloom.js
// The map's bloom and the effects' bloom, both of them, in one command
// encoder of twelve passes instead of twenty-four three.js renders.
//
// Same arithmetic as three r169's BloomNode, line for line: a luminosity high
// pass into half resolution, five mips of separable gaussian blur with kernel
// radii 3/5/7/9/11 (each mip half the last, each blur sized to its own
// target), and a composite of the five weighted by mix(f, 1.2 - f, radius) at
// factors 1.0/0.8/0.6/0.4/0.2, times strength. Two blooms differ only in
// threshold, strength and radius, so every pass here runs both at once and
// writes two targets; the composite then adds the two results into one
// texture. The final picture samples that with the same bilinear upsample it
// used on each bloom separately, and a bilinear sample of a sum is the sum of
// the samples, so the frame is the same up to half-float rounding.
//
// What it saves is per-pass overhead, not GPU work: each three render() of a
// full-screen quad cost ~40 µs of CPU, and this was 24 of them every frame.
//
// WebGPU only; createFastBloom returns null on the WebGL backend and the
// caller keeps three's bloom nodes.
// ---------------------------------------------------------------------------

const KERNELS = [3, 5, 7, 9, 11];
const FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2];
const MIPS = KERNELS.length;
/** BloomNode's smoothWidth. */
const SMOOTH = 0.01;
/** Linear sRGB / Rec. 709 luminance, three's working-space default. */
const LUMA = [0.2126, 0.7152, 0.0722];
const FORMAT = 'rgba16float';

const f32 = (x) => {
  const s = Math.fround(x).toString();
  return /[.e]/.test(s) ? s : `${s}.0`;
};

const VERTEX = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
`;

/** BloomNode's luminosityHighPass, for two thresholds. */
const HIGH_PASS = /* wgsl */ `
struct P { thrA: f32, thrB: f32, smoothWidth: f32, pad: f32, invSize: vec2f, pad2: vec2f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: P;
struct Out { @location(0) a: vec4f, @location(1) b: vec4f };
@fragment fn fs(@builtin(position) pos: vec4f) -> Out {
  // The scene texture sampled at this half-resolution pixel's centre, as
  // BloomNode's screenUV does: a bilinear average of the 2x2 under it.
  let uv = pos.xy * p.invSize;
  let texel = textureSampleLevel(src, smp, uv, 0.0);
  let v = dot(texel.rgb, vec3f(${LUMA.map(f32).join(', ')}));
  var o: Out;
  o.a = mix(vec4f(0.0), texel, smoothstep(p.thrA, p.thrA + p.smoothWidth, v));
  o.b = mix(vec4f(0.0), texel, smoothstep(p.thrB, p.thrB + p.smoothWidth, v));
  return o;
}
`;

/** BloomNode's separable blur at one kernel radius, for both chains. */
function blurShader(radius) {
  const coefficients = [];
  for (let i = 0; i < radius; i++) coefficients.push(0.39894 * Math.exp((-0.5 * i * i) / (radius * radius)) / radius);
  return /* wgsl */ `
struct P { invSize: vec2f, direction: vec2f };
@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var<uniform> p: P;
const W = array<f32, ${radius}>(${coefficients.map(f32).join(', ')});
struct Out { @location(0) a: vec4f, @location(1) b: vec4f };
@fragment fn fs(@builtin(position) pos: vec4f) -> Out {
  let uv = pos.xy * p.invSize;
  var weightSum = W[0];
  var sumA = textureSampleLevel(srcA, smp, uv, 0.0).rgb * weightSum;
  var sumB = textureSampleLevel(srcB, smp, uv, 0.0).rgb * weightSum;
  for (var i = 1; i < ${radius}; i++) {
    let w = W[i];
    let off = p.direction * p.invSize * f32(i);
    sumA += (textureSampleLevel(srcA, smp, uv + off, 0.0).rgb + textureSampleLevel(srcA, smp, uv - off, 0.0).rgb) * w;
    sumB += (textureSampleLevel(srcB, smp, uv + off, 0.0).rgb + textureSampleLevel(srcB, smp, uv - off, 0.0).rgb) * w;
    weightSum += 2.0 * w;
  }
  var o: Out;
  o.a = vec4f(sumA / weightSum, 1.0);
  o.b = vec4f(sumB / weightSum, 1.0);
  return o;
}
`;
}

/** BloomNode's composite for each chain, added together. */
const COMPOSITE = /* wgsl */ `
struct P { a: array<vec4f, 2>, b: array<vec4f, 2>, invSize: vec2f, pad: vec2f };
${Array.from({ length: MIPS }, (_, i) => `@group(0) @binding(${i}) var a${i}: texture_2d<f32>;\n@group(0) @binding(${MIPS + i}) var b${i}: texture_2d<f32>;`).join('\n')}
@group(0) @binding(${2 * MIPS}) var smp: sampler;
@group(0) @binding(${2 * MIPS + 1}) var<uniform> p: P;
fn wa(i: u32) -> f32 { return p.a[i / 4u][i % 4u]; }
fn wb(i: u32) -> f32 { return p.b[i / 4u][i % 4u]; }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy * p.invSize;
  var o = vec4f(0.0);
${Array.from({ length: MIPS }, (_, i) => `  o += wa(${i}u) * textureSampleLevel(a${i}, smp, uv, 0.0) + wb(${i}u) * textureSampleLevel(b${i}, smp, uv, 0.0);`).join('\n')}
  return o;
}
`;

/**
 * @param {THREE.WebGPURenderer} renderer  initialised, WebGPU backend
 * @param {object} THREE  three/webgpu
 * @param {{ a: {strength:number, radius:number, threshold:number}, b: {strength:number, radius:number, threshold:number} }} blooms
 *   the two blooms; a strength of 0 contributes nothing
 * @returns {{ texture: THREE.Texture, run(source: THREE.Texture): void, setStrengths(a: number, b: number): void, dispose(): void } | null}
 */
export function createFastBloom(renderer, THREE, blooms) {
  const backend = renderer?.backend;
  const device = backend?.device;
  if (!backend?.isWebGPUBackend || !device) return null;

  const out = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  out.texture.name = 'cs3d.bloom';
  out.texture.generateMipmaps = false;

  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const target2 = { targets: [{ format: FORMAT }, { format: FORMAT }] };
  const module = (code) => device.createShaderModule({ code: VERTEX + code });
  const pipeline = (code, targets) =>
    device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: module(code), entryPoint: 'vs' },
      fragment: { module: module(code), entryPoint: 'fs', ...targets },
      primitive: { topology: 'triangle-list' }
    });

  const highPass = pipeline(HIGH_PASS, target2);
  const blurPipes = KERNELS.map((r) => pipeline(blurShader(r), target2));
  const composite = pipeline(COMPOSITE, { targets: [{ format: FORMAT }] });

  const UNIFORM = globalThis.GPUBufferUsage?.UNIFORM ?? 0x40;
  const COPY_DST = globalThis.GPUBufferUsage?.COPY_DST ?? 0x08;
  const uniform = (bytes) => device.createBuffer({ size: bytes, usage: UNIFORM | COPY_DST });
  const highParams = uniform(32);
  const blurParams = Array.from({ length: MIPS * 2 }, () => uniform(16));
  const compParams = uniform(80);

  const strengths = { a: blooms.a.strength || 0, b: blooms.b.strength || 0 };
  function writeWeights() {
    const w = new Float32Array(20);
    for (let i = 0; i < MIPS; i++) {
      const f = FACTORS[i];
      w[i] = strengths.a * (f + (1.2 - f - f) * blooms.a.radius);
      w[8 + i] = strengths.b * (f + (1.2 - f - f) * blooms.b.radius);
    }
    return w;
  }

  /** Per-mip targets, rebuilt with the bind groups when the size changes. */
  let size = { w: 0, h: 0 };
  let sourceGPU = null;
  let outGPU = null;
  let outView = null;
  let mips = [];
  let groups = null;
  const textures = [];

  function makeTarget(w, h) {
    const t = device.createTexture({
      size: [w, h],
      format: FORMAT,
      usage: (globalThis.GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10) | (globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 0x04)
    });
    textures.push(t);
    return t;
  }

  function resize(w, h) {
    for (const t of textures) t.destroy();
    textures.length = 0;
    size = { w, h };
    // BloomNode.setSize: half the drawing buffer, then half again per mip.
    let rx = Math.round(w / 2);
    let ry = Math.round(h / 2);
    const brightA = makeTarget(rx, ry);
    const brightB = makeTarget(rx, ry);
    mips = [];
    for (let i = 0; i < MIPS; i++) {
      mips.push({ w: rx, h: ry, hA: makeTarget(rx, ry), hB: makeTarget(rx, ry), vA: makeTarget(rx, ry), vB: makeTarget(rx, ry) });
      device.queue.writeBuffer(blurParams[2 * i], 0, new Float32Array([1 / rx, 1 / ry, 1, 0]));
      device.queue.writeBuffer(blurParams[2 * i + 1], 0, new Float32Array([1 / rx, 1 / ry, 0, 1]));
      rx = Math.round(rx / 2);
      ry = Math.round(ry / 2);
    }
    mips.brightA = brightA;
    mips.brightB = brightB;
    for (const t of [brightA, brightB]) t.view = t.createView();
    for (const m of mips) for (const k of ['hA', 'hB', 'vA', 'vB']) m[k].view = m[k].createView();
    device.queue.writeBuffer(highParams, 0, new Float32Array([blooms.a.threshold, blooms.b.threshold, SMOOTH, 0, 1 / mips[0].w, 1 / mips[0].h, 0, 0]));
    const w20 = writeWeights();
    w20[16] = 1 / mips[0].w;
    w20[17] = 1 / mips[0].h;
    device.queue.writeBuffer(compParams, 0, w20);
    out.setSize(mips[0].w, mips[0].h);
    groups = null;
  }

  function bind(pipe, entries) {
    return device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries.map((resource, binding) => ({ binding, resource })) });
  }

  function buildGroups() {
    const v = (t) => t.view;
    outView = outGPU.createView();
    const g = { high: bind(highPass, [sourceGPU.createView(), sampler, { buffer: highParams }]), blur: [] };
    let inA = mips.brightA;
    let inB = mips.brightB;
    for (let i = 0; i < MIPS; i++) {
      const m = mips[i];
      g.blur.push(bind(blurPipes[i], [v(inA), v(inB), sampler, { buffer: blurParams[2 * i] }]));
      g.blur.push(bind(blurPipes[i], [v(m.hA), v(m.hB), sampler, { buffer: blurParams[2 * i + 1] }]));
      inA = m.vA;
      inB = m.vB;
    }
    g.comp = bind(composite, [...mips.map((m) => v(m.vA)), ...mips.map((m) => v(m.vB)), sampler, { buffer: compParams }]);
    groups = g;
  }

  const pass = (enc, pipe, group, views) => {
    const p = enc.beginRenderPass({ colorAttachments: views.map((view) => ({ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] })) });
    p.setPipeline(pipe);
    p.setBindGroup(0, group);
    p.draw(3);
    p.end();
  };

  return {
    texture: out.texture,
    /** Bloom `source` (the scene's HDR texture, already drawn this frame) into `texture`. */
    run(source) {
      const src = backend.get(source)?.texture;
      if (!src) return;
      if (src.width !== size.w || src.height !== size.h) resize(src.width, src.height);
      // The output is a three render target so the composite can sample it;
      // three makes (and remakes, after a resize) its GPU texture.
      let dst = backend.get(out.texture)?.texture;
      if (!dst || dst.width !== mips[0].w || dst.height !== mips[0].h) {
        renderer._textures.updateRenderTarget(out);
        dst = backend.get(out.texture)?.texture;
        if (!dst) return;
      }
      if (src !== sourceGPU || dst !== outGPU || groups === null) {
        sourceGPU = src;
        outGPU = dst;
        buildGroups();
      }
      const enc = device.createCommandEncoder({ label: 'cs3d bloom' });
      pass(enc, highPass, groups.high, [mips.brightA.view, mips.brightB.view]);
      for (let i = 0; i < MIPS; i++) {
        const m = mips[i];
        pass(enc, blurPipes[i], groups.blur[2 * i], [m.hA.view, m.hB.view]);
        pass(enc, blurPipes[i], groups.blur[2 * i + 1], [m.vA.view, m.vB.view]);
      }
      pass(enc, composite, groups.comp, [outView]);
      device.queue.submit([enc.finish()]);
    },
    setStrengths(a, b) {
      strengths.a = a;
      strengths.b = b;
      if (mips.length) {
        const w20 = writeWeights();
        w20[16] = 1 / mips[0].w;
        w20[17] = 1 / mips[0].h;
        device.queue.writeBuffer(compParams, 0, w20);
      }
    },
    dispose() {
      for (const t of textures) t.destroy();
      textures.length = 0;
      out.dispose();
    }
  };
}
