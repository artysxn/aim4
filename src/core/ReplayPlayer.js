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

export const REPLAY_SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4];

const TRACER_LIFE = 0.09; // seconds (scaled by timescale so it lingers in slow-mo)

function makeGeometry(d) {
  const p = d.params || {};
  switch (d.geo) {
    case 'Sphere':
      return new THREE.SphereGeometry(p.radius ?? 0.5, p.widthSegments ?? 16, p.heightSegments ?? 12);
    case 'Box':
      return new THREE.BoxGeometry(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
    case 'Cylinder':
      return new THREE.CylinderGeometry(
        p.radiusTop ?? 0.5, p.radiusBottom ?? 0.5, p.height ?? 1, p.radialSegments ?? 16
      );
    case 'Plane':
      return new THREE.PlaneGeometry(p.width ?? 1, p.height ?? 1);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function makeMesh(d) {
  const mat = new THREE.MeshStandardMaterial({
    color: d.color ?? 0xffffff,
    emissive: d.emissive ?? 0x000000,
    emissiveIntensity: d.emissiveIntensity ?? 0,
    roughness: 0.6,
    metalness: 0.05,
    transparent: !!d.transparent,
    opacity: d.opacity ?? 1
  });
  const mesh = new THREE.Mesh(makeGeometry(d), mat);
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
    this.entities = []; // { data, object }
    this.tracers = [];

    this.playing = false;
    this.speed = 1;
    this.time = 0; // seconds into the replay
    this.duration = 0;
    this._prevTick = -1;

    this.onProgress = null; // ({ time, duration, playing, speed }) => void
    this.onEnd = null;
  }

  get active() {
    return !!this.replay;
  }

  /** Load a decoded replay, rebuild the scene, and pause at t=0. */
  load(replay) {
    this.dispose();
    this.replay = replay;
    this.duration = replay.durationSec;
    this.time = 0;
    this._prevTick = -1;
    this.speed = 1;
    this.playing = false;

    this.root = new THREE.Group();
    this.root.name = 'replay-root';
    this.engine.scene.add(this.root);

    this._buildEnvironment(replay);
    this._buildEntities(replay);

    // Hide the live first-person gun; a replay is a free observer of the run.
    this.engine.viewmodel?.setVisible(false);
    this._applyTick(0);
    this._emitProgress();
  }

  _buildEnvironment(replay) {
    for (const d of replay.environment || []) {
      this.root.add(makeMesh(d));
    }
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
    this._prevTick = Math.floor(this.time * this.replay.tickRate);
    this._emitProgress();
  }

  pause() {
    this.playing = false;
    this._emitProgress();
  }

  togglePlay() {
    this.playing ? this.pause() : this.play();
  }

  setSpeed(speed) {
    if (REPLAY_SPEEDS.includes(speed)) this.speed = speed;
    this._emitProgress();
  }

  /** Scrub to a fraction [0,1] of the timeline. */
  seekFraction(frac) {
    if (!this.replay) return;
    this.time = Math.max(0, Math.min(1, frac)) * this.duration;
    this._prevTick = Math.floor(this.time * this.replay.tickRate); // don't re-fire past shots
    this._clearTracers();
    this._applyTick(this.time * this.replay.tickRate);
    this._emitProgress();
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
      this._fireEventsUpTo(tickFloat);
      this._applyTick(tickFloat);
      this._emitProgress();
    }
    this._updateTracers(dt * this.speed);
  }

  _applyTick(tickFloat) {
    const r = this.replay;
    const cam = r.sampleCamera(tickFloat);
    const camera = this.engine.camera;
    camera.position.set(cam.px, cam.py, cam.pz);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');

    for (const e of this.entities) {
      const s = r.sampleEntity(e.data, tickFloat);
      if (!s) {
        e.object.visible = false;
        continue;
      }
      e.object.visible = true;
      e.object.position.set(s.x, s.y, s.z);
      e.object.scale.setScalar(Math.max(0.0001, s.s));
    }
  }

  _fireEventsUpTo(tickFloat) {
    const r = this.replay;
    const tick = Math.floor(tickFloat);
    if (tick <= this._prevTick) {
      this._prevTick = tick;
      return;
    }
    for (const ev of r.events) {
      if (ev.type === 'shot' && ev.t > this._prevTick && ev.t <= tick) {
        this._spawnTracer(ev.o, ev.e);
      }
    }
    this._prevTick = tick;
  }

  _spawnTracer(o, e) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(o[0], o[1], o[2]),
      new THREE.Vector3(e[0], e[1], e[2])
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 1 });
    const line = new THREE.Line(geo, mat);
    this.root.add(line);
    this.tracers.push({ line, life: TRACER_LIFE });
  }

  _updateTracers(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= Math.abs(dt);
      if (t.life <= 0) {
        this._disposeTracer(t);
        this.tracers.splice(i, 1);
      } else {
        t.line.material.opacity = Math.max(0, t.life / TRACER_LIFE);
      }
    }
  }

  _disposeTracer(t) {
    this.root.remove(t.line);
    t.line.geometry.dispose();
    t.line.material.dispose();
  }

  _clearTracers() {
    for (const t of this.tracers) this._disposeTracer(t);
    this.tracers.length = 0;
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
    this.entities = [];
    this.replay = null;
    this.playing = false;
    this.time = 0;
    this.engine.camera.position.set(0, EYE_HEIGHT, 0);
    this.engine.camera.rotation.set(0, 0, 0, 'YXZ');
  }
}
