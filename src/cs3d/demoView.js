// ---------------------------------------------------------------------------
// src/cs3d/demoView.js
// Demo playback inside the map explorer: ten placeholder bodies driven by a
// round's tick buffer, every grenade the round threw, and a POV camera that
// puts you behind any player's recorded eyes. CS3D-PLAN's "3D timeline
// viewer", first standing version.
//
// Bodies are the game's own agent models when the players pack is present
// (scripts/cs3d-models.mjs → src/cs3d/playerModels.js): a T and a CT model,
// animated by the world-model locomotion clips from the tick record's speed,
// heading, duck amount and held weapon, aiming on the recorded pitch. Without
// the pack (a fresh clone, a host without the local assets) the placeholder
// stays: a team-coloured cylinder with a nose block for facing. Everything
// positional is exact either way: origins, view angles, duck state and deaths
// come straight from the demo, and the interpolation between rows is the same
// shortest-path angle lerp the 2D viewer uses.
//
// Grenades come from GrenadeEvents: a small sphere flies the recorded path
// (linear between the parser's waypoints), and the detonation leaves a
// placeholder volume — grey sphere for smoke, orange disc for fire — sized
// to CS2's nominal radii. Durations are placeholders pending the utility
// systems (CS3D-ENGINE-PLAN E-5); the point today is that you can SEE the
// round: who was where, which smoke was up, who peeked through it.
//
// Rendering: everything lives under one group that is attached to the pack's
// world root, so the two-pass sky/world render and the flat view treat the
// demo layer exactly like map geometry. Materials are MeshBasicMaterial on
// purpose: readable in any lighting, indifferent to V mode, zero cost.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { FLAG_DUCKING, FLAG_AIRBORNE, readRecord, lerpAngle } from '../replays/shared/tickFormat.js';
import { cameraYawFromSource } from '../../shared/sim3d/units.js';
import { HULL_STAND, HULL_DUCK, EYE_STAND, EYE_DUCK, HULL_HALF_WIDE } from '../../shared/sim3d/constants.js';
import { SMOKE_SECONDS, SMOKE_RADIUS, FIRE_SECONDS } from './nadeEffects.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/**
 * Post-detonation lifetimes and sizes come from src/cs3d/nadeEffects.js (see
 * the import above), so a smoke in a replay stands for as long as one you throw
 * yourself and the provenance of each number lives in one place.
 *
 * The volumes here stay placeholders on purpose: this view derives its whole
 * state fresh from the event list every frame, which is what makes scrubbing
 * backwards free, while NadeEffects owns a running clock. Two different jobs;
 * the numbers are the part worth sharing.
 */
const POP_SECONDS = 0.3;
const FIRE_RADIUS = 110;

const TEAM_COLOR = { T: 0xd9a24a, CT: 0x5b87e0 };
const NADE_COLOR = {
  smokegrenade: 0xc8ccd0,
  flashbang: 0xfff0a8,
  hegrenade: 0xd8503a,
  molotov: 0xe87a28,
  incgrenade: 0xe87a28,
  decoy: 0x7fc46a
};

const _a = {};
const _b = {};

