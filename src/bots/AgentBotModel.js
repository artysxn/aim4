// ---------------------------------------------------------------------------
// AgentBotModel.js
// A trainer bot wearing CS2's own CT agent, animated by the game's own
// world-model clips (src/agents/agentModels.js).
//
// It is a drop-in for CSBotModel: same constructor options, same
// `aimAt / setYaw / setPitch / update(dt, { crouch, onGround })`, same
// `root / colliders / visualMeshes / headMesh` tagging contract. Scenarios do
// not know which one they got — buildBotTarget.js picks.
//
// Two things are genuinely different, and both are improvements:
//
//   · **The hitboxes are the game's.** CSBotModel's capsules ARE its visible
//     limbs, which is honest but is a model of a CS player rather than the CS
//     player. Here the visible body is the agent mesh and the hit volumes are
//     the capsules `ctm_sas.vmdl_c` actually ships, parented to the bones they
//     belong to, so a bot's head is where CS2 says a head is. They are drawn
//     nowhere (`visible = false`, which three's Raycaster does not filter on).
//   · **Velocity is measured, not given.** Same as CSBotModel: the scenario
//     only ever moves and turns `root`, and the gait works itself out from the
//     root's world motion between frames. That is what lets every scenario use
//     this without changing a line.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { HEAD_CENTER_STAND } from '../multiplayer/constants.js';
import { IDLE_SPEED } from '../agents/agentBlend.js';
import { flattenMaterial, staticLighting } from '../agents/agentPaint.js';

/** Source hitgroups that count as a headshot here (1 head, 8 neck). */
const HEAD_GROUPS = new Set([1, 8]);
/** Source hitgroup → the trainer's hitgroup label, for replay/telemetry parity. */
const HITGROUP_NAME = {
  0: 'chest',
  1: 'head',
  2: 'chest',
  3: 'stomach',
  4: 'left_arm',
  5: 'right_arm',
  6: 'left_leg',
  7: 'right_leg',
  8: 'head'
};

/** A teleport rather than a step: plant the gait instead of sprinting it. */
const TELEPORT_SPEED = 20; // m/s

const _wp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * One hit capsule from the pack, as an invisible mesh on its bone.
 *
 * The pack stores `min`/`max` as the capsule's two END POINTS in bone space
 * (Source units) with `radius` beside them — not as a box. A sphere hitbox
 * (`shape` 0, and any capsule whose ends coincide) collapses to one point.
 */
export function hitboxMesh(box, scale = 1) {
  _a.set(box.min[0], box.min[1], box.min[2]);
  _b.set(box.max[0], box.max[1], box.max[2]);
  const r = Math.max(1e-3, (box.radius || 0) * scale);
  _dir.subVectors(_b, _a);
  const len = _dir.length() * scale;
  const geo = len > 1e-3 ? new THREE.CapsuleGeometry(r, len, 4, 8) : new THREE.SphereGeometry(r, 10, 8);
  const mesh = new THREE.Mesh(geo, HITBOX_MATERIAL);
  mesh.position.copy(_a).add(_b).multiplyScalar(0.5 * scale);
  if (len > 1e-3) mesh.quaternion.setFromUnitVectors(_up, _dir.normalize());
  mesh.visible = false;
  mesh.matrixAutoUpdate = true;
  return mesh;
}

/**
 * One material for every hit capsule in the app. They are never drawn, and
 * Target.startDying writing `opacity` on a shared invisible material changes
 * nothing anyone can see.
 */
const HITBOX_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

export class AgentBotModel {
  /**
   * @param {object} opts
   * @param {import('../agents/agentModels.js').AgentModels} opts.models  a loaded pack
   * @param {string} [opts.side]        which agent to wear
   * @param {number} [opts.widthScale]  squashes the body laterally (tracking difficulty)
   * @param {number} [opts.scale]       uniform scale of the whole model
   * @param {THREE.Object3D} [opts.weapon] world model to hang off the `wpn` bone
   */
  constructor({ models, side = 'CT', widthScale = 1, scale = 1, weapon = null } = {}) {
    this.models = models;
    this._w = widthScale;
    this.root = new THREE.Group();
    this.body = models.createBody(side);
    this.body.onPaint = () => this.paintWeapon();
    this.root.add(this.body.group);
    if (widthScale !== 1) {
      // Lateral only, so a narrower bot is a narrower target and not a shorter
      // one. The hit capsules hang off the bones inside this, so what you see
      // stays what you can hit.
      this.body.group.scale.x *= widthScale;
      this.body.group.scale.z *= widthScale;
    }
    if (scale !== 1) this.root.scale.setScalar(scale);

    this.colliders = [];
    this.visualMeshes = this.body.meshes.slice();
    this.headMesh = null;
    this._buildHitboxes();
    if (weapon) this.attachWeapon(weapon);

    // ---- anim state ----
    this._crouch = 0;
    this._pitchTarget = 0; // radians, positive = looking UP (CSBotModel's sign)
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._speed = 0;
    this._moveYaw = 0;
    this._onGround = true;
    this._groundY = 0;
    this._airTime = 0;
  }

