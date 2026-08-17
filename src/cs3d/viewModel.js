// ---------------------------------------------------------------------------
// src/cs3d/viewModel.js
// The first-person viewmodel: your hands, the weapon in them, and the motion
// that sells both — CS3D-ENGINE-PLAN E-9, over the pack scripts/cs3d-weapons.mjs
// builds.
//
// What comes out of the game and what does not:
//
//   from the files   the arms (the agent models' own `firstperson_*` meshes,
//                    re-bound onto the viewmodel rig at pack time), the weapon
//                    and grenade models, and the viewmodel clips — draw, idle,
//                    shoot, reload, and the knife's light/heavy swings.
//   from the table   fire rate (`m_flCycleTime`) and deploy time
//                    (`m_flDeployDuration`), straight out of weapons.vdata.
//   derived here     bob, sway and recoil. CS2 computes those in the binary;
//                    the shapes below are the standard Source ones with their
//                    constants marked `[verify]`, which is the honest state of
//                    them until the server instrument measures the real curves.
//
// Rendering. The viewmodel is drawn in its own pass with its own camera and a
// cleared depth buffer, which is what stops a gun muzzle from poking through a
// wall the player is standing against and lets it keep CS2's narrower
// viewmodel FOV (`viewmodel_fov`, 68 by default) while the world stays at 90.
// It lives in view space: the group sits at the origin looking down −z, so
// nothing here has to know where in the map the player is.
//
// Lighting. One key light and a fill, plus the map's own baked ambient at the
// player's position when there is a probe grid — so the gun darkens indoors
// with everything else rather than floating at a fixed brightness.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AnimationMixer, LoopOnce, LoopRepeat } from 'three';
import { assetBase } from './mapLoader.js';

export const WEAPONS_PACK_VERSION = 1;

const DEG = Math.PI / 180;

/** CS2's `viewmodel_fov` default. The world renders at its own, wider, FOV. */
export const VIEWMODEL_FOV = 68;

/**
 * Where the rig sits in view space, units. The viewmodel rig is authored with
 * its root at the eye looking down +x (Source), so the group is rotated into
 * three's −z and nudged by CS2's `viewmodel_offset_*` defaults (0, 0, 0) plus
 * a small drop so the hands sit low in frame the way the game's do. `[verify]`
 * against the game rather than trusting these three numbers.
 */
const RIG_OFFSET = new THREE.Vector3(0, -1.5, 0);

/** Bob and sway, the Source shapes. All `[verify]`. */
const BOB = {
  /** Cycle speed at full run, rad/s. */
  frequency: 9.2,
  /** Side-to-side and vertical travel at full run, units. */
  lateral: 0.5,
  vertical: 0.42,
  /** Speed (u/s) at which the bob is at full amplitude. */
  fullSpeed: 250,
  /** How fast the bob amplitude follows a change in speed. */
  ease: 0.12
};

const SWAY = {
  /** Units of lag per degree/second of view rotation. */
  perDegree: 0.0065,
  /** Clamp, units — a fast flick must not throw the gun off screen. */
  limit: 2.6,
  /** Seconds for the lag to catch up. */
  ease: 0.09
};

/**
 * Recoil kick of the VIEWMODEL — the gun jumping in frame. This is the
 * cosmetic half of CS3D-ENGINE-PLAN E-6's three-way split (aim punch, view
 * punch, viewmodel kick) and is deliberately independent of where the bullets
 * go. Scaled by the weapon's own `m_flRecoilMagnitude`. `[verify]`
 */
const KICK = {
  back: 0.85,
  up: 0.35,
  roll: 1.6 * DEG,
  /** Seconds to reach the kick, and to settle back. */
  attack: 0.02,
  decay: 0.14
};

