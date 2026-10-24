// ---------------------------------------------------------------------------
// src/cs3d/threePatches.js
// Corrections to three.js internals that the explorer depends on. Each one is
// pinned to a version and checked against the shipped code before it applies,
// so a three upgrade that fixes the bug upstream turns the patch into a no-op
// rather than silently overwriting a good implementation.
// ---------------------------------------------------------------------------

/**
 * three r169 `WebGPUAttributeUtils.updateAttribute()` cannot do a partial
 * attribute upload:
 *
 *   device.queue.writeBuffer(
 *     buffer,
 *     0,                                      // always the start of the buffer
 *     array,
 *     range.start * array.BYTES_PER_ELEMENT,  // dataOffset
 *     range.count * array.BYTES_PER_ELEMENT   // size
 *   );
 *
 * Two bugs. `bufferOffset` is 0, so a partial update lands at the start of the
 * destination instead of at the range. And when `data` is a TypedArray, the
 * WebGPU spec measures `dataOffset` and `size` in **elements**, not bytes:
 * multiplying by BYTES_PER_ELEMENT asks for 4× the data on a Float32Array, so
 * the browser throws
 *
 *   OperationError: Failed to execute 'writeBuffer' on 'GPUQueue':
 *   Number of bytes to write is too large
 *
 * The WebGL2 backend in the same build gets it right
 * (`gl.bufferSubData(type, range.start * BYTES_PER_ELEMENT, array, range.start,
 * range.count)`) — byte offset into the buffer, element offset/count into the
 * array — and this is that, for WebGPU.
 *
 * It matters here because the map loader streams tiles into a BatchedMesh per
 * material: every `addGeometry()` after a batch's buffers exist records an
 * update range, and on a big map that is hundreds of throws per load and a
 * batch whose vertex data never arrives on the GPU.
 *
 * Fixed upstream after r169; the guard below removes this patch as soon as the
 * shipped implementation no longer writes at a hard-coded offset 0.
 *
 * @param {THREE.WebGPURenderer} renderer  already `init()`ed
 * @returns {boolean} whether the patch was applied
 */
export function patchWebGPUPartialAttributeUpload(renderer) {
  const backend = renderer?.backend;
  if (!backend?.isWebGPUBackend) return false;
  const utils = backend.attributeUtils;
  if (!utils || typeof utils.updateAttribute !== 'function') return false;
  // Only patch the known-broken implementation.
  const src = String(utils.updateAttribute);
  if (!/BYTES_PER_ELEMENT/.test(src) || !/updateRanges/.test(src)) return false;

  utils.updateAttribute = function (attribute) {
    const bufferAttribute = this._getBufferAttribute(attribute);
    const device = this.backend.device;
    const buffer = this.backend.get(bufferAttribute).buffer;
    const array = bufferAttribute.array;
    const bytesPerElement = array.BYTES_PER_ELEMENT;
    const ranges = bufferAttribute.updateRanges;

    if (ranges.length === 0) {
      device.queue.writeBuffer(buffer, 0, array, 0);
      return;
    }
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const byteOffset = range.start * bytesPerElement;
      const byteSize = range.count * bytesPerElement;
      // writeBuffer wants both 4-byte aligned. Every attribute the pack ships
      // is (itemSize × bytesPerElement is a multiple of 4), but an attribute
      // that is not — a 3-wide Uint8, say — is uploaded whole rather than
      // dropped.
      if (byteOffset % 4 !== 0 || byteSize % 4 !== 0) {
        device.queue.writeBuffer(buffer, 0, array, 0);
        break;
      }
      device.queue.writeBuffer(buffer, byteOffset, array, range.start, range.count);
    }
    bufferAttribute.clearUpdateRanges();
  };
  return true;
}

/**
 * three's WebGPU node library is registered by CONSTRUCTOR NAME and looked up
 * by `material.type`, so a minified bundle can never match the two.
 *
 * `NodeLibrary.addMaterial(nodeClass, materialClass)` stores under
 * `materialClass.name` (StandardNodeLibrary.js), while `fromMaterial(material)`
 * reads `getMaterialNodeClass(material.type)` (NodeLibrary.js). `type` is a
 * hard-coded string that survives minification; `name` is the class binding,
 * which esbuild renames. In `npm run dev` the two agree and everything works.
 * In `npm run build` the table comes out keyed `uy`, `ul`, `ly`… and every
 * lookup misses:
 *
 *   NodeMaterial: Material "MeshStandardMaterial" is not compatible.
 *
 * That message is a `console.error` and the consequence is not cosmetic. The
 * fallback is a bare `new NodeMaterial()`, which carries NONE of the material
 * it replaced: no colour, no map, no opacity, no side. Anything drawn with a
 * plain (non-node) material renders as an untextured default — which is what
 * the black boxes on the deployed maps were. Every one of them was a surface
 * still on `MaterialLibrary`'s interim flat-colour stand-in, because a stand-in
 * whose colour is thrown away is not a stand-in, it is a hole.
 *
 * It hits everything that is not explicitly a node material: the interim
 * material pass, the grey `phys-placeholder`, the flat view's Lambert set,
 * the demo bodies, and every grenade trail (`LineBasicMaterial`).
 *
 * The fix is to register the same node classes a second time under the type
 * strings the lookup actually uses. Nothing is overwritten — `addType` refuses
 * a redefinition — so on a build where the names DO survive (dev, or a three
 * release that switches to `type`) this adds nothing and reports 0.
 *
 * @param {THREE.WebGPURenderer} renderer   constructed; need not be init()ed
 * @param {object} THREE                    the `three/webgpu` namespace
 * @returns {number} how many types had to be repaired
 */
