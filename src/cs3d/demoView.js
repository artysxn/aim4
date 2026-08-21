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
// Grenades are the practice mode's own effects, driven from the playhead
// rather than from a clock: src/cs3d/demoNades.js over src/cs3d/nadeEffects.js.
// A replayed smoke is the same raymarched volume you get when you throw one, a
// molotov burns with the game's flame sheets and leaves the same scorch, and a
// flashbang blinds the eyes you are borrowing by RadiusFlash against where
// that player was actually looking. The flight is drawn from the recorded
// waypoints, with the trail practice mode gives a throw.
//
// Rendering: everything lives under one group that is attached to the pack's
// world root, so the two-pass sky/world render and the flat view treat the
// demo layer exactly like map geometry. Materials are MeshBasicMaterial on
// purpose: readable in any lighting, indifferent to V mode, zero cost.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { FLAG_DUCKING, FLAG_AIRBORNE, PLAYER_SLOTS, readRecord, lerpAngle } from '../replays/shared/tickFormat.js';
import { cameraYawFromSource } from '../../shared/sim3d/units.js';
import { HULL_STAND, HULL_DUCK, EYE_STAND, EYE_DUCK, HULL_HALF_WIDE } from '../../shared/sim3d/constants.js';
import { hudLoadout, inventoryAt } from '../replays/viewer/equipmentIcons.js';
import { markXrayObject, xrayIconList } from './xray.js';
import {
  consumeForward,
  resolveDemoHit,
  applyTraceHit,
  killedOnTick,
  createPovFlinch,
  addPovFlinch,
  decayPovFlinch,
  resetPovFlinch,
  scaledAimPunch,
  scaledCameraPunch
} from './demoHits.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const SPEEDS = [0.25, 0.5, 1, 2, 4];

const TEAM_COLOR = { T: 0xd9a24a, CT: 0x5b87e0 };

const _a = {};
const _b = {};
const _c = {};
const _radarNext = {};
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

export class DemoView {
  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {() => import('./mapLoader.js').MapPack|null} o.getPack
   * @param {import('./playerModels.js').PlayerModels} [o.playerModels]  the
   *   agent models + clips; bodies fall back to placeholders until it is ready
   * @param {import('./demoNades.js').DemoNades} [o.nades]  the round's utility,
   *   drawn with the practice engine. Without one a demo simply has no grenades.
   * @param {import('./blood.js').BloodSpray} [o.blood]
   * @param {(view: DemoView) => void} [o.onChange]  fired on state changes
   *   (round, play, POV) — not per frame; the HUD polls status() for the clock.
   */
  constructor({ camera, getPack, playerModels, nades, blood, onChange }) {
    this.camera = camera;
    this.getPack = getPack;
    this.playerModels = playerModels || null;
    this.nades = nades || null;
    this.blood = blood || null;
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
    this._flinch = createPovFlinch();
    this._camPunch = [0, 0, 0];
    this._aimPunch = [0, 0, 0];
    this._hurtTick = null;
    this._hurtRound = -1;
    this._hitStates = Array.from({ length: 10 }, () => ({}));
    this._pendingHits = [];

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
      markXrayObject(g);
      g.visible = false;
      this.root.add(g);
      // `model` is the animated agent body once the players pack has loaded;
      // `group` (the placeholder) then stays hidden. `prev` is the last frame's
      // sample, for the velocity the locomotion blend runs on.
      this._bodies.push({ group: g, body, nose, model: null, prev: null, lastLive: null });
    }