export class DemoView {
  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {() => import('./mapLoader.js').MapPack|null} o.getPack
   * @param {import('./playerModels.js').PlayerModels} [o.playerModels]  the
   *   agent models + clips; bodies fall back to placeholders until it is ready
   * @param {(view: DemoView) => void} [o.onChange]  fired on state changes
   *   (round, play, POV) — not per frame; the HUD polls status() for the clock.
   */
  constructor({ camera, getPack, playerModels, onChange }) {
    this.camera = camera;
    this.getPack = getPack;
    this.playerModels = playerModels || null;
    this.onChange = onChange || (() => {});

    this.demo = null;
    this.roundIndex = 0;
    this.meta = null;
    this.ticks = null; // { header, view }
    this.row = 0;
    this.playing = false;
    this.speed = 1;
    this.povSlot = null;
    this._eye = EYE_STAND;
    this._last = 0;
    this._lastRow = -1;
    /** POV player's weapon/speed/view for the viewmodel; see povState(). */
    this._pov = null;

    this.root = new THREE.Group();
    this.root.name = 'demo';
    this._bodies = [];
    this._teamMats = {
      T: new THREE.MeshBasicMaterial({ color: TEAM_COLOR.T }),
      CT: new THREE.MeshBasicMaterial({ color: TEAM_COLOR.CT }),
      unknown: new THREE.MeshBasicMaterial({ color: 0x9a9a9a })
    };
    this._noseMat = new THREE.MeshBasicMaterial({ color: 0x18181c });
    this._bodyGeo = new THREE.CylinderGeometry(HULL_HALF_WIDE, HULL_HALF_WIDE, 1, 12);
    this._bodyGeo.translate(0, 0.5, 0); // origin at the feet, scale.y = height
    this._noseGeo = new THREE.BoxGeometry(18, 9, 9);
    for (let slot = 0; slot < 10; slot++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(this._bodyGeo, this._teamMats.unknown);
      body.scale.y = HULL_STAND;
      const nose = new THREE.Mesh(this._noseGeo, this._noseMat);
      nose.position.set(HULL_HALF_WIDE + 6, EYE_STAND - 4, 0);
      g.add(body, nose);
      g.visible = false;
      this.root.add(g);
      // `model` is the animated agent body once the players pack has loaded;
      // `group` (the placeholder) then stays hidden. `prev` is the last frame's
      // sample, for the velocity the locomotion blend runs on.
      this._bodies.push({ group: g, body, nose, model: null, prev: null });
    }

    this._nades = new Map(); // grenade index -> { mesh, kind }
    this._nadeGeo = new THREE.SphereGeometry(5, 10, 8);
    this._smokeGeo = new THREE.SphereGeometry(SMOKE_RADIUS, 20, 14);
    this._fireGeo = new THREE.CylinderGeometry(FIRE_RADIUS, FIRE_RADIUS, 6, 20);
    this._popGeo = new THREE.SphereGeometry(30, 12, 8);
  }

  get active() {
    return !!this.ticks;
  }

  /** @param demo  from demoData.loadDemoBytes */
  setDemo(demo) {
    this.demo = demo;
    this.roundIndex = -1;
    this.setRound(0);
  }

  clear() {
    this.demo = null;
    this.meta = null;
    this.ticks = null;
    this.playing = false;
    this.povSlot = null;
    this._pov = null;
    for (const b of this._bodies) {
      b.group.visible = false;
      if (b.model) b.model.group.visible = false;
      b.prev = null;
    }
    this._clearNades();
    this.root.removeFromParent();
    this.onChange(this);
  }

  setRound(index) {
    if (!this.demo) return;
    const n = this.demo.rounds.length;
    const i = Math.max(0, Math.min(n - 1, index));
    if (i === this.roundIndex) return;
    const r = this.demo.rounds[i];
    this.ticks = this.demo.loadRound(r.stem);
    this.meta = r.meta;
    this.roundIndex = i;
    // Start where the round goes live, not in freezetime.
    const live = (this.meta.freezeEndTick ?? this.ticks.header.firstTick) - this.ticks.header.firstTick;
    this.row = Math.max(0, Math.min(this.ticks.header.tickCount - 1, live));
    this.playing = true;
    this._clearNades();
    this.onChange(this);
  }

  shiftRound(d) {
    this.setRound(this.roundIndex + d);
  }

  togglePlay() {
    if (!this.ticks) return;
    this.playing = !this.playing;
    this.onChange(this);
  }

  /** Pause and move by whole ticks (±1 frame-step, ±32 half-second). */
  step(dTicks) {
    if (!this.ticks) return;
    this.playing = false;
    this.row = Math.max(0, Math.min(this.ticks.header.tickCount - 1, Math.round(this.row) + dTicks));
    this.onChange(this);
  }

  cycleSpeed() {
    if (!this.ticks) return;
    const i = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[(i + 1) % SPEEDS.length];
    this.onChange(this);
  }

  /**
   * Enter a player's eyes (slot 0-9), or null for the free camera. Leaving
   * hands the fly camera the POV's view so there is no snap.
   */
  setPov(slot) {
    if (!this.ticks) return;
    this.povSlot = slot === this.povSlot ? null : slot;
    this.onChange(this);
  }