export function patchNodeMaterialTypeLookup(renderer, THREE) {
  const library = renderer?.nodes?.library;
  const table = library?.materialNodes;
  if (!table?.set || !THREE) return 0;

  // Every pair StandardNodeLibrary registers, by the `type` string the plain
  // material reports. Kept as literals rather than read off `new Klass().type`
  // so the patch costs nothing and cannot itself be defeated by minification.
  const PAIRS = [
    ['MeshStandardMaterial', THREE.MeshStandardNodeMaterial],
    ['MeshPhysicalMaterial', THREE.MeshPhysicalNodeMaterial],
    ['MeshBasicMaterial', THREE.MeshBasicNodeMaterial],
    ['MeshLambertMaterial', THREE.MeshLambertNodeMaterial],
    ['MeshPhongMaterial', THREE.MeshPhongNodeMaterial],
    ['MeshToonMaterial', THREE.MeshToonNodeMaterial],
    ['MeshNormalMaterial', THREE.MeshNormalNodeMaterial],
    ['MeshMatcapMaterial', THREE.MeshMatcapNodeMaterial],
    ['LineBasicMaterial', THREE.LineBasicNodeMaterial],
    ['LineDashedMaterial', THREE.LineDashedNodeMaterial],
    ['PointsMaterial', THREE.PointsNodeMaterial],
    ['SpriteMaterial', THREE.SpriteNodeMaterial],
    ['ShadowMaterial', THREE.ShadowNodeMaterial]
  ];

  let fixed = 0;
  for (const [type, nodeClass] of PAIRS) {
    if (typeof nodeClass !== 'function' || table.has(type)) continue;
    table.set(type, nodeClass);
    fixed++;
  }
  return fixed;
}

/**
 * Let BatchedMeshes share their compiled shaders.
 *
 * three builds a shader once per (material structure, object kind) and shares
 * it between every object that comes out the same — except BatchedMesh, whose
 * cache key carries the batch's own `_matricesTexture.uuid`, because r169's
 * BatchNode binds that batch's matrix, indirect and colour textures straight
 * into the shader. So the map, one BatchedMesh per material, built every
 * shader from scratch: measured on Nuke, 377 world builds that came out as 40
 * distinct programs, and 288 shadow-pass builds that came out as ONE. That was
 * ~6.5 s of the 10.5 s it took to open the map, all of it NodeBuilder on the
 * main thread.
 *
 * Two changes make the sharing safe:
 *
 *   1. BatchNode reads the batch textures through nodes that take their value
 *      from the object being drawn (NodeUpdateType.OBJECT), the same way
 *      `materialReference` reads a material's maps. A shader built for one
 *      batch then binds each batch's own textures at its own draw.
 *   2. The cache key drops the batch's texture uuids — keeping only whether it
 *      has per-instance colours, which changes the shader — so batches whose
 *      materials agree get the same build.
 *
 * The materials have to agree for real for (2) to do anything: three keys a
 * node material by its node ids, so materials.js gives `Cs3dMaterial` a
 * structural key and reads its own textures through slots (SlotTextureNode)
 * for the same reason as (1).
 *
 * WebGPU only, and only on r169's BatchNode (checked against its source).
 *
 * @param {THREE.WebGPURenderer} renderer  already `init()`ed
 * @param {object} THREE                   the `three/webgpu` namespace
 * @returns {boolean} whether the patch was applied
 */
export function patchSharedBatchShaders(renderer, THREE) {
  if (!renderer?.backend?.isWebGPUBackend || !THREE) return false;
  const nodes = renderer._nodes;
  const BatchNode = THREE.BatchNode;
  if (!nodes || typeof nodes.getForRenderCacheKey !== 'function' || !BatchNode?.prototype?.setup) return false;
  if (nodes._cs3dSharedBatches) return true;
  const setupSrc = String(BatchNode.prototype.setup);
  if (!BatchNode.prototype._cs3dShared) {
    // Only the implementation this replaces: it reads the three textures off
    // `this.batchMesh` and nothing else about the batch.
    if (!/_matricesTexture/.test(setupSrc) || !/_indirectTexture/.test(setupSrc) || !/_colorsTexture/.test(setupSrc)) {
      return false;
    }
    BatchNode.prototype.setup = makeSharedBatchSetup(THREE);
    BatchNode.prototype._cs3dShared = true;
  }

  // Stand-ins with fixed uuids: RenderObject.getMaterialCacheKey reads only
  // `.uuid` off the batch's textures, so swapping these in for the duration of
  // the call yields the key with the per-batch part taken out, and everything
  // else (material, geometry layout, shadows, lights) exactly as three has it.
  const MATRICES = { uuid: 'cs3d-batch-matrices' };
  const COLORS = { uuid: 'cs3d-batch-colors' };
  const original = nodes.getForRenderCacheKey;
  nodes.getForRenderCacheKey = function (renderObject) {
    // Cached on the render object, so `delete()` finds the entry that
    // `getForRender()` made even if the material changed in between.
    if (renderObject._cs3dSharedKey !== undefined) return renderObject._cs3dSharedKey;
    const o = renderObject.object;
    let key;
    if (o?.isBatchedMesh === true && o._matricesTexture) {
      const mt = o._matricesTexture;
      const ct = o._colorsTexture;
      o._matricesTexture = MATRICES;
      o._colorsTexture = ct ? COLORS : null;
      try {
        key = `batch:${renderObject.getMaterialCacheKey()}:${renderObject.getDynamicCacheKey()}`;
      } finally {
        o._matricesTexture = mt;
        o._colorsTexture = ct;
      }
    } else {
      key = original.call(this, renderObject);
    }
    renderObject._cs3dSharedKey = key;
    return key;
  };
  nodes._cs3dSharedBatches = true;
  return true;
}

