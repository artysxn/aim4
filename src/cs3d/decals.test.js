// ---------------------------------------------------------------------------
// src/cs3d/decals.test.js
// The two things about a bullet hole that can be wrong without anyone noticing
// on screen until it is on the wrong wall:
//
//   the CLIP — a decal is geometry cut out of the surface it landed on, and a
//   clip that is off by a plane leaves a triangle hanging in the air or eats
//   the hole entirely;
//   the PICK — which of CS2's 98 decals a surface gets, and how often. The
//   game's own weights are in the pack and a uniform pick makes a wall shot
//   fifty times read as five textures rather than fifty holes.
//
// Run: node src/cs3d/decals.test.js
// ---------------------------------------------------------------------------

// three/webgpu reads `self` at module scope for GPUShaderStage. Nothing here
// touches the GPU, so a shim is enough to get the module graph to load.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const assert = (await import('node:assert/strict')).default;
const { clipPolygonToBox, DECAL_MAX_VERTEX_BUFFERS, createDecalRingGeometry, spherePickScore, boxOverlaps, Decals } = await import('./decals.js');
const { BulletAssets } = await import('./bulletPack.js');

const tri = (a, b, c) => [
  { x: a[0], y: a[1], z: a[2], w: [1, 0, 0] },
  { x: b[0], y: b[1], z: b[2], w: [0, 1, 0] },
  { x: c[0], y: c[1], z: c[2], w: [0, 0, 1] }
];

// ---- the clip ---------------------------------------------------------------

{
  // A triangle entirely inside the box comes back untouched.
  const poly = clipPolygonToBox(tri([-1, -1, 0], [1, -1, 0], [0, 1, 0]), 3, 3, 3);
  assert.equal(poly.length, 3, 'a triangle inside the box should survive whole');
}

{
  // ...and one entirely outside it comes back empty rather than clamped to the
  // face, which is the failure that pastes a hole on the wrong wall.
  const poly = clipPolygonToBox(tri([10, 10, 0], [12, 10, 0], [11, 12, 0]), 3, 3, 3);
  assert.equal(poly.length, 0);
}

{
  // A big triangle across the box becomes a polygon bounded by the box.
  const poly = clipPolygonToBox(tri([-100, -100, 0], [100, -100, 0], [0, 100, 0]), 2, 2, 5);
  assert.ok(poly.length >= 3);
  for (const p of poly) {
    assert.ok(Math.abs(p.x) <= 2 + 1e-9, `x ${p.x} escaped the box`);
    assert.ok(Math.abs(p.y) <= 2 + 1e-9, `y ${p.y} escaped the box`);
  }
  // A plane through a box is bounded by four sides, so at most a quadrilateral.
  assert.ok(poly.length <= 4, `${poly.length} vertices from a planar cut`);
}

{
  // The barycentrics have to be interpolated at the cut, or every attribute
  // carried through it (the lightmap UV above all) lands on the wrong texel.
  const poly = clipPolygonToBox(tri([-4, 0, 0], [4, 0, 0], [0, 4, 0]), 2, 2, 5);
  for (const p of poly) {
    const sum = p.w[0] + p.w[1] + p.w[2];
    assert.ok(Math.abs(sum - 1) < 1e-9, `barycentrics summed to ${sum}`);
    for (const w of p.w) assert.ok(w >= -1e-9 && w <= 1 + 1e-9, `barycentric ${w} out of range`);
  }
}

{
  // Depth is a real plane too: a triangle parallel to the decal but well
  // behind it must not be caught. This is what keeps a hole off the back face
  // of a thin panel.
  assert.equal(clipPolygonToBox(tri([-1, -1, 20], [1, -1, 20], [0, 1, 20]), 3, 3, 6).length, 0);
  assert.equal(clipPolygonToBox(tri([-1, -1, 2], [1, -1, 2], [0, 1, 2]), 3, 3, 6).length, 3);
}

// ---- the pick ---------------------------------------------------------------

