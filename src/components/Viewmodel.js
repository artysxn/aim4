// ---------------------------------------------------------------------------
// Viewmodel.js
// A deliberately simple, blocky first-person gun model plus its juice: a subtle
// muzzle flash, a small kick-back on fire, optional weapon bob while moving, and
// pooled yellow bullet tracers. The model is a plain scene object that follows
// the camera each frame (the engine camera is not in the scene graph, so we
// can't parent to it) using the camera's own basis vectors.
//
// Configurable from Settings: handedness (left/right), viewmodel FOV (approxed
// via scale + distance, since a true second render pass is overkill here),
// XYZ offset, and bob on/off.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { PUNCH_TAU_SPRAY, PUNCH_TAU_RECOVER, VIEW_PUNCH_STRENGTH } from '../weapons/ak47.js';

const TRACER_POOL = 24;
const TRACER_LIFE = 0.09; // seconds — quick, just a firing indicator
const FLASH_LIFE = 0.045; // seconds — brief, non-distracting
const MAX_PITCH = (89 * Math.PI) / 180;

export class Viewmodel {
  constructor(engine, settings) {
    this.engine = engine;
    this.settings = settings;
    this.camera = engine.camera;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 10;
    engine.scene.add(this.group);

    this._buildGun();
    this._buildFlash();
    this._buildTracers();

    // Live animation state.
    this._bobPhase = 0;
    this._kick = 0; // 0..1 recoil kick amount, decays each frame
    this._flashT = 0;
    this._punchPitch = 0; // view-punch (aimpunch) offset, springs back to 0
    this._punchYaw = 0;

    // Scratch vectors reused every frame (no per-frame allocation).
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
  }

