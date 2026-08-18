// Run: node src/cs3d/hullWorld.test.js
//
// The collision BANDS, end to end. mapLoader merges the map's collision in a
// fixed order so that each audience is a range of triangle indices, and this
// file builds a map the same way and checks that a player and a grenade are
// stopped by different things.
//
// It is worth a test of its own because the mechanism has a non-obvious
// dependency: MeshBVH reorders the index buffer in place unless it is built
// `indirect: true`, and if it does, triangle indices stop meaning anything and
// every audience silently collides with everything. That failure is invisible
// in the renderer until someone throws a grenade at a player clip.
//
// Ground truth for the sets themselves is the demo corpus: over 64,750 recorded
// grenade segments on Nuke, real grenades crossed `playerclip` geometry 482
// times and `solid` geometry 8 times (precision noise). Grenades go through
// player clips; that is not a preference, it is what the game does.

// three/webgpu reads `self` at module scope for GPUShaderStage, and hullWorld
// imports it for Box3 alone. Same shim the other cs3d tests use, and the
// imports below have to be dynamic so it is in place first.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const THREE = await import('three');
const { MeshBVH } = await import('three-mesh-bvh');
const { boxTriangles } = await import('../../shared/sim3d/hullTrace.js');
const { createHullWorld } = await import('./hullWorld.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// Four walls across the x axis, one of each kind, in mapLoader's band order:
//   light (solid + entity) | both (sky) | walkOnly (playerclip) | nadeOnly (grenadeclip)
const bands = { light: [], both: [], walkOnly: [], nadeOnly: [] };
boxTriangles([100, -300, -50], [110, 300, 300], bands.light); // solid
boxTriangles([700, -300, -50], [710, 300, 300], bands.both); // sky
boxTriangles([200, -300, -50], [210, 300, 300], bands.walkOnly); // playerclip
boxTriangles([300, -300, -50], [310, 300, 300], bands.nadeOnly); // grenadeclip

const order = [...bands.light, ...bands.both, ...bands.walkOnly, ...bands.nadeOnly];
const tri = (a) => a.length / 9;
const tLight = tri(bands.light);
const tBoth = tLight + tri(bands.both);
const tWalk = tBoth + tri(bands.walkOnly);
const tAll = tWalk + tri(bands.nadeOnly);

const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(order), 3));
geo.setIndex(Array.from({ length: tAll * 3 }, (_, i) => i));
const bvh = new MeshBVH(geo, { targetLeafSize: 8, indirect: true });

const collider = {
  geometry: geo,
  bvh,
  triangles: tAll,
  ranges: {
    light: [[0, tLight]],
    walk: [[0, tWalk]],
    nade: [[0, tBoth], [tWalk, tAll]]
  }
};

const walk = createHullWorld(collider, 'walk');
const nade = createHullWorld(collider, 'nade');

/** Does this audience get stopped between x = from and x = to? */
const blocked = (world, from, to) => {
  const t = world.traceHull({ x: from, y: 0, z: 0 }, { x: to, y: 0, z: 0 }, 2, 2);
  return t.fraction < 1;
};

// Solid stops everything.
assert(blocked(walk, 50, 150), 'a player is stopped by solid');
assert(blocked(nade, 50, 150), 'a grenade is stopped by solid');

// The player clip is the whole point: it stops a player and NOT a grenade.
assert(blocked(walk, 150, 250), 'a player is stopped by playerclip');
assert(!blocked(nade, 150, 250), 'a grenade passes THROUGH playerclip');

// ...and the grenade clip is the mirror image.
assert(!blocked(walk, 250, 350), 'a player walks through grenadeclip');
assert(blocked(nade, 250, 350), 'a grenade is stopped by grenadeclip');

// The sky lid stops both, and it lives in a band after the light range, which
// is the case that catches an off-by-one in the band boundaries.
assert(blocked(walk, 650, 750), 'a player is stopped by the sky brush');
assert(blocked(nade, 650, 750), 'a grenade is stopped by the sky brush');

// And the light set is narrower than both: solid only, no sky.
const light = createHullWorld(collider, 'light');
assert(blocked(light, 50, 150), 'light is stopped by solid');
assert(!blocked(light, 650, 750), 'light passes through the sky brush');

console.log('hullWorld.test: ok');