  /**
   * One display row per player for the HUD roster, in slot order. `side` is
   * this ROUND's side (teams swap at half), so the roster colours always
   * match the bodies on the map.
   */
  roster() {
    if (!this.meta) return [];
    const players = this.meta.players || [];
    return players.map((p) => ({
      slot: p.slot,
      name: p.name || p.id || `#${p.slot}`,
      side: (p.team === 1 ? this.meta.team1Side : this.meta.team2Side) || '',
      pov: this.povSlot === p.slot
    }));
  }

  /**
   * What the POV player is doing this frame, for the viewmodel: the weapon in
   * their hands, how fast they are moving, where they are looking. Null when
   * nobody's eyes are borrowed.
   *
   * Written by `update()` rather than recomputed, because everything in it was
   * already sampled to place that player's body.
   */
  povState() {
    return this.povSlot === null ? null : this._pov;
  }

  /**
   * How many shots a slot fired between the previous drawn frame's tick and
   * this one. Playing forward that is normally 0 or 1; at 4× or after a step
   * it can be several, and each one kicks the viewmodel.
   *
   * Scrubbing backwards returns 0 rather than a negative — a rewind should not
   * fire the gun.
   */
  _shotsCrossed(slot) {
    const shots = this.meta?.events?.shots;
    if (!shots?.length || !this.ticks) return 0;
    const h = this.ticks.header;
    const to = h.firstTick + this.row * h.stride;
    const from = this._shotTick === undefined ? to : this._shotTick;
    this._shotTick = to;
    if (!(to > from) || to - from > (h.tickRate || 64)) return 0;
    const who = this.meta.players?.find((p) => p.slot === slot)?.id;
    let n = 0;
    for (const s of shots) {
      if (s.tick > from && s.tick <= to && (s.player === who || s.slot === slot)) n++;
    }
    return n;
  }

  /** Everything the HUD strip shows, cheap enough to poll per frame. */
  status() {
    if (!this.ticks || !this.meta) return null;
    const h = this.ticks.header;
    const tick = h.firstTick + this.row * h.stride;
    const live = this.meta.freezeEndTick ?? h.firstTick;
    const t = (tick - live) / (h.tickRate || 64);
    const povName =
      this.povSlot !== null ? (this.meta.players?.find((p) => p.slot === this.povSlot)?.name ?? `#${this.povSlot}`) : null;
    return {
      round: this.meta.round,
      rounds: this.demo.rounds.length,
      clock: t,
      playing: this.playing,
      speed: this.speed,
      pov: povName,
      atEnd: this.row >= h.tickCount - 1
    };
  }

