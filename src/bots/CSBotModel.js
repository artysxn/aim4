// ---------------------------------------------------------------------------
// CSBotModel.js
// A CS:GO / CS2-style skeletal bot model for three.js: a bone hierarchy at CS
// proportions (72 u ≈ 1.83 m tall, eye line ≈ 64 u) whose limbs and torso are
// capsule meshes — the capsules ARE the hitboxes, so what you see is exactly
// what you can hit. Poses are driven by a small port of the CS player anim
// state, rebuilt from the public Source SDK architecture + community docs
// (no game code or assets):
//
//   · Aim matrix    — eye pitch/yaw distributed procedurally over the spine,
//                     neck and head (upper body decoupled from locomotion).
//   · Lower-body yaw — feet chase the eyes at CS:GO rates (30–50°/s moving,
//                     100°/s standing replant) inside an aim-matrix width that
//                     narrows with speed; on stop they stay planted for 0.22 s,
//                     then realign (and every 1.1 s after) — the LBY mechanic.
//   · Locomotion    — CS:GO move-yaw gait: the stride heading chases the
//                     measured travel direction (snapping on move-start like
//                     the eight-way start cycles), locomotion weight normalises
//                     to the stance's top speed (walk / crouch-walk), cadence
//                     is tied to ground speed over stride so feet don't skate,
//                     and rapid stop/starts damp the gait via a stutter-step
//                     counter instead of pumping it.
//   · Lean          — the lower body leans into the travel direction while the
//                     spine counter-rotates, so the torso (and the aim) stays
//                     upright and only the legs/hips telegraph the movement.
//   · Combat stance — staggered feet at rest (support foot forward, weapon foot
//                     back, knees slightly bent — a shooting stance), and while
//                     strafing the lead-side leg plants wider toward the travel
//                     direction than the trailing leg.
//   · Jump / land   — airborne state (passed by the scenario via onGround, or
//                     inferred from root vertical motion) tucks the legs and
//                     fades the gait; landings dip into a brief crouch scaled
//                     by hang time / fall height (CS:GO duck-additional).
//   · Crouch        — pose blend (pelvis drop + knee fold + hunch) driven by
//                     the same 0..1 crouch amount the movement code already uses.
//
// The model measures its own world velocity from its root position, and reads
// eye yaw from its root rotation, so scenarios only position/rotate the bot
// (exactly like they already do) and call update(dt, { crouch, onGround }).
//
// Hitboxes: every capsule mesh is tagged with userData.zone ('head' | 'body')
// and userData.hitgroup (chest / stomach / pelvis / arms / legs) matching the
// Source hitgroup layout, and works with the existing Raycaster hit pipeline.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { RUN_SPEED, WALK_SPEED, CROUCH_SPEED } from '../utils/SourceMovement.js';
import { buildGunModel } from '../weapons/gunModels.js';

// ---- Proportions (m). 1 Source unit = 0.0254 m; CS player hull = 72 u. ----
export const MODEL_HEIGHT = 1.83; // 72 u
export const HEAD_CENTER_STAND = 1.655; // ≈ 65 u (CS eye line 64 u ≈ 1.63 m)
export const HEAD_CENTER_CROUCH = 1.21; // crouched head centre (CS eye 46 u ≈ 1.17)

const HIP_Y = 0.95;
const HIP_HALF = 0.095; // hip joint half-spacing
const FOOT_HALF = 0.105; // foot rest half-spacing
const THIGH_LEN = 0.44;
const CALF_LEN = 0.44;
const ANKLE_H = 0.07;
const SPINE0_UP = 0.12; // pelvis → spine_0
const SPINE1_UP = 0.12; // spine_0 → spine_1
const CHEST_UP = 0.11; // spine_1 → chest
const SHOULDER_X = 0.185;
const SHOULDER_UP = 0.155;
const UPPER_ARM = 0.28;
const FOREARM = 0.26;
const NECK_UP = 0.195; // chest → neck
const HEAD_UP = 0.075; // neck → head joint
const CROUCH_DROP = 0.445; // pelvis drop at full crouch → head lands at HEAD_CENTER_CROUCH

// ---- Lower-body yaw (LBY) — CS:GO timings from public community research ----
const LBY_STOP_DELAY = 0.22; // s after stopping before feet realign to eyes
const LBY_REPEAT = 1.1; // s between realigns while standing still
const MAX_FOOT_DESYNC = THREE.MathUtils.degToRad(58); // aim-matrix yaw extent
const FOOT_CHASE_WALK = THREE.MathUtils.degToRad(30); // °/s feet chase eyes at a walk
const FOOT_CHASE_RUN = THREE.MathUtils.degToRad(50); // °/s at a full run
const FOOT_CHASE_IDLE = THREE.MathUtils.degToRad(100); // °/s during a standing replant
const AIM_NARROW_WALK = 0.8; // aim-matrix width narrows as speed rises…
const AIM_NARROW_RUN = 0.5;
const AIM_NARROW_CROUCH = 0.5; // …and while crouch-walking
const MOVE_EPS = 0.15; // m/s — "velocity > 0.1" threshold, scaled to metres

