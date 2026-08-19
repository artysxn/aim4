// ---------------------------------------------------------------------------
// src/cs3d/demoNades.js
// The utility in a replayed round, drawn with the practice mode's own engine.
//
// Until now a demo's grenades were placeholders: a grey sphere for a smoke, an
// orange disc for a fire, a coloured blip for a pop. Practice mode meanwhile
// has CS2's actual effects — a raymarched smoke volume lit by the map's sun
// (src/cs3d/smokeVolume3d.js), a molotov's outward walk with the game's own
// flame sheets and scorch (shared/sim3d/fireSpread.js), an HE's ring-wave
// blast, and RadiusFlash with the leaked blind curve. There is no reason a
// replay should get the cartoon version, and this file is what stops it.
//
// The whole problem is the CLOCK. NadeEffects runs on a monotonic one — spawn,
// then age by dt every frame — and a demo has no such thing. It has a playhead
// that pauses, runs at ¼× and 4×, steps a tick at a time and jumps backwards,
// and DemoView derives every other thing it draws fresh from that playhead
// each frame precisely so that scrubbing backwards costs nothing.
//
// The reconciliation is that NadeEffects never actually needed a clock. Every
// effect in it is already a pure function of `fx.age` — the fire poses from
// it, the blast poses from it, a smoke cell's opacity is `cellOpacity(vol,
// idx)` over `vol.age`. So this file spawns effects when the playhead crosses
// a detonation, and thereafter tells them what time it is (NadeEffects.setAge)
// instead of letting them count. Scrubbing lands on exactly the right frame.
//
// One piece of state is not a function of age: the holes an HE punches in a
// smoke, which heal on their own timers and cannot be un-punched. A cloud
// created part-way through its life therefore has its age walked FORWARD
// through every blast that went off inside it (`_seedHoles`), punching at each
// stop, which reproduces the hole state exactly rather than approximating it.
//
// Also here, because both are part of "what the round's utility did":
//
//   TRAJECTORY  the recorded flight path, drawn as the grenade model flying
//               along it plus the line it took, in the same colours and with
//               the same linger as practice mode's `sv_grenade_trajectory`
//               trails (src/cs3d/projectiles.js). Recorded, not re-simulated:
//               the demo has the waypoints the grenade actually passed
//               through, and a re-sim would only be a guess that disagrees.
//
//   FLASH       what a flashbang did to the player whose eyes you are
//               borrowing. Computed from RadiusFlash against the POV player's
//               eye and view angle AT THE DETONATION TICK — where they were
//               looking when it popped is what decides how blind they are —
//               and then evaluated as a function of elapsed demo time, so it
//               is exact under scrubbing like everything else.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { sourceToScene } from '../../shared/sim3d/units.js';
import { pushSmoke, SMOKE_PUSH_RADIUS, SMOKE_SECONDS } from '../../shared/sim3d/smokeVolume.js';
import { FIRE_SECONDS, FIRE_SECONDS_INC } from '../../shared/sim3d/fireSpread.js';
import { applyBlind, flashOverlayAlpha, FLASH_MAX_SECONDS } from '../../shared/sim3d/flash.js';
import { DECOY_SECONDS, HE_SECONDS } from './nadeEffects.js';

/**
 * How long a flight's line stays after the grenade goes off, seconds.
 * Matches projectiles.js TRAIL_LINGER: the same throw should read the same
 * whether you made it or watched someone else make it.
 */
const TRAIL_LINGER = 2.5;
/** Trail colour per type — projectiles.js TRAIL_COLOR, and the radar's. */
const TRAIL_COLOR = {
  hegrenade: 0xd8503a,
  flashbang: 0xfff0a8,
  smokegrenade: 0xc8ccd0,
  molotov: 0xe87a28,
  incgrenade: 0xe87a28,
  decoy: 0x7fc46a
};

/**
 * How long each effect stands, for deciding whether to spawn one at all.
 *
 * Only a gate: once an effect exists its own `fx.life` is authoritative, and
 * these are read from the same constants it uses. A flash has no standing
 * effect — the blind is an overlay, handled separately — so it gets the pop's
 * length, which is what the old placeholder drew.
 */
