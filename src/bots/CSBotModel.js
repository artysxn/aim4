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
//   · Lower-body yaw — feet track the eyes while moving; on stop they stay
//                     planted for 0.22 s, then realign (and every 1.1 s after),
//                     clamped to ±58° of desync, like the CS:GO LBY mechanic.
//   · Locomotion    — procedural 8-way gait built from the actual measured
//                     velocity: stride direction follows the movement vector
//                     relative to foot yaw (so strafing side-runs emerge), and
//                     cadence scales with speed / max speed so feet don't skate.
//   · Crouch        — pose blend (pelvis drop + knee fold + hunch) driven by
//                     the same 0..1 crouch amount the movement code already uses.
//
// The model measures its own world velocity from its root position, and reads
// eye yaw from its root rotation, so scenarios only position/rotate the bot
// (exactly like they already do) and call update(dt, { crouch }).
//
// Hitboxes: every capsule mesh is tagged with userData.zone ('head' | 'body')
// and userData.hitgroup (chest / stomach / pelvis / arms / legs) matching the
// Source hitgroup layout, and works with the existing Raycaster hit pipeline.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { RUN_SPEED } from '../utils/SourceMovement.js';
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
const MAX_FOOT_DESYNC = THREE.MathUtils.degToRad(58);
const MOVE_YAW_RATE = 10; // 1/s exponential chase while moving
const ADJUST_YAW_RATE = 9; // 1/s while replanting the feet
const MOVE_EPS = 0.15; // m/s — "velocity > 0.1" threshold, scaled to metres

