// ---------------------------------------------------------------------------
// ReplayRecorder.js
// Captures a run as a fixed 128-tick telemetry stream the codec can compress.
//
// Recording is decoupled from every scenario: we never touch scenario internals
// beyond reading `scenario.targets` and the live camera. Each tick we snapshot
//   • the camera (true look pitch/yaw + position) and the input bitmask, and
//   • every live target/bot's world transform (so the replay reproduces the
//     exact random target layout and bot movement — no re-simulation needed).
// Target/bot *visuals* are captured once as deduplicated "blueprints" (geometry
// + material descriptors) and the static environment (floor, cover, map) is
// snapshotted at run start, so ReplayPlayer can rebuild the whole scene.
//
// Sampling runs on a fixed accumulator: regardless of render FPS, exactly
// TICK_RATE samples are emitted per second (the spec's 128 tick requirement).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TICK_RATE, TICK_DT, inputBitmask } from '../lib/replayCodec.js';

const MAX_SECONDS = 5 * 60; // hard cap so a stuck run can't exhaust memory
const MAX_TICKS = MAX_SECONDS * TICK_RATE;

const _v = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _ac = new THREE.Vector3(); // aim-collider world centre
const _as = new THREE.Vector3(); // aim-collider world scale

function r(n, p = 1000) {
  return Math.round(n * p) / p;
}

function colorHex(material, key) {
  const c = material?.[key];
  return c && typeof c.getHex === 'function' ? c.getHex() : null;
}

/** One mesh → descriptor from an already-computed local transform matrix. */
function describeFromMatrix(node, matrix) {
  matrix.decompose(_p, _q, _s);
  const mat = Array.isArray(node.material) ? node.material[0] : node.material;
  const side = mat?.side === THREE.BackSide ? 1 : mat?.side === THREE.DoubleSide ? 2 : 0;
  return {
    geo: (node.geometry.type || 'Box').replace('Geometry', ''),
    params: { ...node.geometry.parameters },
    color: colorHex(mat, 'color'),
    emissive: colorHex(mat, 'emissive'),
    emissiveIntensity: mat?.emissiveIntensity ?? 0,
    opacity: mat?.opacity ?? 1,
    transparent: !!mat?.transparent,
    side,
    gridCover: !!(mat?.map),
    p: [r(_p.x), r(_p.y), r(_p.z)],
    q: [r(_q.x, 1e5), r(_q.y, 1e5), r(_q.z, 1e5), r(_q.w, 1e5)],
    s: [r(_s.x), r(_s.y), r(_s.z)]
  };
}

/** Flatten an Object3D subtree into descriptors local to that object. */
function describeMeshes(object) {
  object.updateWorldMatrix(true, true);
  _inv.copy(object.matrixWorld).invert();
  const meshes = [];
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    _local.multiplyMatrices(_inv, node.matrixWorld);
    meshes.push(describeFromMatrix(node, _local));
  });
  return meshes;
}