const POP_SECONDS = 0.3;
const LIFE = {
  smokegrenade: SMOKE_SECONDS,
  molotov: FIRE_SECONDS,
  incgrenade: FIRE_SECONDS_INC,
  hegrenade: HE_SECONDS,
  decoy: DECOY_SECONDS,
  flashbang: POP_SECONDS
};

/** Every type this draws a standing effect for. */
const lifeOf = (type) => LIFE[type] ?? 0;

export class DemoNades {
  /**
   * @param {object} o
   * @param {import('./nadeEffects.js').NadeEffects} o.effects  the practice engine
   * @param {import('./viewModel.js').ViewModelAssets} [o.assets]  grenade models
   *   for the flights; without it a flight is an untextured blip, as before
   * @param {(id: string) => ('T'|'CT'|'')} [o.sideOf]  thrower's side this round,
   *   which is what tints a smoke
   */
  constructor({ effects, assets = null, sideOf = null } = {}) {
    this.effects = effects;
    this.assets = assets;
    this.sideOf = sideOf || (() => '');
    /** Draw the flown path. CS2 calls this `sv_grenade_trajectory`. */
    this.trails = true;

    this.root = new THREE.Group();
    this.root.name = 'demo-nades';

    /** Event list for the round, in DETONATION order. See `setEvents`. */
    this._order = [];
    this._events = [];
    this._rate = 64;
    /** event index → the live NadeEffects handle. */
    this._live = new Map();
    /** event index → { group, model, line, positions } */
    this._flights = new Map();
    this._lastTick = null;
    /** Overlay alpha the POV player is under, 0..1. Read by main.js. */
    this.flash = 0;
    /**
     * `${event}:${povSlot}` → the blind state that flash left that viewer, or
     * null if it did not reach them. Solved once: RadiusFlash traces line of
     * sight against the map, and re-solving every frame of a flash for the
     * same pair would be the same answer at a cost.
     */
    this._flashCache = new Map();
    this._blip = new THREE.SphereGeometry(4, 10, 8);
    this._blipMats = new Map();
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  /**
   * A new round's grenades.
   *
   * Kept in DETONATION order rather than the throw order the parser writes,
   * because that is the order effects have to be created in for an HE to punch
   * a smoke that is already standing — which matters every time the playhead
   * is rebuilt from scratch after a jump.
   *
   * @param {Array} grenades  meta.events.grenades
   * @param {number} tickRate
   */
  setEvents(grenades, tickRate = 64) {
    this.clear();
    this._events = Array.isArray(grenades) ? grenades : [];
    this._rate = tickRate || 64;
    this._order = this._events
      .map((g, i) => i)
      .filter((i) => Number.isFinite(this._detTick(this._events[i])))
      .sort((a, b) => this._detTick(this._events[a]) - this._detTick(this._events[b]));
  }

  /** Detonation tick, falling back to the end of the recorded path. */
  _detTick(g) {
    if (g?.detonateTick !== null && g?.detonateTick !== undefined) return g.detonateTick;
    const path = Array.isArray(g?.path) ? g.path : [];
    return path.length ? path[path.length - 1].tick : g?.throwTick;
  }

  /** Where it went off. `at` is authoritative; the path's end is the fallback. */
  _detPos(g) {
    if (g?.at) return g.at;
    const path = Array.isArray(g?.path) ? g.path : [];
    return path.length ? path[path.length - 1] : null;
  }

  clear() {
    for (const fx of this._live.values()) if (!fx.disposed) this.effects?.remove(fx);
    this._live.clear();
    for (const f of this._flights.values()) this._disposeFlight(f);
    this._flights.clear();
    this.flash = 0;
    this._flashCache.clear();
    this._lastTick = null;
  }

  dispose() {
    this.clear();
    this._blip.dispose();
    for (const m of this._blipMats.values()) m.dispose();
    this._blipMats.clear();
    this.root.removeFromParent();
  }

  // ---- the frame ----------------------------------------------------------

  /**
   * Put every effect where the playhead says it should be.
   *
   * @param {number} tick  the playhead, in demo ticks (fractional is fine)
   * @param {object} [o]
   * @param {number|null} [o.povSlot]  whose eyes are being borrowed, or null
   *   for the free camera. Nothing is blinded outside a POV.
   * @param {(tick: number) => ({eye,forward}|null)} [o.povAt]  that player's
   *   eye and view direction (scene frame) at an ARBITRARY tick: a flash is
   *   judged on where they were looking when it popped, not where they are now.
   */
  update(tick, { povSlot = null, povAt = null } = {}) {
    if (!this.effects || !this._events.length) {
      this.flash = 0;
      return;
    }
    const rate = this._rate;
    // Going backwards, a smoke's holes cannot be un-punched, so the clouds are
    // rebuilt from scratch. Everything else would have been fine either way;
    // dropping the lot keeps one rule instead of two.
    if (this._lastTick !== null && tick < this._lastTick - 1e-6) this._dropEffects();
    this._lastTick = tick;

    for (const i of this._order) {
      const g = this._events[i];
      const det = this._detTick(g);
      const age = (tick - det) / rate;
      const life = lifeOf(g.type);
      const at = this._detPos(g);
      const want = at && age >= 0 && age < life;
      let fx = this._live.get(i);
      // `NadeEffects.clear()` (a map change, a practice reset) takes effects
      // out from under us; a disposed handle is not one we can pose.
      if (fx?.disposed) {
        this._live.delete(i);
        fx = null;
      }

      if (want && !fx) {
        fx = this._spawn(i, g, at, age);
        if (fx) this._live.set(i, fx);
      }
      if (fx) {
        // `fx.life` is the effect's own, which for a fire is per-type and can
        // be shorter than the gate above.
        if (age >= 0 && age < fx.life) this.effects.setAge(fx, age);
        else {
          this.effects.remove(fx);
          this._live.delete(i);
        }
      }
      this._updateFlight(i, g, tick, det);
    }

    this._updateFlash(tick, povSlot, povAt);
  }

  /** Drop every standing effect, keeping the flights (they are stateless). */
  _dropEffects() {
    for (const fx of this._live.values()) if (!fx.disposed) this.effects.remove(fx);
    this._live.clear();
  }

  /**
   * Create one effect at the age the playhead is already at.
   *
   * The spawn itself is age-blind — a smoke's flood fill and a molotov's spread
   * are computed from the detonation alone — so putting it straight to `age`
   * gives exactly the cloud or the fire that should be standing there.
   */
  _spawn(index, g, at, age) {
    const side = g.player ? this.sideOf(g.player) : '';
    const fx = this.effects.spawn({
      type: g.type,
      pos: { x: at.x, y: at.y, z: at.z },
      // A CS2 molotov spreads DOWNRANGE, so the fire needs the direction the
      // bottle was travelling when it broke. The demo does not record a
      // velocity, but it records where the grenade was a moment earlier, which
      // is the same information: the last leg of the recorded path.
      vel: g.type === 'molotov' || g.type === 'incgrenade' ? this._arrivalVel(g) : null,
      side: side || null,
      driven: true
    });
    if (!fx) return null;
    if (fx.kind === 'smoke' && age > 0) this._seedHoles(fx, index, g, age);
    this.effects.setAge(fx, age);
    return fx;
  }

  /**
   * The direction the grenade was going when it broke, from the last leg of
   * the recorded path, scaled to something the spread reads as a throw.
   *
   * Only the direction matters to `buildFireSpread`; the magnitude here is the
   * path's own, which is per-tick displacement times the tick rate — i.e. the
   * real speed, in units per second, to the accuracy the parser sampled it at.
   */
  _arrivalVel(g) {
    const path = Array.isArray(g.path) ? g.path : [];
    if (path.length < 2) return null;
    const b = path[path.length - 1];
    // Back to the last sample that is somewhere ELSE. A grenade that came to
    // rest before it broke has repeated samples at the end of its path, and
    // their difference is a zero direction the spread cannot use.
    let k = path.length - 2;
    while (k > 0 && Math.hypot(b.x - path[k].x, b.y - path[k].y, b.z - path[k].z) < 1e-3) k--;
    const a = path[k];
    const dt = Math.max(1, b.tick - a.tick) / this._rate;
    const v = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt };
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return null;
    return v.x || v.y || v.z ? v : null;
  }

