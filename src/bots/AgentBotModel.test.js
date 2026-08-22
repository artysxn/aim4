// Run: node src/bots/AgentBotModel.test.js
//
// The CS2 agent bot's adapter layer: the part that turns what a trainer
// scenario does (move and turn a root, in metres, with +z as yaw zero) into
// what CS2's animation blend reads (Source units and Source degrees, with +x
// as yaw zero and yaw growing to the LEFT).
//
// Three things here fail silently in a way that still animates:
//
//   1. **The yaw sign.** `θ = ψ − 90` and `θ = 90 − ψ` differ by a negation,
//      and only the difference `moveYaw − viewYaw` reaches the blend — so the
//      offset cancels and the SIGN is the whole of what matters. Get it wrong
//      and a bot strafing left plays the strafe-right loop: legs move, cadence
//      is right, feet go the wrong way.
//   2. **The hitbox bone names.** The pack's hit table names bones in lower
//      case and the skeleton does not. Matching case-sensitively finds the
//      seven bones with no side suffix and misses all twelve that have one —
//      a bot you can shoot in the chest and not in the arms or the legs.
//   3. **The teleport guard.** A respawn moves the root across the arena in
//      one frame. Without the guard that is a measured 400 m/s and the bot
//      sprints on the spot for as long as the smoother takes to catch up.

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const THREE = await import('three');
const { AgentBotModel, hitboxMesh } = await import('./AgentBotModel.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) return;
  failures++;
  console.error(`  FAIL ${msg}`);
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- a stand-in for the pack ------------------------------------------------
// Bone names carry the skeleton's capitalisation; the hit table's do not,
// exactly as ctm_sas.vmdl_c ships them.
const BONES = ['pelvis', 'spine_1', 'head_0', 'arm_upper_L', 'arm_upper_R', 'leg_upper_L', 'leg_upper_R'];
const BOXES = [
  { name: 'head_0', bone: 'head_0', min: [-1, 1.8, 0], max: [3.5, 0.2, 0], radius: 4.3, group: 1 },
  { name: 'spine_1', bone: 'spine_1', min: [3.8, 0.8, -2.4], max: [3.8, 0.4, 2.4], radius: 6.5, group: 2 },
  { name: 'pelvis', bone: 'pelvis', min: [-2.7, 1.1, -3.2], max: [-2.7, 1.1, 3.2], radius: 6, group: 3 },
  { name: 'arm_upper_l', bone: 'arm_upper_l', min: [0, 0, 0], max: [10, 0, 0], radius: 3, group: 4 },
  { name: 'arm_upper_r', bone: 'arm_upper_r', min: [0, 0, 0], max: [10, 0, 0], radius: 3, group: 5 },
  { name: 'leg_upper_l', bone: 'leg_upper_l', min: [0, 0, 0], max: [16, 0, 0], radius: 4, group: 6 },
  { name: 'leg_upper_r', bone: 'leg_upper_r', min: [0, 0, 0], max: [16, 0, 0], radius: 4, group: 7 },
  { name: 'nowhere', bone: 'bone_the_model_lacks', min: [0, 0, 0], max: [1, 0, 0], radius: 1, group: 2 }
];

function stubBody(side) {
  const model = new THREE.Object3D();
  model.name = 'ctm_sas';
  const byName = new Map();
  for (const n of BONES) {
    const b = new THREE.Object3D();
    b.name = n;
    model.add(b);
    byName.set(n, b);
    if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), b);
  }
  const wpn = new THREE.Object3D();
  wpn.name = 'wpn';
  model.add(wpn);
  byName.set('wpn', wpn);

  const group = new THREE.Group();
  group.add(model);
  return {
    side,
    group,
    model,
    meshes: [],
    hitboxes: { boxes: BOXES },
    states: [],
    disposed: false,
    opacity: 1,
    boneNamed(name) {
      return byName.get(name) || byName.get(String(name).toLowerCase()) || null;
    },
    set(s) {
      this.states.push({ ...s });
    },
    update() {},
    setOpacity(v) {
      this.opacity = v;
    },
    deathDuration() {
      return 2.47;
    },
    dispose() {
      this.disposed = true;
    }
  };
}

function stubModels() {
  return {
    manifest: { frame: { rootRotationX: -90 } },
    made: [],
    createBody(side) {
      const b = stubBody(side);
      this.made.push(b);
      return b;
    }
  };
}

function makeBot(opts = {}) {
  const models = stubModels();
  const bot = new AgentBotModel({ models, ...opts });
  return { bot, models, body: models.made[0] };
}

// ---- hitboxes ---------------------------------------------------------------
{
  const { bot, body } = makeBot();
  assert(bot.colliders.length === 7, `one collider per box whose bone exists (got ${bot.colliders.length})`);
  const zones = bot.colliders.map((c) => c.userData.zone);
  assert(zones.filter((z) => z === 'head').length === 1, 'exactly the head group is a headshot');
  assert(zones.filter((z) => z === 'body').length === 6, 'everything else is a body shot');
  const groups = bot.colliders.map((c) => c.userData.hitgroup).sort();
  assert(
    JSON.stringify(groups) === JSON.stringify(['chest', 'head', 'left_arm', 'left_leg', 'right_arm', 'right_leg', 'stomach']),
    `hitgroups carry through: ${groups}`
  );

  // The case-insensitive lookup is the point: every side-suffixed bone matched.
  for (const key of ['arm_upper_L', 'arm_upper_R', 'leg_upper_L', 'leg_upper_R']) {
    const bone = body.boneNamed(key);
    assert(bone.children.some((c) => c.isMesh), `${key} carries a hit capsule`);
  }
  // A box naming a bone the model lacks is skipped, not crashed on.
  assert(!bot.colliders.some((c) => c.userData.hitgroup === undefined), 'no untagged collider');

  assert(bot.headMesh && bot.headMesh.userData.zone === 'head', 'headMesh is the head capsule');
  assert(bot.headMesh.parent === body.boneNamed('head_0'), 'headMesh hangs off the head bone');
  assert(bot.colliders.every((c) => c.visible === false), 'hit capsules are never drawn');
}

