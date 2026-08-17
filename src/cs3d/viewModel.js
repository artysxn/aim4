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
import { UNIT_M } from '../../shared/sim3d/units.js';

export const WEAPONS_PACK_VERSION = 3;

const DEG = Math.PI / 180;

/** CS2's `viewmodel_fov` default. The world renders at its own, wider, FOV. */
export const VIEWMODEL_FOV = 68;

/**
 * How much sky the viewmodel reflects.
 *
 * NOT the world's `environmentIntensity`. The map crushes its probe to a
 * hundredth (sky.js SKY_PROBE_SCALE) because every lightmapped surface already
 * carries baked light and a second, unoccluded environment on top would wash it
 * out. The viewmodel has no bake — a key light, a fill, and this — so it wants
 * the probe at something like full strength, and inheriting the world's 0.1
 * leaves metal exactly as black as having no environment at all. `[verify]`
 */
export const VIEWMODEL_ENV_INTENSITY = 1;
/**
 * The pass's sun, in irradiance.
 *
 * Direction, colour and shade come from the map; this level does not, and
 * deliberately. `MapLighting.sunIntensity` is a world number (60 on Nuke —
 * `brightness × SUN_SCALE × SUN_BOOST`) that the lightmapped materials and the
 * props' own DirectionalLight consume, and feeding it to a standard material
 * renders white: three's Lambert divides by π, so π units of irradiance is what
 * puts an albedo of 1 on screen at 1.0 (fpsView.js says the same thing).
 *
 * 0.7π is what this pass has always used, and it is the right anchor for a
 * reason beyond continuity: MapLighting sets the tone-mapping exposure so that
 * a world surface facing the unshadowed sun lands on EXPOSURE_TARGET. A gun
 * rendering its own albedo at 1.0 therefore lands in the same place, on any
 * map, without knowing anything about that map's numbers.
 */
export const VIEWMODEL_SUN = 0.7 * Math.PI;
/** Half-width of the viewmodel pass's shadow frustum, in Source units. */
const VM_SHADOW_EXTENT = 30;
/** How far out the pass's sun sits. Only the direction matters to the shading;
 *  the distance is there so the whole viewmodel is in front of its shadow camera. */
const VM_SUN_DISTANCE = 200;

/**
 * Where the rig sits in view space, units. The viewmodel rig is authored with
 * its root at the eye looking down +x (Source), so the group is rotated into
 * three's −z and nudged by CS2's `viewmodel_offset_*` defaults (0, 0, 0) plus
 * a small drop so the hands sit low in frame the way the game's do. `[verify]`
 * against the game rather than trusting these three numbers.
 */
const RIG_OFFSET = new THREE.Vector3(0, -1.5, 0);

/**
 * The account settings this viewmodel honours, and what they mean here.
 *
 * `viewmodel.offsetX/Y/Z` are the trainer's, in METRES, and its own viewmodel
 * has been placed by them since before this one existed — so they are read as a
 * DELTA from their defaults rather than as absolute positions. Default settings
 * therefore leave the placement solved by the pack exactly where it is, and a
 * slider nudges from there. Their metres become Source units, which is what
 * this whole file counts in.
 */
const SETTING_DEFAULT = { offsetX: 0.16, offsetY: -0.15, offsetZ: 0.5 };
const M_TO_UNIT = 1 / UNIT_M;

/**
 * The yaw that turns the packed rig to face the camera, radians.
 *
 * The pack ships its frame in the manifest (`forward: '+x'`, up +z folded to
 * three's +y by the packer's −90° root rotation), and the bind pose agrees:
 * `wpn` sits at (17, 0, 0), `hand_R` at z +18 and `hand_L` at z −18. So model
 * +x is forward, +y is up, +z is RIGHT.
 *
 * three's camera looks down −z with +x to its right, and `Ry(θ)` maps
 * (1,0,0) → (cos θ, 0, −sin θ). Only +π/2 sends forward to −z and right to +x;
 * −π/2 sends forward to +z, which is directly behind the eye. That is what it
 * was, and it is why no weapon ever appeared: `wpn` rendered at z +17, a clean
 * 17 units behind the near plane, while `hand_R` landed at z +1.1 — barely
 * behind it, close enough that a knife swing threw a sliver of it into frame at
 * the bottom left. Getting the sign wrong here mirrors left/right as well, so
 * "the hands look swapped" is the same bug and not a separate one.
 */
