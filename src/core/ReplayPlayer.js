// ---------------------------------------------------------------------------
// ReplayPlayer.js
// Plays back a decoded replay: rebuilds the environment + targets/bots from the
// captured blueprints, then drives the camera and every entity from the
// telemetry tracks. Playback is time-based (not tick-based) so it supports
// arbitrary timescales — 0.125× … 4× — and INTERPOLATES between the 128 Hz
// ticks so slow-motion stays smooth instead of stepping frame-to-frame.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { EYE_HEIGHT } from './Engine.js';
import { decodeInput } from '../lib/replayCodec.js';
import { getWeapon } from '../weapons/index.js';
import { PLAYER_RUN_SPEED } from '../utils/spawnVisibility.js';
import { ReplayAnalytics } from '../lib/replayAnalytics.js';
import { createCoverGridMaterial, applyCoverGridRepeat } from '../utils/ColorUtils.js';

export const REPLAY_SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4];

const _shotOrigin = new THREE.Vector3();
const _shotEnd = new THREE.Vector3();
const _shotNormal = new THREE.Vector3();

function makeGeometry(d) {
  const p = d.params || {};
  switch (d.geo) {
    case 'Sphere':
      return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 16, p.heightSegments ?? 12);
    case 'Box':
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case 'Cylinder':
      return new THREE.CylinderGeometry(
        p.radiusTop ?? 0.5,
        p.radiusBottom ?? 0.5,
        p.height ?? 1,
        p.radialSegments ?? 16,
        p.heightSegments ?? 1,
        p.openEnded ?? false,
        p.thetaStart ?? 0,
        p.thetaLength ?? Math.PI * 2
      );
    case 'Plane':
      return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    case 'Circle':
      return new THREE.CircleGeometry(p.radius ?? 0.5, p.segments ?? 32);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function makeMesh(d, colors) {
  const p = d.params || {};
  let material;
  if (d.gridCover && colors?.cover && colors?.floor && d.geo === 'Box') {
    material = createCoverGridMaterial(colors.cover, colors.floor);
    applyCoverGridRepeat(material, (p.width ?? 1) * (d.s?.[0] ?? 1), (p.height ?? 1) * (d.s?.[1] ?? 1));
  } else {
    const matOpts = {
      color: d.color ?? 0xffffff,
      emissive: d.emissive ?? 0x000000,
      emissiveIntensity: d.emissiveIntensity ?? 0,
      roughness: d.roughness ?? 0.6,
      metalness: d.metalness ?? 0.05,
      transparent: !!d.transparent,
      opacity: d.opacity ?? 1
    };
    if (d.side === 1) matOpts.side = THREE.BackSide;
    else if (d.side === 2) matOpts.side = THREE.DoubleSide;
    material = new THREE.MeshStandardMaterial(matOpts);
  }

  const mesh = new THREE.Mesh(makeGeometry(d), material);
  if (d.p) mesh.position.set(d.p[0], d.p[1], d.p[2]);
  if (d.q) mesh.quaternion.set(d.q[0], d.q[1], d.q[2], d.q[3]);
  if (d.s) mesh.scale.set(d.s[0], d.s[1], d.s[2]);
  return mesh;
}

export class ReplayPlayer {
  constructor(engine) {
    this.engine = engine;
    this.replay = null;
    this.root = null;
    this._envGroup = null;
    this._envSegmentIdx = -1;
    this.entities = []; // { data, object }

    this.playing = false;
    this.speed = 1;
    this.time = 0; // seconds into the replay
    this.duration = 0;
    this._lastEventTick = -1;
    this._sfx = null;
    this._replayFov = 75;
    this.zoom = 1; // scroll wheel zoom during playback (1 = default)

    this.analytics = null; // ReplayAnalytics for the loaded replay

    this.onProgress = null; // ({ time, duration, playing, speed }) => void
    this.onSample = null; // (analyticsSample, camera) => void — per-tick analysis
    this.onEnd = null;
  }

  get active() {
    return !!this.replay;
  }

  /** Load a decoded replay, rebuild the scene, and pause at t=0. */
  load(replay, { baselineVFov } = {}) {
    this.dispose();
    this.replay = replay;
    this._replayColors = replay.settings?.colors || null;
    this.duration = replay.durationSec;
    this.time = 0;
    this._lastEventTick = -1;
    this._envSegmentIdx = -1;
    this._sfx = null;
    this.speed = 1;
    this.playing = false;
    this.zoom = 1;
    // Viewer default FOV — zoom 1 = this value; zoom in narrows, zoom out stops here.
    this._replayFov = baselineVFov ?? this.engine.camera.fov;

    this.root = new THREE.Group();
    this.root.name = 'replay-root';
    this.engine.scene.add(this.root);

    this._envGroup = new THREE.Group();
    this._envGroup.name = 'replay-env';
    this.root.add(this._envGroup);

    this.analytics = new ReplayAnalytics(replay);

    this._buildEntities(replay);
    this._applyEnvironmentAtTick(0);
    this._setupViewmodel(replay);
    this._applyTick(0);
    this._emitProgress();
    this._emitSample(0);
  }

  _setupViewmodel(replay) {
    const vm = this.engine.viewmodel;
    if (!vm) return;
    const show = replay.showViewmodel !== false;
    vm.setVisible(show);
    if (show) {
      vm.setWeapon(getWeapon(replay.weaponId));
      vm._kick = 0;
      vm._flashT = 0;
      vm._punchPitch = 0;
      vm._punchYaw = 0;
    }
  }

  /** Movement hint for viewmodel bob during playback (from recorded input). */
  getMotion() {
    if (!this.replay) return {};
    const tickFloat = this.time * this.replay.tickRate;
    const cam = this.replay.sampleCamera(tickFloat);
    const flags = decodeInput(cam.input);
    const moving = flags.W || flags.A || flags.S || flags.D;
    return {
      onGround: !flags.jump,
      speedHoriz: moving ? PLAYER_RUN_SPEED : 0
    };
  }

  _setEnvironment(meshDescs) {
    if (!this._envGroup) return;
    while (this._envGroup.children.length) {
      const node = this._envGroup.children[0];
      this._envGroup.remove(node);
      if (node.isMesh) {
        node.geometry?.dispose?.();
        if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
        else node.material?.dispose?.();
      }
    }
    for (const d of meshDescs || []) {
      this._envGroup.add(makeMesh(d, this._replayColors));
    }
  }

  /** Pick the map segment active at an integer tick (duels arena swaps). */
  _applyEnvironmentAtTick(tick) {
    const segs = this.replay?.environmentSegments;
    if (!segs?.length) {
      if (this._envSegmentIdx === 0) return;
      this._envSegmentIdx = 0;
      this._setEnvironment(this.replay?.environment || []);
      return;
    }
    let idx = 0;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].start <= tick) idx = i;
      else break;
    }
    if (idx === this._envSegmentIdx) return;
    this._envSegmentIdx = idx;
    this._setEnvironment(segs[idx].meshes);
  }

  _buildEntities(replay) {
    // Build one template per blueprint, then clone it per entity instance.
    const templates = {};
    for (const [id, meshes] of Object.entries(replay.blueprints || {})) {
      const g = new THREE.Group();
      for (const d of meshes) g.add(makeMesh(d));
      templates[id] = g;
    }
    for (const ent of replay.entities) {
      const tmpl = templates[ent.bp];
      const object = tmpl ? tmpl.clone(true) : new THREE.Group();
      object.visible = false;
      this.root.add(object);
      this.entities.push({ data: ent, object });
    }
  }

  // ---- transport controls -------------------------------------------------
  play() {
    if (!this.replay) return;
    if (this.time >= this.duration) this.time = 0; // restart from a finished replay
    this.playing = true;
    // -1 so tick-0 shots/env still fire on the first advancing frame.
    this._lastEventTick = Math.floor(this.time * this.replay.tickRate) - 1;
    this.engine.audio?.resume();
    this._emitProgress();
  }

  pause() {
    this.playing = false;
    this._emitProgress();
  }

  togglePlay() {
    this.engine.audio?.resume();
    this.playing ? this.pause() : this.play();
  }

  setSpeed(speed) {
    if (REPLAY_SPEEDS.includes(speed)) this.speed = speed;
    this._emitProgress();
  }

  /** Scroll-wheel zoom during playback (1 = default FOV, higher = zoomed in). */
  adjustZoom(wheelDeltaY) {
    const factor = Math.pow(1.12, -wheelDeltaY / 100);
    // Cannot zoom out past the viewer's default FOV (zoom 1); no cap on zoom-in.
    this.zoom = Math.max(1, this.zoom * factor);
    if (this.replay) {
      const tickFloat = this.time * this.replay.tickRate;
      this._applyTick(tickFloat);
    }
  }

  /** Scrub to a fraction [0,1] of the timeline. */
  seekFraction(frac) {
    if (!this.replay) return;
    this.time = Math.max(0, Math.min(1, frac)) * this.duration;
    this._lastEventTick = Math.floor(this.time * this.replay.tickRate);
    this._clearTracers();
    this._sfx = null;
    const tickFloat = this.time * this.replay.tickRate;
    this._applyEnvironmentAtTick(Math.floor(tickFloat));
    this._applyTick(tickFloat);
    this._emitProgress();
    this._emitSample(tickFloat);
  }

  // ---- per-frame update (driven by the engine loop) -----------------------
  update(dt) {
    if (!this.replay) return;
    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.playing = false;
        if (this.onEnd) this.onEnd();
      }
      const tickFloat = this.time * this.replay.tickRate;
      this._applyTick(tickFloat);
      this._fireEventsUpTo(tickFloat);
      this._updateReplayAudio(tickFloat, dt);
      this._emitProgress();
      this._emitSample(tickFloat);
    }
  }

  /** Run the analysis for the current tick and hand it to the overlay/HUD. */
  _emitSample(tickFloat) {
    if (!this.onSample || !this.analytics) return;
    const sample = this.analytics.sampleTick(tickFloat);
    this.onSample(sample, this.engine.camera);
  }

  _applyTick(tickFloat) {
    const r = this.replay;
    const tick = Math.floor(tickFloat);
    this._applyEnvironmentAtTick(tick);

    const cam = r.sampleCamera(tickFloat);
    const camera = this.engine.camera;
    camera.position.set(cam.px, cam.py, cam.pz);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    camera.fov = this._replayFov / this.zoom;
    camera.updateProjectionMatrix();

    for (const e of this.entities) {
      const s = r.sampleEntity(e.data, tickFloat);
      if (!s) {
        e.object.visible = false;
        continue;
      }
      e.object.visible = true;
      // Frames track the entity's visual mesh (head/body); shift by the
      // recorded visual→root offset so the blueprint stands where it did live.
      const vis = e.data.vis || [0, 0, 0];
      e.object.position.set(
        s.x - vis[0] * s.s,
        s.y - vis[1] * s.s,
        s.z - vis[2] * s.s
      );
      e.object.scale.setScalar(Math.max(0.0001, s.s));
      this._applyDeathTint(e, tickFloat);
    }
  }

  /** Killed targets turn green (like ingame) instead of staying red. */
  _applyDeathTint(e, tickFloat) {
    const deadT = this.analytics?.deadAtTick(e.data.id);
    const dead = deadT != null && tickFloat >= deadT;
    if (dead === !!e.tinted) return;
    e.tinted = dead;
    e.object.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      // Clones share template materials — give this entity its own before tinting.
      if (!node.userData._ownMat) {
        node.material = node.material.clone();
        node.userData._ownMat = true;
        node.userData._origColor = node.material.color?.getHex() ?? null;
        node.userData._origEmissive = node.material.emissive?.getHex() ?? null;
        node.userData._origEmissiveIntensity = node.material.emissiveIntensity ?? 0;
      }
      if (dead) {
        node.material.color?.set(0x35e06a);
        node.material.emissive?.set(0x1a8840);
        if ('emissiveIntensity' in node.material) node.material.emissiveIntensity = 0.9;
      } else {
        if (node.userData._origColor != null) node.material.color?.set(node.userData._origColor);
        if (node.userData._origEmissive != null) node.material.emissive?.set(node.userData._origEmissive);
        if ('emissiveIntensity' in node.material) {
          node.material.emissiveIntensity = node.userData._origEmissiveIntensity;
        }
      }
    });
  }

  _fireEventsUpTo(tickFloat) {
    const r = this.replay;
    const tick = Math.floor(tickFloat);
    if (tick <= this._lastEventTick) return;

    for (const ev of r.events) {
      if (ev.t <= this._lastEventTick || ev.t > tick) continue;
      if (ev.type === 'shot') this._playShot(ev);
    }
    this._lastEventTick = tick;
  }

  _playShot(ev) {
    const vm = this.engine.viewmodel;
    const recoil = this.replay?.viewmodelRecoil !== false;

    // Align the camera to the shot tick so muzzle sync matches the recording.
    const cam = this.replay.sampleCamera(ev.t);
    const camera = this.engine.camera;
    camera.position.set(cam.px, cam.py, cam.pz);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    camera.fov = this._replayFov / this.zoom;
    camera.updateProjectionMatrix();

    const flags = decodeInput(cam.input);
    const moving = flags.W || flags.A || flags.S || flags.D;
    const motion = {
      onGround: !flags.jump,
      speedHoriz: moving ? PLAYER_RUN_SPEED : 0
    };

    if (vm?.group.visible) {
      vm.syncMuzzleForShot(motion);
      vm.fire({ recoil });
    }

    if (ev.o?.length >= 3 && ev.e?.length >= 3) {
      _shotOrigin.set(ev.o[0], ev.o[1], ev.o[2]);
      _shotEnd.set(ev.e[0], ev.e[1], ev.e[2]);
      if (_shotOrigin.distanceToSquared(_shotEnd) < 1e-8 && vm?.group.visible) {
        vm.syncMuzzleForShot(motion);
        vm.getMuzzlePosition(_shotOrigin);
        _shotEnd.copy(_shotOrigin).add(
          camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(120)
        );
      }
      vm?.spawnTracer(_shotOrigin, _shotEnd);
      if (ev.hit && ev.n?.length >= 3) {
        vm?.spawnBulletImpact(
          _shotEnd,
          _shotNormal.set(ev.n[0], ev.n[1], ev.n[2]),
          { decal: false }
        );
      }
    }

    const audio = this.engine.audio;
    if (audio) {
      audio._ensure();
      audio.playLocalShot();
    }
  }

  _updateReplayAudio(tickFloat, dt) {
    const audio = this.engine.audio;
    if (!audio || !this.replay) return;

    const cam = this.replay.sampleCamera(tickFloat);
    const flags = decodeInput(cam.input);
    const moving = flags.W || flags.A || flags.S || flags.D;

    if (!this._sfx) {
      this._sfx = { input: cam.input, wasOnGround: true };
    }
    const sfx = this._sfx;
    const prev = decodeInput(sfx.input);
    const onGround = !flags.jump;

    if (prev.jump !== flags.jump && flags.jump) {
      audio.playLocalJump();
    }

    audio.updateLocalFootsteps(dt * this.speed, {
      onGround: true,
      crouchAmt: flags.crouch ? 1 : 0,
      walkHeld: flags.walk,
      spawnGrace: 0,
      speedHoriz: moving ? PLAYER_RUN_SPEED : 0
    });

    sfx.input = cam.input;
    sfx.wasOnGround = onGround;
  }

  _clearTracers() {
    for (const tr of this.engine.viewmodel?._tracers || []) {
      tr.t = 0;
      tr.line.visible = false;
    }
  }

  _emitProgress() {
    if (this.onProgress) {
      this.onProgress({
        time: this.time,
        duration: this.duration,
        playing: this.playing,
        speed: this.speed
      });
    }
  }

  /** Tear down the replay scene and restore the camera to a neutral pose. */
  dispose() {
    this._clearTracers();
    this.engine.viewmodel?.setVisible(false);
    if (this.root) {
      this.root.traverse((node) => {
        if (node.isMesh || node.isLine) {
          node.geometry?.dispose?.();
          if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose());
          else node.material?.dispose?.();
        }
      });
      this.engine.scene.remove(this.root);
      this.root = null;
    }
    this._envGroup = null;
    this._envSegmentIdx = -1;
    this.entities = [];
    this.analytics = null;
    this.replay = null;
    this.playing = false;
    this.time = 0;
    this.zoom = 1;
    this._sfx = null;
    this.engine.camera.fov = this._replayFov;
    this.engine.camera.updateProjectionMatrix();
    this.engine.camera.position.set(0, EYE_HEIGHT, 0);
    this.engine.camera.rotation.set(0, 0, 0, 'YXZ');
  }
}