/** Clip names the runtime looks for, in preference order, per action. */
const CLIP_ALIASES = {
  draw: ['draw', 'draw_silenced', 'deploy'],
  idle: ['idle', 'idle2'],
  fire: ['shoot1', 'shoot', 'shoot_empty'],
  reload: ['reload', 'reload_empty'],
  /** The knife swings, alternated so repeated slices do not look identical. */
  light: ['light_miss1', 'light_miss2', 'light_hit1', 'light_hit2'],
  heavy: ['heavy_miss1', 'heavy_hit1'],
  pull: ['pullpin'],
  throw: ['throw_overhand', 'throw_underhand']
};

// ---------------------------------------------------------------------------

/**
 * The weapons pack: the table, the arms, the clip sets, and weapon models
 * fetched the first time something asks for one. One per page.
 */
export class ViewModelAssets {
  constructor({ base } = {}) {
    this.base = base || `${assetBase()}/weapons`;
    this.manifest = null;
    this.ready = false;
    this.failed = null;
    /** side → Object3D template (rig + arm meshes) */
    this.arms = {};
    /** class → Map<clip name, AnimationClip> */
    this.clips = {};
    /** weapon name → Object3D template */
    this.models = new Map();
    this._pending = new Map();
    this._loading = null;
    this._loader = null;
    this._v = '';
  }

  /** Everything except the weapon models, which stream on demand. */
  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('cs3d: no weapons pack, the viewmodel stays hidden —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const res = await fetch(`${this.base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`no weapons pack (${res.status} from ${this.base}/manifest.json)`);
    const manifest = await res.json();
    if (manifest.version !== WEAPONS_PACK_VERSION) {
      throw new Error(`weapons pack is v${manifest.version}; this build reads v${WEAPONS_PACK_VERSION}. Re-run cs3d-weapons.`);
    }
    this.manifest = manifest;
    this._v = `?v=${encodeURIComponent(manifest.generated || String(manifest.version))}`;
    this._loader = new GLTFLoader();
    this._loader.setMeshoptDecoder(MeshoptDecoder);

    const jobs = [];
    for (const [side, a] of Object.entries(manifest.viewmodel.arms || {})) {
      jobs.push(
        this._fetch(a.file).then((gltf) => {
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.frustumCulled = false;
            o.castShadow = false;
            o.receiveShadow = false;
          });
          this.arms[side] = gltf.scene;
        })
      );
    }
    for (const [key, s] of Object.entries(manifest.viewmodel.anims || {})) {
      jobs.push(
        this._fetch(s.file).then((gltf) => {
          const map = new Map();
          for (const c of gltf.animations) map.set(c.name, c);
          this.clips[key] = map;
        })
      );
    }
    await Promise.all(jobs);
    if (!this.arms.T && !this.arms.CT) throw new Error('weapons pack has no viewmodel arms');
    // Clip channels aimed at bones the arms rig does not carry (the weapon's
    // own `bolt`, `trigger`, `magazine`) would be one PropertyBinding warning
    // per track per action. Drop them once, here.
    const rigBones = new Set();
    for (const s of Object.values(this.arms)) s.traverse((o) => rigBones.add(o.name));
    let dropped = 0;
    for (const map of Object.values(this.clips)) {
      for (const clip of map.values()) {
        const kept = clip.tracks.filter((t) => rigBones.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        dropped += clip.tracks.length - kept.length;
        clip.tracks = kept;
      }
    }
    if (dropped) console.log(`cs3d: viewmodel clips — ${dropped} tracks for weapon-side bones dropped`);
  }

  _fetch(file) {
    return new Promise((resolve, reject) =>
      this._loader.load(`${this.base}/${file}${this._v}`, resolve, undefined, (e) => reject(new Error(`${file}: ${e?.message || e}`)))
    );
  }

  /** The table row for a weapon, by bare name (`ak47`). */
  stats(name) {
    return this.manifest?.weapons?.[String(name || '').replace(/^weapon_/, '')] || null;
  }

  /** Weapon model, fetched once. Resolves to null when the pack has no such weapon. */
  model(name) {
    const key = String(name || '').replace(/^weapon_/, '');
    if (this.models.has(key)) return Promise.resolve(this.models.get(key));
    if (this._pending.has(key)) return this._pending.get(key);
    const w = this.stats(key);
    if (!w?.file) return Promise.resolve(null);
    const job = this._fetch(w.file)
      .then((gltf) => {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = false;
          o.castShadow = false;
          o.receiveShadow = false;
        });
        this.models.set(key, gltf.scene);
        this._pending.delete(key);
        return gltf.scene;
      })
      .catch((e) => {
        console.warn(`cs3d: weapon model ${key} failed`, e);
        this.models.set(key, null);
        this._pending.delete(key);
        return null;
      });
    this._pending.set(key, job);
    return job;
  }
}

