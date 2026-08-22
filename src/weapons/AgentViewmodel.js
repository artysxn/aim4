// ---------------------------------------------------------------------------
// src/weapons/AgentViewmodel.js
// The first-person viewmodel: CS2's own arms, the real weapon in them, and the
// game's own draw / idle / shoot / reload clips — replacing the box-primitive
// rifle, pistol and AWP in gunModels.js.
//
// Rendering. Like the game (and like src/cs3d/viewModel.js, whose motion this
// is a WebGL-side port of) the viewmodel is drawn in its OWN pass with its own
// camera and a cleared depth buffer, after the world. That is what stops a
// muzzle poking through a wall the player is against, and it lets the gun keep
// CS2's narrower `viewmodel_fov` while the arena stays at the player's own.
// The pass lives in view space: the rig sits at the origin looking down −z, so
// nothing here knows or cares where in the arena the player is.
//
// Units. The pack counts SOURCE units, and so does this pass — it has no scene
// to agree with, so there is no reason to convert. The one number that leaves
// in metres is the muzzle (`muzzleWorld`), because tracers and impacts are the
// arena's, not the viewmodel's.
//
// What is the game's and what is not:
//
//   from the files   the arms, the weapon models, the clips, and the fire rate
//                    and deploy time out of `weapons.vdata`.
//   derived here     bob, sway and recoil — the standard Source shapes, ported
//                    from src/cs3d/viewModel.js where their constants are
//                    documented at length. Change them there and here together.
//
// The trainer's own weapon tables (ak47.js, pistol.js, sniper.js) still own
// everything that decides where a BULLET goes; this file only draws.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js?three-webgl';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { sourceVFovFromHFov } from '../utils/MathUtils.js';
import { VIEW_RECOIL_TRACKING } from '../../shared/sim3d/recoil.js';
import { reloadClipAliases } from '../cs3d/viewModelClips.js';
import { sharedWeaponAssets, weaponNameFor } from '../agents/weaponAssets.js';
import { flattenMaterial } from '../agents/agentPaint.js';
import {
  BOB,
  SWAY,
  GUN_LOWER_ANGLE,
  GUN_LOWER_SPEED,
  VIEWMODEL_RECOIL,
  CLIP_ALIASES,
  bobShape,
  bobPeriod,
  wrapDeg,
  sampleAngles,
  forwardOf
} from './viewmodelMotion.js';
import { gripFallbackOffset } from '../../shared/sim3d/gripPlacement.js';

const DEG = Math.PI / 180;

/** CS2's `viewmodel_fov` default (4:3 horizontal cvar). The arena uses world FOV. */
export const VIEWMODEL_FOV = 68;

/**
 * Flat-colour paint for the viewmodel, and its defaults.
 *
 * Off, the arms and the gun wear CS2's own skins. On, both drop their colour
 * maps and take one flat colour each — still shaded, and still carrying their
 * normal maps, because a flat gun with no relief is a silhouette rather than a
 * gun. The rest of the viewmodel (the clips, the bob, the placement) does not
 * know or care which it is.
 *
 * There is no static-lighting switch here the way there is for bodies: this
 * pass is already fixed. Its key and fill live in the pass's own scene, which
 * IS view space, so the gun is lit identically wherever the player stands and
 * whichever way they face — see `createViewModelPass` in src/cs3d/viewModel.js
 * for the version of this that has to work in a lit map.
 */
export const DEFAULT_VIEWMODEL_PAINT = Object.freeze({
  flat: false,
  hands: '#6f7480',
  weapon: '#3a3f46'
});

/** Where the rig sits in view space, Source units. See cs3d/viewModel.js. */
const RIG_OFFSET = new THREE.Vector3(0, -1.5, 0);

/**
 * The yaw that turns the packed rig to face the camera.
 *
 * The pack ships its frame in the manifest (`forward: '+x'`, up +z folded to
 * three's +y by the packer's −90° root rotation). three's camera looks down −z
 * with +x to its right, and `Ry(θ)` maps (1,0,0) → (cos θ, 0, −sin θ) — only
 * +π/2 sends forward to −z. −π/2 puts the whole viewmodel directly behind the
 * eye, and mirrors left and right on the way.
 */
