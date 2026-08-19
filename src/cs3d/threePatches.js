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