// ---------------------------------------------------------------------------

/**
 * One viewmodel: a pair of hands, whatever they are holding, and its motion.
 *
 * Drive it with `setWeapon()` when the held weapon changes, `attack()` when
 * the trigger goes, and `update(dt, state)` every frame. `group` renders in
 * view space — see `render()` for the pass that draws it.
 */
export class ViewModel {
  constructor(assets) {
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    // The rig is authored looking down Source +x; three's camera looks down
    // −z. One rotation puts the whole thing in front of the eye.
    this.rig = new THREE.Group();
    this.rig.rotation.set(0, -Math.PI / 2, 0);
    this.rig.position.copy(RIG_OFFSET);
    this.group.add(this.rig);

    this.side = 'T';
    this.weapon = null; // the table row
    this.weaponName = '';
    this.arms = null;
    this.mixer = null;
    this.actions = new Map();
    this.wpnBone = null;
    this.weaponModel = null;
    this.clipSet = 'rifle';

    /** Seconds until the weapon can fire again (deploy, then cycle time). */
    this.nextAttack = 0;
    this.lastAttackAt = 0;
    this._swingIndex = 0;

    // Motion state.
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._sway = new THREE.Vector2();
    this._swayTarget = new THREE.Vector2();
    this._kick = 0;
    this._kickVel = 0;
    this._lastYaw = null;
    this._lastPitch = null;
    this._offset = new THREE.Vector3();
    this.visible = true;
  }

  get ready() {
    return !!this.arms;
  }

  /** Team hands. Cheap: the arms template is cloned once per side change. */
  setSide(side) {
    if (side === this.side && this.arms) return;
    const tmpl = this.assets.arms[side] || this.assets.arms.T || this.assets.arms.CT;
    if (!tmpl) return;
    this.side = side;
    if (this.arms) {
      this.mixer?.stopAllAction();
      this.mixer?.uncacheRoot(this.arms);
      this.rig.remove(this.arms);
    }
    this.arms = cloneSkinned(tmpl);
    this.rig.add(this.arms);
    this.mixer = new AnimationMixer(this.arms);
    this.actions.clear();
    // Where the weapon hangs. `wpn` is the viewmodel rig's own weapon bone and
    // the clips animate it, so a gun parented here moves with the hands.
    this.wpnBone = this.arms.getObjectByName('wpn') || this.arms.getObjectByName('weapon') || this.arms;
    if (this.weaponModel) this.wpnBone.add(this.weaponModel);
  }