/**
 * r169's BatchNode.setup, line for line, with every read of the batch's
 * textures going through a node that follows the object being drawn.
 */
function makeSharedBatchSetup(THREE) {
  const {
    Fn,
    int,
    ivec2,
    float,
    vec3,
    mat3,
    mat4,
    textureSize,
    instanceIndex,
    drawIndex,
    varyingProperty,
    positionLocal,
    normalLocal,
    tangentLocal,
    nodeObject,
    TextureNode,
    NodeUpdateType
  } = THREE;

  /** `textureLoad(batch[prop], uv)`, with the texture taken from the drawn object. */
  class BatchTextureNode extends TextureNode {
    static get type() {
      return 'Cs3dBatchTextureNode';
    }

    constructor(prop = '', batch = null, uvNode = null) {
      super(batch ? batch[prop] : null, uvNode);
      this.prop = prop;
      this.sampler = false;
      this.updateMatrix = false;
      this.updateType = NodeUpdateType.OBJECT;
    }

    getUniformHash() {
      return `cs3d-batch:${this.prop}`;
    }

    update(frame) {
      const t = frame.object?.[this.prop];
      if (t && t.isTexture) this.value = t;
    }
  }

  const load = (batch, prop, uvNode = null) => nodeObject(new BatchTextureNode(prop, batch, uvNode));

  return function setup(builder) {
    if (this.batchingIdNode === null) {
      this.batchingIdNode = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
    }
    const mesh = this.batchMesh;

    const getIndirectIndex = Fn(([id]) => {
      const size = textureSize(load(mesh, '_indirectTexture'), 0);
      const x = int(id).modInt(int(size));
      const y = int(id).div(int(size));
      return load(mesh, '_indirectTexture', ivec2(x, y)).x;
    }).setLayout({
      name: 'getIndirectIndex',
      type: 'uint',
      inputs: [{ name: 'id', type: 'int' }]
    });

    const indirectId = getIndirectIndex(int(this.batchingIdNode));

    const size = textureSize(load(mesh, '_matricesTexture'), 0);
    const j = float(indirectId).mul(4).toInt().toVar();
    const x = j.modInt(size);
    const y = j.div(int(size));
    const batchingMatrix = mat4(
      load(mesh, '_matricesTexture', ivec2(x, y)),
      load(mesh, '_matricesTexture', ivec2(x.add(1), y)),
      load(mesh, '_matricesTexture', ivec2(x.add(2), y)),
      load(mesh, '_matricesTexture', ivec2(x.add(3), y))
    );

    if (mesh._colorsTexture !== null) {
      const getBatchingColor = Fn(([id]) => {
        const csize = textureSize(load(mesh, '_colorsTexture'), 0).x;
        const cj = id;
        const cx = cj.modInt(csize);
        const cy = cj.div(csize);
        return load(mesh, '_colorsTexture', ivec2(cx, cy)).rgb;
      }).setLayout({
        name: 'getBatchingColor',
        type: 'vec3',
        inputs: [{ name: 'id', type: 'int' }]
      });
      const color = getBatchingColor(indirectId);
      varyingProperty('vec3', 'vBatchColor').assign(color);
    }

    const bm = mat3(batchingMatrix);
    positionLocal.assign(batchingMatrix.mul(positionLocal));
    const transformedNormal = normalLocal.div(vec3(bm[0].dot(bm[0]), bm[1].dot(bm[1]), bm[2].dot(bm[2])));
    const batchingNormal = bm.mul(transformedNormal).xyz;
    normalLocal.assign(batchingNormal);
    if (builder.hasGeometryAttribute('tangent')) {
      tangentLocal.mulAssign(bm);
    }
  };
}

/**
 * One GPU submit per frame instead of one per pass.
 *
 * three r169 ends every `renderer.render()` and every `renderer.clear()` with
 * its own `device.queue.submit()`. A frame of the explorer is ~50 of them: the
 * sky and world passes, the viewmodel, and two bloom chains of a dozen quads
 * each with a clear in front of every quad. In Chrome every submit costs about
 * 130 µs whatever it carries, so the frame was bound by submit count with the
 * GPU nearly idle: Dust 2 at 1080p on an RTX 4090 sat at ~100 fps on 53
 * submits, ~280 fps on one, same pixels.
 *
 * Between `begin()` and `end()` the command buffers are held and handed over in
 * one `submit()` at the end. Holding them is only safe because of what happens
 * to the writes in between. three uploads uniforms with `queue.writeBuffer()`
 * while it records, and a queue write runs before every command buffer
 * submitted after it — so a write made for pass 7 would overtake passes 1-6
 * still waiting, and any of them that read the old bytes would see the new
 * ones. A write that arrives while buffers are waiting is staged instead: its
 * bytes go into a staging buffer that nothing waiting reads, and a
 * `copyBufferToBuffer` into the real buffer is recorded in its place in the
 * sequence. The GPU sees the same order of reads and writes as one submit per
 * pass.
 *
 * Everything that could make a held buffer invalid or out of order flushes
 * what is held first: texture writes, a write too big to stage (a tile
 * streaming in), a readback (`mapAsync`), a work-done wait, and destroying any
 * GPU buffer or texture (a resize disposing a target a held pass drew into).
 * Those are rare inside a frame, so a frame is one submit or close to it.
 *
 * Not version-specific in the way the other patches are: it only changes when
 * work reaches the queue, never what the work is, so a three that already
 * submits once per frame simply makes `end()` a pass-through.
 *
 * @param {THREE.WebGPURenderer} renderer  already `init()`ed
 * @returns {{ begin(): void, end(): void, run(fn: () => any): any, stats: object } | null}  null off WebGPU
 */