  /** The pack's own hit capsules, parented to the bones they belong to. */
  _buildHitboxes() {
    const boxes = this.body.hitboxes?.boxes || [];
    let bestHead = null;
    for (const box of boxes) {
      const bone = this.body.boneNamed(box.bone);
      if (!bone) continue;
      const mesh = hitboxMesh(box);
      const head = HEAD_GROUPS.has(box.group);
      mesh.userData.zone = head ? 'head' : 'body';
      mesh.userData.hitgroup = HITGROUP_NAME[box.group] || 'chest';
      bone.add(mesh);
      this.colliders.push(mesh);
      if (box.group === 1 && (!bestHead || (box.radius || 0) > (bestHead.userData.radius || 0))) {
        mesh.userData.radius = box.radius || 0;
        bestHead = mesh;
      }
    }
    // Everything that reads an eye line reads it off headMesh; without a head
    // capsule (a pack that changed shape) fall back to a marker at CS's eye
    // height so LOS and bot muzzles still have somewhere to come from.
    if (!bestHead) {
      bestHead = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), HITBOX_MATERIAL);
      bestHead.visible = false;
      bestHead.position.y = HEAD_CENTER_STAND;
      bestHead.userData.zone = 'head';
      bestHead.userData.hitgroup = 'head';
      this.root.add(bestHead);
      this.colliders.push(bestHead);
    }
    this.headMesh = bestHead;
  }

  /**
   * Hang a weapon world model off the agent's `wpn` bone.
   *
   * The bone is already in the pack's frame (Source axes, turned −90° about x
   * at the model root), and cs3d-weapons.mjs stamps that same turn onto a
   * rigid weapon's own mesh nodes so it stands up as a world model on its own.
   * Parented directly the two compose to −180° and the gun hangs upside down
   * through the hands, so the mount cancels the rotation and keeps only the
   * bone's placement — the weapon's origin is its grip, which is where it
   * belongs. Same reasoning as ViewModel.setSide; see src/cs3d/viewModel.js.
   */
  attachWeapon(object) {
    const bone = this.body.model?.getObjectByName('wpn') || this.body.model?.getObjectByName('wpnPivot');
    if (!bone) return null;
    const frameX = (this.models.manifest?.frame?.rootRotationX ?? -90) * (Math.PI / 180);
    const mount = new THREE.Group();
    mount.name = 'wpnMount';
    mount.rotation.x = -frameX;
    mount.add(object);
    bone.add(mount);
    this.weapon = object;
    object.traverse((o) => {
      if (o.isMesh) this.visualMeshes.push(o);
    });
    this.paintWeapon();
    return mount;
  }

  /**
   * The rifle takes the HEAD's colour in flat mode.
   *
   * Deliberately the head and not a colour of its own: what a rifle does for
   * an aim trainer is tell you which way a bot is facing from across the
   * arena, and the fastest way to read that is for the barrel and the thing
   * you are trying to hit to be the same colour. It also lights in the model's
   * own frame like the body does, so it does not go dark when a bot turns.
   */
  paintWeapon() {
    if (!this.weapon) return;
    const paint = this.models.paint;
    this.weapon.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        if (m.userData.agentSrc === undefined) {
          m.userData.agentSrc = { map: m.map || null, color: m.color?.getHex() ?? 0xffffff, metalness: m.metalness };
          staticLighting(m);
        }
        if (paint?.flat) {
          flattenMaterial(m, { color: paint.head, keepNormalMap: true });
        } else {
          m.map = m.userData.agentSrc.map;
          m.metalness = m.userData.agentSrc.metalness;
          m.vertexColors = false;
          m.color.setHex(m.userData.agentSrc.color);
          m.needsUpdate = true;
        }
      }
    });
  }

  // ---- Aiming --------------------------------------------------------------
  /** Face a world point: yaw snaps to the root, pitch feeds the aim tilt. */
  aimAt(x, y, z) {
    this.root.getWorldPosition(_wp);
    const dx = x - _wp.x;
    const dz = z - _wp.z;
    this.root.rotation.y = Math.atan2(dx, dz);
    const eyeY = this.headMesh.getWorldPosition(_eye).y - 0.03;
    this._pitchTarget = Math.atan2(y - eyeY, Math.hypot(dx, dz) || 1e-6);
  }

  setYaw(yaw) {
    this.root.rotation.y = yaw;
  }

  setPitch(pitch) {
    this._pitchTarget = pitch;
  }

  /** Fade the whole bot (Target's death cross-fade). */
  setOpacity(v) {
    this.body.setOpacity(v);
    if (this.weapon) {
      this.weapon.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          m.transparent = v < 1;
          m.opacity = v;
          m.depthWrite = v >= 1;
        }
      });
    }
  }

  /** Start the packed death animation. Returns its length in seconds. */
  die() {
    this.body.set({ alive: false });
    this.body.update(0);
    return this.body.deathDuration();
  }

  /**
   * Advance a death already started. Separate from `update` because that one
   * measures velocity off the root and re-derives the gait, and a corpse has
   * neither — and because scenarios stop calling `update` on a dying target.
   */
  stepDeath(dt) {
    this.body.update(dt);
  }

  // ---- Per-frame -----------------------------------------------------------
  /**
   * @param {number} dt
   * @param {object} opts
   * @param {number} [opts.crouch]    0..1
   * @param {boolean} [opts.onGround] pass when the scenario knows (jump arcs);
   *   omitted → inferred from the root's vertical motion, as CSBotModel does.
   */
  update(dt, { crouch = this._crouch, onGround } = {}) {
    if (dt <= 0) return;
    this._crouch = Math.max(0, Math.min(1, crouch));

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
    if (!this._hasPrev || Math.hypot(vx, vz) > TELEPORT_SPEED) {
      // First frame or a respawn teleport: plant, do not sprint across the map.
      vx = vy = vz = 0;
      this._speed = 0;
      this._moveYaw = eyeYaw;
      this._onGround = true;
      this._groundY = _wp.y;
      this._airTime = 0;
      this._hasPrev = true;
    }

    // ---- ground state: explicit from the scenario, else inferred from y ----
    if (onGround !== undefined) {
      this._onGround = !!onGround;
      if (this._onGround) this._groundY = _wp.y;
    } else if (this._onGround) {
      if (vy > 1.2 && _wp.y > this._groundY + 0.08) this._onGround = false;
      else this._groundY += (_wp.y - this._groundY) * Math.min(1, 10 * dt);
    } else if ((_wp.y <= this._groundY + 0.04 && vy <= 0.5) || this._airTime > 2) {
      this._onGround = true;
      this._groundY = _wp.y;
    }
    this._airTime = this._onGround ? 0 : this._airTime + dt;

    // ---- into the blend's frame -------------------------------------------
    // The blend counts Source units per second and Source degrees; the trainer
    // counts metres and measures yaw as `atan2(dx, dz)`, i.e. an object facing
    // +z at zero. A Source yaw θ faces (cos θ, 0, −sin θ), so matching the two
    // gives θ = ψ − 90°. (Not `90 − ψ`: that has the right offset and the
    // wrong SIGN, which mirrors the ring — a bot strafing left would play the
    // strafe-right loop, and nothing about the result looks broken enough to
    // notice.) Only the difference moveYaw − viewYaw reaches the blend, so the
    // offset cancels and the sign is the whole of what matters.
    const speed = Math.hypot(vx, vz);
    this._speed = speed;
    const speedU = speed / UNIT_M;
    if (speedU > IDLE_SPEED) this._moveYaw = Math.atan2(vx, vz);
    const toSource = (yaw) => (yaw * 180) / Math.PI - 90;

    this.body.set({
      speed: speedU,
      moveYaw: toSource(this._moveYaw),
      viewYaw: toSource(eyeYaw),
      // Source pitch is positive DOWN; `_pitchTarget` is positive UP.
      pitch: (-this._pitchTarget * 180) / Math.PI,
      duck: this._crouch,
      airborne: !this._onGround
    });
    this.body.update(dt);
  }

  dispose() {
    for (const m of this.colliders) m.geometry?.dispose();
    this.colliders.length = 0;
    this.visualMeshes.length = 0;
    this.body.dispose();
    this.root.removeFromParent();
  }
}