  /**
   * Punch the holes an HE left in a cloud that is being created part-way
   * through its life.
   *
   * A hole is the one thing about a smoke that is not a function of its age:
   * `pushSmoke` writes a per-cell hold that then counts down. So the cloud's
   * age is walked forward through each blast that went off inside it, punched
   * at each stop, and the count-down between stops falls out of `setAge`'s own
   * forward step. That reproduces the hole state exactly — a cloud scrubbed
   * back into looks like it did, not like it was never hit.
   */
  _seedHoles(fx, index, g, age) {
    const det = this._detTick(g);
    for (const j of this._order) {
      if (j === index) continue;
      const b = this._events[j];
      if (b.type !== 'hegrenade') continue;
      const bTick = this._detTick(b);
      const bAge = (bTick - det) / this._rate;
      // Only blasts inside this cloud's life so far.
      if (!(bAge > 0 && bAge < age)) continue;
      const at = this._detPos(b);
      if (!at) continue;
      this.effects.setAge(fx, bAge);
      pushSmoke(fx.vol, at, SMOKE_PUSH_RADIUS);
      fx.holed = true;
    }
  }

  // ---- the flight ---------------------------------------------------------

  /**
   * The grenade in the air and the line it took.
   *
   * Drawn from the recorded waypoints and NOT re-simulated. The parser stores
   * the positions the projectile actually reported, simplified; running
   * shared/sim3d/grenade.js from a guessed release instead would produce a
   * plausible arc that disagrees with the one on screen at every bounce.
   */
  _updateFlight(index, g, tick, det) {
    const path = Array.isArray(g.path) ? g.path : [];
    const linger = TRAIL_LINGER * this._rate;
    const live = path.length >= 2 && tick >= g.throwTick && tick < det + linger;
    let f = this._flights.get(index);
    if (!live) {
      if (f) {
        this._disposeFlight(f);
        this._flights.delete(index);
      }
      return;
    }
    if (!f) {
      f = this._makeFlight(index, g, path);
      this._flights.set(index, f);
    }

    const flying = tick < det;
    const head = Math.min(tick, det);

    // Which leg of the path the grenade is on, and where along it.
    let k = 0;
    while (k + 2 < path.length && path[k + 1].tick <= head) k++;
    const p0 = path[k];
    const p1 = path[Math.min(k + 1, path.length - 1)];
    const span = Math.max(1, p1.tick - p0.tick);
    const t = Math.max(0, Math.min(1, (head - p0.tick) / span));
    const x = p0.x + (p1.x - p0.x) * t;
    const y = p0.y + (p1.y - p0.y) * t;
    const z = p0.z + (p1.z - p0.z) * t;
    const [sx, sy, sz] = sourceToScene(x, y, z);

    f.group.visible = flying;
    if (flying) {
      f.group.position.set(sx, sy, sz);
      // A thrown grenade tumbles (projectiles.js does the same). The rate is
      // off the flight's own speed so a lob reads as a lob.
      f.spin = (head - g.throwTick) * f.spinRate;
      f.group.quaternion.setFromAxisAngle(f.axis, f.spin);
    }

    if (!f.line) return;
    // The line is the path SO FAR: every waypoint already passed, then the
    // grenade's own position as the last point.
    const pos = f.positions;
    let n = 0;
    for (let i = 0; i <= k && i < path.length; i++) {
      const p = path[i];
      const s = sourceToScene(p.x, p.y, p.z);
      pos[n * 3] = s[0];
      pos[n * 3 + 1] = s[1];
      pos[n * 3 + 2] = s[2];
      n++;
    }
    pos[n * 3] = sx;
    pos[n * 3 + 1] = sy;
    pos[n * 3 + 2] = sz;
    n++;
    f.line.geometry.attributes.position.needsUpdate = true;
    f.line.geometry.setDrawRange(0, n);
    f.line.visible = n >= 2;
    // Fades out over the linger, like a practice trail.
    const after = (tick - det) / this._rate;
    f.line.material.opacity = after <= 0 ? 1 : Math.max(0, 1 - after / TRAIL_LINGER);
  }