export function patchFrameSubmits(renderer) {
  const backend = renderer?.backend;
  const device = backend?.device;
  const queue = device?.queue;
  if (!backend?.isWebGPUBackend || !queue || typeof queue.submit !== 'function') return null;
  if (backend._cs3dFrameSubmits) return backend._cs3dFrameSubmits;

  const submit = queue.submit.bind(queue);
  const writeBuffer = queue.writeBuffer.bind(queue);
  const writeTexture = queue.writeTexture.bind(queue);
  const copyExternal = queue.copyExternalImageToTexture?.bind(queue);
  const workDone = queue.onSubmittedWorkDone?.bind(queue);
  const COPY_SRC = globalThis.GPUBufferUsage?.COPY_SRC ?? 0x0004;
  const COPY_DST = globalThis.GPUBufferUsage?.COPY_DST ?? 0x0008;
  /** A staged write bigger than this flushes instead; the staging buffer never grows past twice it. */
  const STAGE_LIMIT = 4 << 20;

  let open = 0;
  let held = [];
  /** Staged writes recorded since the last held command buffer. */
  let copies = null;
  let staging = null;
  let stagingSize = 0;
  let stagingUsed = 0;
  let stagingWant = 64 * 1024;
  const stats = { frames: 0, submits: 0, staged: 0, flushes: 0 };

  const closeCopies = () => {
    if (copies) {
      held.push(copies.finish());
      copies = null;
    }
  };
  const flush = () => {
    closeCopies();
    if (held.length) {
      const list = held;
      held = [];
      stats.submits++;
      submit(list);
    }
    // Whatever the copies read from staging was submitted above, and a later
    // queue write cannot overtake a submit, so the space is free again.
    stagingUsed = 0;
  };
  const waiting = () => open > 0 && (held.length > 0 || copies !== null);
  const flushIfWaiting = () => {
    if (!waiting()) return;
    stats.flushes++;
    flush();
  };

  /** Byte length of a writeBuffer call, in the spec's units (elements for a typed array). */
  const writeBytes = (data, dataOffset = 0, size) => {
    const per = data.BYTES_PER_ELEMENT || 1;
    const count = size ?? (data.byteLength ?? data.length) / per - dataOffset;
    return count * per;
  };

  const stage = (buffer, offset, data, dataOffset, size) => {
    const bytes = writeBytes(data, dataOffset, size);
    const aligned = (bytes + 15) & ~15;
    if (bytes % 4 !== 0 || offset % 4 !== 0 || aligned > STAGE_LIMIT || !(buffer.usage & COPY_DST)) return false;
    if (stagingUsed + aligned > stagingSize) {
      stagingWant = Math.min(STAGE_LIMIT * 2, Math.max(stagingWant, (stagingUsed + aligned) * 2));
      // Only replaced while no recorded copy reads it; otherwise hand over
      // what is held, which frees the space, and write directly this once.
      if (stagingUsed > 0 || stagingWant <= stagingSize) return false;
      staging?.destroy();
      stagingSize = stagingWant;
      staging = device.createBuffer({ label: 'cs3d staged writes', size: stagingSize, usage: COPY_SRC | COPY_DST });
    }
    writeBuffer(staging, stagingUsed, data, dataOffset, size);
    if (!copies) copies = device.createCommandEncoder({ label: 'cs3d staged writes' });
    copies.copyBufferToBuffer(staging, stagingUsed, buffer, offset, bytes);
    stagingUsed += aligned;
    stats.staged++;
    return true;
  };

  queue.submit = (buffers) => {
    if (open === 0) return submit(buffers);
    closeCopies();
    for (const b of buffers) held.push(b);
  };
  queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
    if (waiting()) {
      if (stage(buffer, offset, data, dataOffset, size)) return;
      stats.flushes++;
      flush();
    }
    return writeBuffer(buffer, offset, data, dataOffset, size);
  };
  queue.writeTexture = (...args) => {
    flushIfWaiting();
    return writeTexture(...args);
  };
  if (copyExternal) {
    queue.copyExternalImageToTexture = (...args) => {
      flushIfWaiting();
      return copyExternal(...args);
    };
  }
  if (workDone) {
    queue.onSubmittedWorkDone = () => {
      flushIfWaiting();
      return workDone();
    };
  }
  guardResourceLifetimes();
  _frameSubmitFlushers.add(flushIfWaiting);

  const api = {
    stats,
    /** Hold submits until the matching end(). Nests. */
    begin() {
      open++;
    },
    /** Submit everything held since the outermost begin(). */
    end() {
      if (open === 0) return;
      open--;
      if (open > 0) return;
      stats.frames++;
      flush();
    },
    /** begin(), run `fn`, end() — even when `fn` throws. */
    run(fn) {
      api.begin();
      try {
        return fn();
      } finally {
        api.end();
      }
    }
  };
  backend._cs3dFrameSubmits = api;
  return api;
}

/** One per patched renderer; each flushes its held work if it has any. */
const _frameSubmitFlushers = new Set();
let _lifetimesGuarded = false;

