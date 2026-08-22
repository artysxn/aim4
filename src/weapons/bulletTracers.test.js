// Run: node src/weapons/bulletTracers.test.js
//
// The bullet streak: the parts that are arithmetic rather than pixels.
//
// The ribbon is a port of src/cs3d/tracers.js from the explorer's scene, which
// IS Source units, into the trainer's, which is metres. Everything that can go
// wrong in that move is a length:
//
//   · 20500 u/s read as 20500 m/s is a tracer that crosses the arena in a
//     tenth of a millisecond — invisible, and indistinguishable from "tracers
//     are broken" without measuring it.
//   · 1200 units of tail read as 1200 m is a streak longer than any trainer
//     arena, so it never has a tail at all and reads as a solid beam.
//
// The other half is `m_nTracerFrequency`, where the trap is that CS2 overrides
// the weapon's period to 1 but does NOT override a weapon having no tracer at
// all — a silenced gun still draws none, and reading the override as "always
// draw" puts streaks on an MP5-SD.

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const THREE = await import('three');
const { BulletTracers, smoothstep } = await import('./bulletTracers.js');
const { UNIT_M } = await import('../../shared/sim3d/units.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// The pack's own tracer block, as scripts/cs3d-decals.mjs writes it.
const TRACER = {
  texture: 'tracer.webp',
  speed: 20500,
  maxLength: 1200,
  fadeInAt: 0.2,
  fadeOutAt: 0.95,
  nearFade: 180
};
function stubAssets() {
  return { ready: true, tracer: new THREE.Texture(), manifest: { tracer: TRACER } };
}
/**
 * A tracer rig whose camera is OFF the line of flight.
 *
 * A ribbon is built perpendicular to both the flight and the line of sight, so
 * one seen exactly end-on has no width and is skipped — correct, and never hit
 * in the game, because the muzzle sits 0.125 m right and 0.086 m below the
 * eye and a bullet therefore never leaves along the view axis exactly.
 */
function make(camX = 1) {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
  camera.position.set(camX, 0, 0);
  camera.updateMatrixWorld(true);
  return new BulletTracers({ camera, assets: stubAssets() });
}
const RIFLE = { name: 'ak47', tracerFrequency: 3 };
const SILENCED = { name: 'mp5sd', tracerFrequency: 0 };

// ---- smoothstep -------------------------------------------------------------
{
  close(smoothstep(0.2, 0.3, 0.1), 0, 1e-12, 'before the ramp');
  close(smoothstep(0.2, 0.3, 0.4), 1, 1e-12, 'after it');
  close(smoothstep(0.2, 0.3, 0.25), 0.5, 1e-12, 'and half way through the middle');
  assert(smoothstep(0.3, 0.3, 0.3) === 1, 'a zero-width ramp does not divide by zero');
}

// ---- the frequency rule -----------------------------------------------------
{
  const t = make();
  // CS2 ships `cl_tracer_frequency_override` at 1, so a rifle's own period of
  // 3 is ignored and every bullet gets a streak.
  let drawn = 0;
  for (let i = 0; i < 9; i++) if (t.wants(RIFLE)) drawn++;
  assert(drawn === 9, `CS2 draws every bullet, not one in three (got ${drawn}/9)`);

  // ...but the override changes the PERIOD, not whether a weapon has one.
  const t2 = make();
  let silenced = 0;
  for (let i = 0; i < 9; i++) if (t2.wants(SILENCED)) silenced++;
  assert(silenced === 0, 'a silenced weapon still leaves no streak at all');
  assert(t2.wants(null) === false, 'and neither does a weapon nobody named');

  // Counted per weapon, so switching guns does not reset the other's phase.
  const t3 = make();
  t3.wants(RIFLE);
  t3.wants({ name: 'awp', tracerFrequency: 1 });
  assert(t3._shots.get('ak47') === 1 && t3._shots.get('awp') === 1, 'each weapon keeps its own count');
}

// ---- the lengths, in metres -------------------------------------------------
{
  const t = make();
  const ok = t.fire({ from: new THREE.Vector3(0, 0, 0), to: new THREE.Vector3(0, 0, -100), weapon: RIFLE });
  assert(ok, 'a 100 m shot draws');
  const s = t.live[0];
  close(s.speed, 20500 * UNIT_M, 1e-6, 'the speed is 20500 u/s in metres (520.7 m/s)');
  close(s.speed, 520.7, 0.1, '...which is 520.7 m/s');
  close(s.len, 1200 * UNIT_M, 1e-6, 'the tail is 1200 units in metres (30.5 m)');
  close(s.len, 30.48, 0.01, '...which is 30.48 m');
  close(s.nearFade, 180 * UNIT_M, 1e-6, 'and the near fade is 180 units');
  close(s.dist, 100, 1e-9, 'the flight is the distance given');
  assert(Math.abs(s.dir.z + 1) < 1e-9, 'pointing the way it was fired');

  // Under a Source unit of travel there is nothing to draw.
  const t2 = make();
  assert(!t2.fire({ from: new THREE.Vector3(), to: new THREE.Vector3(0, 0, -0.01), weapon: RIFLE }), 'a 1 cm shot draws nothing');
}

// ---- the life of a streak ---------------------------------------------------
{
  const t = make();
  t.fire({ from: new THREE.Vector3(0, 0, 0), to: new THREE.Vector3(0, 0, -100), weapon: RIFLE });
  const s = t.live[0];
  // Alive until the head has arrived AND the tail has caught up: 100 m of
  // flight plus 30.48 m of tail, at 520.7 m/s.
  const life = (100 + s.len) / s.speed;
  close(life, 0.2506, 1e-3, 'a 100 m tracer lives about a quarter of a second');
  t.update(life * 0.9);
  assert(t.live.length === 1, 'still there just before the end');
  t.update(life * 0.2);
  assert(t.live.length === 0, 'and gone just after it');
}

// ---- the ribbon -------------------------------------------------------------
{
  const t = make();
  t.fire({ from: new THREE.Vector3(0, 0, -1), to: new THREE.Vector3(0, 0, -101), weapon: RIFLE });
  // A tenth of the way is inside the fade-in, so nothing is drawn yet: CS2
  // holds the streak off over the first fifth of the flight so a bullet does
  // not flash in the shooter's own face.
  t.update(0.1 * 100 / t.live[0].speed);
  assert(t._geo.drawRange.count === 0, 'nothing drawn inside the fade-in');

  // Half way is full brightness and one quad.
  const t2 = make();
  t2.fire({ from: new THREE.Vector3(0, 0, -1), to: new THREE.Vector3(0, 0, -101), weapon: RIFLE });
  t2.update(50 / t2.live[0].speed);
  assert(t2._geo.drawRange.count === 6, `one quad, six vertices (got ${t2._geo.drawRange.count})`);
  const C = t2._geo.getAttribute('color').array;
  close(C[0], 1, 1e-6, 'and at full brightness half way down the line');

  // The head is 50 m out, the tail 30.48 m behind it: the ribbon spans that.
  const P = t2._geo.getAttribute('position').array;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < 6; i++) {
    minZ = Math.min(minZ, P[i * 3 + 2]);
    maxZ = Math.max(maxZ, P[i * 3 + 2]);
  }
  close(maxZ - minZ, 30.48, 0.02, 'the drawn ribbon is exactly one tail long');
  close(minZ, -51, 0.02, 'with its head where the bullet is');

  // v runs 0 at the tail and 1 at the head — the spark texture tapers, and
  // that end is the bullet.
  const U = t2._geo.getAttribute('uv').array;
  const vs = [];
  for (let i = 0; i < 6; i++) vs.push(U[i * 2 + 1]);
  assert(vs.includes(0) && vs.includes(1), 'the quad spans the whole texture');

  // Dead end-on there is no ribbon to build, and it is skipped rather than
  // drawn as a degenerate sliver. See `make`.
  const axial = make(0);
  axial.fire({ from: new THREE.Vector3(0, 0, -1), to: new THREE.Vector3(0, 0, -101), weapon: RIFLE });
  axial.update(50 / axial.live[0].speed);
  assert(axial._geo.drawRange.count === 0, 'a streak seen exactly end-on draws nothing');
}

// ---- disabled / no pack -----------------------------------------------------
{
  const t = make();
  t.enabled = false;
  assert(!t.fire({ from: new THREE.Vector3(), to: new THREE.Vector3(0, 0, -100), weapon: RIFLE }), 'off means off');

  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
  const none = new BulletTracers({ camera, assets: { ready: false } });
  assert(!none.ready, 'no pack, not ready');
  assert(!none.fire({ from: new THREE.Vector3(), to: new THREE.Vector3(0, 0, -100), weapon: RIFLE }), 'and nothing drawn');
  none.update(0.1); // must not throw
}

// ---- clear ------------------------------------------------------------------
{
  const t = make();
  t.fire({ from: new THREE.Vector3(), to: new THREE.Vector3(0, 0, -100), weapon: RIFLE });
  t.clear();
  assert(t.live.length === 0, 'clear drops the streaks');
  assert(t._shots.size === 0, 'and the per-weapon counts with them');
  assert(t._geo.drawRange.count === 0, 'and draws nothing');
}

if (failures) {
  console.error(`bulletTracers.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('bulletTracers.test.js: ok');
