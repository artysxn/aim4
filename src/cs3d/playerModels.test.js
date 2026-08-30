// Run: node src/cs3d/playerModels.test.js
//
// The aim tilt must be idempotent.
//
// PlayerBody applies the view pitch to the spine AFTER the mixer, by
// premultiplying onto the bone. That is only safe if the pose underneath is
// rewritten every frame, and three does not promise that: PropertyMixer.apply
// ends with a compare, and when this frame's blended value is bit-identical to
// the last one it never calls binding.setValue at all. The bone then still
// holds the tilt from the previous frame, and the next tilt lands on top of it.
//
// In the viewer that is every paused frame, every forced redraw, and every
// scrub that lands on a tick whose pose has not moved. Two redraws leaned the
// torso, five folded the body through its own chest with the arms overhead,
// and it compounded down the chain because each bone inherits its parent's
// error as well as its own.
//
// So the property under test is not "the tilt is correct" but "applying it N
// times is the same as applying it once", which is what the fix (restore the
// mixer's pose first) actually guarantees.

// three/webgpu reads `self` at module scope for GPUShaderStage. Nothing here
// touches the GPU — PlayerBody's bone maths is plain three — so a shim is
// enough to get the module graph to load under node.
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;

const { Bone, Object3D, AnimationClip, QuaternionKeyframeTrack, VectorKeyframeTrack, Quaternion } = await import('three');
const { PlayerBody } = await import('./playerModels.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---- a rig with the bones the tilt touches ---------------------------------

/** The chain AIM_BONES walks, under the model root that cs3d-models writes. */
const CHAIN = ['pelvis', 'spine_0', 'spine_1', 'spine_2', 'spine_3', 'neck_0', 'head_0'];

function makeRig() {
  const scene = new Object3D();
  scene.name = 'model';
  const root = new Bone();
  root.name = 'root_motion';
  root.rotation.x = -Math.PI / 2; // the packed model's Source→scene root
  scene.add(root);
  let parent = root;
  for (const name of CHAIN) {
    const b = new Bone();
    b.name = name;
    b.position.set(0, 4, 0);
    // A rest orientation of its own, so an identity pose cannot hide a bug.
    b.quaternion.setFromAxisAngle(new Quaternion(0, 0, 1, 0).set(0.3, 0.6, 0.74, 0), 0.12);
    parent.add(b);
    parent = b;
  }
  return scene;
}

/** A clip that animates the whole chain, so every aim bone has a binding. */
function makeClip(name, duration) {
  const tracks = [];
  for (const bone of CHAIN) {
    const a = new Quaternion().setFromAxisAngle(new Quaternion(0, 1, 0, 0).set(0, 1, 0, 0), 0.05);
    const b = new Quaternion().setFromAxisAngle(new Quaternion(0, 1, 0, 0).set(0, 1, 0, 0), -0.05);
    tracks.push(
      new QuaternionKeyframeTrack(`${bone}.quaternion`, [0, duration], [a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w])
    );
    tracks.push(new VectorKeyframeTrack(`${bone}.position`, [0, duration], [0, 4, 0, 0, 4, 0]));
  }
  return new AnimationClip(name, duration, tracks);
}

function makeModels() {
  const clips = new Map();
  for (const name of ['idle', 'run_n', 'run_ne', 'run_e', 'walk_n', 'idle_crouch', 'crouch_n']) {
    clips.set(name, makeClip(name, 0.8));
  }
  return {
    models: {
      T: { scene: makeRig(), hitboxes: [], bones: CHAIN, name: 'test_t' },
      CT: { scene: makeRig(), hitboxes: [], bones: CHAIN, name: 'test_ct' }
    },
    clips: { rifle: clips, shared: new Map([['death_front', makeClip('death_front', 0.4)]]) },
    gait: { rifle: { run: 224.4, walk: 115, crouch: 93.4 } },
    getProbeGrid: () => null,
    // No meshes in the rig, so this is never reached; present for shape.
    buildMaterial: () => null
  };
}

const snapshot = (body) => body.aimBones.map(({ bone }) => bone.quaternion.clone());
const compare = (a, b, tol, label) => {
  for (let i = 0; i < a.length; i++) {
    close(a[i].x, b[i].x, tol, `${label} bone ${i} x`);
    close(a[i].y, b[i].y, tol, `${label} bone ${i} y`);
    close(a[i].z, b[i].z, tol, `${label} bone ${i} z`);
    close(a[i].w, b[i].w, tol, `${label} bone ${i} w`);
  }
};

const STATE = {
  speed: 220,
  moveYaw: 0,
  viewYaw: 0,
  pitch: 30,
  duck: 0,
  airborne: false,
  weapon: 'weapon_ak47',
  alive: true
};

// ---- a still frame, redrawn, must not move the body ------------------------
{
  const body = new PlayerBody(makeModels(), 'CT');
  body.set(STATE);
  // Settle: the pitch input is smoothed, so let it reach the target first.
  for (let i = 0; i < 60; i++) body.update(1 / 64);
  assert(body.aimBones.length === 5, `all five aim bones resolved (got ${body.aimBones.length})`);

  const tilted = snapshot(body);
  // The tilt must actually be doing something, or idempotence is vacuous.
  const rest = makeRig();
  let moved = 0;
  for (const { bone } of body.aimBones) {
    const r = rest.getObjectByName(bone.name);
    if (r && bone.quaternion.angleTo(r.quaternion) > 1e-3) moved++;
  }
  assert(moved === 5, `the tilt reaches every aim bone (${moved}/5 moved off the rest pose)`);

  // The reported reproduction: same tick, redrawn. dt = 0 means the mixer
  // blends to the identical value and skips the write.
  for (let i = 0; i < 8; i++) body.update(0);
  compare(tilted, snapshot(body), 1e-12, 'eight redraws of one tick');
}

// ---- the tilt stays bounded by the clamp -----------------------------------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set({ ...STATE, pitch: 89 });
  for (let i = 0; i < 60; i++) body.update(1 / 64);
  const rest = makeRig();
  for (const { bone, w } of body.aimBones) {
    const r = rest.getObjectByName(bone.name);
    const swing = (bone.quaternion.angleTo(r.quaternion) * 180) / Math.PI;
    // 55° is AIM_PITCH_LIMIT; each bone takes its weight of it, and the parent
    // frame it is expressed in can only rotate the axis, not lengthen it.
    assert(swing <= 55 * w + 1e-6, `${bone.name} takes ${swing.toFixed(2)}°, its share of the clamp is ${(55 * w).toFixed(2)}°`);
  }
  // ...and looking down 89° repeatedly must not walk past it either.
  for (let i = 0; i < 200; i++) body.update(0);
  for (const { bone, w } of body.aimBones) {
    const r = rest.getObjectByName(bone.name);
    const swing = (bone.quaternion.angleTo(r.quaternion) * 180) / Math.PI;
    assert(swing <= 55 * w + 1e-6, `${bone.name} after 200 redraws: ${swing.toFixed(2)}° vs ${(55 * w).toFixed(2)}°`);
  }
}

