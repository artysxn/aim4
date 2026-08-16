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