/** A pack manifest with the shape scripts/cs3d-decals.mjs writes. */
const manifest = {
  atlas: { color: 'decals.webp', normal: 'decals_n.webp', cols: 4, rows: 2, cell: 128, gutter: 8 },
  decals: [
    { name: 'concrete/concrete1', width: 5, height: 5, sizeVariance: 0.5 },
    { name: 'concrete/concrete2', width: 7, height: 7, sizeVariance: 1.25 },
    { name: 'metal/metal1', width: 3, height: 3, sizeVariance: 0.5 },
    { name: 'metal/metal1_grazing', width: 3, height: 3.5, sizeVariance: 1 }
  ],
  groups: {
    'Impact.Concrete': [
      { cell: 0, weight: 1 },
      { cell: 1, weight: 3 }
    ],
    'Impact.Metal': [{ cell: 2, weight: 1 }],
    'Impact.Metal_Grazing': [{ cell: 3, weight: 1 }]
  },
  surfaceGroup: { C: 'Impact.Concrete', M: 'Impact.Metal' },
  defaultGroup: 'Impact.Concrete',
  grazingSuffix: '_Grazing'
};

const assets = new BulletAssets();
assets.manifest = manifest;
for (const [group, rows] of Object.entries(manifest.groups)) {
  let sum = 0;
  assets._picks[group] = {
    cum: rows.map((r) => {
      sum += r.weight;
      return { cell: r.cell, upto: sum };
    }),
    total: sum
  };
}

{
  // The route is surface name -> the game material letter the surface table
  // carries -> the group. `concrete` is 'C', `metal` is 'M'.
  assert.equal(assets.groupFor('concrete'), 'Impact.Concrete');
  assert.equal(assets.groupFor('metal'), 'Impact.Metal');
  // A surface nobody mapped falls back rather than throwing.
  assert.equal(assets.groupFor('brass_bell_large'), 'Impact.Concrete');
  assert.equal(assets.groupFor(undefined), 'Impact.Concrete');
}

{
  // A grazing hit takes the streaked variant where CS2 authors one...
  assert.equal(assets.groupFor('metal', true), 'Impact.Metal_Grazing');
  // ...and the straight-on set where it does not. Only six groups have one.
  assert.equal(assets.groupFor('concrete', true), 'Impact.Concrete');
}

{
  // The weights are the game's: concrete2 carries 3 of the group's 4.
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) counts[assets.pick('Impact.Concrete', i / 4000)]++;
  const share = counts[1] / (counts[0] + counts[1]);
  assert.ok(share > 0.72 && share < 0.78, `weighted pick gave ${(share * 100).toFixed(1)}% to the heavy option`);
  assert.equal(counts[2], 0, 'a cell from another group must never be picked');
}

{
  // The atlas box for a cell: cell 0 is the top-left, v is flipped because an
  // image's first row is the top and a texture's v runs up, and every edge is
  // inset by the gutter the packer left for the mip chain.
  const W = 4 * 128;
  const H = 2 * 128;
  const uv = assets.cellUv(0);
  assert.equal(uv.u0, 8 / W);
  assert.equal(uv.du, 112 / W);
  assert.equal(uv.dv, 112 / H);
  // Cell 0's pixels run y 8..120 of a 256-tall sheet, so its bottom edge is
  // v = 1 - 120/256.
  assert.ok(Math.abs(uv.v0 - (1 - 120 / H)) < 1e-12);
  // ...and the second row sits below it, never overlapping.
  const second = assets.cellUv(4);
  assert.ok(second.v0 + second.dv <= uv.v0 + 1e-12, 'rows must not overlap');
  assert.ok(second.v0 > 0, 'the bottom row keeps its gutter too');
}

// ---- WebGPU vertex-buffer cap ----------------------------------------------
// Both rings are added on the first shot. Nine attributes used to invalidate
// the whole scene pass (maxVertexBuffers is 8).
{
  for (const kind of ['world', 'prop']) {
    const g = createDecalRingGeometry(kind);
    const n = Object.keys(g.attributes).length;
    assert.ok(n <= DECAL_MAX_VERTEX_BUFFERS, `${kind} ring has ${n} vertex buffers`);
    assert.equal(g.getAttribute('_uvl').itemSize, 4, `${kind} packs t0+alpha into _uvl.zw`);
    assert.equal(g.getAttribute('_t0'), undefined);
    assert.equal(g.getAttribute('_a'), undefined);
    g.dispose();
  }
}