const RIG_YAW = Math.PI / 2;

/**
 * The trainer's own viewmodel offsets, in METRES, are read as a DELTA from
 * their defaults: the pack has already solved where each weapon sits, so
 * default settings leave that placement alone and a slider nudges from there.
 */
const SETTING_DEFAULT = { offsetX: 0.16, offsetY: -0.15, offsetZ: 0.5 };
const M_TO_UNIT = 1 / UNIT_M;

// ---------------------------------------------------------------------------

/**
 * One viewmodel: a pair of hands, whatever they are holding, its motion, and
 * the pass that draws it.
 *
 * Drive it with `setWeapon()` when the held weapon changes, `attack()` when a
 * bullet leaves, `reload()` on R or an empty mag, and `update(dt, state)`
 * every frame. `render(renderer, camera)` goes after the world pass.
 */
export class AgentViewmodel {
  constructor({ assets = sharedWeaponAssets(), fov = VIEWMODEL_FOV } = {}) {
    this.assets = assets;

    // ---- the pass ---------------------------------------------------------
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(sourceVFovFromHFov(fov), 1, 0.5, 400);
    this.scene.add(this.camera);
    // A key over the shoulder and a fill, which is all the trainer's arenas
    // have to offer anyway — there is no map bake here to sample.
    this._key = new THREE.DirectionalLight(0xffffff, 2.2);
    this._key.position.set(-0.4, 1, 0.6);
    this._fill = new THREE.AmbientLight(0xffffff, 0.75);
    this.scene.add(this._key, this._key.target, this._fill);

    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    this.scene.add(this.group);
    this.rig = new THREE.Group();
    // 'YXZ' from the start, so the rest pose and the per-frame bob agree about
    // which axis is which — see the note where `update` writes this.
    this.rig.rotation.set(0, RIG_YAW, 0, 'YXZ');
    this.rig.position.copy(RIG_OFFSET);
    this.group.add(this.rig);

    this.side = 'CT';
    this.weapon = null; // the table row
    this.weaponName = '';
    this.arms = null;
    this.mixer = null;
    this.actions = new Map();
    this.wpnBone = null;
    this.wpnMount = null;
    this.weaponModel = null;
    this.clipSet = 'rifle';
    this.weaponSet = null;
    this._frameX = -Math.PI / 2;
    /** This weapon's placement, packed or solved. See `_solveOffset`.
     *  NOT `_offset` — that name is the bob/sway scratch vector below. */
    this._wpnOffset = null;
    this._settingOffset = new THREE.Vector3();
    this.hand = 'right';
    this.bob = true;
    this.visible = false;
    this.paint = { ...DEFAULT_VIEWMODEL_PAINT };

    this.nextAttack = 0;
    this._bobSpeed = 0;
    this._bobTime = 0;
    this._verticalBob = 0;
    this._lateralBob = 0;
    this._angleLog = [];
    this._loweredX = 0;
    this._offset = new THREE.Vector3();
    this._current = null;
    this._currentLoops = false;
    this._aspect = 0;

    // Scratch, so the per-frame path allocates nothing.
    this._m = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
  }

  /** True once there are hands to draw. */
  get ready() {
    return !!this.arms;
  }