/**
 * A held command buffer that uses a destroyed buffer or texture, or a buffer
 * mapped for reading, fails validation at submit and the whole frame is lost.
 * Those calls go through the prototypes (three destroys through its backend,
 * readbacks map their own buffers), so they flush first. Outside a frame the
 * flushers have nothing held and this is one Set walk.
 */
function guardResourceLifetimes() {
  if (_lifetimesGuarded) return;
  _lifetimesGuarded = true;
  const flushAll = () => {
    for (const f of _frameSubmitFlushers) f();
  };
  const wrap = (proto, name) => {
    const orig = proto?.[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      flushAll();
      return orig.apply(this, args);
    };
  };
  wrap(globalThis.GPUBuffer?.prototype, 'destroy');
  wrap(globalThis.GPUBuffer?.prototype, 'mapAsync');
  wrap(globalThis.GPUTexture?.prototype, 'destroy');
  wrap(globalThis.GPUQuerySet?.prototype, 'destroy');
}

/**
 * Static map geometry: three's per-object refresh only when something it reads
 * changed, and its draws replayed from one recorded GPU bundle.
 *
 * r169 refreshes every render object on every draw: it runs every update node
 * of the material (the camera, the model matrix, a MaterialReferenceNode per
 * map/colour/roughness slot, the batch's own textures), walks every binding
 * comparing uniforms and texture versions, then encodes the draw — pipeline,
 * bind groups, an index buffer and a vertex buffer per attribute. For the ~400
 * TileBatches of a map that was most of the CPU frame, spent rediscovering
 * that a wall had not changed. The camera is the only thing that moves.
 *
 * An object opts in with `object.cs3dStatic = true`. The full r169 refresh
 * still runs whenever anything the object's draw reads could differ:
 *
 *   - the render object is new (first draw, new material, new cache key);
 *   - a texture it binds is a different texture, or a new GPU generation
 *     (checked exactly, every draw); a new version of the same texture — a
 *     batch's indirect texture after its draw list changed, a lightmap that
 *     finished streaming — is uploaded in place;
 *   - its matrixWorld moved, or its material's version did;
 *   - an app-set uniform it reads (the sun, the bake, the fog colours, the
 *     clock) holds a new value: compared exactly, once per render call;
 *   - `markStaticUniformsDirty()` was called (the look's knobs; anything that
 *     edits a material or scene property a MaterialReferenceNode reads);
 *   - and, as a backstop for an edit nobody announced, every
 *     STATIC_REFRESH_FRAMES draws regardless, staggered across objects.
 * Otherwise only the shared (render-group) uniforms — the camera — are
 * brought up to date, once per shader per render call.
 *
 * Bundles. An object that also has `cs3dBundle` (a marker from
 * createStaticBundle, in the same parent and sorted after it) does not encode
 * its draw at all: it joins the marker's member list, and when three reaches
 * the marker the members are replayed with one executeBundles(). The bundle
 * is recorded again only when the member list or a member's pipeline, bind
 * groups, buffers or draw list differ from what it recorded. Uniform writes
 * still land before the pass runs, so the replay draws with this frame's
 * values. Only passes with no override material bundle: shadow and silhouette
 * passes draw the same objects with other materials, normally.
 *
 * Pinned to r169: the full path is three's own `_renderObjectDirect`, and the
 * patch refuses to apply if that method no longer has the shape it mirrors.
 *
 * @param {THREE.WebGPURenderer} renderer  already `init()`ed
 * @returns {{ bundles: boolean, fast: number, full: number, bundled: number, records: number, why: object } | null}
 *   the switches and counters, or null when not applied
 */
