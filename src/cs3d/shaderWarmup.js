// ---------------------------------------------------------------------------
// src/cs3d/shaderWarmup.js
// Build the map's shaders while it is still loading, a few at a time.
//
// three's WebGPU renderer turns a node material into WGSL the first time it
// draws it, on the main thread, and a map is a few hundred materials. Drawn
// all at once that was the whole cost of opening the 3D view: Dust 2's first
// frame spent 8-11 seconds in NodeBuilder.build after every byte had already
// arrived, with the page frozen behind the boot screen.
//
// None of that depends on the download being finished. A material can be
// built as soon as its batch exists and its textures are in, so this draws
// real frames behind the boot screen while the pack streams, each with only a
// handful of not-yet-built batches visible: the builds land between network
// waits instead of after them, no single frame stalls for long, and by the
// time the last tile is in most of the map has been compiled.
//
// A batch is only warmed once it wears its final material. Building its flat
// stand-in first would be a shader thrown away a second later.
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {() => Iterable<THREE.Object3D>} o.batches  every map batch so far
 * @param {(batch: THREE.Object3D) => boolean} o.ready  wears its final material
 * @param {() => void} o.render  draw one frame exactly as the viewer does
 * @param {number} [o.budgetMs]  aim for frames about this long
 */
export function createShaderWarmup({ batches, ready, render, budgetMs = 40 }) {
  /** batch -> the material it was last drawn with */
  const drawn = new WeakMap();
  /** batch -> its geometry's version when last drawn (see step). */
  const uploaded = new WeakMap();
  const geometryVersion = (b) => b.geometry?.attributes?.position?.version ?? 0;
  let perFrame = 6;
  let built = 0;
  /** Whether the last step drew a frame (false: nothing was ready to warm). */
  let drew = false;

  function pendingOf() {
    const out = [];
    for (const b of batches()) {
      if (!b.visible) continue;
      if (drawn.get(b) === b.material) continue;
      out.push(b);
    }
    return out;
  }

  return {
    /** Batches drawn with the material they wear now. */
    get built() {
      return built;
    },
    /** Whether the last step() drew anything; when not, there is no point stepping again at once. */
    get drew() {
      return drew;
    },
    /** Batches still to build, of the ones that exist. */
    pending() {
      return pendingOf().length;
    },
    /**
     * One warm-up frame.
     *
     * Drawn: the batches being warmed, and the built ones whose geometry grew
     * since they were last drawn (a draw is what uploads a batch's new tiles;
     * left alone, the whole map's vertex data went up in the first real frame,
     * two seconds of it on Inferno). Everything else is hidden for the frame:
     * drawing it again builds and uploads nothing, and late in a big map's
     * load that was four hundred draws per warm-up frame, all of it in the way
     * of the tiles still streaming in.
     * @param {{ all?: boolean }} [opts]  `all`: stop waiting for final
     *   materials (the textures are as done as they will get)
     * @returns {number} batches still waiting after this frame
     */
    step({ all = false } = {}) {
      drew = false;
      const pending = pendingOf();
      const want = pending.filter((b) => all || ready(b));
      const take = new Set(want.slice(0, perFrame));
      const show = new Set(take);
      for (const b of batches()) {
        if (b.visible && drawn.get(b) === b.material && uploaded.get(b) !== geometryVersion(b)) show.add(b);
      }
      if (!show.size) return pending.length;
      const hidden = [];
      for (const b of batches()) {
        if (show.has(b) || !b.visible) continue;
        b.visible = false;
        hidden.push(b);
      }
      const t = performance.now();
      try {
        render();
      } finally {
        for (const b of hidden) b.visible = true;
      }
      drew = true;
      const ms = performance.now() - t;
      for (const b of show) uploaded.set(b, geometryVersion(b));
      for (const b of take) {
        drawn.set(b, b.material);
        built++;
      }
      // Keep each frame near the budget: the page stays responsive and the
      // boot bar keeps moving.
      const scale = budgetMs / Math.max(1, ms);
      perFrame = Math.max(2, Math.min(64, Math.round(perFrame * Math.min(2, Math.max(0.5, scale)))));
      return pending.length - take.size;
    }
  };
}