  /** Advance the clock and write every transform. Call once per frame. */
  update(now) {
    const dt = this._last ? Math.min(0.25, (now - this._last) / 1000) : 0;
    this._last = now;
    if (!this.ticks) return;

    // The demo layer draws with the world (second pass), so it parents there.
    const pack = this.getPack();
    if (!this.root.parent && pack?.world) pack.world.add(this.root);

    const h = this.ticks.header;
    if (this.playing) {
      this.row += dt * (h.tickRate || 64) * this.speed;
      if (this.row >= h.tickCount - 1) {
        this.row = h.tickCount - 1;
        this.playing = false;
        this.onChange(this);
      }
    }

    const r0 = Math.floor(this.row);
    const r1 = Math.min(h.tickCount - 1, r0 + 1);
    const f = this.row - r0;
    // Demo seconds this frame advanced, for the animation mixers: paused, the
    // pose holds; a frame-step while paused moves it one tick; at 4× the legs
    // run 4×.
    const demoDt = this.playing ? dt * this.speed : this.row !== this._lastRow ? 1 / (h.tickRate || 64) : 0;
    this._lastRow = this.row;
    const rowsPerSecond = (h.tickRate || 64) / (h.stride || 1);
    const useModels = !!this.playerModels?.ready;

    for (let slot = 0; slot < (h.playerCount || 10); slot++) {
      const a = readRecord(this.ticks.view, r0, slot, _a);
      const bodyState = this._bodies[slot];
      if (!a.alive) {
        bodyState.group.visible = false;
        if (bodyState.model) bodyState.model.group.visible = false;
        bodyState.prev = null;
        continue;
      }
      const b = readRecord(this.ticks.view, r1, slot, _b);
      const useB = b.alive; // never lerp into a corpse's reset position
      const x = useB ? a.x + (b.x - a.x) * f : a.x;
      const y = useB ? a.y + (b.y - a.y) * f : a.y;
      const z = useB ? a.z + (b.z - a.z) * f : a.z;
      const yaw = useB ? lerpAngle(a.yaw, b.yaw, f) : a.yaw;
      const pitch = useB ? a.pitch + (b.pitch - a.pitch) * f : a.pitch;
      // The continuous duck (parser revision 3+) drives the hull directly, so
      // a crouch animates instead of snapping — 29% of crouch-state ticks are
      // mid-transition. Rounds parsed before that store 0 here and fall back
      // to the boolean, which for revision < 3 is itself always 0: those
      // rounds simply have no crouch data and render standing. See
      // shared/sim3d/deriveFlags.js for why it cannot be recovered.
      const amount = useB ? a.duckAmount + (b.duckAmount - a.duckAmount) * f : a.duckAmount;
      const duck = amount > 0 ? amount : (a.flags & FLAG_DUCKING) !== 0 ? 1 : 0;

      const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
      const visible = slot !== this.povSlot;
      // Velocity from the row-to-row delta, once per body: the legs run on it
      // and so do the POV's hands, so they are always in step.
      const prev = bodyState.prev;
      let speed = 0;
      let moveYaw = yaw;
      if (prev && prev.row !== this.row) {
        const dtRows = Math.abs(this.row - prev.row);
        if (dtRows > 0 && dtRows < 8) {
          const dxr = (x - prev.x) / dtRows;
          const dyr = (y - prev.y) / dtRows;
          speed = Math.hypot(dxr, dyr) * rowsPerSecond;
          if (speed > 1) moveYaw = Math.atan2(dyr, dxr) * RAD;
        }
      }
      bodyState.prev = { row: this.row, x, y, z };
      if (useModels && (a.side === 'T' || a.side === 'CT')) {
        // The agent model. Velocity from the row-to-row delta (¼-unit
        // quantised, smoothed inside the body); heading from that velocity;
        // airborne only when the record says so — the derived flag is not
        // worth a body that hops on every staircase.
        let m = bodyState.model;
        if (!m) {
          m = bodyState.model = this.playerModels.createBody(a.side);
          this.root.add(m.group);
        } else if (m.side !== a.side) m.setSide(a.side);
        bodyState.group.visible = false;
        m.set({
          speed,
          moveYaw,
          viewYaw: yaw,
          pitch,
          duck,
          airborne: (a.flags & FLAG_AIRBORNE) !== 0,
          weapon: this.meta.weapons?.[a.weapon] || '',
          alive: true
        });
        m.group.position.set(x, z, -y);
        m.update(demoDt);
        m.group.visible = visible;
      } else {
        if (bodyState.model) bodyState.model.group.visible = false;
        const g = bodyState.group;
        g.visible = visible;
        // Source (x, y, z) → scene (x, z, −y); yaw is rotation.y for a +x-forward object.
        g.position.set(x, z, -y);
        g.rotation.y = yaw * DEG;
        const hull = HULL_STAND + (HULL_DUCK - HULL_STAND) * duck;
        bodyState.body.scale.y = hull;
        bodyState.nose.position.y = eye - 4;
        const mat = this._teamMats[a.side] || this._teamMats.unknown;
        if (bodyState.body.material !== mat) bodyState.body.material = mat;
      }

      if (slot === this.povSlot) {
        // With a real duck amount the camera follows it exactly, which is the
        // game's own curve; without one, ease so the fallback boolean does not
        // snap the view 18 units.
        this._eye = amount > 0 ? eye : this._eye + (eye - this._eye) * Math.min(1, dt * 14);
        this.camera.position.set(x, z + this._eye, -y);
        this.camera.rotation.set(-pitch * DEG, cameraYawFromSource(yaw), 0, 'YXZ');
        // For the viewmodel: what this player is holding and how they move.
        // Speed comes from the same row delta the body's legs run on, so the
        // hands bob in step with the feet.
        this._pov = {
          side: a.side,
          weapon: this.meta.weapons?.[a.weapon] || '',
          speed,
          airborne: (a.flags & FLAG_AIRBORNE) !== 0,
          yaw,
          pitch,
          eye: this.camera.position,
          // Shots this player fired in the ticks the clock just crossed, so
          // the viewmodel kicks on the demo's own trigger pulls rather than
          // on a guess from the animation.
          shots: this._shotsCrossed(slot)
        };
      }
    }

    this._updateNades();
  }