// ---- scrubbing back a tick at a time ---------------------------------------
//
// This is the case the operator reported, in the shape the viewer actually
// produces it: view3d.js advances the mixers by the TICK DELTA and clamps it
// to forward only, so dragging the slider backwards hands out dt = 0 on every
// frame while the state keeps changing underneath. Nothing about the pose may
// drift across that.
{
  const body = new PlayerBody(makeModels(), 'CT');
  body.set(STATE);
  for (let i = 0; i < 60; i++) body.update(1 / 64);
  const atRest = snapshot(body);
  for (let tick = 100; tick > 60; tick--) {
    body.set({ ...STATE, viewYaw: tick * 2, pitch: 30 - (100 - tick) * 0.5, speed: 220 - (100 - tick) });
    body.update(0);
  }
  compare(atRest, snapshot(body), 1e-12, 'forty ticks scrubbed backwards');
}

// ---- a negative delta must not blow the smoothers up ------------------------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set(STATE);
  for (let i = 0; i < 60; i++) body.update(1 / 64);
  // A second of demo time backwards. With the easing taken on dt rather than
  // |dt| this factor is about -2.7e5 and every smoothed input leaves its range
  // on the first step.
  body.update(-1);
  assert(Number.isFinite(body.speed) && body.speed >= -1 && body.speed <= 400, `speed stays sane (${body.speed})`);
  assert(body.duck >= -1e-9 && body.duck <= 1, `duck stays in range (${body.duck})`);
  assert(body.air >= -1e-9 && body.air <= 1, `air stays in range (${body.air})`);
  assert(Math.abs(body.pitch) <= 90, `pitch stays in range (${body.pitch})`);
  for (const { bone } of body.aimBones) {
    const q = bone.quaternion;
    assert(Number.isFinite(q.x + q.y + q.z + q.w), `${bone.name} is finite after a backward step`);
  }
}