  /**
   * Hold a weapon by its bare name. Plays the draw, and blocks firing for the
   * table's deploy duration — the pull-out the operator asked for, at the
   * game's own timing.
   */
  async setWeapon(name, { draw = true } = {}) {
    const bare = String(name || '').replace(/^weapon_/, '');
    if (bare === this.weaponName) return;
    const stats = this.assets.stats(bare);
    if (!stats) return;
    this.weaponName = bare;
    this.weapon = stats;
    this.clipSet = this.assets.clips[stats.class] ? stats.class : 'rifle';
    if (!this.arms) this.setSide(this.side);
    // The old model goes as soon as the new one is asked for, so a slow fetch
    // never shows the previous weapon in the new weapon's hands.
    if (this.weaponModel) {
      this.weaponModel.removeFromParent();
      this.weaponModel = null;
    }
    this.actions.clear();
    this.mixer?.stopAllAction();
    const model = await this.assets.model(bare);
    if (this.weaponName !== bare) return; // switched again while fetching
    if (model) {
      this.weaponModel = cloneSkinned(model);
      (this.wpnBone || this.rig).add(this.weaponModel);
    }
    this.nextAttack = draw ? stats.deploy || 0 : 0;
    if (draw) this._play('draw', { loop: false });
    else this._play('idle', { loop: true });
  }

  /** The first clip of an action that this weapon's set actually has. */
  _clip(action) {
    const set = this.assets.clips[this.clipSet];
    if (!set) return null;
    for (const name of CLIP_ALIASES[action] || [action]) {
      const c = set.get(name);
      if (c) return c;
    }
    return null;
  }

  _play(action, { loop = false, fade = 0.06, clip = null } = {}) {
    const c = clip || this._clip(action);
    if (!c || !this.mixer) return null;
    let a = this.actions.get(c.name);
    if (!a) {
      a = this.mixer.clipAction(c);
      this.actions.set(c.name, a);
    }
    for (const [, other] of this.actions) if (other !== a) other.fadeOut(fade);
    a.reset();
    a.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    a.fadeIn(fade).play();
    this._current = a;
    this._currentLoops = loop;
    return a;
  }

  /**
   * Pull the trigger. Returns true when the weapon actually fired, false when
   * it is still cycling, still deploying, or empty — so the caller can decide
   * whether to spawn a tracer.
   *
   * @param {'primary'|'secondary'} [button]
   */
  attack(button = 'primary', now = performance.now() / 1000) {
    if (!this.weapon || now < this.nextAttack) return false;
    const cycle = this.cycleTime(button);
    this.nextAttack = now + cycle;
    this.lastAttackAt = now;
    if (this.weapon.melee) {
      // Alternate the swing so a spammed knife does not replay one animation.
      const names = CLIP_ALIASES[button === 'secondary' ? 'heavy' : 'light'];
      const set = this.assets.clips[this.clipSet];
      const have = names.map((n) => set?.get(n)).filter(Boolean);
      if (have.length) {
        const clip = have[this._swingIndex++ % have.length];
        this._play('light', { loop: false, fade: 0.02, clip });
      }
    } else {
      this._play('fire', { loop: false, fade: 0.01 });
      // The gun jumps by its own recoil magnitude, normalised about a rifle's.
      this._kickVel += 1 + (this.weapon.recoilMagnitude || 30) / 30;
    }
    return true;
  }

  /** Seconds between shots for this weapon and button, from the game's table. */
  cycleTime(button = 'primary') {
    const c = this.weapon?.cycleTime;
    if (Array.isArray(c)) return button === 'secondary' ? c[1] || c[0] : c[0];
    return c || 0.1;
  }

  /** Is this weapon allowed to hold the trigger down? */
  get isAuto() {
    return !!this.weapon?.auto;
  }