// ---- Gait tuning ----
const STRIDE_HALF_RUN = 0.48; // m half-stride at a full run (wider steps)
const STRIDE_HALF_WALK = 0.34; // m half-stride at walk speeds
const STRIDE_HALF_CROUCH = 0.26; // m half-stride while crouch-walking
const LIFT_RUN = 0.12; // m foot lift at full run
const BOB_RUN = 0.015; // m pelvis bob at full run
const PITCH_RATE = 18; // 1/s aim-pitch smoothing
const GAIT_DIR_BIAS = 0.18; // move-yaw chase ratio = Bias(weight, 0.18) + 0.1
const ALIGN_DAMP_BIAS = 0.2; // gait fade when travel disagrees with its heading
const STUTTER_WINDOW = 0.25; // s — a stop/start inside this window is a stutter-step
const WALK_RUN_RATE = 2.0; // 1/s walk↔run gait transition

// ---- Velocity / lean smoothing ----
const VEL_APPROACH = 50; // m/s² anim-velocity chase (smooths wall-stops)
const LEAN_RATE = 12; // 1/s lean smoothing
const MAX_LEAN = THREE.MathUtils.degToRad(8); // travel-lean cap (lower body only)

// ---- Combat stance (staggered shooting pose) ----
const STANCE_DROP = 0.045; // m pelvis drop at rest — keeps the knees slightly bent
const STAGGER_FWD = 0.11; // m the left (support) foot leads…
const STAGGER_BACK = 0.13; // m …and the right (weapon) foot trails
const STANCE_WIDE = 0.03; // m extra half-width of the planted base
const STRAFE_WIDE_LEAD = 0.1; // m lead leg widens toward the travel side
const STRAFE_WIDE_TRAIL = 0.05; // m trail leg tucks under the body

// ---- Air / landing ----
const AIR_APPROACH_STAND = 8; // 1/s fuzzy on-ground blend (16 when crouched)
const AIR_APPROACH_CROUCH = 16;
const AIR_VY_TAKEOFF = 2.5; // m/s upward — infer airborne (a jump starts at ~7.7)
const AIR_TUCK_Y = 0.33; // m feet pull up to this height above the root while airborne
const LAND_DIP_MAX = 0.55; // cap on the landing crouch dip
const LAND_DIP_DECAY = 2; // 1/s dip recovery after landing

// Capsule dims (mirror _buildSkeleton) — anchor math for joint bridges.
const THIGH_CAP_R = 0.088;
const THIGH_CAP_SEG = THIGH_LEN - 0.176;
const KNEE_CAP_R = 0.062;
const KNEE_CAP_SEG = 0.30;
const KNEE_CAP_Y = -0.215;
const FOOT_CAP_R = 0.048;
const FOOT_CAP_SEG = 0.15;
const FOOT_CAP_Y = -0.015;
const FOOT_CAP_Z = 0.06;
const SHOULDER_CAP_R = 0.056;
const SHOULDER_CAP_SEG = UPPER_ARM - 0.112;
const FORE_CAP_R = 0.048;
const FORE_CAP_SEG = 0.2;
const FORE_CAP_Y = -0.16;

const NEG_Y = new THREE.Vector3(0, -1, 0);
const _yUp = new THREE.Vector3(0, 1, 0);

// Scratch objects (module-level, reused every call — no per-frame allocation).
const _wp = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikN = new THREE.Vector3();
const _ikNLocal = new THREE.Vector3();
const _ikQa = new THREE.Quaternion();
const _ikQb = new THREE.Quaternion();
const _ikQinv = new THREE.Quaternion();
const _legTarget = new THREE.Vector3();
const _legPole = new THREE.Vector3();
const _footQ = new THREE.Quaternion();
const _toeQ = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _jointA = new THREE.Vector3();
const _jointB = new THREE.Vector3();
const _jointDir = new THREE.Vector3();