const RIG_YAW = Math.PI / 2;

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
  // Knives author `idle1`/`idle2` and no plain `idle`.
  idle: ['idle', 'idle1', 'idle2'],
  // The Dual Berettas fire one pistol at a time and have no `shoot1` at all.
  fire: ['shoot1', 'shoot', 'shoot_right1', 'shoot_left1', 'shoot_empty'],
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
    /** weapon name → Map<clip name, AnimationClip>, or null for "use the class set" */
    this.weaponSets = new Map();
    this._pendingSets = new Map();
    this._rigBones = new Set();
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
            // Both, so the gun shades the hands and a hand shades the arm
            // behind it (createViewModelPass's key carries a shadow map).
            o.castShadow = true;
            o.receiveShadow = true;
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
    this._rigBones = new Set();
    for (const s of Object.values(this.arms)) s.traverse((o) => this._rigBones.add(o.name));
    let dropped = 0;
    for (const map of Object.values(this.clips)) dropped += this._trimToRig(map);
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
          o.castShadow = true;
          o.receiveShadow = true;
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

  /**
   * Drop clip channels aimed at bones nothing in the scene carries. Left in,
   * each is one PropertyBinding warning per track per action, thousands of
   * them. Returns how many went.
   *
   * `own` is the held weapon's own bone list, from the manifest. A weapon's
   * clips animate its own skeleton as well as the arms — `slide_r` on a pistol,
   * `crane` and `cylinder` on the revolver, `lighter` on the molotov — and now
   * that the model ships those bones, those tracks are the point, not noise.
   */
  _trimToRig(map, own = null) {
    let dropped = 0;
    for (const clip of map.values()) {
      const kept = clip.tracks.filter((t) => {
        const bone = t.name.slice(0, t.name.lastIndexOf('.'));
        return this._rigBones.has(bone) || !!own?.has(bone);
      });
      dropped += clip.tracks.length - kept.length;
      clip.tracks = kept;
    }
    return dropped;
  }

  /**
   * This weapon's own clip set, fetched once, or null when CS2 ships none and
   * the class default has to do.
   *
   * Streamed beside the model rather than up front for the same reason the
   * models are: 61 sets is ~12 MB, and a round touches a handful of weapons.
   */
  weaponClips(name) {
    const key = String(name || '').replace(/^weapon_/, '');
    if (this.weaponSets.has(key)) return Promise.resolve(this.weaponSets.get(key));
    if (this._pendingSets.has(key)) return this._pendingSets.get(key);
    const s = this.manifest?.viewmodel?.weaponAnims?.[key];
    if (!s?.file) return Promise.resolve(null);
    const own = new Set(this.stats(key)?.bones || []);
    const job = this._fetch(s.file)
      .then((gltf) => {
        const map = new Map();
        for (const c of gltf.animations) map.set(c.name, c);
        this._trimToRig(map, own);
        this.weaponSets.set(key, map);
        this._pendingSets.delete(key);
        return map;
      })
      .catch((e) => {
        console.warn(`cs3d: viewmodel clips for ${key} failed, using the ${this.stats(key)?.class || 'class'} set`, e);
        this.weaponSets.set(key, null);
        this._pendingSets.delete(key);
        return null;
      });
    this._pendingSets.set(key, job);
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
    this.rig.rotation.set(0, RIG_YAW, 0);
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
    /** This weapon's own clip set, when CS2 ships one; the class set backs it. */
    this.weaponSet = null;
    /**
     * Live placement offsets driven by the tuner (src/cs3d/vmTuner.js). `rig`
     * is view space (x right, y up, z back); `wpn` and `rot` are the pack's rig
     * frame relative to the hand bone (x forward, y up, z RIGHT — the bind pose
     * puts `hand_R` at z +18, so z is right and not up).
     */
    this.tune = { rig: new THREE.Vector3(), wpn: new THREE.Vector3(), rot: new THREE.Euler() };
    this._frameX = -Math.PI / 2;
    /** The account's hand offsets, already converted to units (see SETTING_DEFAULT). */
    this._settingOffset = new THREE.Vector3();
    /** 'right' | 'left'. Left mirrors the group; see setHand. */
    this.hand = 'right';
    this.bob = true;

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
      this.mixer?.uncacheRoot(this.rig);
      this.rig.remove(this.arms);
    }
    this.arms = cloneSkinned(tmpl);
    this.rig.add(this.arms);
    // Rooted at the rig, not the arms: a viewmodel clip drives TWO skeletons.
    // The arms are one; the weapon's own bones are the other, and they are a
    // sibling of the arms in the clip, not a child. Rooting on the arms left
    // every weapon-side track unresolvable, which is why they had to be
    // trimmed away and the gun hung off `wpn` by a solved offset instead.
    this.mixer = new AnimationMixer(this.rig);
    this.actions.clear();
    // Where the weapon hangs. `wpn` is the viewmodel rig's own weapon bone and
    // the clips animate it (65 nodes a clip, `wpn` among them), so a gun
    // parented here moves with the hands.
    this.wpnBone = this.arms.getObjectByName('wpn') || this.arms.getObjectByName('weapon') || this.arms;
    // ...but parented DIRECTLY it takes the pack's frame rotation twice.
    //
    // Every glb in this pack is normalized to one frame: Source units, +x
    // forward, turned −90° about x to put Source's +z up on three's +y. The
    // manifest states it (`frame.rootRotationX`), the rig root carries it, and
    // cs3d-weapons.mjs stamps the same −90° onto a rigid weapon's mesh nodes so
    // the model stands up correctly on its own — as a world model must.
    //
    // A weapon hung off `wpn` does not need it: the bone is already in that
    // frame, so the two compose to −180° and the gun hangs inverted through the
    // hands. What the bone DOES supply is the placement, and that is wanted —
    // the weapon's own origin is its grip (the AK's geometry straddles it, from
    // 11 units behind to 26 in front), so it belongs at the bone, not at the
    // eye. Cancelling the bone outright put every gun back at the eye and left
    // the AWP flying off the top of the frame.
    //
    // So the mount cancels the ROTATION only. Fixed matrix, because it is a
    // constant of the pack, and read from the manifest rather than assumed.
    this.arms.updateWorldMatrix(true, true);
    this._frameX = (this.assets.manifest?.frame?.rootRotationX ?? -90) * DEG;
    this.wpnMount = new THREE.Group();
    this.wpnMount.name = 'wpnMount';
    this.wpnMount.matrixAutoUpdate = false;
    this.wpnBone.add(this.wpnMount);
    this.applyWeaponTune();
    this._applyCull();
    if (this.weaponModel) this.wpnMount.add(this.weaponModel);
  }

  /**
   * Apply the account's viewmodel settings (SettingsManager `viewmodel`).
   * Safe to call whenever they change; nothing here allocates.
   */
  applySettings(vm = {}) {
    this.setHand(vm.hand === 'left' ? 'left' : 'right');
    this.bob = vm.bob !== false;
    const d = (v, k) => ((Number.isFinite(v) ? v : SETTING_DEFAULT[k]) - SETTING_DEFAULT[k]) * M_TO_UNIT;
    // z is BACK in view space and the setting is forward, hence the negation.
    this._settingOffset.set(d(vm.offsetX, 'offsetX'), d(vm.offsetY, 'offsetY'), -d(vm.offsetZ, 'offsetZ'));
  }

  /**
   * Right or left handed. Left is a true mirror of the whole viewmodel, not a
   * nudge across the screen: these are real hands, and negating an offset the
   * way a floating gun can get away with would leave a right hand holding the
   * gun on the left side of the frame, thumb and trigger finger on the wrong
   * faces of it.
   *
   * Mirroring flips triangle winding, and the two backends do NOT agree about
   * what to do with that. three's WebGL path checks
   * `object.matrixWorld.determinant() < 0` and reverses front-face by itself;
   * its WebGPU pipeline (r169) hardcodes `frontFace: CCW` and picks `cullMode`
   * from `material.side` alone, with no determinant anywhere in the file. So on
   * WebGPU — which is what this renderer runs — a mirrored viewmodel has every
   * triangle reclassified as back-facing and culled, and the left hand renders
   * as nothing at all.
   *
   * Swapping FrontSide for BackSide swaps the cull to match, which is the
   * compensation the backend does not do. `side` is restored on the way back.
   */
  setHand(hand) {
    const want = hand === 'left' ? 'left' : 'right';
    if (want === this.hand) return;
    this.hand = want;
    this.group.scale.x = want === 'left' ? -1 : 1;
    this._applyCull();
    this.group.updateMatrixWorld(true);
  }

  /** Cull side for the current hand; see setHand. Call after new meshes arrive. */
  _applyCull() {
    const mirrored = this.hand === 'left';
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        if (m.userData.cs3dSide === undefined) m.userData.cs3dSide = m.side;
        const base = m.userData.cs3dSide;
        const flipped = base === THREE.FrontSide ? THREE.BackSide : base === THREE.BackSide ? THREE.FrontSide : base;
        const next = mirrored ? flipped : base;
        if (m.side !== next) {
          m.side = next;
          m.needsUpdate = true;
        }
      }
    });
  }

  /**
   * Rebuild the weapon mount: the pack's frame rotation cancelled, then the
   * tuner's offset and rotation in the rig axes that leaves behind (x forward
   * down the barrel, y up, z right). Cheap enough to call per change.
   */
  applyWeaponTune() {
    if (!this.wpnMount) return;
    const t = this.tune;
    // The pack solves each weapon's own placement (cs3d-weapons.mjs
    // computeVmOffsets); the tuner rides on top of it as a correction.
    const b = this.weapon?.vmOffset || [0, 0, 0];
    this.wpnMount.matrix
      .makeRotationX(-this._frameX)
      .multiply(new THREE.Matrix4().makeTranslation(b[0] + t.wpn.x, b[1] + t.wpn.y, b[2] + t.wpn.z))
      .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(t.rot.x * DEG, t.rot.y * DEG, t.rot.z * DEG)));
    this.wpnMount.matrixWorldNeedsUpdate = true;
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
    // And drop the mixer's cached bindings with them. Every weapon's skeleton
    // uses the same bone names (`weapon`, `trigger`, `magazine`), so a binding
    // cached against the rig would still be pointing at the LAST gun's bone of
    // that name — an object no longer in the scene.
    this.mixer?.uncacheRoot(this.rig);
    // The weapon's own clips ride along with its model — one round touches a
    // handful of weapons, and CS2 animates each of them differently.
    const [model, own] = await Promise.all([this.assets.model(bare), this.assets.weaponClips(bare)]);
    if (this.weaponName !== bare) return; // switched again while fetching
    this.weaponSet = own || null;
    this.applyWeaponTune(); // this weapon's own placement, not the last one's
    if (model) {
      this.weaponModel = cloneSkinned(model);
      // Still on the mount, even now that the weapon brings its own skeleton.
      //
      // A clip carries the weapon's bones as a SIBLING of the arms', both at
      // the origin, but that is only how VRF writes two skeletons to one file —
      // it is not where the gun goes. The engine attaches the weapon skeleton
      // to the arms' `wpn`, and the clips say so: `attachHand_R` is animated to
      // exactly `wpn` on every frame. Measured both ways, the weapon's own
      // `ag1_hand_r` grip marker lands 14-17 units from `hand_R` as a sibling
      // and 2.5-3.5 from it on the mount — and on the mount the residual is the
      // SAME vector in hand space for every weapon (wrist to palm), which is
      // what says it is anatomy and not a placement error.
      (this.wpnMount || this.rig).add(this.weaponModel);
      this._applyCull(); // a freshly cloned gun starts on the default side
    }
    this.nextAttack = draw ? stats.deploy || 0 : 0;
    if (draw) this._play('draw', { loop: false });
    else this._play('idle', { loop: true });
  }

  /**
   * The first clip of an action that this weapon actually has.
   *
   * The weapon's own set first, the class default behind it. Both, rather than
   * one or the other, because a per-weapon folder is not a superset: the Dual
   * Berettas have no `reload_empty` and every knife folder omits the pistol
   * actions entirely. An action the weapon does not author falls back to the
   * generic one rather than to nothing at all.
   */
  _clip(action) {
    const names = CLIP_ALIASES[action] || [action];
    for (const set of [this.weaponSet, this.assets.clips[this.clipSet]]) {
      if (!set) continue;
      for (const name of names) {
        const c = set.get(name);
        if (c) return c;
      }
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
    const target = onGround && this.bob ? Math.min(1, speed / BOB.fullSpeed) : 0;
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
    // View space here is x right, y up, z BACK, so the setting's "forward" is
    // negated into it.
    this.rig.position.copy(RIG_OFFSET).add(this._offset).add(this.tune.rig).add(this._settingOffset);
    this.rig.rotation.set(this._kick * KICK.up * DEG * 10, RIG_YAW, this._kick * KICK.roll);

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
  // The map's sun, once `setSun` has it — until then a key over the shoulder,
  // which is what this pass used to have permanently.
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-0.4, 1, 0.6);
  const fill = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(key, key.target, fill);
  // The gun shades the hands holding it. Cheap here in a way it is not in the
  // world: this scene is two meshes inside a 40-unit box, so a small map over a
  // tight frustum gives a texel a twentieth of a unit — fine enough for a
  // thumb across a slide, where the world's 4096 over 4400 units is not.
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -VM_SHADOW_EXTENT;
  key.shadow.camera.right = VM_SHADOW_EXTENT;
  key.shadow.camera.top = VM_SHADOW_EXTENT;
  key.shadow.camera.bottom = -VM_SHADOW_EXTENT;
  key.shadow.camera.near = Math.max(0.1, VM_SUN_DISTANCE - 3 * VM_SHADOW_EXTENT);
  key.shadow.camera.far = VM_SUN_DISTANCE + 3 * VM_SHADOW_EXTENT;
  key.shadow.bias = -0.0015;
  key.shadow.normalBias = 0.05;
  key.shadow.camera.updateProjectionMatrix();
  const _euler = new THREE.Euler();

  return {
    scene,
    camera,
    /**
     * Point the pass's sun where the map's sun is, from where the player is
     * standing and facing.
     *
     * This scene is camera space: the gun sits at the origin looking down −z
     * and never moves, so a light fixed in it is a light bolted to the player's
     * head. Turning around changed nothing — the same highlight stayed on the
     * same side of the barrel with the sun behind you. The direction has to be
     * the world's sun run through the camera's rotation, which is what the
     * caller passes.
     *
     * @param {THREE.Vector3} toSunView  unit vector toward the sun, in view space
     * @param {THREE.Color} color
     * @param {number} intensity
     */
    setSun(toSunView, color, intensity) {
      if (toSunView) key.position.copy(toSunView).multiplyScalar(VM_SUN_DISTANCE);
      if (color) key.color.copy(color);
      if (Number.isFinite(intensity)) key.intensity = intensity;
      key.updateMatrixWorld();
    },
    /**
     * Turn the sky probe with the view, for the same reason.
     *
     * Reflections are sampled in this scene's space, which is view space, so
     * without this the sky is glued to the player's head: a barrel reflects the
     * same slice of sky whichever way you face. Rotating the environment by the
     * camera's own rotation puts the reflected sky back in the world, so a
     * chrome Deagle sweeps the horizon past its slide as you turn.
     */
    setViewRotation(quaternion) {
      if (!quaternion) return;
      scene.environmentRotation = _euler.setFromQuaternion(quaternion);
    },
    /**
     * Hand the pass the map's own sky probe.
     *
     * Metal has no diffuse term at all — it is lit entirely by what it
     * reflects — so a metallic surface in a scene with only punctual lights
     * renders black except for a pinpoint highlight. This pass had a key and a
     * fill and no environment, which is why the smoke grenade (metalness µ177)
     * came out solid black, and why the metal parts of guns that are mostly
     * dielectric did too: the MAC-10's receiver and the SSG's barrel are
     * metallic texels inside a µ17 average.
     *
     * The world scene has had the probe since the bake landed (sky.js
     * `_buildEnvironment`); this just points the viewmodel at the same one, so
     * a gun reflects the sky the map is standing under rather than nothing.
     */
    setEnvironment(texture, intensity = VIEWMODEL_ENV_INTENSITY) {
      scene.environment = texture || null;
      scene.environmentIntensity = intensity;
    },
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
