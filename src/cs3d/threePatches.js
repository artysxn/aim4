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
