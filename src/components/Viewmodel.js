// ---------------------------------------------------------------------------
// Viewmodel.js
// A deliberately simple, blocky first-person gun model plus its juice: a subtle
// muzzle flash, a small kick-back on fire, optional weapon bob while moving, and
// pooled yellow bullet tracers. During reload the viewmodel dips down and tilts
// in sync with WeaponController.reloadProgress.
// the camera each frame (the engine camera is not in the scene graph, so we
// can't parent to it) using the camera's own basis vectors.
//
// Two gun meshes are built up-front (rifle + pistol); setWeapon() toggles which
// one is visible and loads that weapon's recoil/muzzle tuning. Configurable from
// Settings: handedness, viewmodel FOV, XYZ offset, bob.
//
// The blocky guns are now the FALLBACK. When the CS2 weapons pack has landed
// (src/agents/weaponAssets.js) this class hands the drawing over to
// AgentViewmodel — real arms, the real weapon, and the game's own draw / idle /
// shoot / reload clips, in their own render pass — and keeps everything else it
// owns: the tracers, the impact sparks, the bullet holes and the view punch,
// none of which the pack has anything to say about. `useAgent` is the switch,
// and everything downstream of it stays on the same public API, so nothing that
// calls into the viewmodel (BaseScenario.shoot, ReplayPlayer, the UI) knows
// which one is drawing.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { getWeapon } from '../weapons/index.js';
import { buildGunModel } from '../weapons/gunModels.js';
import { AgentViewmodel } from '../weapons/AgentViewmodel.js';
import { sharedWeaponAssets, weaponNameFor } from '../agents/weaponAssets.js';
import { BulletTracers } from '../weapons/bulletTracers.js';
import { sharedBulletAssets } from '../agents/bulletAssets.js';