  _makeFlight(index, g, path) {
    const group = new THREE.Group();
    group.name = `demo-nade:${g.type}`;
    this.root.add(group);
    // A stand-in until (or instead of) the real model: the pack may not have
    // one, and the flight must not wait for the network.
    const color = TRAIL_COLOR[g.type] ?? 0xffffff;
    let mat = this._blipMats.get(color);
    if (!mat) this._blipMats.set(color, (mat = new THREE.MeshBasicMaterial({ color })));
    const blip = new THREE.Mesh(this._blip, mat);
    group.add(blip);

    // How fast it was going, averaged over the recorded path. projectiles.js
    // spins a thrown grenade at `0.006 * speed + 4` rad/s off the release
    // speed; the same law here off the measured one keeps a lob reading as a
    // lob and a full throw as a whipped ball, in both modes.
    let flown = 0;
    for (let i = 1; i < path.length; i++) {
      flown += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
    }
    const ticks = Math.max(1, path[path.length - 1].tick - path[0].tick);
    const speed = (flown / ticks) * this._rate;

    const f = {
      group,
      blip,
      line: null,
      positions: null,
      axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      /** Radians per TICK: the flight is posed off the playhead, not off dt. */
      spinRate: (0.006 * speed + 4) / this._rate,
      spin: 0
    };

    if (this.trails) {
      const positions = new Float32Array((path.length + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setDrawRange(0, 0);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false })
      );
      line.frustumCulled = false;
      this.root.add(line);
      f.line = line;
      f.positions = positions;
    }