  /** Team hands. The trainer's player has no side; CT matches the bots. */
  setSide(side) {
    if (side === this.side && this.arms) return;
    const tmpl = this.assets.arms[side] || this.assets.arms.CT || this.assets.arms.T;
    if (!tmpl) return;
    this.side = side;
    if (this.arms) {
      this.mixer?.stopAllAction();
      this.mixer?.uncacheRoot(this.rig);
      this.rig.remove(this.arms);
    }
    this.arms = cloneSkinned(tmpl);
    this.rig.add(this.arms);
    // Rooted at the RIG, not the arms: a viewmodel clip drives two skeletons —
    // the arms and the weapon's own bones, which are a sibling of the arms in
    // the clip rather than a child of them.
    this.mixer = new THREE.AnimationMixer(this.rig);
    this.actions.clear();
    this.wpnBone = this.arms.getObjectByName('wpn') || this.arms.getObjectByName('weapon') || this.arms;
    // ...but parented DIRECTLY the weapon takes the pack's frame rotation
    // twice. Every glb here is normalized to one frame (Source units, +x
    // forward, turned −90° about x), the rig root carries it, and a rigid
    // weapon carries it on its own mesh nodes so it stands up as a world model.
    // Composed, that is −180° and the gun hangs inverted through the hands.
    // What the bone DOES supply is placement — a weapon's origin is its grip —
    // so the mount cancels the rotation and keeps the position.
    this.arms.updateWorldMatrix(true, true);
    this._frameX = (this.assets.manifest?.frame?.rootRotationX ?? -90) * DEG;
    this.wpnMount = new THREE.Group();
    this.wpnMount.name = 'wpnMount';
    this.wpnMount.matrixAutoUpdate = false;
    this.wpnBone.add(this.wpnMount);
    this.applyWeaponTune();
    this._applyCull();
    if (this.weaponModel) this.wpnMount.add(this.weaponModel);
    this.applyPaint();
  }

  /**
   * Flat colours on / off, and which colours. Safe to call every frame; the
   * work is one pass over about four materials.
   */
  setPaint(paint = {}) {
    Object.assign(this.paint, paint);
    this.applyPaint();
    return this.paint;
  }

  applyPaint() {
    this._paint(this.arms, this.paint.hands);
    this._paint(this.weaponModel, this.paint.weapon);
  }