const TRACER_POOL = 24;
const TRACER_LIFE = 0.09; // seconds — quick, just a firing indicator
const SPARK_POOL = 20;
const SPARK_LIFE = 0.24;
const SPARKS_PER_HIT = 12;
const DECAL_POOL = 96;
const DECAL_RADIUS = 0.052;
const _decalAxis = new THREE.Vector3(0, 0, 1);
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

    this._models = {};
    /** What setVisible was last told, independent of which model is drawing. */
    this._wantVisible = false;
    this._spec = null;
    this._wasReloading = false;
    /**
     * When true, `_punchPitch`/`_punchYaw` are being written from outside
     * every frame (the CS2 recoil model) and this class must not decay them —
     * see `setAbsolutePunch`.
     */
    this._absolutePunch = false;
    /** CS2's own bullet streak. Falls back to the pooled line below. */
    this.tracers = new BulletTracers({ camera: engine.camera, assets: sharedBulletAssets() });
    this.tracers.attach(engine.scene);
    sharedBulletAssets().load().catch(() => {});
    this.agent = new AgentViewmodel();
    engine.viewmodelRender = (renderer, camera) => this.agent.render(renderer, camera);
    // The pack is already being fetched by main.js; this is only the callback.
    sharedWeaponAssets()
      .load()
      .then((ok) => {
        if (!ok) return;
        this.agent.setSide('CT');
        this.agent.applySettings(this.settings.activeSettings().viewmodel || {});
        if (this._spec) this.agent.setWeapon(weaponNameFor(this._spec));
        this._syncModels();
      })
      .catch(() => {});
    settings.onChange(() => this.agent.applySettings(this.settings.activeSettings().viewmodel || {}));

    this._buildModels();
    this._buildTracers();
    this._buildImpactSparks();
    this._buildBulletDecals();

    // Live animation state.
    this._bobPhase = 0;
    this._kick = 0; // 0..1 recoil kick amount, decays each frame
    this._flashT = 0;
    this._punchPitch = 0; // view-punch (aimpunch) offset, springs back to 0
    this._punchYaw = 0;

    // Active-weapon tuning (set via setWeapon).
    this._punchTauSpray = 0.1;
    this._punchTauRecover = 0.16;
    this._viewPunchStrength = 1;
    this._muzzleFwd = 0.66;
    this._muzzleUp = 0.03;

    // Scratch vectors reused every frame (no per-frame allocation).
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._decalNormal = new THREE.Vector3();
    this._decalQuat = new THREE.Quaternion();

    this.setWeapon(getWeapon());
  }

  // ---- Build ---------------------------------------------------------------
  _buildModels() {
    // Shared builders (see gunModels.js) — barrel points along -Z (camera forward).
    for (const kind of ['rifle', 'pistol', 'sniper']) {
      const model = buildGunModel(kind);
      this.group.add(model.group);
      this._models[kind] = model;
    }
  }

  _buildTracers() {
    this._tracers = [];
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe24a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,
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

  _buildImpactSparks() {
    this._impacts = [];
    for (let i = 0; i < SPARK_POOL; i++) {
      const group = new THREE.Group();
      group.visible = false;
      group.frustumCulled = false;
      group.renderOrder = 12;
      const parts = [];
      for (let j = 0; j < SPARKS_PER_HIT; j++) {
        const mat = new THREE.MeshBasicMaterial({
          color: j % 3 === 0 ? 0xffffff : 0xffcc44,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.012), mat);
        mesh.visible = false;
        mesh.userData.vx = 0;
        mesh.userData.vy = 0;
        mesh.userData.vz = 0;
        group.add(mesh);
        parts.push(mesh);
      }
      this.engine.scene.add(group);
      this._impacts.push({ group, parts, t: 0 });
    }
    this._impactIdx = 0;
  }

  _buildBulletDecals() {
    this._decalGeom = new THREE.CircleGeometry(DECAL_RADIUS, 10);
    this._decals = [];
    for (let i = 0; i < DECAL_POOL; i++) {
      const mesh = new THREE.Mesh(
        this._decalGeom,
        new THREE.MeshBasicMaterial({
          color: 0x0c0c0c,
          transparent: true,
          opacity: 0.88,
          depthWrite: true,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4
        })
      );
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.engine.scene.add(mesh);
      this._decals.push(mesh);
    }
    this._decalIdx = 0;
  }

  // ---- Public API ----------------------------------------------------------
  /**
   * Is the viewmodel on screen at all?
   *
   * `group` is the BLOCKY model's group and is false whenever the CS2 model is
   * the one drawing, so reading it as "is the gun visible" answers no for
   * every agent-viewmodel frame. That is what stopped replays firing the
   * viewmodel at all — see ReplayPlayer._playShot.
   */
  get visible() {
    return this._wantVisible;
  }

  /** True while the CS2 arms and weapon are the ones being drawn. */
  get useAgent() {
    if (this.settings.activeSettings().viewmodel?.agentModels === false) return false;
    return this.agent.ready;
  }

  /** Switch the visible gun mesh + load its recoil/muzzle tuning. */
  setWeapon(spec) {
    if (!spec) return;
    this._spec = spec;
    this._punchTauSpray = spec.punchTauSpray;
    this._punchTauRecover = spec.punchTauRecover;
    this._viewPunchStrength = spec.viewPunchStrength;
    for (const id in this._models) {
      const model = this._models[id];
      const active = id === spec.model;
      model._active = active;
      if (active) {
        this._flash = model.flash;
        this._muzzleFwd = model.fwd;
        this._muzzleUp = model.up;
      }
    }
    const name = weaponNameFor(spec);
    if (this.agent.ready) {
      // Already holding it (a second run with the same weapon): the draw is
      // still what should play, so ask for it rather than no-oping.
      if (this.agent.weaponName === name) this.agent.redraw();
      else this.agent.setWeapon(name);
    }
    this._syncModels();
  }

  /**
   * Show whichever model is in charge, and only that one. Called whenever the
   * pack lands, the weapon changes or visibility flips, because any of the
   * three can be what decides the answer.
   */
  _syncModels() {
    const agent = this.useAgent;
    this.group.visible = this._wantVisible && !agent;
    for (const id in this._models) {
      this._models[id].group.visible = this.group.visible && this._models[id]._active;
    }
    this.agent.setVisible(this._wantVisible && agent);
  }

  setVisible(v) {
    v = !!v;
    if (v === this._wantVisible) return;
    this._wantVisible = v;
    this._syncModels();
    if (!v) {
      this._punchPitch = 0;
      this._punchYaw = 0;
      this._kick = 0;
      for (const tr of this._tracers) {
        tr.t = 0;
        tr.line.visible = false;
      }
      for (const fx of this._impacts) {
        fx.t = 0;
        fx.group.visible = false;
      }
    }
  }

  /** Trigger the per-shot flash + optional kick (call when a bullet is actually fired). */
  fire({ recoil = true } = {}) {
    if (recoil) this._kick = 1;
    this._flashT = FLASH_LIFE;
    if (this.useAgent) this.agent.attack();
  }

  /**
   * View-punch (aimpunch): camera jolt per shot. The rifle's stacks across a
   * held spray; the pistol's snaps back fast between clicks. Visual-only — never
   * changes where bullets go.
   */
  punch(pitchRad, yawRad = 0) {
    if (this.settings.activeSettings().weapon?.aimpunch === false) return;
    this._punchPitch += pitchRad;
    this._punchYaw += yawRad;
  }

  /**
   * Take the camera punch from outside instead of springing it here.
   *
   * CS2's view punch is state with its own decay law, integrated inside
   * shared/sim3d/recoil.js at a fixed sub-step — the spring below is a
   * different, cruder decay, and running both would compound them. The
   * WeaponController pushes an absolute angle every frame while its CS2 model
   * is in charge; passing `null` hands the spring back.
   *
   * @param {number|null} pitchRad  camera pitch offset, positive UP
   * @param {number|null} yawRad
   */
  setAbsolutePunch(pitchRad, yawRad) {
    if (pitchRad === null) {
      this._absolutePunch = false;
      return;
    }
    this._absolutePunch = true;
    this._punchPitch = pitchRad;
    this._punchYaw = yawRad;
  }

  _applyPunch(dt) {
    if (this._absolutePunch) {
      // The value is already this frame's; only steer the camera by it.
      this._steerByPunch();
      return;
    }
    const spraying = !!this.engine.player?.input?.fireHeld;
    if (spraying) {
      const decay = Math.exp(-dt / this._punchTauSpray);
      this._punchPitch *= decay;
      this._punchYaw *= decay;
    } else if (this._punchPitch !== 0 || this._punchYaw !== 0) {
      // Linear recovery to neutral after releasing fire (not instant snap).
      const pMag = Math.abs(this._punchPitch);
      const yMag = Math.abs(this._punchYaw);
      const pStep = (pMag / this._punchTauRecover) * dt;
      const yStep = (yMag / this._punchTauRecover) * dt;
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
    this._steerByPunch();
  }

  /**
   * Point the camera at look + punch. Requires the look input; the gun is only
   * visible during a run, so this never fights the menu camera.
   */
  _steerByPunch() {
    const input = this.engine.player?.input;
    if (!input) return;
    this.camera.rotation.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, input.pitch + this._punchPitch));
    this.camera.rotation.y = input.yaw + this._punchYaw;
  }

  /** Current world-space muzzle tip (valid after update()). */
  getMuzzlePosition(out = new THREE.Vector3()) {
    return out.copy(this._muzzle);
  }

  /**
   * Send a bullet streak from the muzzle to wherever the round stopped.
   *
   * CS2's ribbon when the bullet pack has landed and the caller named the
   * weapon (it carries `m_nTracerFrequency`, and a silenced gun draws none);
   * the pooled yellow line otherwise, which is what the trainer has always
   * drawn and what a cold page still gets.
   */
  spawnTracer(origin, end, weapon = null) {
    if (weapon && this.tracers.ready) {
      if (this.tracers.fire({ from: origin, to: end, weapon })) return;
      // The weapon has no tracer at all (a silencer) — draw nothing rather
      // than falling through to a line the game would not have drawn.
      if (!(weapon.tracerFrequency ?? 0)) return;
    }
    this._spawnLineTracer(origin, end);
  }

  /** The original pooled line: a fallback now, not the main path. */
  _spawnLineTracer(origin, end) {
    const tr = this._tracers[this._tracerIdx];
    this._tracerIdx = (this._tracerIdx + 1) % this._tracers.length;
    const pos = tr.line.geometry.getAttribute('position');
    pos.setXYZ(0, origin.x, origin.y, origin.z);
    pos.setXYZ(1, end.x, end.y, end.z);
    pos.needsUpdate = true;
    tr.line.geometry.computeBoundingSphere();
    tr.t = TRACER_LIFE;
    tr.line.material.opacity = 0.9;
    tr.line.visible = true;
  }

  /** Sparks on any hit; optional bullet-hole decal on cover/walls. */
  spawnBulletImpact(point, normal, { decal = false } = {}) {
    this.spawnImpactSparks(point);
    if (decal && normal) this._spawnBulletHole(point, normal);
  }

  /** Brief spark burst at a bullet impact (world space). */
  spawnImpactSparks(point) {
    const fx = this._impacts[this._impactIdx];
    this._impactIdx = (this._impactIdx + 1) % this._impacts.length;
    fx.group.position.copy(point);
    fx.group.visible = true;
    fx.t = SPARK_LIFE;
    for (const p of fx.parts) {
      p.visible = true;
      p.position.set(0, 0, 0);
      const theta = Math.random() * Math.PI * 2;
      const horiz = 0.35 + Math.random() * 0.85;
      const spd = 2.2 + Math.random() * 5;
      p.userData.vx = Math.cos(theta) * horiz * spd;
      p.userData.vy = (0.35 + Math.random() * 1.1) * spd;
      p.userData.vz = Math.sin(theta) * horiz * spd;
      p.material.opacity = 1;
      p.rotation.z = Math.random() * Math.PI;
    }
  }

  _spawnBulletHole(point, normal) {
    const mesh = this._decals[this._decalIdx];
    this._decalIdx = (this._decalIdx + 1) % this._decals.length;

    const n = this._decalNormal.copy(normal).normalize();
    mesh.position.copy(point).addScaledVector(n, 0.004);
    this._decalQuat.setFromUnitVectors(_decalAxis, n);
    mesh.quaternion.copy(this._decalQuat);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.visible = true;
  }

  clearBulletDecals() {
    for (const mesh of this._decals) mesh.visible = false;
    this._decalIdx = 0;
  }

  /** Recompute gun + muzzle world positions (call after fire() for tracers). */
  syncMuzzleForShot(motion = {}) {
    if (this.useAgent) {
      this._syncAgentMuzzle();
      return;
    }
    if (!this.group.visible) {
      this._muzzle.copy(this.camera.position);
      return;
    }
    this._applyTransform(motion);
  }

  /**
   * The muzzle when the CS2 model is the one drawing.
   *
   * Off the weapon table's own attachment, not off the drawn gun — see
   * AgentViewmodel.muzzleWorld. Hidden (scoped, or between runs) it collapses
   * to the eye, which is where the old blocky path put it too.
   */
  _syncAgentMuzzle() {
    if (!this.agent.visible) {
      this._muzzle.copy(this.camera.position);
      return;
    }
    this.agent.muzzleWorld(this.camera, this._muzzle);
  }

  _applyTransform(motion = {}) {
    if (!this.group.visible) return;

    const cfg = this.settings.activeSettings().viewmodel || {};
    const cam = this.camera;

    cam.getWorldDirection(this._fwd).normalize();
    this._right.crossVectors(this._fwd, this._worldUp).normalize();
    this._up.crossVectors(this._right, this._fwd).normalize();

    const vmFov = cfg.fov ?? 68;
    const scale = THREE.MathUtils.clamp(75 / vmFov, 0.6, 1.7);
    this.group.scale.setScalar(scale);

    const hand = cfg.hand === 'left' ? -1 : 1;
    const ox = (cfg.offsetX ?? 0.16) * hand;
    const oy = cfg.offsetY ?? -0.15;
    // The setting's range now reaches back past the eye, because the cs3d
    // viewmodel reads it as a delta. Here it is an absolute distance in front,
    // so it keeps a floor rather than letting the gun end up behind the camera.
    const oz = Math.max(0.1, cfg.offsetZ ?? 0.5);

    let bobX = 0;
    let bobY = 0;
    if (cfg.bob !== false && motion.onGround && (motion.speedHoriz || 0) > 0.5) {
      const amt = Math.min(0.025, 0.006 + (motion.speedHoriz || 0) * 0.0025);
      bobX = Math.cos(this._bobPhase) * amt;
      bobY = Math.abs(Math.sin(this._bobPhase)) * amt;
    }

    const kickMul = this._viewPunchStrength;
    const kickBack = this._kick * 0.06 * kickMul;
    const kickUp = this._kick * 0.02 * kickMul;

    let reloadDown = 0;
    let reloadBack = 0;
    let reloadTilt = 0;
    const weapon = this.engine.weapon;
    if (weapon?.reloading) {
      const wave = Math.sin(weapon.reloadProgress * Math.PI);
      const mag = weapon.spec?.model === 'pistol' ? 0.85 : 1;
      reloadDown = -0.13 * mag * wave;
      reloadBack = 0.08 * mag * wave;
      reloadTilt = 0.34 * mag * wave;
    }

    let boltDown = 0;
    let boltBack = 0;
    let boltTilt = 0;
    const chamber = weapon?.boltCycleProgress?.() ?? 0;
    if (chamber > 0 && weapon?.spec?.model === 'sniper') {
      const wave = Math.sin(chamber * Math.PI);
      boltDown = -0.06 * wave;
      boltBack = 0.05 * wave;
      boltTilt = 0.18 * wave;
      const sniper = this._models.sniper;
      const bolt = sniper?.boltHandle;
      if (bolt) {
        bolt.position.x = bolt.userData.baseX + 0.04 * wave;
        bolt.position.z = bolt.userData.baseZ - 0.06 * wave;
      }
    } else {
      const bolt = this._models.sniper?.boltHandle;
      if (bolt) {
        bolt.position.x = bolt.userData.baseX;
        bolt.position.z = bolt.userData.baseZ;
      }
    }

    this._pos.copy(cam.position)
      .addScaledVector(this._right, ox + bobX)
      .addScaledVector(this._up, oy + bobY + kickUp + reloadDown + boltDown)
      .addScaledVector(this._fwd, oz - kickBack - reloadBack - boltBack);
    this.group.position.copy(this._pos);
    this.group.quaternion.copy(cam.quaternion);
    this.group.rotateX(-this._kick * 0.05 * kickMul + reloadTilt + boltTilt);

    this._muzzle.copy(this._pos)
      .addScaledVector(this._fwd, this._muzzleFwd * scale)
      .addScaledVector(this._up, this._muzzleUp * scale);
  }

  // ---- Per-frame -----------------------------------------------------------
  update(dt, motion = {}) {
    this._updateTracers(dt);
    this.tracers.update(dt);
    this._updateImpactSparks(dt);
    if (!this.engine.replayPlayer?.active) {
      this._applyPunch(dt);
    }
    const cfg = this.settings.activeSettings().viewmodel || {};
    if (cfg.bob !== false && motion.onGround && (motion.speedHoriz || 0) > 0.5) {
      this._bobPhase += dt * (4 + (motion.speedHoriz || 0) * 0.8);
    } else {
      this._bobPhase = 0;
    }
    if (this.useAgent) this._updateAgent(dt, motion);
    this._applyTransform(motion);

    // Decay kick + flash.
    this._kick = Math.max(0, this._kick - dt / 0.07);
    if (this._flash) {
      if (this._flashT > 0) {
        this._flashT = Math.max(0, this._flashT - dt);
        this._flash.material.opacity = (this._flashT / FLASH_LIFE) * 0.8;
        const s = 0.7 + (this._flashT / FLASH_LIFE) * 0.6;
        this._flash.scale.setScalar(s);
      } else {
        this._flash.material.opacity = 0;
      }
    }
  }

  /**
   * Drive the CS2 viewmodel for this frame.
   *
   * The reload is watched rather than pushed, because the trainer's reload is
   * the WeaponController's: it owns the timer, the magazine and the trigger
   * lockout, and it does not call in here. So the clip is started on the
   * rising edge of `weapon.reloading` and stretched to `spec.reloadTime` —
   * whatever the pack's own clip is worth, the trainer's timing is the timing.
   */
  _updateAgent(dt, motion = {}) {
    const input = this.engine.player?.input;
    const cam = this.camera;
    this.agent.update(dt, {
      speed: motion.speedHoriz || 0,
      onGround: motion.onGround !== false,
      viewYaw: input ? input.yaw : cam.rotation.y,
      viewPitch: input ? input.pitch : cam.rotation.x,
      punchPitch: this._punchPitch,
      punchYaw: this._punchYaw
    });
    const weapon = this.engine.weapon;
    const reloading = !!weapon?.reloading;
    if (reloading && !this._wasReloading) {
      this.agent.reload({ empty: (weapon.ammo ?? 0) <= 0, seconds: weapon.spec?.reloadTime || 0 });
    }
    this._wasReloading = reloading;
    this._syncAgentMuzzle();
  }

  _updateTracers(dt) {
    const replay = this.engine.replayPlayer;
    const dtScale = replay?.active && replay.playing ? replay.speed : 1;
    const step = dt * dtScale;
    for (const tr of this._tracers) {
      if (tr.t <= 0) continue;
      tr.t -= step;
      if (tr.t <= 0) {
        tr.line.visible = false;
        tr.line.material.opacity = 0;
      } else {
        tr.line.material.opacity = 0.9 * (tr.t / TRACER_LIFE);
      }
    }
  }

  _updateImpactSparks(dt) {
    const replay = this.engine.replayPlayer;
    const dtScale = replay?.active && replay.playing ? replay.speed : 1;
    const step = dt * dtScale;
    const cam = this.camera.position;
    for (const fx of this._impacts) {
      if (fx.t <= 0) continue;
      fx.t -= step;
      const fade = Math.max(0, fx.t / SPARK_LIFE);
      if (fx.t <= 0) {
        fx.group.visible = false;
        for (const p of fx.parts) p.visible = false;
        continue;
      }
      for (const p of fx.parts) {
        p.position.x += p.userData.vx * step;
        p.position.y += p.userData.vy * step;
        p.position.z += p.userData.vz * step;
        p.userData.vy -= 14 * step;
        p.material.opacity = fade * 0.95;
        p.lookAt(cam);
      }
    }
  }
}