// A sphere that contains the point scores; one further than the slop does not.
// Tight vs huge is no longer a winner-take-all: a hole overlaps several tiles.
{
  assert.ok(spherePickScore(0, 0, 0, 10, 1, 0, 0, 8) < Infinity);
  assert.ok(spherePickScore(0, 0, 0, 10, 16, 0, 0, 8) < Infinity, 'adjacent tile still overlaps a typical hole');
  assert.equal(spherePickScore(0, 0, 0, 10, 100, 0, 0, 8), Infinity);
}

{
  const fakeBatch = (matId, cx, r) => ({
    userData: { matId },
    geometry: { getAttribute: () => ({}) },
    _drawInfo: [{ active: true, geometryIndex: 0 }],
    getGeometryRangeAt: () => ({ start: 0, count: 3 }),
    getMatrixAt: (_i, m) => m.identity(),
    getBoundingSphereAt: (_g, sph) => {
      sph.center.set(cx, 0, 0);
      sph.radius = r;
      return sph;
    }
  });
  const decals = new Decals({
    assets,
    getPack: () => ({
      world: { traverse() {} },
      manifest: { materials: { 1: { decal: true }, 2: { decal: false } } },
      batches: new Map([
        ['m1', fakeBatch(1, 0, 2)],
        ['m2a', fakeBatch(2, 0, 8)],
        ['m2b', fakeBatch(2, 10, 8)],
        ['s0', fakeBatch(2, 0, 8)]
      ])
    })
  });
  const hits = decals._targetsAt({ x: 5, y: 0, z: 0 }, 6);
  assert.equal(hits.length, 2, 'overlapping wall tiles both clip; overlay and sky do not');
  assert.ok(hits.every((h) => h.object.userData.matId === 2));
}

{
  // Packed AABB vs sphere: a long thin tile's sphere covers a nearby wall,
  // the box does not. Without the box, `_cut` walked the whole fence per shot.
  const boxes = new Float32Array([-400, -2, -2, 400, 2, 2]);
  assert.equal(boxOverlaps(boxes, 0, 0, 0, 0, 8), true, 'on the fence');
  assert.equal(boxOverlaps(boxes, 0, 0, 80, 0, 8), false, 'beside the fence');
  const fence = {
    userData: { matId: 2 },
    geometry: { getAttribute: () => ({}) },
    _drawInfo: [{ active: true, geometryIndex: 0 }],
    getGeometryRangeAt: () => ({ start: 0, count: 30000 }),
    getMatrixAt: (_i, m) => m.identity(),
    getBoundingSphereAt: (_g, sph) => {
      sph.center.set(0, 0, 0);
      sph.radius = 400;
      return sph;
    },
    _tileSpheres: new Float32Array([0, 0, 0, 400]),
    _tileBoxes: boxes
  };
  const decals = new Decals({
    assets,
    getPack: () => ({
      world: { traverse() {} },
      manifest: { materials: { 2: { decal: false } } },
      batches: new Map([['fence', fence]])
    })
  });
  assert.equal(decals._targetsAt({ x: 0, y: 80, z: 0 }, 6).length, 0, 'sphere hit + AABB miss');
  assert.equal(decals._targetsAt({ x: 0, y: 0, z: 0 }, 6).length, 1, 'on-fence still clips');
}

{
  // Hidden player / nade meshes hang off pack.world; they are not walls.
  const playerMesh = {
    isMesh: true,
    isBatchedMesh: false,
    visible: true,
    name: 'body',
    parent: { name: 'player', visible: false, parent: null },
    userData: {},
    geometry: {
      getAttribute: () => ({ count: 20000 }),
      index: { count: 20000 },
      boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 40 }
    },
    matrixWorld: { equals: () => true, elements: new Float32Array(16) }
  };
  const decals = new Decals({
    assets,
    getPack: () => ({
      world: {
        traverse(fn) {
          fn(playerMesh);
        }
      },
      manifest: { materials: {} },
      batches: new Map()
    })
  });
  assert.equal(decals._targetsAt({ x: 0, y: 0, z: 0 }, 6).length, 0, 'player mesh is not a decal source');
}

console.log('decals: ok');