export function patchStaticRefresh(renderer) {
  if (!renderer?.backend?.isWebGPUBackend) return null;
  if (renderer._cs3dStaticRefresh) return renderer._cs3dStaticRefresh;
  const full = renderer._renderObjectDirect;
  if (typeof full !== 'function') return null;
  const src = String(full);
  for (const part of ['needsRefresh', '_geometries.updateForRender', '_nodes.updateForRender', '_bindings.updateForRender', '_pipelines.updateForRender', 'backend.draw', '_currentRenderBundle']) {
    if (!src.includes(part)) return null;
  }
  const bindings = renderer._bindings;
  const backend = renderer.backend;
  if (typeof bindings?._update !== 'function' || typeof renderer._nodes?.getNodeFrameForRender !== 'function') return null;
  if (typeof backend.pipelineUtils?.createBundleEncoder !== 'function') return null;

  let stagger = 0;
  /** Switches and counters. `bundles` can be flipped at any time; `enabled` turns the whole patch off. */
  const control = { enabled: true, bundles: true, fast: 0, full: 0, bundled: 0, records: 0, why: {} };
  const miss = (why) => {
    control.why[why] = (control.why[why] || 0) + 1;
    return false;
  };

  function plan(renderObject) {
    const nodeState = renderObject.getNodeBuilderState();
    const cached = nodeState._cs3dStaticPlan;
    if (cached) return cached;
    const groups = renderObject.getBindings();
    const shared = [];
    const sharedUniforms = new Set();
    const ownUniforms = new Set();
    // Shared groups are the state's own instances; createBindings() clones
    // every other group per render object. Identity, not a flag on a binding:
    // one group can mix bindings from shared and per-object group nodes.
    const stateGroups = new Set(nodeState.bindings);
    for (const g of groups) {
      const isShared = stateGroups.has(g);
      if (isShared) shared.push(g);
      for (const b of g.bindings) {
        if (!b.isNodeUniformsGroup) continue;
        for (const u of b.uniforms) {
          const node = u.nodeUniform?.node;
          if (node) (isShared ? sharedUniforms : ownUniforms).add(node);
        }
      }
    }
    // What each update node writes: itself, or the uniform node it feeds.
    const writes = (n) => [n, n.node, n._uniformNode, n._matrixUniform].filter(Boolean);
    const driven = new Set();
    const sharedNodes = [];
    /** Texture nodes a reference fills per material (map, normalMap...), by node. */
    const refTextures = new Map();
    let alwaysFull = false;
    for (const n of nodeState.updateNodes) {
      if (n.node?.isTextureNode && Array.isArray(n.properties)) refTextures.set(n.node, n);
      const type = n.getUpdateType();
      const out = writes(n);
      for (const w of out) driven.add(w);
      if (type === 'render' && out.some((w) => ownUniforms.has(w))) alwaysFull = true;
      if (type !== 'object' && out.some((w) => sharedUniforms.has(w))) sharedNodes.push(n);
    }
    // Uniforms nothing updates are the app's own (`uniform(x)` set from JS):
    // global values, so a change in one is seen once per render call.
    const plain = [];
    for (const node of ownUniforms) {
      if (driven.has(node)) continue;
      const v = node.value;
      if (v !== null && typeof v === 'object' && typeof v.equals !== 'function') alwaysFull = true;
      else plain.push(node);
    }
    for (const node of plain) {
      if (!plainAll.has(node)) {
        snapshot(node);
        plainAll.add(node);
      }
    }
    const p = { shared, sharedNodes, plain, refTextures, alwaysFull, sharedTick: -1 };
    nodeState._cs3dStaticPlan = p;
    return p;
  }

  /**
   * Every app-set uniform any static object reads, compared with its last
   * value once per render call. `plainChanged` is the last call that saw one
   * move; an object only looks at its own list when that is newer than it.
   */
  const plainAll = new Set();
  let plainTick = -1;
  let plainChanged = -1;
  const snapshot = (node) => {
    const v = node.value;
    node._cs3dSnap = v !== null && typeof v === 'object' ? v.clone() : v;
    node._cs3dChanged = -1;
  };
  function scanPlain(tick) {
    if (plainTick === tick) return;
    plainTick = tick;
    for (const node of plainAll) {
      const v = node.value;
      const snap = node._cs3dSnap;
      let moved;
      if (v !== null && typeof v === 'object') {
        moved = !snap.equals(v);
        if (moved) snap.copy(v);
      } else {
        moved = snap !== v;
        if (moved) node._cs3dSnap = v;
      }
      if (moved) {
        node._cs3dChanged = tick;
        plainChanged = tick;
      }
    }
  }

  /**
   * The sampled textures a render object binds, each with where its own
   * refresh would read it from. A shared shader build (patchSharedBatchShaders)
   * means one texture node serves every material of that shape, so the node's
   * `value` is whichever object refreshed last; the per-object sources are read
   * the way their update() reads them. Anything else holds one texture for
   * everyone and its `value` is it.
   */
  function textureList(renderObject, p) {
    const list = [];
    for (const g of renderObject.getBindings()) {
      for (const b of g.bindings) {
        if (!b.isSampledTexture || !b.textureNode) continue;
        const node = b.textureNode;
        const t = b.texture;
        // Render-target textures are rebuilt on a resize without a version
        // bump; only those need their GPU generation checked every draw.
        const rt = !!(t && (t.isRenderTargetTexture || t.isDepthTexture));
        if (typeof node.prop === 'string' && node.prop) list.push({ b, kind: 0, key: node.prop, rt });
        else if (typeof node.slot === 'string' && 'own' in node) list.push({ b, kind: 1, key: node.slot, own: node.own, rt });
        else if (p.refTextures.has(node)) list.push({ b, kind: 2, ref: p.refTextures.get(node), rt });
        else list.push({ b, kind: 3, node, rt });
      }
    }
    return list;
  }

  /**
   * The textures the draw binds, brought up to date the way r169's
   * Bindings._update does it for one binding: a new version of the same
   * texture is uploaded in place. A different texture, or a new GPU
   * generation, needs the bind group rebuilt, which is the full path's job:
   * returns false.
   */
  function syncTextures(renderObject, object, list) {
    const textures = renderer._textures;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const b = e.b;
      let want;
      if (e.kind === 0) {
        const t = object[e.key];
        want = t !== null && t !== undefined && t.isTexture === true ? t : b.texture;
      } else if (e.kind === 1) {
        want = renderObject.material.cs3dTex?.[e.key] || e.own || b.texture;
      } else if (e.kind === 2) {
        let v = e.ref.material ?? renderObject.material;
        for (const k of e.ref.properties) v = v?.[k];
        want = v ?? b.texture;
      } else {
        want = e.node.value;
      }
      if (want !== b.texture) return false;
      if (want === null || want === undefined) continue;
      if (b.version !== want.version) {
        // SampledTexture.update(), not the binding's own: NodeSampledTexture's
        // first re-reads the shared node's value, which is another object's.
        b.version = want.version;
        textures.updateTexture(want);
        if (textures.get(want).generation !== b.generation) return false;
      } else if (e.rt && textures.get(want).generation !== b.generation) {
        return false;
      }
    }
    return true;
  }

  function current(renderObject, object, st, tick) {
    if (st.epoch !== _staticEpoch) return miss('epoch');
    if (++st.skips >= STATIC_REFRESH_FRAMES) return miss('backstop');
    if (st.materialVersion !== renderObject.material.version) return miss('material');
    const m = object.matrixWorld.elements;
    const s = st.matrix;
    for (let i = 0; i < 16; i++) if (m[i] !== s[i]) return miss('matrix');
    const p = st.plan;
    if (p.alwaysFull) return miss('always');
    scanPlain(tick);
    if (plainChanged > st.tick) {
      for (let i = 0; i < p.plain.length; i++) if (p.plain[i]._cs3dChanged > st.tick) return miss('uniform');
    }
    return syncTextures(renderObject, object, st.textures) || miss('texture');
  }

  function remember(renderObject, object, st, tick) {
    st.plan = plan(renderObject);
    st.epoch = _staticEpoch;
    st.skips = 0;
    st.tick = tick;
    st.materialVersion = renderObject.material.version;
    st.matrix.set(object.matrixWorld.elements);
    st.textures = textureList(renderObject, st.plan);
    st.geometry = geometryVersion(object.geometry);
    st.drawVersion = object.cs3dDrawVersion;
    st.sigDirty = true;
    // Values the full refresh just uploaded are not news to this object.
    scanPlain(tick);
  }

  /** Sum of the geometry's buffer versions: it moves whenever anything is uploaded. */
  function geometryVersion(geometry) {
    let v = geometry.index ? geometry.index.version : 0;
    const attrs = geometry.attributes;
    for (const k in attrs) {
      const a = attrs[k];
      v += a.isInterleavedBufferAttribute ? a.data.version : a.version;
    }
    return v;
  }

  // ---- bundles ---------------------------------------------------------------

  /** The bundle marker this draw belongs to, or null to draw it directly. */
  function bundleFor(object, material, scene) {
    const marker = object.cs3dBundle;
    if (!control.bundles || !marker || marker.visible !== true || scene.overrideMaterial !== null) return null;
    if (material.transparent === true || object.renderOrder !== marker.memberOrder) return null;
    return marker;
  }

  /** Everything the recorded draw commands of this object refer to. */
  function signature(renderObject, out) {
    out.length = 0;
    out.push(renderObject, backend.get(renderObject.pipeline).pipeline);
    for (const g of renderObject.getBindings()) out.push(backend.get(g).group);
    const index = renderObject.getIndex();
    if (index !== null) out.push(backend.get(index).buffer);
    for (const vb of renderObject.getVertexBuffers()) out.push(backend.get(vb).buffer);
    const o = renderObject.object;
    out.push(o._multiDrawCount, o.cs3dDrawVersion, renderObject.drawRange?.start, renderObject.drawRange?.count);
    return out;
  }
  const _sig = [];

  function join(marker, renderObject, st, tick) {
    const ctx = renderObject.context;
    let s = marker._cs3dBundles.get(ctx);
    if (s === undefined) {
      s = { bundle: null, members: [], visited: [], tick: -1, dirty: true };
      marker._cs3dBundles.set(ctx, s);
    }
    if (s.tick !== tick) {
      s.tick = tick;
      s.visited.length = 0;
    }
    s.visited.push(renderObject);
    if (st.sigDirty) {
      st.sigDirty = false;
      signature(renderObject, _sig);
      const prev = st.sig;
      let same = prev !== undefined && prev.length === _sig.length;
      if (same) for (let i = 0; i < _sig.length; i++) if (prev[i] !== _sig[i]) same = false;
      if (!same) {
        st.sig = _sig.slice();
        s.dirty = true;
      }
    }
  }

  function playBundle(r, marker) {
    const ctx = r._currentRenderContext;
    const s = marker._cs3dBundles.get(ctx);
    if (s === undefined || s.tick !== r._nodes.nodeFrame.renderId || s.visited.length === 0) return;
    const data = backend.get(ctx);
    let same = !s.dirty && s.bundle !== null && s.visited.length === s.members.length;
    if (same) for (let i = 0; i < s.visited.length; i++) if (s.visited[i] !== s.members[i]) { same = false; break; }
    if (!same) {
      const pass = data.currentPass;
      const sets = data.currentSets;
      data.currentPass = backend.pipelineUtils.createBundleEncoder(ctx);
      data.currentSets = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
      try {
        for (const ro of s.visited) backend.draw(ro, r.info);
        s.bundle = data.currentPass.finish();
      } finally {
        data.currentPass = pass;
        data.currentSets = sets;
      }
      s.members = s.visited.slice();
      s.dirty = false;
      control.records++;
    }
    data.currentPass.executeBundles([s.bundle]);
    // A bundle leaves the pass with no pipeline, bind groups or buffers set;
    // three's redundant-state cache has to forget what it thinks is bound.
    data.currentSets = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
  }

  // ---- the object handler ----------------------------------------------------

  renderer._renderObjectDirect = function (object, material, scene, camera, lightsNode, group, passId) {
    if (object.isCs3dBundle === true) {
      if (control.enabled) playBundle(this, object);
      return;
    }
    if (object.cs3dStatic !== true || !control.enabled) return full.call(this, object, material, scene, camera, lightsNode, group, passId);
    const renderObject = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, passId);
    const tick = this._nodes.nodeFrame.renderId;
    const marker = bundleFor(object, material, scene);
    let st = renderObject._cs3dStatic;
    if (st && current(renderObject, object, st, tick)) {
      renderObject.drawRange = object.geometry.drawRange;
      renderObject.group = group;
      this._nodes.updateBefore(renderObject);
      const gv = geometryVersion(object.geometry);
      if (gv !== st.geometry) {
        st.geometry = gv;
        this._geometries.updateForRender(renderObject);
        st.sigDirty = true;
      }
      if (st.drawVersion !== object.cs3dDrawVersion) {
        st.drawVersion = object.cs3dDrawVersion;
        st.sigDirty = true;
      }
      const p = st.plan;
      if (p.sharedTick !== tick) {
        p.sharedTick = tick;
        if (p.sharedNodes.length) {
          const frame = this._nodes.getNodeFrameForRender(renderObject);
          for (let i = 0; i < p.sharedNodes.length; i++) frame.updateNode(p.sharedNodes[i]);
        }
        const all = renderObject.getBindings();
        for (let i = 0; i < p.shared.length; i++) bindings._update(p.shared[i], all);
      }
      this._pipelines.updateForRender(renderObject);
      this._nodes.updateAfter(renderObject);
      if (marker !== null) {
        join(marker, renderObject, st, tick);
        control.bundled++;
        return;
      }
      if (this._currentRenderBundle !== null) {
        this.backend.get(this._currentRenderBundle).renderObjects.push(renderObject);
        renderObject.bundle = this._currentRenderBundle.scene;
      }
      this.backend.draw(renderObject, this.info);
      control.fast++;
      return;
    }
    control.full++;
    if (marker !== null) {
      // r169's refresh, step for step, without the draw: the bundle draws it.
      renderObject.drawRange = object.geometry.drawRange;
      renderObject.group = group;
      this._nodes.needsRefresh(renderObject);
      this._nodes.updateBefore(renderObject);
      this._geometries.updateForRender(renderObject);
      this._nodes.updateForRender(renderObject);
      this._bindings.updateForRender(renderObject);
      this._pipelines.updateForRender(renderObject);
      this._nodes.updateAfter(renderObject);
    } else {
      full.call(this, object, material, scene, camera, lightsNode, group, passId);
    }
    const fresh = !st;
    if (fresh) st = renderObject._cs3dStatic = { plan: null, textures: null, sig: undefined, epoch: -1, skips: 0, tick: 0, geometry: -1, drawVersion: -1, sigDirty: true, materialVersion: -1, matrix: new Float64Array(16) };
    remember(renderObject, object, st, tick);
    // Spread the backstop refreshes so they do not all land on one frame.
    if (fresh) st.skips = stagger++ % STATIC_REFRESH_FRAMES;
    if (marker !== null) join(marker, renderObject, st, tick);
  };
  // r169 binds the object handler once in the constructor and again after
  // every compileAsync, both from `this._renderObjectDirect`.
  if (renderer._handleObjectFunction === full) renderer._handleObjectFunction = renderer._renderObjectDirect;
  renderer._cs3dStaticRefresh = control;
  return control;
}

