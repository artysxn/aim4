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
import { assetBase } from './mapLoader.js';
import { packFetch, loadWithRetry, PACK_CDN } from './packFetch.js';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { VIEW_RECOIL_TRACKING } from '../../shared/sim3d/recoil.js';
import { reloadClipAliases } from './viewModelClips.js';

export const WEAPONS_PACK_VERSION = 4;

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
 * more than the world's 0.1. Full strength (1) turned metal cyan-white on
 * Anubis: the gun was mirroring a sky whose upper quartile is already near the
 * exposure target. A quarter keeps the reflection without the flood.
 */
export const VIEWMODEL_ENV_INTENSITY = 0.28;
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

/**
 * Bob, the game's own — `CBaseViewModel::CalcViewModelBob`, cvar defaults.
 *
 * Not a sine on a fixed frequency: the PERIOD comes from the weapon's max
 * speed, so a knife bobs faster than an AWP and the two look different at the
 * same running speed. That single line is most of why CS's walk reads the way
 * it does, and no amount of tuning a fixed frequency gets there.
 *
 * The lateral bob runs at HALF the vertical's frequency (double the period),
 * which is the opposite of the usual footfall model and is what gives the
 * figure-of-eight rather than an up-down bounce.
 */
const BOB = {
  /** `cl_bobcycle`, `cl_bobup`: the period scale, and where the peak sits. */
  cycle: 0.98,
  up: 0.5,
  /** `cl_bobamt_vert` / `cl_bobamt_lat`. */
  vert: 0.25,
  lat: 0.4,
  /** `cl_bob_lower_amt`: how far the gun drops as the player speeds up. */
  lowerAmount: 21,
  /** Speed is clamped here and slewed at 640 u/s² so a stop does not snap. */
  maxSpeed: 320,
  slew: 640,
  /** Amplitude scale on the ground and in the air. */
  groundMul: 0.00625,
  airMul: 0.00125
};

/**
 * Sway, the game's own — `CBaseViewModel::CalcViewModelLag`, the CS override.
 *
 * The shape that matters: the gun does not lag by the CURRENT turn rate, it
 * lags toward where the view was `interp` seconds ago. So a flick and a slow
 * pan of the same total angle produce completely different motion, and a turn
 * that stops leaves the gun still catching up — which a rate-based spring
 * cannot do at all.
 */
const SWAY = {
  /** `cl_wpn_sway_interp`: seconds of history to look back over. */
  interp: 0.1,
  /** `cl_wpn_sway_scale`. */
  scale: 1.6
};

/**
 * How much of the aim punch the VIEWMODEL takes — `viewmodel_recoil`, 1 by
 * default.
 *
 * The camera takes 0.45 of it (shared/sim3d/recoil.js VIEW_RECOIL_TRACKING),
 * so what actually moves on screen is the DIFFERENCE: the gun climbs out of
 * frame by `punch × (1 − 0.45)` over a spray while the crosshair climbs by the
 * rest. Setting this to 0.45 welds the gun to the crosshair, which is what a
 * viewmodel that adds the same punch the camera already has looks like, and is
 * the usual way this gets built wrong.
 */
const VIEWMODEL_RECOIL = 1.0;

/** [docs] `cl_gunlowerangle` / `cl_gunlowerspeed`: the gun drops in the air. */
const GUN_LOWER_ANGLE = 2;
const GUN_LOWER_SPEED = 0.1;

/**
 * The bob's phase shape: a triangle in TIME run through a sine, with the peak
 * at `cl_bobup` through the cycle rather than the middle.
 *
 * A plain sine gets the rhythm but not the gait — the asymmetry is the weight
 * coming down faster than it goes up, and it is what makes the walk read as
 * footfalls instead of a float.
 */
function bobShape(t, period) {
  if (!(period > 0)) return 0;
  let c = t - Math.floor(t / period) * period;
  c /= period;
  return c < BOB.up ? (Math.PI * c) / BOB.up : Math.PI + (Math.PI * (c - BOB.up)) / (1 - BOB.up);
}

/** Shortest signed difference between two angles, degrees. */
function wrapDeg(d) {
  let x = d % 360;
  if (x > 180) x -= 360;
  else if (x < -180) x += 360;
  return x;
}

/**
 * The view angles at `when`, out of a flat [t, pitch, yaw, ...] ring.
 * Linear between the two samples that straddle it; the newest pair if `when`
 * is past the end, which is what happens for the first tenth of a second.
 */