// ---- hitboxMesh: capsule vs sphere ------------------------------------------
{
  const capsule = hitboxMesh({ min: [0, 0, 0], max: [10, 0, 0], radius: 3 });
  assert(capsule.geometry.type === 'CapsuleGeometry', `a segment makes a capsule, got ${capsule.geometry.type}`);
  close(capsule.position.x, 5, 1e-9, 'capsule sits at the segment midpoint');

  const sphere = hitboxMesh({ min: [2, 3, 4], max: [2, 3, 4], radius: 3 });
  assert(sphere.geometry.type === 'SphereGeometry', `coincident ends make a sphere, got ${sphere.geometry.type}`);
  close(sphere.position.x, 2, 1e-9, 'sphere sits on the point');
  close(sphere.position.y, 3, 1e-9, 'sphere sits on the point (y)');

  // A zero radius would be an unhittable hitbox; it is floored instead.
  const degenerate = hitboxMesh({ min: [0, 0, 0], max: [0, 0, 0], radius: 0 });
  assert(degenerate.geometry.parameters.radius > 0, 'a zero radius is floored');
}

// ---- yaw and pitch into the blend's frame -----------------------------------
{
  const { bot, body } = makeBot();
  const root = new THREE.Group();
  root.add(bot.root);

  // Frame one plants; from then on the root's motion is the gait's input.
  bot.setYaw(0);
  bot.update(1 / 128, {});
  body.states.length = 0;

  // Facing +z (yaw 0) in a right-handed frame with +y up, the bot's own right
  // is forward × up = −x. So walking toward +x is a strafe to its LEFT, which
  // in Source's counter-clockwise yaw is +90° relative — the "w" loop.
  const step = 3 / 128; // 3 m/s
  bot.root.position.set(step, 0, 0);
  root.updateMatrixWorld(true);
  bot.update(1 / 128, {});
  const s = body.states.at(-1);
  assert(s, 'the blend was driven');
  const rel = ((((s.moveYaw - s.viewYaw) + 180) % 360) + 360) % 360 - 180;
  close(rel, 90, 1e-6, 'strafing left is +90° relative (the "w" loop), not −90');
  // 3 m/s is 118 u/s. A missing conversion would hand the blend 3, which is
  // under IDLE_SPEED — a bot sliding around in its idle pose.
  close(s.speed, 3 / 0.0254, 1e-6, 'speed reaches the blend in Source u/s, not metres');

  // ...and to the RIGHT is the mirror of it.
  bot.root.position.set(step - step * 2, 0, 0);
  root.updateMatrixWorld(true);
  bot.update(1 / 128, {});
  const s2 = body.states.at(-1);
  const rel2 = ((((s2.moveYaw - s2.viewYaw) + 180) % 360) + 360) % 360 - 180;
  close(rel2, -90, 1e-6, 'strafing right is −90° relative (the "e" loop)');
}

// ---- pitch sign -------------------------------------------------------------
{
  const { bot, body } = makeBot();
  bot.update(1 / 128, {});
  bot.setPitch(Math.PI / 6); // the trainer's pitch is positive UP
  bot.update(1 / 128, {});
  const s = body.states.at(-1);
  close(s.pitch, -30, 1e-6, 'Source pitch is positive DOWN, so looking up is negative');
}

// ---- the teleport guard -----------------------------------------------------
{
  const { bot, body } = makeBot();
  bot.update(1 / 128, {});
  body.states.length = 0;
  // A respawn: 30 m in one tick.
  bot.root.position.set(30, 0, 0);
  bot.root.updateMatrixWorld(true);
  bot.update(1 / 128, {});
  const s = body.states.at(-1);
  close(s.speed, 0, 1e-9, 'a teleport plants the gait instead of sprinting it');
}

// ---- aimAt ------------------------------------------------------------------
{
  const { bot } = makeBot();
  // The trainer's convention: yaw 0 faces +z, and aimAt is atan2(dx, dz).
  bot.aimAt(0, 1.6, 5);
  close(bot.root.rotation.y, 0, 1e-9, 'a target straight ahead is yaw 0');
  bot.aimAt(5, 1.6, 0);
  close(bot.root.rotation.y, Math.PI / 2, 1e-9, 'a target to the right is yaw +90°');
}

// ---- width scaling is lateral only ------------------------------------------
{
  const { bot, body } = makeBot({ widthScale: 0.6 });
  close(body.group.scale.y / body.group.scale.x, 1 / 0.6, 1e-9, 'a narrower bot is not a shorter one');
}

// ---- dispose ----------------------------------------------------------------
{
  const { bot, body } = makeBot();
  bot.dispose();
  assert(body.disposed, 'the body goes with the bot');
  assert(bot.colliders.length === 0, 'colliders are released');
}

if (failures) {
  console.error(`AgentBotModel.test.js: ${failures} failure(s)`);
  process.exit(1);
}
console.log('AgentBotModel.test.js: ok');