function wrapPI(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Linear chase toward `target` by at most `maxDelta` (Source Approach()). */
function approach(target, cur, maxDelta) {
  if (cur < target) return Math.min(cur + maxDelta, target);
  return Math.max(cur - maxDelta, target);
}

/** approach() over the shortest angular path. */
function approachAngle(target, cur, maxDelta) {
  return wrapPI(cur + THREE.MathUtils.clamp(wrapPI(target - cur), -maxDelta, maxDelta));
}

/** Source Bias(): remaps x∈0..1 so the curve passes through `b` at x = 0.5. */
function bias(x, b) {
  return Math.pow(x, Math.log(b) / Math.log(0.5));
}

/** Source RemapValClamped(). */
function remapClamp(x, inA, inB, outA, outB) {
  const t = THREE.MathUtils.clamp((x - inA) / (inB - inA), 0, 1);
  return outA + (outB - outA) * t;
}

/**
 * Analytic two-bone IK. Both bones rest along local -Y (`upper` at a fixed
 * position under its parent, `lower` a child of `upper` at (0, -aLen, 0)).
 * `target` and `pole` are expressed in `upper.parent`'s local frame; the chain
 * end (lower's child at (0, -bLen, 0)) lands on `target`, with the mid joint
 * bending toward `pole`'s side of the shoulder→target line.
 */
export function solveTwoBone(upper, lower, aLen, bLen, target, pole) {
  _ikDir.copy(target).sub(upper.position);
  let d = _ikDir.length();
  if (d < 1e-6) {
    _ikDir.copy(NEG_Y);
    d = 1e-6;
  } else {
    _ikDir.divideScalar(d);
  }
  d = Math.min(d, aLen + bLen - 1e-4);

  _ikN.crossVectors(_ikDir, pole);
  if (_ikN.lengthSq() < 1e-8) _ikN.set(1, 0, 0);
  else _ikN.normalize();

  const cosA = THREE.MathUtils.clamp((aLen * aLen + d * d - bLen * bLen) / (2 * aLen * d), -1, 1);
  const alpha = Math.acos(cosA);
  const cosB = THREE.MathUtils.clamp((aLen * aLen + bLen * bLen - d * d) / (2 * aLen * bLen), -1, 1);
  const bend = Math.PI - Math.acos(cosB);

  _ikQa.setFromUnitVectors(NEG_Y, _ikDir);
  _ikQb.setFromAxisAngle(_ikN, alpha);
  upper.quaternion.multiplyQuaternions(_ikQb, _ikQa);

  _ikNLocal.copy(_ikN).applyQuaternion(_ikQinv.copy(upper.quaternion).invert());
  lower.quaternion.setFromAxisAngle(_ikNLocal, -bend);
}

export class CSBotModel {
  /**
   * @param {object} opts
   * @param {number|string} opts.bodyColor  body capsule color
   * @param {number|string} opts.headColor  head + neck capsule color
   * @param {number} opts.widthScale        multiplies capsule radii (tracking difficulty)
   * @param {number} opts.scale             uniform scale of the whole model
   * @param {boolean} opts.rifle            attach the shared rifle world model
   */
  constructor({
    bodyColor = 0xff5544,
    headColor = 0xffd24a,
    widthScale = 1,
    scale = 1,
    rifle = true
  } = {}) {
    this._w = widthScale;
    this._bodyMat = new THREE.MeshStandardMaterial({
      color: bodyColor,
      emissive: bodyColor,
      emissiveIntensity: 0.4,
      roughness: 0.5
    });
    this._headMat = new THREE.MeshStandardMaterial({
      color: headColor,
      emissive: headColor,
      emissiveIntensity: 0.5,
      roughness: 0.4
    });

    this.colliders = [];
    this.visualMeshes = [];
    this._dynamicJoints = [];

    this._buildSkeleton();
    if (scale !== 1) this.root.scale.setScalar(scale);
    if (rifle) this._attachRifle();
    this._poseArms();

    // ---- Anim state ----
    this._footYaw = 0;
    this._lbyRealignIn = LBY_STOP_DELAY;
    this._adjusting = false;
    this._phase = 0;
    this._amp = 0;
    this._lift = 0;
    this._pitch = 0;
    this._pitchTarget = 0;
    this._crouch = 0;
    this._crouchEased = 0;
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._speed = 0;
    // Smoothed anim velocity + last nonzero heading (CS:GO m_vecVelocity).
    this._velX = 0;
    this._velZ = 0;
    this._velDirX = 0;
    this._velDirZ = 1;
    // Gait heading relative to foot yaw (CS:GO move_yaw) + locomotion weight.
    this._moveYaw = 0;
    this._moveYawIdeal = 0;
    this._moveWeight = 0;
    this._walkRun = 0; // walk↔run gait transition 0..1
    this._stutter = 0; // 0..100 — recent stop/start jiggle
    this._durMoving = 0;
    this._durStill = 0;
    // Lower-body travel lean.
    this._leanX = 0;
    this._leanZ = 0;
    // Air / landing (CS:GO in-air smooth value + landing duck dip).
    this._onGround = true;
    this._airSmooth = 1;
    this._airTime = 0;
    this._groundY = 0;
    this._apexY = 0;
    this._duckAdd = 0;
  }

  // ---- Build ---------------------------------------------------------------
  _node(parent, x, y, z) {
    const n = new THREE.Group();
    n.position.set(x, y, z);
    n.rotation.order = 'YXZ';
    parent.add(n);
    return n;
  }

  /** Capsule mesh: radius r (× widthScale), straight-section length seg. */
  _cap(parent, r, seg, { x = 0, y = 0, z = 0, axis = 'y', zone = 'body', hitgroup = 'chest' } = {}) {
    r *= this._w;
    const geo = new THREE.CapsuleGeometry(r, Math.max(0.005, seg), 4, 12);
    const mesh = new THREE.Mesh(geo, zone === 'head' ? this._headMat : this._bodyMat);
    mesh.position.set(x, y, z);
    if (axis === 'x') mesh.rotation.z = Math.PI / 2;
    else if (axis === 'z') mesh.rotation.x = Math.PI / 2;
    mesh.userData.zone = zone;
    mesh.userData.hitgroup = hitgroup;
    parent.add(mesh);
    this.colliders.push(mesh);
    return mesh;
  }

  /** Tapered bridge between two limb anchors — visual only, not a hitbox. */
  _buildJointBridge(upperNode, upperLocal, lowerNode, lowerLocal, rTop, rBot) {
    const geo = new THREE.CylinderGeometry(rBot * this._w, rTop * this._w, 1, 8, 1);
    geo.translate(0, 0.5, 0); // local +Y spans 0 → 1 for stretch scaling
    const mesh = new THREE.Mesh(geo, this._bodyMat);
    upperNode.parent.add(mesh);
    this._dynamicJoints.push({ mesh, upperNode, upperLocal, lowerNode, lowerLocal });
    this.visualMeshes.push(mesh);
    return mesh;
  }

  _capBottomY(centerY, seg, r) {
    return centerY - seg / 2;
  }

  _capTopY(centerY, seg, r) {
    return centerY + seg / 2;
  }

  _updateJointBridges() {
    for (const j of this._dynamicJoints) {
      j.upperNode.localToWorld(_jointA.copy(j.upperLocal));
      j.lowerNode.localToWorld(_jointB.copy(j.lowerLocal));

      j.mesh.parent.worldToLocal(_jointA);
      j.mesh.parent.worldToLocal(_jointB);

      const dist = _jointA.distanceTo(_jointB);
      if (dist < 1e-4) {
        j.mesh.visible = false;
        continue;
      }

      j.mesh.visible = true;
      _jointDir.subVectors(_jointB, _jointA);
      j.mesh.position.copy(_jointA);
      _jointDir.normalize();
      j.mesh.quaternion.setFromUnitVectors(_yUp, _jointDir);
      j.mesh.scale.set(1, dist, 1);
    }
  }

  _buildSkeleton() {
    this.root = new THREE.Group(); // rotation.y = eye yaw (set by scenario / aimAt)
    this.lower = this._node(this.root, 0, 0, 0); // rotation.y = footYaw − eyeYaw

    // Pelvis + torso chain (torso counter-rotates back toward eye yaw).
    this.pelvis = this._node(this.lower, 0, HIP_Y, 0);
    this._cap(this.pelvis, 0.115, 0.11, { y: -0.01, axis: 'x', hitgroup: 'pelvis' });

    this.spine0 = this._node(this.pelvis, 0, SPINE0_UP, 0);
    this._cap(this.spine0, 0.14, 0.07, { y: 0.05, z: 0.005, hitgroup: 'stomach' });

    this.spine1 = this._node(this.spine0, 0, SPINE1_UP, 0);
    this.chest = this._node(this.spine1, 0, CHEST_UP, 0);
    this._cap(this.chest, 0.15, 0.13, { y: 0.03, hitgroup: 'chest' });
    this._cap(this.chest, 0.09, 0.22, { y: 0.15, axis: 'x', hitgroup: 'chest' }); // clavicle bar

    this.neck = this._node(this.chest, 0, NECK_UP, 0);
    this._cap(this.neck, 0.055, 0.055, { y: 0.005, zone: 'head', hitgroup: 'head' });

    this.head = this._node(this.neck, 0, HEAD_UP, 0);
    this.headMesh = this._cap(this.head, 0.105, 0.085, {
      y: 0.085,
      z: 0.015,
      zone: 'head',
      hitgroup: 'head'
    });

    // Legs (thigh joints hang off the pelvis; IK keeps the feet on the ground).
    this.legs = [];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'left' : 'right';
      const thigh = this._node(this.pelvis, s * HIP_HALF, -0.03, 0);
      this._cap(thigh, 0.088, THIGH_LEN - 0.176, { y: -THIGH_LEN / 2, hitgroup: `${side}_leg` });
      const knee = this._node(thigh, 0, -THIGH_LEN, 0);
      this._cap(knee, 0.062, 0.30, { y: -0.215, hitgroup: `${side}_leg` });
      const foot = this._node(knee, 0, -CALF_LEN, 0);
      this._cap(foot, FOOT_CAP_R, FOOT_CAP_SEG, { y: FOOT_CAP_Y, z: FOOT_CAP_Z, axis: 'z', hitgroup: `${side}_leg` });

      const thighBot = this._capBottomY(-THIGH_LEN / 2, THIGH_CAP_SEG, THIGH_CAP_R);
      const kneeTop = this._capTopY(KNEE_CAP_Y, KNEE_CAP_SEG, KNEE_CAP_R);
      const kneeBot = this._capBottomY(KNEE_CAP_Y, KNEE_CAP_SEG, KNEE_CAP_R);
      const footTop = new THREE.Vector3(0, FOOT_CAP_Y + FOOT_CAP_R * 0.35, FOOT_CAP_Z - FOOT_CAP_SEG / 2);
      this._buildJointBridge(
        thigh,
        new THREE.Vector3(0, thighBot, 0),
        knee,
        new THREE.Vector3(0, kneeTop, 0),
        THIGH_CAP_R,
        KNEE_CAP_R
      );
      this._buildJointBridge(
        knee,
        new THREE.Vector3(0, kneeBot, 0),
        foot,
        footTop,
        KNEE_CAP_R,
        FOOT_CAP_R
      );

      this.legs.push({ s, thigh, knee, foot, phaseOff: s < 0 ? Math.PI : 0 });
    }

    // Arms (posed once onto the rifle grips; the chest carries them with aim).
    this.arms = [];
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'left' : 'right';
      const shoulder = this._node(this.chest, s * SHOULDER_X, SHOULDER_UP, 0);
      this._cap(shoulder, 0.056, UPPER_ARM - 0.112, { y: -UPPER_ARM / 2, hitgroup: `${side}_arm` });
      const elbow = this._node(shoulder, 0, -UPPER_ARM, 0);
      this._cap(elbow, FORE_CAP_R, FORE_CAP_SEG, { y: FORE_CAP_Y, hitgroup: `${side}_arm` }); // forearm + hand

      const shoulderBot = this._capBottomY(-UPPER_ARM / 2, SHOULDER_CAP_SEG, SHOULDER_CAP_R);
      const foreTop = this._capTopY(FORE_CAP_Y, FORE_CAP_SEG, FORE_CAP_R);
      const foreBot = this._capBottomY(FORE_CAP_Y, FORE_CAP_SEG, FORE_CAP_R);
      this._buildJointBridge(
        shoulder,
        new THREE.Vector3(0, shoulderBot, 0),
        elbow,
        new THREE.Vector3(0, foreTop, 0),
        SHOULDER_CAP_R,
        FORE_CAP_R
      );
      this._buildJointBridge(
        elbow,
        new THREE.Vector3(0, foreTop, 0),
        elbow,
        new THREE.Vector3(0, foreBot, 0),
        FORE_CAP_R,
        FORE_CAP_R * 0.82
      );

      this.arms.push({ s, shoulder, elbow });
    }
  }

  _attachRifle() {
    const { group } = buildGunModel('rifle', { withFlash: false });
    // Carried at the chest, stock tucked to the right shoulder, barrel rotated
    // to the bot's forward (+Z).
    group.rotation.y = Math.PI;
    group.position.set(0.09, -0.04, 0.16);
    this.chest.add(group);
    this.rifle = group;
    group.traverse((o) => {
      if (o.isMesh) this.visualMeshes.push(o);
    });
  }

  /** Two-hand rifle hold: right hand on the grip, left on the front of the receiver. */
  _poseArms() {
    // Targets in chest-local space (rifle grip points after its 180° turn).
    const rightTarget = new THREE.Vector3(0.09, -0.18, 0.04);
    const leftTarget = new THREE.Vector3(0.09, -0.09, 0.34);
    const rightPole = new THREE.Vector3(0.9, -0.4, -0.35).normalize();
    const leftPole = new THREE.Vector3(-0.9, -0.4, -0.35).normalize();
    for (const arm of this.arms) {
      solveTwoBone(
        arm.shoulder,
        arm.elbow,
        UPPER_ARM,
        FOREARM,
        arm.s > 0 ? rightTarget : leftTarget,
        arm.s > 0 ? rightPole : leftPole
      );
    }
  }

  // ---- Aiming --------------------------------------------------------------
  /** Face a world point: yaw snaps to the root, pitch feeds the aim matrix. */
  aimAt(x, y, z) {
    this.root.getWorldPosition(_wp);
    const dx = x - _wp.x;
    const dz = z - _wp.z;
    this.root.rotation.y = Math.atan2(dx, dz);
    // Eye line sits just below the head capsule centre — reading it from the
    // head mesh keeps the pitch correct under crouch and uniform scaling.
    const eyeY = this.headMesh.getWorldPosition(_eye).y - 0.03;
    this._pitchTarget = Math.atan2(y - eyeY, Math.hypot(dx, dz) || 1e-6);
  }

  /** Directly set eye yaw (multiplayer remotes; camera yaw convention is +π). */
  setYaw(yaw) {
    this.root.rotation.y = yaw;
  }

  setPitch(pitch) {
    this._pitchTarget = pitch;
  }

  // ---- Per-frame -----------------------------------------------------------
  /**
   * @param {number} dt
   * @param {object} opts
   * @param {number} [opts.crouch]    0..1 crouch amount
   * @param {boolean} [opts.onGround] pass when the scenario knows (jump arcs);
   *   omitted → inferred from the root's vertical motion.
   */
  update(dt, { crouch = this._crouch, onGround } = {}) {
    if (dt <= 0) return;
    this._crouch = THREE.MathUtils.clamp(crouch, 0, 1);

    // Measure world velocity + eye yaw from wherever the scenario put us.
    this.root.getWorldPosition(_wp);
    this.root.getWorldDirection(_fwd);
    const eyeYaw = Math.atan2(_fwd.x, _fwd.z);

    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (this._hasPrev) {
      vx = (_wp.x - this._prev.x) / dt;
      vy = (_wp.y - this._prev.y) / dt;
      vz = (_wp.z - this._prev.z) / dt;
    }
    this._prev.copy(_wp);
    if (!this._hasPrev || Math.hypot(vx, vz) > RUN_SPEED * 2.2) {
      // First frame or teleport (spawn/respawn): plant everything.
      vx = 0;
      vy = 0;
      vz = 0;
      this._footYaw = eyeYaw;
      this._phase = 0;
      this._amp = 0;
      this._velX = 0;
      this._velZ = 0;
      this._moveYaw = 0;
      this._moveYawIdeal = 0;
      this._moveWeight = 0;
      this._walkRun = 0;
      this._stutter = 0;
      this._durMoving = 0;
      this._durStill = 0;
      this._leanX = 0;
      this._leanZ = 0;
      this._onGround = true;
      this._airSmooth = 1;
      this._airTime = 0;
      this._groundY = _wp.y;
      this._duckAdd = 0;
      this._hasPrev = true;
    }

    // ---- Ground state: explicit from the scenario, else inferred from y ----
    const wasOnGround = this._onGround;
    if (onGround !== undefined) {
      this._onGround = !!onGround;
      if (this._onGround) this._groundY = _wp.y;
    } else if (this._onGround) {
      if (vy > AIR_VY_TAKEOFF && _wp.y > this._groundY + 0.08) {
        this._onGround = false;
      } else {
        this._groundY += (_wp.y - this._groundY) * Math.min(1, 10 * dt);
      }
    } else if ((_wp.y <= this._groundY + 0.04 && vy <= 0.5) || this._airTime > 2) {
      this._onGround = true; // came back down (or the inference gave up)
      this._groundY = _wp.y;
    }

    if (!this._onGround) {
      if (wasOnGround) this._apexY = _wp.y;
      this._airTime += dt;
      if (_wp.y > this._apexY) this._apexY = _wp.y;
      this._duckAdd = approach(0, this._duckAdd, dt * LAND_DIP_DECAY);
    } else {
      if (!wasOnGround) {
        // Landed: dip into a partial crouch scaled by hang time / fall height.
        const fallFrac = bias(remapClamp(this._apexY - _wp.y, 0.3, 1.8, 0, 1), 0.4);
        const airFrac = THREE.MathUtils.clamp(bias(Math.min(this._airTime, 1), 0.3), 0.1, 1);
        this._duckAdd = Math.min(LAND_DIP_MAX, Math.max(airFrac, fallFrac));
      } else {
        this._duckAdd = approach(0, this._duckAdd, dt * LAND_DIP_DECAY);
      }
      this._airTime = 0;
    }

    // Fuzzy on-ground value: →1 on the ground, →0 in the air (jump/land fades).
    this._airSmooth = THREE.MathUtils.clamp(
      approach(
        this._onGround ? 1 : 0,
        this._airSmooth,
        dt * THREE.MathUtils.lerp(this._crouchEased, AIR_APPROACH_STAND, AIR_APPROACH_CROUCH)
      ),
      0,
      1
    );

    // Smooth crouch transition (~10 units/s); the landing dip rides the same channel.
    const crouchTarget = THREE.MathUtils.clamp(this._crouch + this._duckAdd, 0, 1);
    this._crouchEased += (crouchTarget - this._crouchEased) * Math.min(1, 10 * dt);
    const c = this._crouchEased;

    // ---- Velocity: chase the measured value so wall-stops / frame jitter
    // don't snap the pose (CS:GO smooths its anim velocity the same way).
    this._velX = approach(vx, this._velX, dt * VEL_APPROACH);
    this._velZ = approach(vz, this._velZ, dt * VEL_APPROACH);
    const speed = Math.hypot(this._velX, this._velZ);
    this._speed = speed;
    if (speed > 1e-4) {
      this._velDirX = this._velX / speed;
      this._velDirZ = this._velZ / speed;
    }

    const walkFrac = THREE.MathUtils.clamp(speed / WALK_SPEED, 0, 1);
    const crouchFrac = THREE.MathUtils.clamp(speed / CROUCH_SPEED, 0, 1);
    // Speed relative to the current stance's top speed (run ↔ crouch-walk).
    const stanceFrac = THREE.MathUtils.clamp(
      speed / THREE.MathUtils.lerp(c, RUN_SPEED, CROUCH_SPEED),
      0,
      1
    );
    const moving = speed > MOVE_EPS;

    // Stutter-step: quick stop/starts (A/D jiggle) should damp the gait
    // instead of pumping it — mirrors CS:GO's stutter counter.
    let startedMoving = false;
    if (moving) {
      startedMoving = this._durMoving <= 0;
      if (startedMoving && this._durStill > 0 && this._durStill < STUTTER_WINDOW) {
        this._stutter = Math.min(100, this._stutter + 30);
      }
      this._durStill = 0;
      this._durMoving += dt;
    } else {
      if (this._durMoving > 0 && this._durMoving < STUTTER_WINDOW) {
        this._stutter = Math.min(100, this._stutter + 30);
      }
      this._durMoving = 0;
      this._durStill += dt;
    }
    this._stutter = approach(0, this._stutter, dt * 40);

    // Walk ↔ run gait transition (blends stride length + cadence).
    this._walkRun = approach(speed > WALK_SPEED ? 1 : 0, this._walkRun, dt * WALK_RUN_RATE);

    // ---- Lower-body yaw ----
    let dYaw = wrapPI(eyeYaw - this._footYaw);

    // The allowed eye↔feet desync narrows as speed rises (and crouch-walking),
    // and the clamp is hard — spinning while running drags the feet around.
    let narrow = THREE.MathUtils.lerp(
      walkFrac,
      1,
      THREE.MathUtils.lerp(this._walkRun, AIM_NARROW_WALK, AIM_NARROW_RUN)
    );
    if (c > 0) narrow = THREE.MathUtils.lerp(c * crouchFrac, narrow, AIM_NARROW_CROUCH);
    const yawLimit = MAX_FOOT_DESYNC * narrow;
    if (dYaw > yawLimit) this._footYaw = wrapPI(eyeYaw - yawLimit);
    else if (dYaw < -yawLimit) this._footYaw = wrapPI(eyeYaw + yawLimit);

    if (moving && this._onGround) {
      // Feet chase the eyes at 30–50°/s (faster at a run) while moving.
      this._footYaw = approachAngle(
        eyeYaw,
        this._footYaw,
        dt * THREE.MathUtils.lerp(this._walkRun, FOOT_CHASE_WALK, FOOT_CHASE_RUN)
      );
      this._lbyRealignIn = LBY_STOP_DELAY;
      this._adjusting = false;
    } else if (this._onGround) {
      // Standing: LBY realigns 0.22 s after stopping, then every 1.1 s.
      this._lbyRealignIn -= dt;
      if (this._lbyRealignIn <= 0) this._adjusting = true;
      if (this._adjusting) {
        this._footYaw = approachAngle(eyeYaw, this._footYaw, dt * FOOT_CHASE_IDLE);
        if (Math.abs(wrapPI(eyeYaw - this._footYaw)) < 0.03) {
          this._adjusting = false;
          this._lbyRealignIn = LBY_REPEAT;
        }
      }
    }
    dYaw = wrapPI(eyeYaw - this._footYaw);

    const cosF = Math.cos(this._footYaw);
    const sinF = Math.sin(this._footYaw);

    // ---- Lean the lower body into the travel direction. Only the hips/legs
    // tilt — the spine counter-rotates below so the torso stays upright.
    let targetLeanX = 0;
    let targetLeanZ = 0;
    if (moving) {
      const leanW = MAX_LEAN * stanceFrac * this._airSmooth;
      const velFwd = this._velDirX * sinF + this._velDirZ * cosF;
      const velRight = this._velDirX * cosF - this._velDirZ * sinF;
      targetLeanX = leanW * velFwd; // pitch into forward travel
      targetLeanZ = -leanW * velRight; // roll into sideways travel
    }
    const leanK = Math.min(1, LEAN_RATE * dt);
    this._leanX += (targetLeanX - this._leanX) * leanK;
    this._leanZ += (targetLeanZ - this._leanZ) * leanK;

    this.lower.rotation.set(this._leanX, -dYaw, this._leanZ); // YXZ — lean + foot desync

    // ---- Aim matrix: pitch smoothing + spine distribution ----
    this._pitch += (this._pitchTarget - this._pitch) * Math.min(1, PITCH_RATE * dt);
    const p = this._pitch;
    const twist = dYaw / 3; // spine untwists the desync back toward eye yaw
    const unleanX = -this._leanX / 3; // spine also untilts the travel lean so
    const unleanZ = -this._leanZ / 3; // the upper body stays world-upright
    this.spine0.rotation.set(-p * 0.08 + 0.14 * c + unleanX, twist, unleanZ);
    this.spine1.rotation.set(-p * 0.14 + 0.16 * c + unleanX, twist, unleanZ);
    this.chest.rotation.set(-p * 0.22 + 0.1 * c + unleanX, twist, unleanZ);
    this.neck.rotation.set(-p * 0.28 - 0.28 * c, 0, 0);
    this.head.rotation.set(-p * 0.28, 0, 0);

    // ---- Locomotion: gait heading (move yaw) + locomotion weight ----
    if (moving && this._onGround) {
      // Ideal gait heading = travel direction in the foot-yaw frame.
      this._moveYawIdeal = Math.atan2(
        this._velDirX * cosF - this._velDirZ * sinF,
        this._velDirX * sinF + this._velDirZ * cosF
      );
    }
    if (startedMoving && this._moveWeight <= 0.01) {
      // From rest: snap the gait heading and lead with that side's foot
      // (CS:GO picks an eight-way start cycle the same way).
      this._moveYaw = this._moveYawIdeal;
      this._phase = (this._moveYaw >= 0 ? 1.2 : 0.2) * Math.PI;
    } else {
      // Chase harder the stronger the gait is blended in (ratio per 64 Hz tick).
      const ratio = bias(this._moveWeight, GAIT_DIR_BIAS) + 0.1;
      this._moveYaw = wrapPI(
        this._moveYaw + wrapPI(this._moveYawIdeal - this._moveYaw) * Math.min(1, ratio * 64 * dt)
      );
    }

    // Locomotion weight reaches 1 by walk speed standing / crouch speed ducked;
    // it rises instantly and decays faster the more stutter-stepping.
    const targetW = THREE.MathUtils.lerp(c, walkFrac, crouchFrac);
    if (this._moveWeight <= targetW) {
      this._moveWeight = targetW;
    } else {
      this._moveWeight = approach(
        targetW,
        this._moveWeight,
        dt * remapClamp(this._stutter, 0, 100, 2, 20)
      );
    }
    // Fade the gait while the true travel direction disagrees with its heading,
    // while airborne, and briefly after a landing.
    const alignDamp = bias(
      Math.abs(Math.cos(wrapPI(this._moveYawIdeal - this._moveYaw))),
      ALIGN_DAMP_BIAS
    );
    const landDamp = Math.max(1 - this._duckAdd, 0.55);
    const gaitW = this._moveWeight * alignDamp * this._airSmooth * landDamp;

    // ---- Gait: stride from stance, cadence matched to ground speed ----
    const strideHalf = THREE.MathUtils.lerp(
      c,
      THREE.MathUtils.lerp(this._walkRun, STRIDE_HALF_WALK, STRIDE_HALF_RUN),
      STRIDE_HALF_CROUCH
    );
    if (moving) {
      this._amp += (strideHalf * gaitW - this._amp) * Math.min(1, 10 * dt);
      this._lift =
        LIFT_RUN * Math.max(0.35, Math.sqrt(stanceFrac)) * THREE.MathUtils.lerp(c, 1, 0.55);
      // Cadence tied to actual ground speed over the stride, so feet don't skate.
      this._phase += (speed / Math.max(strideHalf, 0.15)) * dt;
    } else {
      this._amp += (0 - this._amp) * Math.min(1, 8 * dt);
      this._lift = 0;
      const rest = Math.round(this._phase / Math.PI) * Math.PI;
      this._phase += (rest - this._phase) * Math.min(1, 10 * dt);
    }

    // ---- Pelvis height: stance knee-bend → crouch drop, plus run bob ----
    const pelvisY =
      HIP_Y -
      THREE.MathUtils.lerp(c, STANCE_DROP, CROUCH_DROP) +
      BOB_RUN * stanceFrac * this._airSmooth * Math.sin(2 * this._phase);
    this.pelvis.position.y = pelvisY;

    // ---- Legs: asymmetric IK gait (60% planted / 40% swing) ----
    const dirX = Math.sin(this._moveYaw);
    const dirZ = Math.cos(this._moveYaw);
    const airPose = 1 - this._airSmooth;
    // Combat stance: staggered feet at rest (support foot leads, weapon foot
    // trails), and while strafing the lead-side leg plants wider toward the
    // travel direction than the trailing leg.
    const stagger = 1 - 0.75 * gaitW;
    const strafeShift = dirX * gaitW;
    const dirXSign = Math.sign(dirX);
    for (const leg of this.legs) {
      let localPhase = (this._phase + leg.phaseOff) % (Math.PI * 2);
      if (localPhase < 0) localPhase += Math.PI * 2;
      const normPhase = localPhase / (Math.PI * 2);

      let swayOut = 0;
      let liftOut = 0;

      if (normPhase < 0.6) {
        // Ground phase: foot moves linearly backward relative to the body.
        swayOut = 1.0 - (normPhase / 0.6) * 2.0;
        liftOut = 0;
      } else {
        // Air phase: foot swings forward in a parabolic arc.
        const airPhase = (normPhase - 0.6) / 0.4;
        swayOut = -1.0 + airPhase * 2.0;
        liftOut = Math.sin(airPhase * Math.PI);
      }

      const sway = this._amp * swayOut;
      const lift = this._lift * liftOut;

      const lead = leg.s * dirXSign >= 0;
      _legTarget.set(
        leg.s * (FOOT_HALF + STANCE_WIDE * stagger) +
          dirX * sway +
          strafeShift * (lead ? STRAFE_WIDE_LEAD : STRAFE_WIDE_TRAIL),
        ANKLE_H + lift - pelvisY,
        dirZ * sway + (leg.s < 0 ? STAGGER_FWD : -STAGGER_BACK) * stagger
      );
      if (airPose > 0.001) {
        // Airborne: tuck the feet up under the pelvis, lead knee forward.
        _legTarget.x = THREE.MathUtils.lerp(_legTarget.x, leg.s * FOOT_HALF, airPose);
        _legTarget.y = THREE.MathUtils.lerp(_legTarget.y, AIR_TUCK_Y - pelvisY, airPose);
        _legTarget.z = THREE.MathUtils.lerp(_legTarget.z, leg.s > 0 ? 0.1 : -0.06, airPose);
      }
      _legPole.set(0, 0, 1);
      solveTwoBone(leg.thigh, leg.knee, THIGH_LEN, CALF_LEN, _legTarget, _legPole);
      _footQ.multiplyQuaternions(leg.thigh.quaternion, leg.knee.quaternion).invert();
      if (lift > 0.001) {
        _toeQ.setFromAxisAngle(_xAxis, 0.35 * (lift / LIFT_RUN));
        _footQ.multiply(_toeQ);
      }
      leg.foot.quaternion.copy(_footQ);
    }

    this._updateJointBridges();
  }

  dispose() {
    const mats = new Set();
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        if (o.material) mats.add(o.material);
      }
    });
    for (const m of mats) m.dispose();
  }
}