  /**
   * Repaint one subtree, remembering what it looked like textured.
   *
   * The originals are stashed on the material rather than rebuilt from the
   * pack, because these materials are already this viewmodel's own clones
   * (WeaponAssets.cloneModel) and the arms are cloned once per side change —
   * there is nothing to fetch and nothing shared to damage.
   */
  _paint(root, color) {
    if (!root) return;
    const flat = this.paint.flat === true;
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        if (m.userData.vmSrc === undefined) {
          m.userData.vmSrc = { map: m.map || null, color: m.color?.getHex() ?? 0xffffff, metalness: m.metalness };
        }
        if (flat) {
          flattenMaterial(m, { color, keepNormalMap: true });
        } else {
          m.map = m.userData.vmSrc.map;
          m.metalness = m.userData.vmSrc.metalness;
          m.vertexColors = false;
          m.color.setHex(m.userData.vmSrc.color);
          m.needsUpdate = true;
        }
      }
    });
  }

  /** Apply the account's viewmodel settings. Safe to call whenever they change. */
  applySettings(vm = {}) {
    this.setHand(vm.hand === 'left' ? 'left' : 'right');
    this.bob = vm.bob !== false;
    this.setPaint({
      flat: vm.flatColors === true,
      hands: vm.handColor || DEFAULT_VIEWMODEL_PAINT.hands,
      weapon: vm.weaponColor || DEFAULT_VIEWMODEL_PAINT.weapon
    });
    const fov = sourceVFovFromHFov(Number.isFinite(vm.fov) ? vm.fov : VIEWMODEL_FOV);
    if (fov !== this.camera.fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const d = (v, k) => ((Number.isFinite(v) ? v : SETTING_DEFAULT[k]) - SETTING_DEFAULT[k]) * M_TO_UNIT;
    // z is BACK in view space and the setting is forward, hence the negation.
    this._settingOffset.set(d(vm.offsetX, 'offsetX'), d(vm.offsetY, 'offsetY'), -d(vm.offsetZ, 'offsetZ'));
  }

  /**
   * Right or left handed. Left is a true mirror of the whole viewmodel, not a
   * nudge across the screen: these are real hands, and negating an offset the
   * way a floating box can get away with would leave a right hand holding the
   * gun on the wrong side with its thumb through the receiver.
   *
   * Mirroring flips triangle winding. three's WebGL renderer checks
   * `matrixWorld.determinant() < 0` and reverses front-face itself, so unlike
   * the WebGPU path this needs no `side` compensation — but the meshes are
   * still walked, because a left-handed gun that arrives later must not miss
   * whatever the current hand decided.
   */
  setHand(hand) {
    const want = hand === 'left' ? 'left' : 'right';
    if (want === this.hand) return;
    this.hand = want;
    this.group.scale.x = want === 'left' ? -1 : 1;
    this._applyCull();
    this.group.updateMatrixWorld(true);
  }

  _applyCull() {
    // Nothing to compensate on WebGL (see setHand); kept as the one place that
    // knows it, so a renderer change has somewhere obvious to go.
  }

  /**
   * Rebuild the weapon mount: the pack's frame rotation cancelled, then this
   * weapon's own solved offset (`vmOffset`, from cs3d-weapons.mjs).
   */
  applyWeaponTune() {
    if (!this.wpnMount) return;
    const b = this._wpnOffset || this.weapon?.vmOffset || [0, 0, 0];
    this.wpnMount.matrix.makeRotationX(-this._frameX).multiply(new THREE.Matrix4().makeTranslation(b[0], b[1], b[2]));
    this.wpnMount.matrixWorldNeedsUpdate = true;
  }

  /**
   * This weapon's placement: the pack's, or one solved from its grip marker
   * when the pack has none (shared/sim3d/gripPlacement.js — the map explorer's
   * viewmodel reads the same rule, which is why it lives there).
   *
   * Never writes back to the manifest row — that object is shared with every
   * other reader of the pack, including the ballistics and the bots.
   */
  _solveOffset(model) {
    const solved = gripFallbackOffset(model, this.weapon);
    if (!solved) return this.weapon?.vmOffset ? [...this.weapon.vmOffset] : [0, 0, 0];
    console.log(
      `aim4: ${this.weaponName} has no packed viewmodel offset; placed by its grip marker at ` +
        `[${solved.map((v) => v.toFixed(2)).join(', ')}]`
    );
    return solved;
  }

  /**
   * Hold a weapon by its bare CS2 name. Plays the draw and blocks firing for
   * the table's deploy duration.
   */
  async setWeapon(name, { draw = true } = {}) {
    const bare = String(name || '').replace(/^weapon_/, '');
    if (!bare || bare === this.weaponName) return;
    const stats = this.assets.stats(bare);
    if (!stats) return;
    this.weaponName = bare;
    this.weapon = stats;
    this._wpnOffset = null;
    this.clipSet = this.assets.clips[stats.class] ? stats.class : 'rifle';
    if (!this.arms) this.setSide(this.side);
    if (!this.arms) return;
    // The old model goes as soon as the new one is asked for, so a slow fetch
    // never shows the previous weapon in the new weapon's hands.
    if (this.weaponModel) {
      this.weaponModel.removeFromParent();
      this.weaponModel = null;
    }
    this.actions.clear();
    this.mixer?.stopAllAction();
    // And drop the mixer's cached bindings with them: every weapon's skeleton
    // uses the same bone names, so a binding cached against the rig would
    // still point at the LAST gun's bone of that name.
    this.mixer?.uncacheRoot(this.rig);
    const [model, own] = await Promise.all([this.assets.model(bare), this.assets.weaponClips(bare)]);
    if (this.weaponName !== bare) return; // switched again while fetching
    this.weaponSet = own || null;
    this.applyWeaponTune();
    if (model) {
      this.weaponModel = this.assets.cloneModel(bare);
      // Measured on the template, before it is parented: `_solveOffset` reads a
      // world position, and under the mount that would already include the
      // placement it is trying to work out.
      this._wpnOffset = this._solveOffset(model);
      this.applyWeaponTune();
      if (this.weaponModel) (this.wpnMount || this.rig).add(this.weaponModel);
      this._applyCull();
      this.applyPaint();
    }
    if (this.weaponSet) this.assets.trimClipsToGraph(this.weaponSet, this.rig);
    this.nextAttack = draw ? performance.now() / 1000 + (stats.deploy || 0) : 0;
    this._play(draw ? 'draw' : 'idle', { loop: !draw });
  }

  /**
   * The first clip of an action this weapon actually has: its own set first,
   * the class default behind it. Both, rather than one or the other, because a
   * per-weapon folder is not a superset of the class one.
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

  /** A bullet left the barrel: play the game's own shot clip. */
  attack() {
    if (!this.weapon) return false;
    this._play('fire', { loop: false, fade: 0.01 });
    return true;
  }

  /**
   * Play the packed reload clip over `seconds` (the trainer's own reload time,
   * which the WeaponController owns — the clip is stretched to it rather than
   * the other way round, so nothing about how the gun SHOOTS changes here).
   */
  reload({ empty = false, seconds = 0 } = {}) {
    if (!this.weapon || !this.mixer) return false;
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
    const a = this._play('reload', { loop: false, fade: 0.06, clip });
    if (a && seconds > 0 && clip.duration > 0) a.timeScale = clip.duration / seconds;
    return true;
  }

  /** Replay the draw for whatever is already held (a weapon switch, a run start). */
  redraw() {
    if (!this.weapon) return;
    this.nextAttack = performance.now() / 1000 + (this.weapon.deploy || 0);
    this._play('draw', { loop: false });
  }

  setVisible(v) {
    this.visible = !!v;
    this.group.visible = this.visible;
  }

  /**
   * The muzzle in ARENA space (metres), for tracers and impacts.
   *
   * Read off the weapon table's own `muzzle` attachment rather than off the
   * drawn model: the table is in the eye's frame (Source forward / left / up),
   * which is exactly the frame the camera basis gives, and it is the same
   * vector the game spawns its own tracers from. Taking it off the model would
   * mean undoing the bob and the sway first, and would put the tracer
   * somewhere different every frame for no gain.
   */
  muzzleWorld(camera, out = new THREE.Vector3()) {
    const m = this.weapon?.muzzle;
    camera.getWorldDirection(this._fwd).normalize();
    this._right.crossVectors(this._fwd, this._worldUp).normalize();
    this._up.crossVectors(this._right, this._fwd).normalize();
    out.copy(camera.position);
    if (!m) return out;
    const mirror = this.hand === 'left' ? -1 : 1;
    // Source view basis is forward, LEFT (+y), up (+z).
    return out
      .addScaledVector(this._fwd, m[0] * UNIT_M)
      .addScaledVector(this._right, -m[1] * UNIT_M * mirror)
      .addScaledVector(this._up, m[2] * UNIT_M);
  }

  /**
   * Advance the viewmodel.
   *
   * @param {number} dt seconds
   * @param {object} state
   * @param {number} state.speed     horizontal speed, METRES/s (converted here)
   * @param {boolean} state.onGround
   * @param {number} state.viewYaw   radians, three camera yaw
   * @param {number} state.viewPitch radians, three camera pitch (positive UP)
   * @param {number} [state.punchPitch] the camera's own aim punch, radians
   * @param {number} [state.punchYaw]
   */
  update(dt, state = {}) {
    if (!this.arms) return;
    const {
      speed = 0,
      onGround = true,
      viewYaw = 0,
      viewPitch = 0,
      punchPitch = 0,
      punchYaw = 0,
      now = performance.now() / 1000
    } = state;
    // The bob and the sway are Source's, so they count Source units and Source
    // degrees: +yaw left, +pitch DOWN.
    const speedU = speed / UNIT_M;
    const yawDeg = (viewYaw * 180) / Math.PI;
    const pitchDeg = (-viewPitch * 180) / Math.PI;

    // ---- bob ---------------------------------------------------------------
    if (this.bob) {
      const maxDelta = Math.max(0, dt * BOB.slew);
      const want = Math.min(BOB.maxSpeed, speedU);
      this._bobSpeed = Math.min(this._bobSpeed + maxDelta, Math.max(this._bobSpeed - maxDelta, want));
    } else {
      this._bobSpeed = 0;
    }
    const bobSpeed = this._bobSpeed;
    // The clock only runs while moving, which is why the gun settles where it
    // is instead of continuing to swing on the spot.
    this._bobTime += dt * Math.min(1, bobSpeed / BOB.maxSpeed);
    // The period is the WEAPON's: (1000 − maxSpeed) / 3.5, in milliseconds. An
    // AK (215 u/s) cycles every 0.220 s and a knife (250) every 0.210.
    const period = bobPeriod(this.weapon?.maxSpeed || 250);
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
    this._angleLog.push(now, pitchDeg, yawDeg);
    while (this._angleLog.length > 3 && this._angleLog[3] <= now - SWAY.interp - 0.05) this._angleLog.splice(0, 3);
    const lag = sampleAngles(this._angleLog, now - SWAY.interp, pitchDeg, yawDeg);
    const dPitch = wrapDeg(lag.pitch - pitchDeg);
    const dYaw = wrapDeg(lag.yaw - yawDeg);
    const f = forwardOf(-dPitch, -dYaw);
    const lagX = (1 - f[0]) * SWAY.scale;
    const lagY = -f[1] * SWAY.scale;
    const lagZ = -f[2] * SWAY.scale;

    // ---- the gun drops in the air ------------------------------------------
    const wantLower = onGround ? 0 : GUN_LOWER_ANGLE;
    this._loweredX += (wantLower - this._loweredX) * Math.min(1, dt / GUN_LOWER_SPEED);

    // ---- compose -----------------------------------------------------------
    // View space: x right, y up, z BACK toward the eye.
    this._offset.set(
      this._lateralBob * 0.2 - lagY,
      this._verticalBob * 0.1 + lagZ,
      -this._verticalBob * 0.4 - lagX - this._loweredX * 0.4
    );
    this.rig.position.copy(RIG_OFFSET).add(this._offset).add(this._settingOffset);

    // The punch, as an on-screen rotation about the eye.
    //
    // What the caller hands in is the CAMERA's punch — the trainer has no
    // separate bullet punch, because its recoil pattern is applied to the
    // bullet directly. In CS terms the camera takes VIEW_RECOIL_TRACKING of
    // the weapon's punch and the viewmodel takes `viewmodel_recoil` of it, so
    // the implied weapon punch is `camera / 0.45` and what actually separates
    // the gun from the crosshair is the difference between the two. Feeding
    // the camera's punch straight in would weld the gun to the crosshair,
    // which is the usual way this gets built wrong.
    const k = (VIEWMODEL_RECOIL - VIEW_RECOIL_TRACKING) / VIEW_RECOIL_TRACKING;
    // Source pitch is positive DOWN, three's rotation.x positive is up; the
    // trainer's punch pitch is already a three-camera delta.
    this.group.rotation.set(punchPitch * k, punchYaw * k, 0, 'YXZ');

    // Bob tilts the gun as well as moving it: roll with the vertical, pitch
    // against it, yaw against the lateral.
    //
    // 'YXZ' rather than three's default, and the three terms are in an order
    // that looks wrong until you follow the axes. R = Ry·Rx·Rz, so the
    // INNERMOST z turns about the model's own +z — which the bind pose says is
    // the gun's RIGHT — so that one is the pitch. The x term then turns the
    // model about its forward axis, which is the roll. Under the default
    // 'XYZ' the x term lands on the same axis the z term does and the two
    // simply add: the gun nods twice as hard and never rolls at all.
    this.rig.rotation.set(
      this._verticalBob * 0.5 * DEG,
      RIG_YAW - this._lateralBob * 0.3 * DEG,
      this._verticalBob * 0.4 * DEG - this._loweredX * 0.2 * DEG,
      'YXZ'
    );

    this.mixer.update(dt);
    // A one-shot that has run out returns to idle rather than freezing on its
    // last frame — the draw, the shot and the reload all end this way.
    const cur = this._current;
    if (cur && !this._currentLoops && cur.time >= cur.getClip().duration - 1e-3) {
      this._play('idle', { loop: true, fade: 0.12 });
    }
    this.group.visible = this.visible;
  }

  /** Draw the viewmodel over the world pass, on the same target. */
  render(renderer, worldCamera) {
    if (!this.visible || !this.arms) return;
    const aspect = worldCamera?.aspect || 1;
    if (aspect !== this._aspect) {
      this._aspect = aspect;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.clearDepth();
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }

  dispose() {
    this.mixer?.stopAllAction();
    if (this.arms) this.mixer?.uncacheRoot(this.rig);
    this.group.removeFromParent();
  }
}

export { weaponNameFor };