/** Full refreshes of a static object are never further apart than this many of its draws. */
export const STATIC_REFRESH_FRAMES = 32;
let _staticEpoch = 0;

/**
 * A material or scene property changed that static objects read through a
 * reference (scene.environmentIntensity, a material's colour or map): refresh
 * every static object on its next draw. App-set uniforms do not need this;
 * their values are compared directly.
 */
export function markStaticUniformsDirty() {
  _staticEpoch++;
}

/**
 * The marker a group of static objects is replayed at (see patchStaticRefresh).
 *
 * Add it to the same parent as its members, which set `cs3dBundle` to it and
 * keep `renderOrder === memberOrder`. It sorts just after them, so three has
 * visited every member by the time it reaches the marker, and before anything
 * drawn later in the same order (decals at renderOrder 1 stay on top). It
 * draws nothing of its own: a degenerate triangle that cannot be hit or seen.
 *
 * @param {typeof import('three/webgpu')} THREE
 * @param {number} memberOrder  the members' renderOrder
 */
export function createStaticBundle(THREE, memberOrder = 0) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  const marker = new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial());
  marker.name = 'static-bundle';
  marker.isCs3dBundle = true;
  marker.memberOrder = memberOrder;
  marker.renderOrder = memberOrder + 0.5;
  marker.frustumCulled = false;
  marker.castShadow = false;
  marker.receiveShadow = false;
  marker.matrixAutoUpdate = false;
  marker.raycast = () => {};
  marker._cs3dBundles = new WeakMap();
  return marker;
}