export class ReplayRecorder {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.active = false;
    this._reset();
  }

  _reset() {
    this.scenario = null;
    this.cam = [];
    this.events = [];
    this.environment = [];
    this.environmentSegments = []; // { start: tick, meshes } — supports mid-run map swaps (duels)
    this.blueprints = {}; // bpId -> descriptor
    this._bpByHash = new Map(); // dedupe identical visuals
    this._bpSeq = 0;
    this._entSeq = 0;
    this._live = new Map(); // target.object -> { id, bp, start, frames }
    this._finished = []; // entities whose target was removed
    this._acc = 0;
    this._tick = 0;
    this._ws = new THREE.Vector3();
    this.meta = {};
  }

  /** Begin recording. Snapshots the static environment from the scenario root. */
  begin({ scenario, configKey, variant, config, settings, weaponId, viewmodelRecoil, showViewmodel }) {
    this._reset();
    this.scenario = scenario;
    this.meta = {
      scenario: scenario?.name,
      configKey,
      variant,
      config: this._plainConfig(config),
      settings,
      weaponId: weaponId ?? scenario?.weaponId,
      viewmodelRecoil: viewmodelRecoil ?? scenario?.viewmodelRecoil !== false,
      showViewmodel: showViewmodel ?? scenario?.showViewmodel !== false,
      startedAt: new Date().toISOString()
    };
    this._snapshotEnvironment(scenario);
    this.active = true;
  }

  /** Only keep JSON-safe config values (drop functions / THREE objects). */
  _plainConfig(config) {
    try {
      return JSON.parse(JSON.stringify(config ?? {}));
    } catch {
      return {};
    }
  }

  _collectEnvironmentMeshes(scenario) {
    const meshes = [];
    const root = scenario?.root;
    if (!root) return meshes;
    const targetObjs = new Set((scenario.targets || []).map((t) => t.object));
    root.updateWorldMatrix(true, true);
    const walk = (node) => {
      if (targetObjs.has(node)) return; // never bake live targets into the map
      if (node.isMesh && node.geometry) {
        meshes.push(describeFromMatrix(node, node.matrixWorld));
      }
      for (const child of node.children) walk(child);
    };
    for (const child of root.children) walk(child);
    return meshes;
  }

  _snapshotEnvironment(scenario) {
    const meshes = this._collectEnvironmentMeshes(scenario);
    this.environment = meshes;
    this.environmentSegments = [{ start: 0, meshes }];
  }

  /** Snapshot the map after a mid-run arena reload (duels round resets). */
  recordEnvironmentChange() {
    if (!this.active || !this.scenario) return;
    const meshes = this._collectEnvironmentMeshes(this.scenario);
    this.environmentSegments.push({ start: this._tick, meshes });
  }

  _blueprintFor(target) {
    const savedObj = target.object.scale.x;
    const savedMesh = target._mesh?.scale.x ?? 1;
    target.object.scale.setScalar(1);
    if (target._mesh) target._mesh.scale.setScalar(1);
    const meshes = describeMeshes(target.object);
    target.object.scale.setScalar(savedObj);
    if (target._mesh) target._mesh.scale.setScalar(savedMesh);
    const hash = JSON.stringify(meshes);
    let id = this._bpByHash.get(hash);
    if (id == null) {
      id = `b${this._bpSeq++}`;
      this._bpByHash.set(hash, id);
      this.blueprints[id] = meshes;
    }
    return id;
  }

  /**
   * Advance the fixed-tick accumulator. Call once per render frame while the
   * run is active; emits 0..N telemetry ticks so the stream stays at TICK_RATE.
   */
  sample(dt) {
    if (!this.active) return;
    this._acc += dt;
    let guard = 0;
    while (this._acc >= TICK_DT && this._tick < MAX_TICKS && guard < 8) {
      this._captureTick();
      this._acc -= TICK_DT;
      this._tick++;
      guard++;
    }
    // Avoid a death-spiral of catch-up ticks after a long stall.
    if (this._acc > TICK_DT) this._acc = 0;
  }

  _captureTick() {
    const cam = this.engine.camera;
    this.cam.push({
      pitch: cam.rotation.x,
      yaw: cam.rotation.y,
      px: cam.position.x,
      py: cam.position.y,
      pz: cam.position.z,
      input: inputBitmask(this.input)
    });
    this._captureEntities();
  }

  /** Primary visual mesh — scale often lives on _mesh, not the root group. */
  _entityVisual(target) {
    // Rigged bots: track the head each tick (crouch moves it relative to the body).
    if (target.headMesh) return target.headMesh;
    if (target._mesh) return target._mesh;
    if (target.colliders?.length) return target.colliders[0];
    return target.object;
  }

  /**
   * Pick the "aim point" the analytics layer should target: the head for bots,
   * the centre for dots. Returns the offset from the tracked visual to that
   * point AND the aim zone's radius, both normalized to unit entity scale so
   * playback can reconstruct world values via `point = visualPos + aim*scale`.
   * @param {object} target  scenario target (has `colliders`, maybe `_mesh`)
   * @param {THREE.Object3D} visual  the tracked visual mesh (already positioned)
   * @param {number} entityScale  mean world scale of the visual this tick
   */
  _aimFor(target, visual, entityScale) {
    // Head mesh is tracked directly — aim point is the sample position.
    if (target.headMesh && visual === target.headMesh) {
      const head = target.headMesh;
      head.updateWorldMatrix(true, false);
      head.getWorldScale(_as);
      const geo = head.geometry;
      if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
      const colScale = (_as.x + _as.y + _as.z) / 3 || 1;
      const worldR = (geo?.boundingSphere?.radius ?? 0.22) * colScale;
      const es = entityScale || 1;
      return { aim: [0, 0, 0], aimR: r(worldR / es) };
    }

    const cols = target.colliders || [];
    const aimCol =
      cols.find((c) => c?.userData?.zone === 'head') ||
      cols.find((c) => c?.userData?.crit) ||
      target._mesh ||
      cols[0] ||
      visual;
    const es = entityScale || 1;
    visual.getWorldPosition(_v); // visual world centre (reused below safely)
    aimCol.updateWorldMatrix(true, false);
    aimCol.getWorldPosition(_ac);
    aimCol.getWorldScale(_as);
    const geo = aimCol.geometry;
    if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
    const colScale = (_as.x + _as.y + _as.z) / 3 || 1;
    const worldR = (geo?.boundingSphere?.radius ?? 0.3) * colScale;
    return {
      aim: [r((_ac.x - _v.x) / es), r((_ac.y - _v.y) / es), r((_ac.z - _v.z) / es)],
      aimR: r(worldR / es)
    };
  }

  _captureEntities() {
    const targets = this.scenario?.targets || [];
    const seen = new Set();
    for (const t of targets) {
      if (!t?.object) continue;
      seen.add(t.object);
      let rec = this._live.get(t.object);
      if (!rec) {
        rec = { id: this._entSeq++, bp: this._blueprintFor(t), start: this._tick, frames: [] };
        this._live.set(t.object, rec);
      }
      t.object.updateWorldMatrix(true, true);
      const visual = this._entityVisual(t);
      visual.getWorldPosition(_v);
      visual.getWorldScale(this._ws);
      const meanScale = (this._ws.x + this._ws.y + this._ws.z) / 3;
      rec.frames.push({ x: _v.x, y: _v.y, z: _v.z, s: meanScale });
      // Aim point (head for bots / centre for dots) is constant in local space —
      // capture it once from the first frame. (clobbers _v internally; safe now.)
      if (!rec.aim) {
        const a = this._aimFor(t, visual, meanScale);
        rec.aim = a.aim;
        rec.aimR = a.aimR;
      }
    }
    // Finalize entities whose target vanished since the last tick.
    for (const [obj, rec] of this._live) {
      if (!seen.has(obj)) {
        this._finished.push(rec);
        this._live.delete(obj);
      }
    }
  }

  /**
   * Record a shot for tracer/impact playback.
   * @param {{origin:THREE.Vector3, end:THREE.Vector3, hit?:boolean, by?:string}} shot
   */
  recordShot({ origin, end, hit = false, by = 'player', normal = null }) {
    if (!this.active) return;
    const ev = {
      t: this._tick,
      type: 'shot',
      by,
      o: [r(origin.x), r(origin.y), r(origin.z)],
      e: [r(end.x), r(end.y), r(end.z)],
      hit: hit ? 1 : 0
    };
    if (normal) {
      ev.n = [r(normal.x), r(normal.y), r(normal.z)];
    }
    if (hit) {
      let bestId = null;
      let bestD = Infinity;
      for (const rec of this._live.values()) {
        const frames = rec.frames;
        const f = frames[frames.length - 1];
        if (!f || !rec.aim) continue;
        const s = f.s || 1;
        const ax = f.x + rec.aim[0] * s;
        const ay = f.y + rec.aim[1] * s;
        const az = f.z + rec.aim[2] * s;
        const rad = (rec.aimR > 0 ? rec.aimR : 0.4) * s * 1.25;
        const d = Math.hypot(end.x - ax, end.y - ay, end.z - az);
        if (d <= rad && d < bestD) {
          bestD = d;
          bestId = rec.id;
        }
      }
      if (bestId != null) ev.ent = bestId;
    }
    this.events.push(ev);
  }

  /** Stop and return the raw recording for encodeReplay (or null if too short). */
  finish() {
    if (!this.active) return null;
    this.active = false;
    for (const rec of this._live.values()) this._finished.push(rec);
    this._live.clear();
    if (this.cam.length < TICK_RATE / 4) return null; // <0.25s — not worth saving

    return {
      scenario: this.meta.scenario,
      configKey: this.meta.configKey,
      variant: this.meta.variant,
      config: this.meta.config,
      settings: this.meta.settings,
      weaponId: this.meta.weaponId,
      viewmodelRecoil: this.meta.viewmodelRecoil,
      showViewmodel: this.meta.showViewmodel,
      startedAt: this.meta.startedAt,
      blueprints: this.blueprints,
      environment: this.environment,
      environmentSegments: this.environmentSegments,
      cam: this.cam,
      entities: this._finished.sort((a, b) => a.start - b.start),
      events: this.events
    };
  }

  cancel() {
    this.active = false;
    this._reset();
  }
}