  /**
   * Advance the viewmodel.
   *
   * @param {number} dt      seconds
   * @param {object} state
   * @param {number} state.speed     horizontal speed, u/s
   * @param {boolean} state.onGround
   * @param {number} state.viewYaw   degrees
   * @param {number} state.viewPitch degrees
   */
  update(dt, state = {}) {
    if (!this.arms) return;
    const { speed = 0, onGround = true, viewYaw = 0, viewPitch = 0 } = state;

    // ---- bob: a walk cycle whose amplitude follows speed -------------------
    const target = onGround ? Math.min(1, speed / BOB.fullSpeed) : 0;
    this._bobAmp += (target - this._bobAmp) * (1 - Math.exp(-dt / BOB.ease));
    this._bobPhase += dt * BOB.frequency * (0.4 + 0.6 * this._bobAmp);
    const bobX = Math.sin(this._bobPhase) * BOB.lateral * this._bobAmp;
    // Twice the frequency vertically: the body rises on each footfall, not
    // once per stride.
    const bobY = Math.abs(Math.cos(this._bobPhase)) * BOB.vertical * this._bobAmp - BOB.vertical * 0.5 * this._bobAmp;

    // ---- sway: the gun lags a turn ----------------------------------------
    if (this._lastYaw !== null && dt > 0) {
      let dYaw = viewYaw - this._lastYaw;
      if (dYaw > 180) dYaw -= 360;
      else if (dYaw < -180) dYaw += 360;
      const dPitch = viewPitch - this._lastPitch;
      this._swayTarget.set(
        THREE.MathUtils.clamp(-dYaw * SWAY.perDegree / dt * 0.016, -SWAY.limit, SWAY.limit),
        THREE.MathUtils.clamp(dPitch * SWAY.perDegree / dt * 0.016, -SWAY.limit, SWAY.limit)
      );
    }
    this._lastYaw = viewYaw;
    this._lastPitch = viewPitch;
    const k = 1 - Math.exp(-dt / SWAY.ease);
    this._sway.x += (this._swayTarget.x - this._sway.x) * k;
    this._sway.y += (this._swayTarget.y - this._sway.y) * k;

    // ---- recoil: a spring that is kicked, then settles ----------------------
    if (this._kickVel > 0) {
      const rise = Math.min(1, dt / KICK.attack);
      this._kick += this._kickVel * rise;
      this._kickVel *= 1 - rise;
    }
    this._kick *= Math.exp(-dt / KICK.decay);

    // ---- compose -----------------------------------------------------------
    // The rig looks down −z after its own rotation, so in the group's frame x
    // is right, y is up and z is back toward the eye.
    this._offset.set(bobX + this._sway.x, bobY + this._sway.y, this._kick * KICK.back);
    this.rig.position.copy(RIG_OFFSET).add(this._offset);
    this.rig.rotation.set(this._kick * KICK.up * DEG * 10, -Math.PI / 2, this._kick * KICK.roll);

    this.mixer.update(dt);
    // A one-shot that has run out returns to idle rather than freezing on its
    // last frame — the draw, the shot and the swing all end this way.
    const cur = this._current;
    if (cur && !this._currentLoops && cur.time >= cur.getClip().duration - 1e-3) {
      this._play('idle', { loop: true, fade: 0.12 });
    }
    this.group.visible = this.visible;
  }

  dispose() {
    this.mixer?.stopAllAction();
    if (this.arms) this.mixer?.uncacheRoot(this.arms);
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------

/**
 * The viewmodel pass: its own scene, its own camera, its own depth.
 *
 * Drawn after the world with the depth buffer cleared, so the gun is never
 * clipped by a wall the player is against — the same reason the game draws it
 * separately — and at CS2's narrower viewmodel FOV rather than the world's.
 */
export function createViewModelPass(renderer, { fov = VIEWMODEL_FOV } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.5, 400);
  scene.add(camera);
  // A key over the shoulder and a soft fill: enough shape on a gun barrel
  // without pretending to be the map's lighting.
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-0.4, 1, 0.6);
  const fill = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(key, key.target, fill);

  return {
    scene,
    camera,
    /** Tint the fill with the map's own ambient where the player stands. */
    setAmbient(color, intensity = 1) {
      if (color) fill.color.copy(color);
      fill.intensity = intensity;
    },
    setFov(v) {
      camera.fov = v;
      camera.updateProjectionMatrix();
    },
    resize(width, height) {
      camera.aspect = Math.max(1e-3, width / height);
      camera.updateProjectionMatrix();
    },
    /** Call after the world pass, on the same target. */
    render() {
      renderer.clearDepth();
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = auto;
    }
  };
}