    /** Source-space dots for the match HUD radar. Rewritten every update. */
    this.marks = [];
    /** Reused by radarFrame() so hold-Q does not allocate ten states a frame. */
    this._radarStates = [];
    /** Bound once: demoNades.js holds it across frames. See _sampleView. */
    this._povAt = (tick) => this._sampleView(tick);
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
    this.nades?.clear();
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
    this.nades?.setEvents(this.meta.events?.grenades, this.ticks.header.tickRate || 64);
    this._hurtTick = null;
    this._hurtRound = i;
    resetPovFlinch(this._flinch);
    for (const b of this._bodies) b.lastLive = null;
    this.onChange(this);
  }

  shiftRound(d) {
    this.setRound(this.roundIndex + d);
  }

  /** Rewind to freeze-end and play. */
  restart() {
    if (!this.ticks) return;
    const live = (this.meta.freezeEndTick ?? this.ticks.header.firstTick) - this.ticks.header.firstTick;
    this.row = Math.max(0, Math.min(this.ticks.header.tickCount - 1, live));
    this.playing = true;
    // A restart is a jump backwards; the effects are rebuilt from the playhead.
    this.nades?.clear();
    this.nades?.setEvents(this.meta.events?.grenades, this.ticks.header.tickRate || 64);
    this.onChange(this);
  }

  /** Alive slots in the current row, in slot order. Same skip-dead as view3d. */
  liveSlots() {
    if (!this.ticks) return [];
    const r0 = Math.max(0, Math.min(this.ticks.header.tickCount - 1, Math.floor(this.row)));
    const out = [];
    for (let slot = 0; slot < (this.ticks.header.playerCount || 10); slot++) {
      if (readRecord(this.ticks.view, r0, slot, _a).alive) out.push(slot);
    }
    return out;
  }

  playerName(slot) {
    return this.meta?.players?.find((p) => p.slot === slot)?.name || '';
  }

  /**
   * Match-HUD fields for one slot at the current row. Null when the demo is
   * not loaded. Money and util are freezetime stats plus pickups; mag counts
   * are not in the tick record.
   */
  hudOverlay(slot) {
    if (!this.ticks || slot == null || slot < 0) return null;
    const r0 = Math.max(0, Math.min(this.ticks.header.tickCount - 1, Math.floor(this.row)));
    const a = readRecord(this.ticks.view, r0, slot, _a);
    const player = this.meta.players?.find((p) => p.slot === slot);
    const id = player?.id;
    const stats = (id && this.meta.stats?.[id]) || {};
    const h = this.ticks.header;
    const tick = h.firstTick + this.row * h.stride;
    const weapon = this.meta.weapons?.[a.weapon] || '';
    const inv = inventoryAt({
      loadout: stats.loadout || [],
      grenades: this.meta.events?.grenades,
      itemEvents: this.meta.events?.items,
      playerId: id,
      tick,
      state: a,
      activeWeapon: weapon
    });
    const nades = (inv.util || []).filter((x) => x !== 'defuser' && x !== 'c4');
    const slots = hudLoadout(inv);
    const kills = (this.meta.events?.kills || []).filter((k) => k.attacker === id && k.tick <= tick).length;
    return {
      hp: a.alive ? a.health : 0,
      dead: !a.alive,
      side: a.side || '',
      money: stats.money || 0,
      held: slots.held || weapon,
      primary: slots.primary,
      pistol: slots.pistol,
      knife: 'knife',
      nades,
      clip: '',
      reserve: '',
      roundKills: kills,
      name: player?.name || 'Bot',
      x: a.x,
      y: a.y,
      z: a.z,
      yaw: a.yaw
    };
  }

  /**
   * Visible demo bodies for X-ray: silhouette object, name, HP, loadout.
   * The followed POV slot is already hidden, so it never appears here.
   */
  xraySubjects() {
    if (!this.ticks) return [];
    const h = this.ticks.header;
    const r0 = Math.max(0, Math.min(h.tickCount - 1, Math.floor(this.row)));
    const tick = h.firstTick + this.row * h.stride;
    const out = [];
    for (let slot = 0; slot < (h.playerCount || 10); slot++) {
      const bodyState = this._bodies[slot];
      const obj = bodyState.model?.group?.visible
        ? bodyState.model.group
        : bodyState.group.visible
          ? bodyState.group
          : null;
      if (!obj) continue;
      const a = readRecord(this.ticks.view, r0, slot, _a);
      if (!a.alive) continue;
      const duck = a.duckAmount > 0 ? a.duckAmount : (a.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
      const player = this.meta.players?.find((p) => p.slot === slot);
      const id = player?.id;
      const stats = (id && this.meta.stats?.[id]) || {};
      const weapon = this.meta.weapons?.[a.weapon] || '';
      const inv = inventoryAt({
        loadout: stats.loadout || [],
        grenades: this.meta.events?.grenades,
        itemEvents: this.meta.events?.items,
        playerId: id,
        tick,
        state: a,
        activeWeapon: weapon
      });
      out.push({
        id: id || `demo-${slot}`,
        object: obj,
        name: player?.name || '',
        hp: a.alive ? a.health : 0,
        side: a.side === 'CT' ? 'CT' : a.side === 'T' ? 'T' : '',
        duck,
        items: xrayIconList(inv)
      });
    }
    return out;
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
   * Put the camera in a player's eyes, or `null` for the free camera.
   * Unlike `setPov`, this does not toggle: clicking the next bot must land
   * on that bot, not turn POV off.
   */
  followSlot(slot) {
    if (!this.ticks) {
      this.povSlot = null;
      return;
    }
    const next = slot == null || slot === '' ? null : Number(slot);
    const resolved = Number.isFinite(next) ? next : null;
    if (this.povSlot === resolved) return;
    this.povSlot = resolved;
    this.onChange(this);
  }

  /**
   * Enter a player's eyes (slot 0-9), or null for the free camera. Leaving
   * hands the fly camera the POV's view so there is no snap.
   */
  setPov(slot) {
    if (!this.ticks) return;
    this.followSlot(slot === this.povSlot ? null : slot);
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

  _applyHurts(tick, rate, demoDt) {
    const from = this._hurtTick;
    this._hurtTick = tick;
    this._pendingHits.length = 0;
    if (from != null && (tick < from || tick - from > rate)) resetPovFlinch(this._flinch);
    const roundKey = this.roundIndex;
    if (roundKey !== this._hurtRound) {
      this._hurtRound = roundKey;
      resetPovFlinch(this._flinch);
      decayPovFlinch(this._flinch, demoDt);
      return;
    }
    const hurts = consumeForward(this.meta?.events?.damage, from, tick, rate);
    const h = this.ticks.header;
    const r0 = Math.max(0, Math.min(h.tickCount - 1, Math.floor(this.row)));
    const n = h.playerCount || 10;
    const states = this._hitStates;
    for (let slot = 0; slot < n; slot++) readRecord(this.ticks.view, r0, slot, states[slot]);
    const kills = this.meta.events?.kills || [];
    for (const ev of hurts) {
      const hit = resolveDemoHit(ev, {
        players: this.meta.players,
        states,
        shots: this.meta.events?.shots,
        grenades: this.meta.events?.grenades
      });
      if (hit.slot < 0) continue;
      this._pendingHits.push({
        ...hit,
        kill: killedOnTick(kills, ev.victim, ev.tick)
      });
    }
    decayPovFlinch(this._flinch, demoDt);
  }

  _deliverHits(slot, body) {
    for (const hit of this._pendingHits) {
      if (hit.slot !== slot) continue;
      const punch = applyTraceHit({
        body,
        blood: this.blood,
        damage: hit.damage,
        hitgroup: hit.group,
        armor: hit.armor,
        helmet: hit.helmet,
        blast: hit.blast,
        point: hit.point,
        dir: hit.dir,
        kill: hit.kill
      });
      if (slot === this.povSlot) addPovFlinch(this._flinch, punch, { replacePitch: hit.blast });
    }
  }

  /**
   * The same numbers the 2D timeline radar draws: interpolated tick states,
   * the round's grenades, and the roster. Hold-Q in Map Practice uses this
   * so an imported round matches the timeline viewer.
   */
  radarFrame() {
    if (!this.ticks || !this.meta) return null;
    const h = this.ticks.header;
    const tick = h.firstTick + this.row * (h.stride || 1);
    const r0 = Math.floor(this.row);
    const r1 = Math.min(h.tickCount - 1, r0 + 1);
    const f = this.row - r0;
    const states = this._radarStates;
    const n = h.playerCount || PLAYER_SLOTS;
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      const s = states[slot] || (states[slot] = {});
      if (slot >= n) {
        s.alive = false;
        s.flags = 0;
        continue;
      }
      readRecord(this.ticks.view, r0, slot, s);
      if (f > 0 && s.alive) {
        const b = readRecord(this.ticks.view, r1, slot, _radarNext);
        if (b.alive) {
          s.x += (b.x - s.x) * f;
          s.y += (b.y - s.y) * f;
          s.z += (b.z - s.z) * f;
          s.yaw = lerpAngle(s.yaw, b.yaw, f);
          s.pitch += (b.pitch - s.pitch) * f;
        }
      }
    }
    const players = this.meta.players || [];
    return {
      tick,
      tickRate: h.tickRate || 64,
      states,
      players,
      allPlayers: players,
      events: this.meta.events || { kills: [], shots: [], grenades: [], bomb: [] },
      weapons: this.meta.weapons || [],
      teamSides: { 1: this.meta.team1Side, 2: this.meta.team2Side },
      highlight: this.povSlot != null ? players.find((p) => p.slot === this.povSlot)?.id : undefined,
      hideDeaths: false,
      mapAlpha: 0.85
    };
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
    const tick = h.firstTick + this.row * h.stride;
    this._applyHurts(tick, h.tickRate || 64, demoDt);
    this.marks = [];

    for (let slot = 0; slot < (h.playerCount || 10); slot++) {
      const a = readRecord(this.ticks.view, r0, slot, _a);
      const bodyState = this._bodies[slot];
      if (!a.alive) {
        const pose = bodyState.lastLive;
        if (!pose) {
          bodyState.group.visible = false;
          if (bodyState.model) bodyState.model.group.visible = false;
          bodyState.prev = null;
          continue;
        }
        const duck = pose.duckAmount > 0 ? pose.duckAmount : (pose.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
        const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
        const visible = slot !== this.povSlot;
        if (useModels && (pose.side === 'T' || pose.side === 'CT')) {
          let m = bodyState.model;
          if (!m) {
            m = bodyState.model = this.playerModels.createBody(pose.side);
            this.root.add(m.group);
          } else if (m.side !== pose.side) m.setSide(pose.side);
          bodyState.group.visible = false;
          this._deliverHits(slot, m);
          m.set({
            speed: 0,
            moveYaw: pose.yaw || 0,
            viewYaw: pose.yaw || 0,
            pitch: pose.pitch || 0,
            duck,
            airborne: false,
            weapon: this.meta.weapons?.[pose.weapon] || '',
            alive: false
          });
          m.group.position.set(pose.x, pose.z, -pose.y);
          m.update(demoDt);
          m.group.visible = visible;
        } else {
          if (bodyState.model) bodyState.model.group.visible = false;
          bodyState.group.visible = visible;
          bodyState.group.position.set(pose.x, pose.z, -pose.y);
          bodyState.group.rotation.y = (pose.yaw || 0) * DEG;
        }
        bodyState.prev = null;
        if (slot === this.povSlot) {
          scaledCameraPunch(this._flinch, this._camPunch);
          this.camera.position.set(pose.x, pose.z + eye, -pose.y);
          this.camera.rotation.set(
            -((pose.pitch || 0) + this._camPunch[0]) * DEG,
            cameraYawFromSource(pose.yaw || 0) + this._camPunch[1] * DEG,
            this._camPunch[2] * DEG,
            'YXZ'
          );
          this._pov = {
            side: pose.side,
            weapon: this.meta.weapons?.[pose.weapon] || '',
            speed: 0,
            airborne: false,
            yaw: pose.yaw || 0,
            pitch: pose.pitch || 0,
            eye: this.camera.position,
            shots: 0,
            punch: scaledAimPunch(this._flinch, this._aimPunch)
          };
        }
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
      bodyState.lastLive = {
        x,
        y,
        z,
        yaw,
        pitch,
        duckAmount: amount,
        flags: a.flags,
        weapon: a.weapon,
        side: a.side
      };
      this.marks.push({ x, y, z, yaw, side: a.side, slot, self: slot === this.povSlot });
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
        this._deliverHits(slot, m);
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
        scaledCameraPunch(this._flinch, this._camPunch);
        this.camera.position.set(x, z + this._eye, -y);
        this.camera.rotation.set(
          -(pitch + this._camPunch[0]) * DEG,
          cameraYawFromSource(yaw) + this._camPunch[1] * DEG,
          this._camPunch[2] * DEG,
          'YXZ'
        );
        this._pov = {
          side: a.side,
          weapon: this.meta.weapons?.[a.weapon] || '',
          speed,
          airborne: (a.flags & FLAG_AIRBORNE) !== 0,
          yaw,
          pitch,
          eye: this.camera.position,
          shots: this._shotsCrossed(slot),
          punch: scaledAimPunch(this._flinch, this._aimPunch)
        };
      }
    }

    this._updateNades();
  }

  // ---- grenades -----------------------------------------------------------

  /**
   * The round's utility, from the playhead.
   *
   * All of the work is in src/cs3d/demoNades.js; what stays here is the demo's
   * own clock (a tick, not a wall-clock second) and the POV sampler a flash
   * needs. Deriving the whole thing from the playhead every frame is what it
   * shares with the bodies above, and is why scrubbing backwards is free.
   */
  _updateNades() {
    if (!this.nades) return;
    const pack = this.getPack();
    if (pack?.world) this.nades.attach(pack.world);
    const h = this.ticks.header;
    this.nades.update(h.firstTick + this.row * h.stride, {
      povSlot: this.povSlot,
      povAt: this._povAt
    });
  }

  /**
   * Where the POV player's eyes were, and what they were pointing at, on an
   * arbitrary tick. Scene frame.
   *
   * A flashbang is decided by where a player was LOOKING when it went off, so
   * this has to answer for the detonation tick and not for the current frame.
   * Bound in the constructor because demoNades.js holds it as a callback.
   *
   * @param {number} tick
   * @returns {{eye: {x,y,z}, forward: {x,y,z}}|null}
   */
  _sampleView(tick) {
    if (!this.ticks || this.povSlot === null) return null;
    const h = this.ticks.header;
    const row = Math.round((tick - h.firstTick) / (h.stride || 1));
    const r = Math.max(0, Math.min(h.tickCount - 1, row));
    const a = readRecord(this.ticks.view, r, this.povSlot, _c);
    if (!a.alive) return null;
    const duck = a.duckAmount > 0 ? a.duckAmount : (a.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
    const eyeH = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
    // The same rotation update() gives the POV camera, so the forward vector
    // is the one the viewer is actually looking down.
    _euler.set(-a.pitch * DEG, cameraYawFromSource(a.yaw), 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    return {
      eye: { x: a.x, y: a.z + eyeH, z: -a.y },
      forward: { x: _fwd.x, y: _fwd.y, z: _fwd.z }
    };
  }
}