function sampleAngles(log, when, pitch, yaw) {
  if (log.length < 6) return { pitch, yaw };
  if (when <= log[0]) return { pitch: log[1], yaw: log[2] };
  for (let i = log.length - 3; i >= 3; i -= 3) {
    if (log[i - 3] <= when && when <= log[i]) {
      const span = log[i] - log[i - 3];
      const f = span > 1e-6 ? (when - log[i - 3]) / span : 0;
      return {
        pitch: log[i - 2] + wrapDeg(log[i + 1] - log[i - 2]) * f,
        yaw: log[i - 1] + wrapDeg(log[i + 2] - log[i - 1]) * f
      };
    }
  }
  return { pitch, yaw };
}

/** Source `AngleVectors(...).forward`, roll 0, degrees in. */
function forwardOf(pitchDeg, yawDeg) {
  const p = pitchDeg * DEG;
  const y = yawDeg * DEG;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

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
    try {
      await this._loadFrom(this.base);
    } catch (e) {
      const cdn = `${PACK_CDN}/weapons`;
      if (this.base.replace(/\/$/, '') === cdn) throw e;
      console.warn('cs3d: weapons pack missed at', this.base, '— trying the public bucket');
      this.base = cdn;
      await this._loadFrom(this.base);
    }
  }

  async _loadFrom(base) {
    this.base = base;
    const res = await packFetch(`${base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`no weapons pack (${res.status} from ${base}/manifest.json)`);
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
    return loadWithRetry(this._loader, `${this.base}/${file}${this._v}`).catch((e) => {
      throw new Error(`${file}: ${e?.message || e}`);
    });
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
   * Drop clip channels whose nodes are not in the mixer graph. Manifest bone
   * names (`weapon`, `magazine`, `slide`) often do not match the cloned glb,
   * and each miss is a PropertyBinding warning plus a failed bind.
   */
  _trimClipsToGraph(map, root) {
    if (!map || !root) return 0;
    const names = new Set();
    root.traverse((o) => {
      if (o.name) names.add(o.name);
    });
    let dropped = 0;
    for (const clip of map.values()) {
      const kept = clip.tracks.filter((t) => {
        const i = t.name.lastIndexOf('.');
        return names.has(i >= 0 ? t.name.slice(0, i) : t.name);
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
 * the trigger goes, `reload()` on R / empty mag, and `update(dt, state)` every
 * frame. `group` renders in view space — see `render()` for the pass that draws it.
 */
export class ViewModel {
  constructor(assets) {
    this.assets = assets;
    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    // The rig is authored looking down Source +x; three's camera looks down
    // −z. One rotation puts the whole thing in front of the eye.
    this.rig = new THREE.Group();
    // 'YXZ' from the start, so the rest pose and the per-frame bob agree about
    // which axis is which — see the note where `update` writes this.
    this.rig.rotation.set(0, RIG_YAW, 0, 'YXZ');
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
    /** Slewed, clamped speed the bob is actually driven by. */
    this._bobSpeed = 0;
    /** The bob's own clock. It only advances while the player is moving. */
    this._bobTime = 0;
    this._verticalBob = 0;
    this._lateralBob = 0;
    /**
     * The view angles of the last 0.1 s, for the lag.
     *
     * A ring of samples rather than a rate, because the game's sway is
     * `where were you looking a tenth of a second ago` and a rate cannot say
     * that — see SWAY. Twelve entries covers 0.1 s at any frame rate that
     * matters and the oldest are dropped as they age out.
     */
    this._angleLog = [];
    this._loweredX = 0;
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
    this.mixer = new THREE.AnimationMixer(this.rig);
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
    if (this.weaponSet) this.assets._trimClipsToGraph(this.weaponSet, this.rig);
    // An absolute time on the same clock `attack()` compares against, not a
    // duration. Storing the duration made the lockout expire the moment
    // `performance.now()/1000` passed it — about one second after the page
    // loaded — so every draw after that was interruptible on the first click.
    this.nextAttack = draw ? performance.now() / 1000 + (stats.deploy || 0) : 0;
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
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
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
      // The gun's jump is the game's own `shoot1` clip plus the aim punch the
      // caller feeds in (`update`'s `punch`), which is where CS2's comes from
      // too. There is no spring here any more: one was, it was invented, and
      // it moved the gun on shots the punch says should barely move it.
      this._play('fire', { loop: false, fade: 0.01 });
    }
    return true;
  }

  /**
   * Play the packed reload clip. Locks the trigger until the clip ends so a
   * click cannot cut it off. Mag fill is the match timer's job.
   *
   * @param {{ empty?: boolean, now?: number }} [opts]
   */
  reload({ empty = false, now = performance.now() / 1000 } = {}) {
    if (!this.weapon || this.weapon.melee || this.weapon.grenade || !this.mixer) return false;
    let clip = null;
    for (const set of [this.weaponSet, this.assets.clips[this.clipSet]]) {
      if (!set) continue;
      for (const name of reloadClipAliases(empty)) {
        clip = set.get(name);
        if (clip) break;
      }
      if (clip) break;
    }
    if (!clip) return false;
    this._play('reload', { loop: false, fade: 0.06, clip });
    this.nextAttack = now + clip.duration;
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

  /** Is the thing in hand a grenade? */
  get isGrenade() {
    return !!this.weapon?.grenade;
  }

  /**
   * A grenade action: `pullpin`, `throw_overhand` or `throw_underhand`.
   *
   * These are the game's own clip names and every grenade authors all three —
   * the pack ships them per weapon, and the shared `grenade` class set carries
   * them plus the three `throwcharge_*` hold poses. Which is itself worth
   * noticing: CS2 animating a high, a mid and a low charge is the animation
   * department agreeing with the three throw strengths the release speeds show.
   */
  playThrow(action) {
    if (!this.isGrenade || !this.mixer) return false;
    const clip = this.weaponSet?.get(action) || this.assets.clips[this.clipSet]?.get(action) || this.assets.clips.grenade?.get(action);
    if (!clip) return false;
    this._play(action, { loop: false, fade: 0.03, clip });
    return true;
  }

  /**
   * Show or hide what is in the hand without changing what is held — the
   * moment between a grenade leaving and the next one being drawn.
   */
  showWeapon(on) {
    if (this.weaponModel) this.weaponModel.visible = !!on;
  }

  /** Replay the draw for what is already held. */
  redraw(now = performance.now() / 1000) {
    this.showWeapon(true);
    this.nextAttack = now + (this.weapon?.deploy || 0);
    this._play('draw', { loop: false });
  }

  /**
   * Advance the viewmodel.
   *
   * Three motions, and all three are the game's rather than a shape that
   * looked about right: `CalcViewModelBob`, `CalcViewModelLag`, and the aim
   * punch the caller hands in. See BOB, SWAY and VIEWMODEL_RECOIL.
   *
   * @param {number} dt      seconds
   * @param {object} state
   * @param {number} state.speed     horizontal speed, u/s
   * @param {boolean} state.onGround
   * @param {number} state.viewYaw   degrees, Source (positive LEFT)
   * @param {number} state.viewPitch degrees, Source (positive DOWN)
   * @param {number[]} [state.punch] the aim punch the BULLETS take, degrees
   *   [pitch, yaw, roll] — already scaled by `weapon_recoil_scale`
   * @param {number[]} [state.viewPunch] the cosmetic shake the CAMERA has
   * @param {number} [state.now]     seconds, for the sway history
   */
  update(dt, state = {}) {
    if (!this.arms) return;
    const {
      speed = 0,
      onGround = true,
      viewYaw = 0,
      viewPitch = 0,
      punch = null,
      viewPunch = null,
      now = performance.now() / 1000
    } = state;

    // ---- bob ---------------------------------------------------------------
    // Speed is slewed before anything reads it, so letting go of W does not
    // stop the bob in one frame, and clamped at 320 whatever the weapon.
    if (this.bob) {
      const maxDelta = Math.max(0, dt * BOB.slew);
      const want = Math.min(BOB.maxSpeed, speed);
      this._bobSpeed = Math.min(this._bobSpeed + maxDelta, Math.max(this._bobSpeed - maxDelta, want));
    } else {
      this._bobSpeed = 0;
    }
    const bobSpeed = this._bobSpeed;
    // The clock only runs while moving, which is why the gun settles where it
    // is instead of continuing to swing on the spot.
    this._bobTime += dt * Math.min(1, bobSpeed / BOB.maxSpeed);
    // The period is the WEAPON's: (1000 − maxSpeed) / 3.5, in milliseconds.
    // An AK (215 u/s) cycles every 0.220 s and a knife (250) every 0.210.
    const period = (((1000 - (this.weapon?.maxSpeed || 250)) / 3.5) * 0.001) * BOB.cycle;
    // The gun rides lower the faster the player is going.
    const runAdd = BOB.lowerAmount * 0.2 * (bobSpeed * 0.006);
    const mul = onGround ? BOB.groundMul : BOB.airMul;

    let v = bobSpeed * mul * BOB.vert;
    v = v * 0.3 + v * 0.7 * Math.sin(bobShape(this._bobTime, period));
    this._verticalBob = THREE.MathUtils.clamp(v - runAdd, -7, 4);
    let l = bobSpeed * mul * BOB.lat;
    // Double the period sideways: the figure-of-eight, not a bounce.
    l = l * 0.3 + l * 0.7 * Math.sin(bobShape(this._bobTime, period * 2));
    this._lateralBob = THREE.MathUtils.clamp(l, -8, 8);

    // ---- sway: the gun lags where the view WAS -----------------------------
    this._angleLog.push(now, viewPitch, viewYaw);
    while (this._angleLog.length > 3 && this._angleLog[3] <= now - SWAY.interp - 0.05) this._angleLog.splice(0, 3);
    const lag = sampleAngles(this._angleLog, now - SWAY.interp, viewPitch, viewYaw);
    // The difference, as a direction: how far off the current forward the old
    // forward sits. Small angles make it nearly linear, a flick does not.
    const dPitch = wrapDeg(lag.pitch - viewPitch);
    const dYaw = wrapDeg(lag.yaw - viewYaw);
    const f = forwardOf(-dPitch, -dYaw);
    const lagX = (1 - f[0]) * SWAY.scale;
    const lagY = -f[1] * SWAY.scale;
    const lagZ = -f[2] * SWAY.scale;

    // ---- the gun drops in the air ------------------------------------------
    const wantLower = onGround ? 0 : GUN_LOWER_ANGLE;
    this._loweredX += (wantLower - this._loweredX) * Math.min(1, dt / GUN_LOWER_SPEED);

    // ---- compose -----------------------------------------------------------
    // View space: x right, y up, z BACK toward the eye. Source's own basis for
    // these terms is forward/right/up, which maps to (0,0,−1), (1,0,0), (0,1,0).
    this._offset.set(
      // lateral bob rides the right vector; the lag's own y term is its right
      this._lateralBob * 0.2 - lagY,
      this._verticalBob * 0.1 + lagZ,
      -this._verticalBob * 0.4 - lagX - this._loweredX * 0.4
    );
    this.rig.position.copy(RIG_OFFSET).add(this._offset).add(this.tune.rig).add(this._settingOffset);

    // The punch, as an on-screen rotation about the eye.
    //
    // The camera already carries `viewPunch + punch × 0.45`; the viewmodel is
    // drawn in its own space and carries none of it. So the group takes the
    // DIFFERENCE, which is what actually separates the gun from the crosshair
    // during a spray — the gun climbs out of frame and the crosshair does not
    // follow it all the way.
    let risePitch = 0;
    let riseYaw = 0;
    let riseRoll = 0;
    if (punch) {
      const k = VIEWMODEL_RECOIL - VIEW_RECOIL_TRACKING;
      risePitch = punch[0] * k - (viewPunch ? viewPunch[0] : 0);
      riseYaw = punch[1] * k - (viewPunch ? viewPunch[1] : 0);
      riseRoll = (punch[2] || 0) * k;
    }
    // Source pitch is positive DOWN, three's rotation.x positive is up.
    // Roll is Source z; the camera already took VIEW_RECOIL_TRACKING of it.
    this.group.rotation.set(-risePitch * DEG, riseYaw * DEG, riseRoll * DEG, 'YXZ');

    // Bob tilts the gun as well as moving it: roll with the vertical, pitch
    // against it, yaw against the lateral.
    //
    // 'YXZ' rather than three's default, and the three terms are in an order
    // that looks wrong until you follow the axes. R = Ry·Rx·Rz, so the
    // INNERMOST z turns about the model's own +z — which the bind pose says is
    // the gun's RIGHT (hand_R sits at z +18), so that one is the pitch. The x
    // term then turns the model about its forward axis, which is the roll. And
    // y stays the outermost view-space yaw, where RIG_YAW already lives.
    //
    // Under the default 'XYZ' the x term is applied AFTER the yaw has carried
    // the model into view space, so it lands on the same axis the z term does
    // and the two simply add: the gun nods twice as hard and never rolls at
    // all. That is what this looked like before, and it is a quiet failure —
    // the motion is still there, it is just the wrong motion.
    this.rig.rotation.set(
      this._verticalBob * 0.5 * DEG,
      RIG_YAW - this._lateralBob * 0.3 * DEG,
      this._verticalBob * 0.4 * DEG - this._loweredX * 0.2 * DEG,
      'YXZ'
    );

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