// ---- a body that never tilts is left alone ---------------------------------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set({ ...STATE, pitch: 0 });
  for (let i = 0; i < 30; i++) body.update(1 / 64);
  const rest = makeRig();
  for (const { bone } of body.aimBones) {
    const r = rest.getObjectByName(bone.name);
    // Level view: the clip's own animation is all that moved these bones, and
    // the clip rotates about y by 0.05 rad at most.
    assert(bone.quaternion.angleTo(r.quaternion) < 0.2, `${bone.name} is left near its clip pose when the view is level`);
  }
  const level = snapshot(body);
  for (let i = 0; i < 8; i++) body.update(0);
  compare(level, snapshot(body), 1e-12, 'level view, eight redraws');
}

// ---- a corpse stays visible and holds the death pose -----------------------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set(STATE);
  for (let i = 0; i < 8; i++) body.update(1 / 64);
  body.set({ ...STATE, alive: false });
  body.update(0);
  assert(body.group.visible, 'a dead body is still drawn');
  assert(body._deadHold, 'death clip is held');
  body.update(1);
  assert(body.group.visible, 'the corpse is still there a second later');
  body.set({ ...STATE, alive: true });
  body.update(1 / 64);
  assert(!body._deadHold, 'respawn drops the death clip');
}

// ---- a kill with a bullet force becomes a ragdoll, not the death clip ------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set(STATE);
  for (let i = 0; i < 8; i++) body.update(1 / 64);
  body.startRagdoll({ force: { x: 80, y: 20, z: 0 }, hitPos: { x: 0, y: 20, z: 0 } });
  body.set({ ...STATE, alive: false });
  body.update(1 / 64);
  assert(body._ragdoll?.active, 'the skeleton is simulating');
  assert(!body._deadHold, 'ragdoll skips the held death clip');
  body.update(0.2);
  assert(body.group.visible, 'the ragdoll stays drawn');
  body.set({ ...STATE, alive: true });
  body.update(1 / 64);
  assert(!body._ragdoll, 'respawn restores the bind pose');
}

// ---- a body revived after a ragdoll death animates again --------------------
//
// _beginRagdoll calls mixer.stopAllAction(), and a stopped action ignores the
// weights _blend writes. Reviving that body (a round switch, a scrub back over
// the kill) therefore left every locomotion loop inert: the restored pose held
// while the position kept updating, which on screen was a lobby of players
// gliding around frozen. The revive branch must put the loops back in play.
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set(STATE);
  for (let i = 0; i < 30; i++) body.update(1 / 64);
  body.startRagdoll({ force: { x: 80, y: 20, z: 0 }, hitPos: { x: 0, y: 20, z: 0 } });
  body.set({ ...STATE, alive: false });
  body.update(1 / 64);
  assert(body._ragdoll?.active, 'the kill ragdolled (stopAllAction has run)');

  // The kill deactivated the loops (that is what stopAllAction does), and a
  // deactivated action ignores the weight and time _blend writes every frame.
  const stopped = [...body.actions.values()].filter(
    (a) => a.timeScale === 0 && !body.mixer._isActiveAction(a)
  );
  assert(stopped.length > 0, 'precondition: the ragdoll death deactivated the loops');

  // The round switches back: same slot, alive, running. Every loop must be
  // back in play or the body holds its restored pose while the position moves.
  body.set(STATE);
  body.update(1 / 64);
  const inert = [...body.actions.values()].filter(
    (a) => a.timeScale === 0 && !body.mixer._isActiveAction(a)
  );
  assert(
    inert.length === 0,
    `a revived body must animate again, not glide frozen (${inert.length} loops still stopped)`
  );
}

// ---- TraceAttack punch tilts the spine on top of the view pitch ------------
{
  const body = new PlayerBody(makeModels(), 'T');
  body.set(STATE);
  for (let i = 0; i < 60; i++) body.update(1 / 64);
  const before = snapshot(body);
  body.applyFlinch({ pitch: -12, yaw: 0, roll: 0 });
  body.update(0);
  let moved = 0;
  const after = snapshot(body);
  for (let i = 0; i < before.length; i++) {
    if (before[i].angleTo(after[i]) > 1e-4) moved++;
  }
  assert(moved === before.length, `flinch reaches every aim bone (${moved}/${before.length})`);
}

console.log('playerModels: aim tilt OK');