// ---- Gait tuning ----
const STRIDE_HALF_RUN = 0.48; // m half-stride at full run speed (wider steps)
const CYCLE_RATE_RUN = 11.5; // rad/s phase rate at full run (slower cadence)
const LIFT_RUN = 0.12; // m foot lift at full run
const BOB_RUN = 0.015; // m pelvis bob at full run
const PITCH_RATE = 18; // 1/s aim-pitch smoothing
const LEAN_RATE = 12; // 1/s travel-lean smoothing
const MAX_LEAN = THREE.MathUtils.degToRad(8); // travel lean cap (upper + lower body)
const LEAN_SENS = MAX_LEAN / RUN_SPEED; // maps run speed → max lean

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
    this._dirX = 0; // gait direction in foot-yaw local frame
    this._dirZ = 1;
    this._pitch = 0;
    this._pitchTarget = 0;
    this._crouch = 0;
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._speed = 0;
    this._leanX = 0;
    this._leanZ = 0;
    // ---- Eased anim state ----
    this._crouchEased = 0;
    this._moveDirX = 0;
    this._moveDirZ = 1;
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

      this._buildJointBridge(
        this.pelvis,
        new THREE.Vector3(s * HIP_HALF * 0.8, -0.05, 0),
        thigh,
        new THREE.Vector3(0, 0, 0),
        0.11,
        THIGH_CAP_R
      );

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

      this._buildJointBridge(
        this.chest,
        new THREE.Vector3(s * SHOULDER_X * 0.75, SHOULDER_UP * 0.9, 0),
        shoulder,
        new THREE.Vector3(0, 0, 0),
        0.08,
        SHOULDER_CAP_R
      );

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
  update(dt, { crouch = this._crouch } = {}) {
    if (dt <= 0) return;
    this._crouch = THREE.MathUtils.clamp(crouch, 0, 1);

    // Smooth crouch transition (~10 units/s).
    this._crouchEased += (this._crouch - this._crouchEased) * Math.min(1, 10 * dt);
    const c = this._crouchEased;

    // Measure world velocity + eye yaw from wherever the scenario put us.
    this.root.getWorldPosition(_wp);
    this.root.getWorldDirection(_fwd);
    const eyeYaw = Math.atan2(_fwd.x, _fwd.z);

    let vx = 0;
    let vz = 0;
    if (this._hasPrev) {
      vx = (_wp.x - this._prev.x) / dt;
      vz = (_wp.z - this._prev.z) / dt;
    }
    this._prev.copy(_wp);
    if (!this._hasPrev || Math.hypot(vx, vz) > RUN_SPEED * 2.2) {
      // First frame or teleport (spawn/respawn): plant everything.
      vx = 0;
      vz = 0;
      this._footYaw = eyeYaw;
      this._phase = 0;
      this._amp = 0;
      this._leanX = 0;
      this._leanZ = 0;
      this._hasPrev = true;
    }
    const speed = Math.hypot(vx, vz);
    this._speed = speed;

    // ---- Directional lean (1–3° into travel direction) ----
    const cosE = Math.cos(eyeYaw);
    const sinE = Math.sin(eyeYaw);
    const localX = vx * cosE - vz * sinE; // strafe right +
    const localZ = vx * sinE + vz * cosE; // forward +
    const targetLeanZ = THREE.MathUtils.clamp(localX * LEAN_SENS, -MAX_LEAN, MAX_LEAN);
    const targetLeanX = THREE.MathUtils.clamp(-localZ * LEAN_SENS, -MAX_LEAN, MAX_LEAN);
    const leanK = Math.min(1, LEAN_RATE * dt);
    this._leanX += (targetLeanX - this._leanX) * leanK;
    this._leanZ += (targetLeanZ - this._leanZ) * leanK;

    // ---- Lower-body yaw ----
    let dYaw = wrapPI(eyeYaw - this._footYaw);
    if (speed > MOVE_EPS) {
      this._footYaw = wrapPI(this._footYaw + dYaw * Math.min(1, MOVE_YAW_RATE * dt));
      this._lbyRealignIn = LBY_STOP_DELAY;
      this._adjusting = false;
    } else {
      // Standing: LBY realigns 0.22 s after stopping, then every 1.1 s.
      this._lbyRealignIn -= dt;
      if (this._lbyRealignIn <= 0) this._adjusting = true;
      if (this._adjusting) {
        this._footYaw = wrapPI(this._footYaw + dYaw * Math.min(1, ADJUST_YAW_RATE * dt));
        if (Math.abs(wrapPI(eyeYaw - this._footYaw)) < 0.03) {
          this._adjusting = false;
          this._lbyRealignIn = LBY_REPEAT;
        }
      } else if (Math.abs(dYaw) > MAX_FOOT_DESYNC) {
        // Eyes twisted past the limit — feet get dragged to the clamp edge.
        const clamped = eyeYaw - Math.sign(dYaw) * MAX_FOOT_DESYNC;
        this._footYaw = wrapPI(
          this._footYaw + wrapPI(clamped - this._footYaw) * Math.min(1, ADJUST_YAW_RATE * dt)
        );
      }
    }
    dYaw = wrapPI(eyeYaw - this._footYaw);
    this.lower.rotation.set(this._leanX, -dYaw, this._leanZ); // YXZ — lean + foot desync

    // ---- Aim matrix: pitch smoothing + spine distribution + travel lean ----
    this._pitch += (this._pitchTarget - this._pitch) * Math.min(1, PITCH_RATE * dt);
    const p = this._pitch;
    const twist = dYaw / 3; // spine untwists the desync back toward eye yaw

    const leanPitch = this._leanX; // forward/backward tilt
    const leanRoll = this._leanZ; // left/right tilt

    this.spine0.rotation.set(-p * 0.08 + 0.14 * c + leanPitch * 0.3, twist, leanRoll * 0.3);
    this.spine1.rotation.set(-p * 0.14 + 0.16 * c + leanPitch * 0.3, twist, leanRoll * 0.3);
    this.chest.rotation.set(-p * 0.22 + 0.1 * c + leanPitch * 0.4, twist, leanRoll * 0.4);
    this.neck.rotation.set(-p * 0.28 - 0.28 * c, 0, 0);
    this.head.rotation.set(-p * 0.28, 0, 0);

    // ---- Gait ----
    const sr = THREE.MathUtils.clamp(speed / RUN_SPEED, 0, 1.3);
    const moving = speed > 0.1;
    if (moving) {
      const k = Math.sqrt(sr);
      this._amp += (STRIDE_HALF_RUN * k - this._amp) * Math.min(1, 10 * dt);
      this._lift = LIFT_RUN * Math.max(0.35, k);
      this._phase += CYCLE_RATE_RUN * k * dt;

      const cosF = Math.cos(this._footYaw);
      const sinF = Math.sin(this._footYaw);
      const lx = vx * cosF - vz * sinF;
      const lz = vx * sinF + vz * cosF;
      const inv = 1 / (Math.hypot(lx, lz) || 1e-6);

      // Smooth direction changes (prevents leg snapping on A/D spam).
      this._moveDirX += (lx * inv - this._moveDirX) * Math.min(1, 12 * dt);
      this._moveDirZ += (lz * inv - this._moveDirZ) * Math.min(1, 12 * dt);

      const smoothedInv = 1 / (Math.hypot(this._moveDirX, this._moveDirZ) || 1e-6);
      this._dirX = this._moveDirX * smoothedInv;
      this._dirZ = this._moveDirZ * smoothedInv;
    } else {
      this._amp += (0 - this._amp) * Math.min(1, 8 * dt);
      this._lift = 0;
      const rest = Math.round(this._phase / Math.PI) * Math.PI;
      this._phase += (rest - this._phase) * Math.min(1, 10 * dt);
    }

    // ---- Pelvis height: crouch drop + run bob ----
    const pelvisY = HIP_Y - CROUCH_DROP * c + BOB_RUN * sr * Math.sin(2 * this._phase);
    this.pelvis.position.y = pelvisY;

    // ---- Legs: asymmetric IK gait (60% planted / 40% swing) ----
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

      _legTarget.set(
        leg.s * FOOT_HALF + this._dirX * sway,
        ANKLE_H + lift - pelvisY,
        this._dirZ * sway
      );
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