/**
 * three r169's BloomNode clears every blur target with `renderer.clear()`
 * before drawing a quad into it. On WebGPU that clear is a render pass of its
 * own, eleven of them per bloom node, and each quad that follows already
 * covers every pixel of its target with blending off (and clears through its
 * own load op). The clears change no pixel; inside the bloom they are skipped.
 *
 * Applied to the prototype once, and only if updateBefore is still the shape
 * that pairs each clear with a full-screen quad.
 *
 * @param {typeof THREE.BloomNode} BloomNode
 * @returns {boolean} whether the patch was applied
 */
export function patchBloomClears(BloomNode) {
  const proto = BloomNode?.prototype;
  if (!proto || typeof proto.updateBefore !== 'function') return false;
  if (proto._cs3dNoClears) return true;
  const orig = proto.updateBefore;
  const src = String(orig);
  if (!/\.clear\(\)/.test(src) || !/_separableBlurMaterials/.test(src) || !/_renderTargetsHorizontal/.test(src)) return false;
  const skip = () => {};
  proto.updateBefore = function (frame) {
    const renderer = frame.renderer;
    const clear = renderer.clear;
    renderer.clear = skip;
    try {
      return orig.call(this, frame);
    } finally {
      renderer.clear = clear;
    }
  };
  proto._cs3dNoClears = true;
  return true;
}
