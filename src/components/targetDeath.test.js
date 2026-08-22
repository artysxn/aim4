// Run: node src/components/targetDeath.test.js
//
// Target's two deaths.
//
// The default one scales the target up 1.6x and walks every mesh's opacity
// down — right for a sphere or a capsule bot, wrong for a body that is
// animating its own fall, and actively dangerous for one whose meshes are
// SkeletonUtils clones sharing geometry and textures with the template every
// future bot is cloned from.
//
// So a target may claim its death (`deathHandler`), and when it does it must
// get BOTH halves: no scale-up, no material walk, and a `dt` of its own —
// scenarios stop calling `model.update()` once a target is dying, so this
// callback is the only clock a death animation gets.

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const THREE = await import('three');
const { Target } = await import('./Target.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

function mesh() {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
}

// ---- the default death, unchanged -------------------------------------------
{
  const t = new Target();
  const m = t.addCollider(mesh(), { zone: 'body' });
  t.spawnT = t.spawnDuration; // past the pop-in
  t.startDying();
  assert(m.material.transparent, 'the default death primes transparency');
  t.update(t.dyingDuration / 2);
  assert(t.object.scale.x > 1, 'the default death still scales up');
  close(m.material.opacity, 0.5, 1e-6, 'the default death still walks opacity');
  t.update(t.dyingDuration);
  assert(t.alive === false, 'the default death still reaps');
}

// ---- a target that owns its death -------------------------------------------
{
  const t = new Target();
  const m = t.addCollider(mesh(), { zone: 'body' });
  t.spawnT = t.spawnDuration;
  t.object.scale.setScalar(1);
  t.dyingDuration = 1.3;
  const calls = [];
  t.deathHandler = (p, dt) => calls.push([p, dt]);

  t.startDying();
  assert(calls.length === 1, 'startDying opens the handler');
  close(calls[0][0], 0, 1e-9, 'it opens at t = 0');
  close(calls[0][1], 0, 1e-9, 'with no elapsed time yet');
  assert(!m.material.transparent, 'no material was primed behind its back');

  t.update(0.65);
  close(calls[1][0], 0.5, 1e-9, 'progress is a fraction of dyingDuration');
  close(calls[1][1], 0.65, 1e-9, 'and dt is the frame that just passed');
  close(t.object.scale.x, 1, 1e-9, 'no scale-up pop');
  close(m.material.opacity, 1, 1e-9, 'no opacity walk — the model owns the fade');
  assert(t.alive, 'still alive halfway through');

  t.update(0.65);
  close(calls[2][0], 1, 1e-9, 'progress clamps at 1');
  assert(t.alive === false, 'and the target is reaped on time either way');

  // Sum of the dts is the whole window, which is what an animation needs.
  const total = calls.reduce((a, [, dt]) => a + dt, 0);
  close(total, 1.3, 1e-9, 'the handler is handed the whole window in dt');
}

// ---- a second startDying is still a no-op -----------------------------------
{
  const t = new Target();
  t.addCollider(mesh(), { zone: 'body' });
  let n = 0;
  t.deathHandler = () => n++;
  t.startDying();
  t.startDying();
  assert(n === 1, 'dying twice does not restart the animation');
}

if (failures) {
  console.error(`targetDeath.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('targetDeath.test.js: ok');