    // The model streams in; the flight draws with the blip until it lands, and
    // the blip goes when it does.
    this.assets?.model?.(g.type)?.then((template) => {
      if (!template || !this._flights.get(index)) return;
      const m = cloneSkinned(template);
      m.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false;
      });
      group.add(m);
      blip.visible = false;
    });
    return f;
  }

  _disposeFlight(f) {
    // Detach only for the model: it is a SkeletonUtils clone and SHARES its
    // geometry and materials with the pack's template (projectiles.js has the
    // same note). The line is ours, so it is disposed.
    f.group.removeFromParent();
    if (f.line) {
      f.line.removeFromParent();
      f.line.geometry.dispose();
      f.line.material.dispose();
    }
  }

  // ---- the flash ----------------------------------------------------------

  /**
   * How blind the borrowed eyes are.
   *
   * RadiusFlash is evaluated once per (flash, viewer) against where that
   * player stood and looked ON THE DETONATION TICK — which is the whole of
   * what decides it, and is why this cannot be sampled at the current frame —
   * and the overlay is then read off the resulting blind state as a function
   * of elapsed demo seconds. No accumulation, so a scrub is exact and holding
   * pause inside a flash holds the flash.
   *
   * The worst of the overlapping flashes wins, which is what `applyBlind` does
   * for a live player too.
   */
  _updateFlash(tick, povSlot, povAt) {
    if (povSlot === null || povSlot === undefined || typeof povAt !== 'function') {
      this.flash = 0;
      return;
    }
    let worst = 0;
    for (const i of this._order) {
      const g = this._events[i];
      if (g.type !== 'flashbang') continue;
      const det = this._detTick(g);
      const elapsed = (tick - det) / this._rate;
      // FLASH_MAX_SECONDS is the longest overlay `sv_flashbang_strength` can
      // produce, so anything older cannot still be blinding anyone.
      if (!(elapsed >= 0 && elapsed < FLASH_MAX_SECONDS)) continue;
      const at = this._detPos(g);
      if (!at) continue;
      const key = `${i}:${povSlot}`;
      let state = this._flashCache.get(key);
      if (state === undefined) {
        const view = povAt(det);
        const hit = view ? this.effects.flashAt(at, view.eye, view.forward) : null;
        state = hit ? applyBlind(null, hit, 0) : null;
        // Not cached until there is a map to trace against: RadiusFlash with
        // no collision blinds through walls, and that answer must not stick.
        if (this.effects.hasCollider?.() !== false) this._flashCache.set(key, state);
      }
      if (!state) continue;
      const a = flashOverlayAlpha(state, elapsed);
      if (a > worst) worst = a;
    }
    this.flash = worst;
  }

  /** Drop the per-viewer flash solutions (the map's collision arrived late). */
  resetFlashCache() {
    this._flashCache.clear();
  }
}

export { TRAIL_COLOR, TRAIL_LINGER };