  // ---- Build ---------------------------------------------------------------
  _box(w, h, d, color, x, y, z) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 })
    );
    m.position.set(x, y, z);
    this._gun.add(m);
    return m;
  }

  _buildGun() {
    // Built in local space with the barrel pointing along -Z (camera forward).
    this._gun = new THREE.Group();
    this._box(0.10, 0.10, 0.55, 0x202225, 0, 0, -0.18); // receiver / body
    this._box(0.05, 0.05, 0.50, 0x303338, 0, 0.03, -0.40); // barrel
    this._box(0.09, 0.20, 0.10, 0x2a2d31, 0, -0.16, -0.05); // magazine
    this._box(0.07, 0.16, 0.09, 0x26282c, 0, -0.12, 0.12); // grip
    this._box(0.06, 0.09, 0.20, 0x202225, 0, -0.02, 0.20); // stock
    this.group.add(this._gun);
  }

  _buildFlash() {
    this._flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    this._flash.position.set(0, 0.03, -0.66); // barrel tip in gun-local space
    this._gun.add(this._flash);
  }

  _buildTracers() {
    this._tracers = [];
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe24a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    for (let i = 0; i < TRACER_POOL; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, mat.clone());
      line.visible = false;
      line.frustumCulled = false;
      line.renderOrder = 11;
      this.engine.scene.add(line);
      this._tracers.push({ line, t: 0 });
    }
    this._tracerIdx = 0;
  }

  // ---- Public API ----------------------------------------------------------
  setVisible(v) {
    v = !!v;
    if (v === this.group.visible) return;
    this.group.visible = v;
    if (!v) {
      this._punchPitch = 0;
      this._punchYaw = 0;
      for (const tr of this._tracers) {
        tr.t = 0;
        tr.line.visible = false;
      }
    }
  }

  /** Trigger the per-shot flash + kick (call when a bullet is actually fired). */
  fire() {
    this._kick = 1;
    this._flashT = FLASH_LIFE;
  }

  /**
   * View-punch (aimpunch): upward camera jolt per shot. During a spray the kick
   * stacks and only partially recovers between bullets; releasing fire springs
   * back to neutral. Visual-only — never changes where bullets go.
   */
  punch(pitchRad, yawRad = 0) {
    if (this.settings.data.weapon?.aimpunch === false) return;
    this._punchPitch += pitchRad;
    this._punchYaw += yawRad;
  }

  _applyPunch(dt) {
    const spraying = !!this.engine.player?.input?.fireHeld;
    if (spraying) {
      const decay = Math.exp(-dt / PUNCH_TAU_SPRAY);
      this._punchPitch *= decay;
      this._punchYaw *= decay;
    } else if (this._punchPitch !== 0 || this._punchYaw !== 0) {
      // Linear recovery to neutral after releasing fire (not instant snap).
      const pMag = Math.abs(this._punchPitch);
      const yMag = Math.abs(this._punchYaw);
      const pStep = (pMag / PUNCH_TAU_RECOVER) * dt;
      const yStep = (yMag / PUNCH_TAU_RECOVER) * dt;
      this._punchPitch =
        pMag <= pStep ? 0 : Math.sign(this._punchPitch) * (pMag - pStep);
      this._punchYaw =
        yMag <= yStep ? 0 : Math.sign(this._punchYaw) * (yMag - yStep);
    }
    if (Math.abs(this._punchPitch) < 1e-4 && Math.abs(this._punchYaw) < 1e-4) {
      this._punchPitch = 0;
      this._punchYaw = 0;
      return;
    }
    // Steer the camera by the punch offset. Requires the look input; the gun is
    // only visible during a run, so this never fights the menu camera.
    const input = this.engine.player?.input;
    if (!input) return;
    this.camera.rotation.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch + this._punchPitch));
    this.camera.rotation.y = input.yaw + this._punchYaw;
  }

  /** Current world-space muzzle tip (valid after update()). */
  getMuzzlePosition(out = new THREE.Vector3()) {
    return out.copy(this._muzzle);
  }

  /** Spawn a quick yellow tracer between two world points. */
  spawnTracer(origin, end) {
    const tr = this._tracers[this._tracerIdx];
    this._tracerIdx = (this._tracerIdx + 1) % this._tracers.length;
    const pos = tr.line.geometry.getAttribute('position');
    pos.setXYZ(0, origin.x, origin.y, origin.z);
    pos.setXYZ(1, end.x, end.y, end.z);
    pos.needsUpdate = true;
    tr.t = TRACER_LIFE;
    tr.line.material.opacity = 0.9;
    tr.line.visible = true;
  }

  // ---- Per-frame -----------------------------------------------------------
  update(dt, motion = {}) {
    this._updateTracers(dt);
    this._applyPunch(dt);
    if (!this.group.visible) return;

    const cfg = this.settings.data.viewmodel || {};
    const cam = this.camera;

    // Camera basis in world space.
    cam.getWorldDirection(this._fwd).normalize();
    this._right.crossVectors(this._fwd, this._worldUp).normalize();
    this._up.crossVectors(this._right, this._fwd).normalize();

    // viewmodel FOV → approximate by scaling the model (lower fov = bigger/closer).
    const vmFov = cfg.fov ?? 68;
    const scale = THREE.MathUtils.clamp(75 / vmFov, 0.6, 1.7);
    this.group.scale.setScalar(scale);

    // Handedness flips the lateral offset.
    const hand = cfg.hand === 'left' ? -1 : 1;
    const ox = (cfg.offsetX ?? 0.16) * hand;
    const oy = cfg.offsetY ?? -0.15;
    const oz = cfg.offsetZ ?? 0.5; // forward distance

    // Weapon bob while moving on the ground.
    let bobX = 0;
    let bobY = 0;
    if (cfg.bob !== false && motion.onGround && (motion.speedHoriz || 0) > 0.5) {
      this._bobPhase += dt * (4 + (motion.speedHoriz || 0) * 0.8);
      const amt = Math.min(0.025, 0.006 + (motion.speedHoriz || 0) * 0.0025);
      bobX = Math.cos(this._bobPhase) * amt;
      bobY = Math.abs(Math.sin(this._bobPhase)) * amt;
    } else {
      this._bobPhase = 0;
    }

    // Recoil kick: gun slides back (+toward camera) and up briefly, springs back.
    const kickMul = VIEW_PUNCH_STRENGTH;
    const kickBack = this._kick * 0.06 * kickMul;
    const kickUp = this._kick * 0.02 * kickMul;

    // Compose world position from the camera basis.
    this._pos.copy(cam.position)
      .addScaledVector(this._right, ox + bobX)
      .addScaledVector(this._up, oy + bobY + kickUp)
      .addScaledVector(this._fwd, oz - kickBack);
    this.group.position.copy(this._pos);
    this.group.quaternion.copy(cam.quaternion);
    // A touch of barrel rise as it kicks.
    this.group.rotateX(-this._kick * 0.05 * kickMul);

    // Muzzle tip in world space (barrel tip is at local ~ -0.66 z, +0.03 y).
    this._muzzle.copy(this._pos)
      .addScaledVector(this._fwd, (0.66 * scale))
      .addScaledVector(this._up, 0.03 * scale);

    // Decay kick + flash.
    this._kick = Math.max(0, this._kick - dt / 0.07);
    if (this._flashT > 0) {
      this._flashT = Math.max(0, this._flashT - dt);
      this._flash.material.opacity = (this._flashT / FLASH_LIFE) * 0.8;
      const s = 0.7 + (this._flashT / FLASH_LIFE) * 0.6;
      this._flash.scale.setScalar(s);
    } else {
      this._flash.material.opacity = 0;
    }
  }

  _updateTracers(dt) {
    for (const tr of this._tracers) {
      if (tr.t <= 0) continue;
      tr.t -= dt;
      if (tr.t <= 0) {
        tr.line.visible = false;
        tr.line.material.opacity = 0;
      } else {
        tr.line.material.opacity = 0.9 * (tr.t / TRACER_LIFE);
      }
    }
  }
}