  // ---- grenades -----------------------------------------------------------

  _clearNades() {
    for (const n of this._nades.values()) {
      n.mesh.removeFromParent();
      n.mesh.material.dispose();
    }
    this._nades.clear();
  }

  _nadeMesh(index, geo, color, opacity) {
    let n = this._nades.get(index);
    if (n?.geo === geo) return n.mesh;
    if (n) {
      n.mesh.removeFromParent();
      n.mesh.material.dispose();
    }
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1
      })
    );
    this.root.add(mesh);
    this._nades.set(index, { mesh, geo });
    return mesh;
  }

  _dropNade(index) {
    const n = this._nades.get(index);
    if (!n) return;
    n.mesh.removeFromParent();
    n.mesh.material.dispose();
    this._nades.delete(index);
  }

  /**
   * Grenade state is derived fresh from the event list every frame — a scan
   * of at most a few dozen events — so scrubbing backwards needs no undo log.
   */
  _updateNades() {
    const grenades = this.meta?.events?.grenades || [];
    const h = this.ticks.header;
    const tick = h.firstTick + this.row * h.stride;
    const rate = h.tickRate || 64;

    for (let i = 0; i < grenades.length; i++) {
      const g = grenades[i];
      const color = NADE_COLOR[g.type] ?? 0xffffff;
      const path = Array.isArray(g.path) ? g.path : [];
      const lastPathTick = path.length ? path[path.length - 1].tick : g.throwTick;
      const det = g.detonateTick ?? lastPathTick;

      if (tick >= g.throwTick && tick < det && path.length >= 2) {
        // In flight: linear between the parser's waypoints.
        let k = 0;
        while (k + 2 < path.length && path[k + 1].tick <= tick) k++;
        const p0 = path[k];
        const p1 = path[Math.min(k + 1, path.length - 1)];
        const span = Math.max(1, p1.tick - p0.tick);
        const t = Math.max(0, Math.min(1, (tick - p0.tick) / span));
        const x = p0.x + (p1.x - p0.x) * t;
        const y = p0.y + (p1.y - p0.y) * t;
        const z = p0.z + (p1.z - p0.z) * t;
        const mesh = this._nadeMesh(i, this._nadeGeo, color, 1);
        mesh.position.set(x, z, -y);
        continue;
      }

      // Detonated: a placeholder volume at the recorded point, for a while.
      const at = g.at || (path.length ? path[path.length - 1] : null);
      const since = g.detonateTick !== null && g.detonateTick !== undefined ? (tick - g.detonateTick) / rate : -1;
      if (at && since >= 0) {
        if (g.type === 'smokegrenade' && since < SMOKE_SECONDS) {
          const mesh = this._nadeMesh(i, this._smokeGeo, 0xb8bcc0, 0.72);
          mesh.position.set(at.x, at.z + 30, -at.y);
          continue;
        }
        if ((g.type === 'molotov' || g.type === 'incgrenade') && since < FIRE_SECONDS) {
          const mesh = this._nadeMesh(i, this._fireGeo, 0xe06818, 0.5);
          mesh.position.set(at.x, at.z + 4, -at.y);
          continue;
        }
        if ((g.type === 'flashbang' || g.type === 'hegrenade') && since < POP_SECONDS) {
          const mesh = this._nadeMesh(i, this._popGeo, color, 0.8 * (1 - since / POP_SECONDS));
          mesh.position.set(at.x, at.z + 8, -at.y);
          continue;
        }
      }
      this._dropNade(i);
    }
  }
}
