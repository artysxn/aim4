// ---------------------------------------------------------------------------
// src/replays/viewer/view3d.js
// The 3D map inside the timeline viewer, in place of the radar canvas.
//
// The timeline still owns the clock: it samples a tick, hands over the same
// `states` array the radar draws from, and this positions bodies against it.
// Utility, dropped weapons, viewmodels and shooting are not reimplemented
// here — they are the map-practice systems (DemoNades, NadeEffects, ViewModel,
// DroppedWeapons, Shooting / Tracers / Decals), driven by that same playhead.
//
// It stays mounted once created. Switching back to 2D hides the canvas and
// stops the render loop; switching in again is a class toggle, not a reload,
// because streaming Nuke's pack costs seconds and the whole point of the
// button is flicking between the two views of one moment.
//
// Camera modes (F toggles the follow pair, G the free pair, wheel cycles all):
//   walk    Map Practice walking body.
//   fly     Map Practice noclip.
//   pov     recorded first person (player watch). Click a roster number to jump.
//   third   behind that same player.
// Zoom is no longer on the wheel in 3D; the wheel steps this list.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import '../../cs3d/cs3d.css';
import { MapPack, assetBase } from '../../cs3d/mapLoader.js';
import { MapLighting } from '../../cs3d/sky.js';
import { patchWebGPUPartialAttributeUpload, patchNodeMaterialTypeLookup } from '../../cs3d/threePatches.js';
import { createLook, createMapRenderer, loadPostLut, installMapGrade, setupBloom } from '../../cs3d/look.js';
import { createBootScreen } from '../../cs3d/bootScreen.js';
import { sharedPlayerModels } from '../../cs3d/playerModels.js';
import {
  ViewModelAssets,
  ViewModel,
  createViewModelPass,
  VIEWMODEL_ENV_INTENSITY,
  VIEWMODEL_SUN
} from '../../cs3d/viewModel.js';
import { DemoNades } from '../../cs3d/demoNades.js';
import { NadeEffects, HE_RADIUS, HE_DAMAGE } from '../../cs3d/nadeEffects.js';
import { DroppedWeapons } from '../../cs3d/droppedWeapons.js';
import { Interactives } from '../../cs3d/interactives.js';
import { Shooting } from '../../cs3d/shooting.js';
import { BulletAssets } from '../../cs3d/bulletPack.js';
import { Decals } from '../../cs3d/decals.js';
import { Tracers } from '../../cs3d/tracers.js';
import { SunTracker, loadShadowMask } from '../../cs3d/sunlight.js';
import { SettingsManager, VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX } from '../../core/SettingsManager.js';
import { bulletDirection } from '../../../shared/sim3d/inaccuracy.js';
import { cs3dMap } from '../../../shared/cs3d/maps.js';
import { cameraYawFromSource } from '../../../shared/sim3d/units.js';
import { sourceVFovFromHFov } from '../../utils/MathUtils.js';
import {
  HULL_STAND,
  HULL_DUCK,
  EYE_STAND,
  EYE_DUCK,
  HULL_HALF_WIDE
} from '../../../shared/sim3d/constants.js';
import { FLAG_DUCKING, FLAG_AIRBORNE, FLAG_HAS_HELMET, PLAYER_SLOTS } from '../shared/tickFormat.js';
import { Player } from '../../cs3d/player.js';
import { Controls } from '../../cs3d/controls.js';
import { placeThirdPersonCamera, THIRD_PERSON_BACK } from '../../cs3d/thirdPerson.js';
import { mountCrosshair } from '../../cs3d/crosshairOverlay.js';
import { rayAabb, botBox, hitgroupFromHeight } from '../../cs3d/practiceBots.js';
import { isGun, isGrenade, bareWeapon, hudLoadout, inventoryAt, viewModelWeaponName } from './equipmentIcons.js';
import { createXrayPass, markXrayObject, xrayIconList } from '../../cs3d/xray.js';
import { createMatchHud } from '../../cs3d/matchHud.js';
import { BloodSpray } from '../../cs3d/blood.js';
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
} from '../../cs3d/demoHits.js';
import { canSpectateSlot, DEATH_FOLLOW_SECONDS, deathFollowShouldSnap, nextCamMode, nextFollowSlot } from './view3dFollow.js';
import { keysAt } from './keypresses.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const TEAM_COLOR = { T: 0xd9a24a, CT: 0x5b87e0 };

/** Scratch for the viewmodel's ambient sample; see updateViewModel. */
const _vmCube = new Float32Array(18);
const _vmColor = new THREE.Color();
const _toSunView = new THREE.Vector3();
const _invView = new THREE.Quaternion();
const _sample = {};
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _povFeet = new THREE.Vector3();
const _camPunch = [0, 0, 0];
const _aimPunch = [0, 0, 0];

// CS2 / Source horizontal FOV (4:3). Three.js cameras take the matching
// vertical; passing 90 through raw was much wider than the game.
const FOV_DEFAULT = 90;
const FOV_MIN = 25;
const FOV_MAX = 90;
const ORBIT_MIN = 40;
const ORBIT_MAX = 500;

export function createView3d({ slug, onModeChange, sampleSlot, tickRange }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'rv-3d-canvas';

  let renderer = null;
  let scene = null;
  let camera = null;
  let pack = null;
  let lighting = null;
  let mapRenderer = null;
  let boot = null;
  let raf = 0;
  let ready = false;
  let failed = null;
  let visible = false;
  let player = null;
  let controls = null;
  let crosshair = null;
  /**
   * The Crosshair instance behind that canvas.
   *
   * It owns `canvas.style.display` — an INLINE style, which beats the UA's
   * `[hidden] { display: none }`. Toggling the `hidden` attribute alone
   * therefore did nothing, and the 3D crosshair stayed painted over the 2D
   * radar after switching back. Visibility goes through the object that owns
   * the property.
   */
  let crosshairXh = null;

  /**
   * Show or hide the crosshair overlay.
   *
   * Both mechanisms, deliberately: `setVisible` for the inline `display` the
   * Crosshair class owns (and to stop it redrawing while off screen), and the
   * `hidden` attribute so the element is out of the accessibility tree too.
   * Setting only one of them is what left it painted over the 2D radar.
   */
  function setCrosshairVisible(on) {
    if (!crosshair) return;
    crosshairXh?.setVisible(Boolean(on));
    crosshair.hidden = !on;
  }
  let lastNow = 0;
  let altHeld = false;
  let corpseRound = '';

  // Camera state. 'pov' | 'third' | 'fly' | 'walk'
  let mode = 'pov';
  let povSlot = -1; // index into the last frame's live slots
  let fov = FOV_DEFAULT;
  let eyeSmooth = EYE_STAND;
  const orbit = {
    dist: THIRD_PERSON_BACK,
    seeded: false,
    target: new THREE.Vector3()
  };

  // Last frame handed in by the viewer, and the tick before it (the animation
  // clock is demo time: the mixers advance by the tick delta between frames,
  // never by wall time, so scrubbing and speed changes stay tick-exact).
  let frame = null;
  let lastTick = null;
  /** Demo seconds to feed the viewmodel this rAF. Zero while the playhead is held. */
  let demoAnimDt = 0;
  /** Demo tick at which a death-hold switches to the killer; null when idle. */
  let deathFollowUntilTick = null;

  // The agents: CS2's own models, animated from the tick record
  // (src/cs3d/playerModels.js). Shared with the explorer; one download per
  // page. Until it lands — or without the pack — the placeholder cylinders draw.
  const models = sharedPlayerModels();

  // The hands and the gun in them (src/cs3d/viewModel.js), over the pack
  // scripts/cs3d-weapons.mjs builds. POV only: in third person, fly or walk
  // there is nobody whose hands these are.
  //
  // Everything it needs comes from the tick the viewer is showing — the held
  // weapon, the eye angles, the speed, whether the feet are on the ground — so
  // the gun sways and bobs on the demo's own motion rather than on wall time,
  // and it kicks on the ticks that player actually pulled the trigger.
  const vmAssets = new ViewModelAssets();
  const viewModel = new ViewModel(vmAssets);
  const vmSettings = new SettingsManager();
  const bulletAssets = new BulletAssets();
  const sunTracker = new SunTracker();
  let vmPass = null;
  let xray = null;
  let xrayWanted = false;
  let _xraySubjects = [];
  let matchHud = null;
  let hudOn = false;
  /** The POV player's state for the viewmodel, rebuilt by applyFrame(). */
  let povState = null;
  /** Tick the shot scan last ran to, so each shot kicks the gun exactly once. */
  let lastShotTick = null;
  let lastShotRound = '';
  let lastHurtTick = null;
  let lastHurtRound = '';
  const povFlinch = createPovFlinch();
  let blood = null;
  /** One line the first time the gun actually draws, so "no hands" is answerable. */
  let vmDrew = false;

  // Map-practice systems. Built in bootScene once the camera exists; until
  // then every call site that uses them is a no-op.
  let nadeEffects = null;
  let demoNades = null;
  let interactives = null;
  let dropped = null;
  let shooting = null;
  let worldShots = null;
  let decals = null;
  let tracers = null;
  let flashOverlay = null;
  let _flashShown = 0;
  let demoFireWeapon = '';
  let shotShooterSlot = -1;

  // ---- keypress overlay -----------------------------------------------------
  //
  // DOM over the canvas, like the flash overlay: it is text and key caps, and
  // per-frame class toggles are cheaper and crisper than drawing them into
  // the scene. Follows whoever the camera follows; free roam is nobody's
  // hands, so it hides there.
  let keysOn = false;
  let keysEl = null;
  /** key name -> element, filled when the overlay is built. */
  let keyEls = null;
  /** key name -> last demo tick it was genuinely down, for de-flicker. */
  let keyLit = {};
  let keysTick = null;
  let keysSlot = -1;
  let keysRound = '';
  const KEYS_SCRATCH = {};
  const KEY_NAMES = ['w', 'a', 's', 'd', 'ctrl', 'shift', 'space', 'm1', 'm2'];
  /** A key that drops out for under this long stays lit (seconds). */
  const KEY_STICKY = 0.09;

  function buildKeysOverlay(container) {
    keysEl = document.createElement('div');
    keysEl.className = 'c3-keys';
    keysEl.hidden = true;
    keysEl.innerHTML = `
      <div class="c3-keys-mods">
        <span class="c3-key c3-key-wide" data-key="shift">SHIFT</span>
        <span class="c3-key c3-key-wide" data-key="ctrl">CTRL</span>
      </div>
      <div class="c3-keys-move">
        <span class="c3-key" data-key="w">W</span>
        <div class="c3-keys-row">
          <span class="c3-key" data-key="a">A</span>
          <span class="c3-key" data-key="s">S</span>
          <span class="c3-key" data-key="d">D</span>
        </div>
        <span class="c3-key c3-key-space" data-key="space" aria-label="Space"></span>
      </div>
      <svg class="c3-keys-mouse" viewBox="0 0 44 64" aria-hidden="true">
        <path data-key="m1" d="M20.5 4.5 V26 H4.5 V19 A16 15 0 0 1 20.5 4.5 Z" />
        <path data-key="m2" d="M23.5 4.5 V26 H39.5 V19 A16 15 0 0 0 23.5 4.5 Z" />
        <rect class="c3-mouse-body" x="4.5" y="4.5" width="35" height="55" rx="15" />
        <line class="c3-mouse-line" x1="22" y1="4.5" x2="22" y2="26" />
        <line class="c3-mouse-line" x1="4.5" y1="26" x2="39.5" y2="26" />
      </svg>`;
    container.appendChild(keysEl);
    keyEls = {};
    for (const name of KEY_NAMES) keyEls[name] = keysEl.querySelector(`[data-key="${name}"]`);
  }

  function updateKeypresses() {
    if (!keysEl) return;
    const follow = mode === 'pov' || mode === 'third';
    const show = keysOn && visible && follow && povSlot >= 0 && !!frame;
    keysEl.hidden = !show;
    if (!show) return;

    const tick = frame.tick;
    const rate = frame.tickRate || 64;
    // A seek, a rewind, another player or another round: the sticky memory
    // describes a moment that no longer precedes this one.
    if (
      keysSlot !== povSlot ||
      keysRound !== (frame.roundKey || '') ||
      keysTick === null ||
      tick < keysTick
    ) {
      keyLit = {};
    }
    keysSlot = povSlot;
    keysRound = frame.roundKey || '';
    keysTick = tick;

    const range = tickRange?.() || null;
    const state = frame.states?.[povSlot];
    const who = (frame.players || []).find((x) => x.slot === povSlot);
    const held = bareWeapon(frame.weapons?.[state?.weapon] || '');
    const k = keysAt({
      at: tick,
      rate,
      stride: range?.stride || 1,
      firstTick: range?.first || 0,
      lastTick: range?.last ?? Infinity,
      sample: (t, out) => (sampleSlot ? sampleSlot(povSlot, t, out) : null),
      shots: frame.events?.shots || null,
      playerId: who?.id,
      weaponName: held,
      out: KEYS_SCRATCH
    });

    for (const name of KEY_NAMES) {
      let down = !!k[name];
      if (down) keyLit[name] = tick;
      // Sector-edge flicker on the inferred keys would strobe at 64 Hz;
      // a sub-tenth-of-a-second gap keeps the cap lit instead.
      else if (keyLit[name] != null && tick - keyLit[name] < KEY_STICKY * rate) down = true;
      keyEls[name].classList.toggle('is-down', down);
    }
  }
  let nadeRound = null;
  let dropSig = '';
  const dropPosCache = new Map();
  let doorOpenAt = new Map();
  let doorScanKey = '';
  let ixTick = null;
  let ixRound = null;

  const bodies = [];
  let geo = null;
  let mats = null;

  function buildActors() {
    geo = {
      body: new THREE.CylinderGeometry(HULL_HALF_WIDE, HULL_HALF_WIDE, 1, 12),
      nose: new THREE.BoxGeometry(18, 9, 9)
    };
    geo.body.translate(0, 0.5, 0); // origin at the feet; scale.y is the hull
    mats = {
      T: new THREE.MeshBasicMaterial({ color: TEAM_COLOR.T }),
      CT: new THREE.MeshBasicMaterial({ color: TEAM_COLOR.CT }),
      unknown: new THREE.MeshBasicMaterial({ color: 0x9a9a9a }),
      nose: new THREE.MeshBasicMaterial({ color: 0x18181c })
    };
    for (let i = 0; i < 10; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(geo.body, mats.unknown);
      body.scale.y = HULL_STAND;
      const nose = new THREE.Mesh(geo.nose, mats.nose);
      nose.position.set(HULL_HALF_WIDE + 6, EYE_STAND - 4, 0);
      group.add(body, nose);
      markXrayObject(group);
      group.visible = false;
      // `model` is the animated agent once the pack is in; `prev` the last
      // sample this slot was drawn at, for the velocity the blend runs on.
      bodies.push({ group, body, nose, model: null, prev: null, lastLive: null });
    }
  }

  async function bootScene(container) {
    renderer = new THREE.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    if (THREE.PCFSoftShadowMap !== undefined) renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(sourceVFovFromHFov(FOV_DEFAULT), 16 / 9, 4, 120000);
    camera.rotation.order = 'YXZ';
    camera.fov = sourceVFovFromHFov(fov);
    scene.add(camera);
    player = new Player(camera);
    controls = new Controls(canvas, player, {
      pageKeys: false,
      lockOnClick: false,
      onLock: () => syncPointerCursor()
    });
    controls.setEnabled(false);
    const _look = player.look.bind(player);
    player.look = (dx, dy, rpc) => {
      _look(dx, dy, rpc);
      if (mode === 'third') applyThirdOrbit();
    };

    nadeEffects = new NadeEffects({
      getCollider: () => pack?.collider || null,
      getMovers: () => interactives?.movers || null,
      getSide: () => 'T',
      camera
    });
    nadeEffects
      .loadFx(`${assetBase()}/fx`)
      .catch((e) => console.warn('cs3d: grenade fx pack unavailable, utility will not draw', e));
    interactives = new Interactives({
      getPack: () => pack,
      onWorldChanged: () => lighting?.markShadowDirty()
    });
    demoNades = new DemoNades({
      effects: nadeEffects,
      assets: vmAssets,
      sideOf: (playerId) => {
        const p = (frame?.players || []).find((q) => q.id === playerId);
        if (!p) return '';
        const sides = frame?.teamSides || {};
        return (p.team === 1 ? sides[1] : sides[2]) || '';
      }
    });
    dropped = new DroppedWeapons({ assets: vmAssets });
    shooting = new Shooting({
      getWeapon: () => vmAssets.stats?.(demoFireWeapon) || null,
      interactives: null,
      traces: false,
      hitTargets: (from, to) => hitTargets(from, to),
      onImpact: ({ point, normal, surface, dir }) => decals?.add({ point, normal, surface, dir })
    });
    worldShots = new Shooting({
      getWeapon: () => vmAssets.stats?.(demoFireWeapon) || null,
      interactives,
      traces: false
    });
    decals = new Decals({ assets: bulletAssets, getPack: () => pack });
    tracers = new Tracers({ assets: bulletAssets, camera });
    blood = new BloodSpray({ camera });
    bulletAssets.load();

    await renderer.init();
    patchWebGPUPartialAttributeUpload(renderer);
    const repaired = patchNodeMaterialTypeLookup(renderer, THREE);
    if (repaired) {
      console.log(`cs3d: node material lookup repaired for ${repaired} material types (minified build)`);
    }

    const mapName = cs3dMap(slug)?.name || slug;
    boot = createBootScreen(container, mapName, slug);

    pack = new MapPack({
      slug,
      scene,
      renderer,
      onProgress: (p) => boot.setProgress(p),
      onPhys: (collider) => {
        interactives?.setCollider(collider);
        player.setCollider(collider, interactives?.movers);
        dropped?.setCollider(collider, interactives?.movers);
        shooting?.setCollider(collider, interactives?.movers);
        worldShots?.setCollider(collider, interactives?.movers);
      },
      onWorldChanged: () => {
        lighting?.markShadowDirty();
        sunTracker.setWorld(pack?.world || null);
        attachWorld();
      }
    });
    // From here on this is src/cs3d/main.js boot(), step for step: the same
    // look controller with the same knobs applied at the same points, so the
    // picture is the explorer's — same sun, same probe, same grade.
    const manifest = await pack.fetchManifest();
    const post = await loadPostLut(pack, manifest);
    const knobs = installMapGrade(renderer, new URLSearchParams(), post);
    const look = createLook({ scene, getPack: () => pack, getLighting: () => lighting, slug, knobs });
    look.applyAll(); // the explorer's panel sets its defaults here, before the lighting exists
    const bloomPass = setupBloom(renderer, manifest, new URLSearchParams());
    vmPass = createViewModelPass(renderer);
    vmPass.scene.add(viewModel.group);
    applyVmSettings();
    vmSettings.onChange(applyVmSettings);
    xray = createXrayPass({ renderer, scene, parent: canvas.parentElement || container });
    xray.enabled = xrayWanted;
    mapRenderer = createMapRenderer({
      renderer,
      scene,
      getPack: () => pack,
      getLighting: () => lighting,
      bloom: bloomPass,
      overlayAfter: new URLSearchParams(location.search).get('vm') === 'after',
      // Inside the scene pass, never after it — see createMapRenderer.
      overlay: () => {
        let drew = false;
        if (xray?.enabled) {
          xray.render(camera, _xraySubjects);
          drew = true;
        }
        if (mode === 'pov' && viewModel.ready) {
          viewModel.visible = true;
          viewModel.group.visible = true;
          vmPass.render();
          drew = true;
        }
        return drew;
      }
    });
    lighting = new MapLighting(scene, camera, manifest, { shadows: true, renderer });
    vmPass.setEnvironment(scene.environment);
    sunTracker.setWorld(pack.world);
    nadeEffects.setProbeGrid(() => pack?.probeGrid || null);
    pack.lightmapIntensity = lighting.lightmapIntensity;
    pack.sun = lighting.worldSun();
    pack.skyAmbient = lighting.skyAmbient;
    nadeEffects.setLight(pack.sun ? { ...pack.sun, ambient: lighting.skyAmbient } : null);
    if (manifest.sky?.equirect) {
      lighting
        .loadSkybox(pack.base, manifest.sky, pack.v)
        .then(() => {
          pack.materials?.setSkyAmbient(lighting.skyAmbient);
          look.apply('sky');
          vmPass.setEnvironment(scene.environment);
          nadeEffects.setLight(pack.sun ? { ...pack.sun, ambient: lighting.skyAmbient } : null);
        })
        .catch(() => {});
    }
    interactives
      .load(pack.base, pack.v)
      .then((ok) => {
        if (!ok) return;
        console.log(`cs3d: ${interactives.count} interactives`);
        doorScanKey = '';
        ixTick = null;
        applyFrame();
      })
      .catch((e) => console.warn('cs3d: interactives failed', e));
    loadShadowMask(pack.base, manifest.shadowMask, pack.v)
      .then((mask) => sunTracker.setMask(mask))
      .catch((e) => console.warn('cs3d: shadow mask unavailable, viewmodel keeps full sun', e));

    buildActors();
    for (const b of bodies) (pack.world || scene).add(b.group);
    // The agents stream alongside the tiles, not ahead of them, and stand in
    // the map's own baked light (mapLoader.js ProbeGrid) like its props do.
    models.getProbeGrid = () => pack?.probeGrid || null;
    models.load();
    // `ViewModel.ready` is "has a pair of hands", and the hands are only built
    // by setSide — so without this call the viewmodel would never become ready
    // and updateViewModel would never reach the setSide that would have made it.
    vmAssets.load().then((ok) => {
      if (ok === false) return;
      viewModel.setSide('T');
      viewModel.setWeapon('knife', { draw: false });
      console.log(`cs3d: viewmodel ready (${Object.keys(vmAssets.manifest?.weapons || {}).length} weapons)`);
      applyFrame();
    });

    await pack.load(manifest);
    look.applyAll();
    attachWorld();
    if (pack.sun) nadeEffects.setLight({ ...pack.sun, ambient: lighting.skyAmbient });
    boot.finish();
    ready = true;
    resize();
  }

  function resize() {
    if (!renderer || !canvas.parentElement) return;
    const r = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    mapRenderer?.resize();
    xray?.resize();
    vmPass?.resize(w, h);
    lighting?.resize?.();
  }

  // ---- actors ---------------------------------------------------------------

  /** Slots that are alive in the current frame, in slot order. */
  function liveSlots() {
    if (!frame) return [];
    const out = [];
    for (let i = 0; i < frame.states.length; i++) {
      const s = frame.states[i];
      if (s && s.alive) out.push(i);
    }
    return out;
  }

  function sideOf(slot) {
    const p = (frame.players || []).find((x) => x.slot === slot);
    if (!p) return frame.states[slot]?.side || '';
    const sides = frame.teamSides || {};
    return (p.team === 1 ? sides[1] : sides[2]) || frame.states[slot]?.side || '';
  }

  /**
   * How many shots this slot fired in the ticks the clock just crossed.
   *
   * Playing forward that is normally 0 or 1; at 4× or after a step it can be
   * several, and each one kicks the viewmodel. A scrub backwards, a seek, or a
   * pause returns 0 — a rewind must not fire the gun, and a held frame must not
   * fire it again.
   */
  function consumeShots(tick, rate) {
    const shots = frame?.events?.shots;
    const from = lastShotTick;
    lastShotTick = tick;
    const roundKey = frame?.roundKey || '';
    if (roundKey !== lastShotRound) {
      lastShotRound = roundKey;
      return [];
    }
    if (!shots?.length || from === null || !(tick > from) || tick - from > rate) return [];
    const out = [];
    for (const sh of shots) {
      if (sh.tick > from && sh.tick <= tick) out.push(sh);
    }
    return out;
  }

  function consumeHurts(tick, rate) {
    const from = lastHurtTick;
    lastHurtTick = tick;
    const roundKey = frame?.roundKey || '';
    if (roundKey !== lastHurtRound) {
      lastHurtRound = roundKey;
      resetPovFlinch(povFlinch);
      return [];
    }
    return consumeForward(frame?.events?.damage, from, tick, rate);
  }

  function shotsForSlot(crossed, slot) {
    const who = (frame.players || []).find((x) => x.slot === slot)?.id;
    let n = 0;
    for (const sh of crossed) {
      if (sh.slot === slot || (who !== undefined && sh.player === who)) n++;
    }
    return n;
  }

  function applyVmSettings() {
    if (!vmPass) return;
    const vm = vmSettings.data.viewmodel || {};
    viewModel.applySettings(vm);
    vmPass.setFov(Math.min(VIEWMODEL_FOV_MAX, Math.max(VIEWMODEL_FOV_MIN, Number(vm.fov) || VIEWMODEL_FOV_MAX)));
  }

  function attachWorld() {
    const world = pack?.world || null;
    if (!world) return;
    dropped?.attach(world);
    nadeEffects?.attach(world);
    demoNades?.attach(world);
    interactives?.attach(world);
    shooting?.attach(world);
    worldShots?.attach(world);
    decals?.attach(world);
    tracers?.attach(world);
    blood?.attach(world);
  }

  function muzzleOf(eye, pitchDeg, yawDeg) {
    const p = (pitchDeg * Math.PI) / 180;
    const y = (yawDeg * Math.PI) / 180;
    const f = [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
    const r = [Math.sin(y), -Math.cos(y), 0];
    const FORWARD = 20;
    const RIGHT = 5;
    const DOWN = 4;
    return {
      x: eye.x + f[0] * FORWARD + r[0] * RIGHT,
      y: eye.y + f[1] * FORWARD + r[1] * RIGHT,
      z: eye.z + f[2] * FORWARD - DOWN
    };
  }

  function samplePovAt(tick) {
    if (povSlot < 0) return null;
    let s = null;
    if (sampleSlot) s = sampleSlot(povSlot, tick, _sample);
    if (!s?.alive) {
      s = frame?.states?.[povSlot];
      if (!s?.alive) return null;
    }
    const duck = s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
    const eyeH = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
    _euler.set(-(s.pitch || 0) * DEG, cameraYawFromSource(s.yaw || 0), 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _fwd.set(0, 0, -1).applyQuaternion(_quat);
    return {
      eye: { x: s.x, y: s.z + eyeH, z: -s.y },
      forward: { x: _fwd.x, y: _fwd.y, z: _fwd.z }
    };
  }

  function hitTargets(from, to) {
    if (!frame) return null;
    let best = null;
    for (let i = 0; i < frame.states.length; i++) {
      if (i === shotShooterSlot) continue;
      const s = frame.states[i];
      if (!s?.alive) continue;
      const box = botBox({ x: s.x, y: s.y, z: s.z });
      const hit = rayAabb(from, to, box.min, box.max);
      if (hit && (!best || hit.distance < best.distance)) {
        best = {
          ...hit,
          id: i,
          group: hitgroupFromHeight(hit.point.z - s.z),
          armor: s.armor || 0,
          helmet: !!(s.flags & FLAG_HAS_HELMET)
        };
      }
    }
    return best;
  }

  function fireDemoShot(sh) {
    if (!shooting) return;
    const weaponName = bareWeapon(sh.weapon) || String(sh.weapon || '').replace(/^weapon_/, '');
    const stats = vmAssets.stats?.(weaponName);
    if (!stats || stats.grenade || stats.melee) return;
    const who = (frame.players || []).find((p) => p.id === sh.player);
    shotShooterSlot = who?.slot ?? sh.slot ?? -1;
    demoFireWeapon = weaponName;
    let duck = 0;
    if (who != null) {
      const s = sampleSlot ? sampleSlot(who.slot, sh.tick, _sample) : frame.states?.[who.slot];
      if (s) duck = s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
    }
    const eyeH = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
    const eye = { x: sh.x, y: sh.y, z: (sh.z || 0) + eyeH };
    const pitch = sh.pitch || 0;
    const yaw = sh.yaw || 0;
    const result = shooting.fire(eye, bulletDirection(pitch, yaw));
    if (result?.end) tracers?.fire({ from: muzzleOf(eye, pitch, yaw), to: result.end, weapon: stats });
    shotShooterSlot = -1;
    demoFireWeapon = '';
    return result;
  }

  function fireWorldShot(sh) {
    if (!worldShots?.world) return;
    const weaponName = bareWeapon(sh.weapon) || String(sh.weapon || '').replace(/^weapon_/, '');
    const stats = vmAssets.stats?.(weaponName);
    if (!stats || stats.grenade || stats.melee) return;
    demoFireWeapon = weaponName;
    let duck = 0;
    const who = (frame.players || []).find((p) => p.id === sh.player);
    if (who != null) {
      const s = sampleSlot ? sampleSlot(who.slot, sh.tick, _sample) : frame.states?.[who.slot];
      if (s) duck = s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
    }
    const eyeH = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
    worldShots.fire({ x: sh.x, y: sh.y, z: (sh.z || 0) + eyeH }, bulletDirection(sh.pitch || 0, sh.yaw || 0));
    demoFireWeapon = '';
  }

  function playerTouchesDoor(o, s) {
    if (!s?.alive) return false;
    const pad = 40;
    const b = o.bounds;
    if (b?.min && b?.max) {
      return (
        s.x >= o.origin[0] + b.min[0] - pad &&
        s.x <= o.origin[0] + b.max[0] + pad &&
        s.y >= o.origin[1] + b.min[1] - pad &&
        s.y <= o.origin[1] + b.max[1] + pad &&
        s.z >= o.origin[2] + b.min[2] - pad &&
        s.z <= o.origin[2] + b.max[2] + pad
      );
    }
    const dx = s.x - o.origin[0];
    const dy = s.y - o.origin[1];
    const dz = s.z - o.origin[2];
    const r = 96 + pad;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  function ensureDoorScan(key) {
    if (doorScanKey === key) return;
    doorOpenAt = new Map();
    const range = tickRange?.();
    if (!range || !sampleSlot || !interactives?.list.length) {
      doorScanKey = '';
      return;
    }
    doorScanKey = key;
    const doors = interactives.list.filter((o) => o.role === 'door');
    if (!doors.length) return;
    const step = Math.max(range.stride || 1, 1);
    const scratch = {};
    for (let t = range.first; t <= range.last; t += step) {
      if (doorOpenAt.size >= doors.length) break;
      for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
        const s = sampleSlot(slot, t, scratch);
        if (!s?.alive) continue;
        for (const o of doors) {
          if (doorOpenAt.has(o.id)) continue;
          if (!playerTouchesDoor(o, s)) continue;
          doorOpenAt.set(o.id, t);
          if (o.linked) doorOpenAt.set(o.linked.id, t);
        }
      }
    }
  }

  function snapDoorsAt(tick) {
    for (const o of interactives.list) {
      if (o.role !== 'door') continue;
      const openAt = doorOpenAt.get(o.id);
      const linkedAt = o.linked ? doorOpenAt.get(o.linked.id) : null;
      const t0 = openAt ?? linkedAt;
      interactives.snapDoor(o, t0 != null && tick >= t0);
    }
  }

  function applyBreakablesFromTo(from, to) {
    const shots = frame.events?.shots || [];
    for (const sh of shots) {
      if (sh.tick > from && sh.tick <= to) fireWorldShot(sh);
    }
    const nades = frame.events?.grenades || [];
    for (const g of nades) {
      if (g.type !== 'hegrenade') continue;
      const det = g.detonateTick;
      if (det == null || !(det > from && det <= to)) continue;
      const at = g.at;
      if (at && Number.isFinite(at.x)) interactives.blast(at, HE_RADIUS, HE_DAMAGE);
    }
  }

  function applyInteractives() {
    if (!interactives?.loaded || !frame) return;
    const tick = frame.tick;
    const rate = frame.tickRate || 64;
    const key = frame.roundKey || '';
    ensureDoorScan(key);
    snapDoorsAt(tick);
    if (!worldShots?.world || !vmAssets.ready) return;
    const seek = ixTick == null || key !== ixRound || tick < ixTick || tick - ixTick > rate;
    if (seek) {
      interactives.reset();
      snapDoorsAt(tick);
      const start = (tickRange?.()?.first ?? 0) - 1;
      applyBreakablesFromTo(start, tick);
      ixTick = tick;
      ixRound = key;
      return;
    }
    applyBreakablesFromTo(ixTick, tick);
    ixTick = tick;
    ixRound = key;
  }

  function heldWeapon(raw) {
    const name = viewModelWeaponName(raw);
    if (!name || name === 'none') return 'knife';
    return vmAssets.stats?.(name) ? name : 'knife';
  }

  /**
   * The gun, once per drawn frame.
   *
   * `dt` is demo time, same as the bodies. A paused playhead must freeze the
   * clip and the bob, not settle them on wall time.
   */
  function updateViewModel(dt) {
    if (vmAssets.ready && !viewModel.ready) viewModel.setSide('T');
    if (!viewModel.ready) return;
    let pov = mode === 'pov' ? povState : null;
    if (!pov && mode === 'pov' && frame && povSlot >= 0) {
      const s = frame.states[povSlot];
      if (s?.alive) {
        pov = {
          side: s.side || sideOf(povSlot),
          weapon: frame.weapons?.[s.weapon] || '',
          speed: 0,
          airborne: (s.flags & FLAG_AIRBORNE) !== 0,
          yaw: s.yaw || 0,
          pitch: s.pitch || 0,
          eye: camera.position,
          shots: 0
        };
      }
    }
    viewModel.visible = !!pov;
    if (!pov) return;
    if (!vmDrew) {
      vmDrew = true;
      console.log(`cs3d: viewmodel drawing — ${pov.side || '?'} hands, ${pov.weapon || 'no weapon in the tick'}`);
    }
    if (pov.side === 'T' || pov.side === 'CT') viewModel.setSide(pov.side);
    viewModel.setWeapon(heldWeapon(pov.weapon), { draw: false });
    if (dt > 0) {
      for (let i = 0; i < pov.shots; i++) viewModel.attack('primary', performance.now() / 1000 + i * 1e-4);
      pov.shots = 0;
    }
    viewModel.update(dt, {
      speed: pov.speed,
      onGround: !pov.airborne,
      viewYaw: pov.yaw,
      viewPitch: pov.pitch,
      punch: scaledAimPunch(povFlinch, _aimPunch),
      viewPunch: [0, 0]
    });
    const eye = pov.eye;
    const grid = pack?.probeGrid;
    if (grid && eye) {
      const cube = grid.sample(eye.x, eye.y, eye.z, _vmCube);
      _vmColor.setRGB(
        (cube[6] + cube[0] + cube[3]) / 3,
        (cube[7] + cube[1] + cube[4]) / 3,
        (cube[8] + cube[2] + cube[5]) / 3
      );
      vmPass.setAmbient(_vmColor, 1.6);
    }
    if (lighting?.sun) {
      _povFeet.copy(eye);
      _povFeet.y = eye.y - EYE_STAND;
      const shade = sunTracker.update(dt, _povFeet);
      _toSunView.copy(lighting.toSun).applyQuaternion(_invView.copy(camera.quaternion).invert());
      vmPass.setSun(_toSunView, lighting.sunColor, VIEWMODEL_SUN * shade);
      vmPass.setViewRotation(camera.quaternion);
      vmPass.setEnvironment(vmPass.scene.environment, VIEWMODEL_ENV_INTENSITY * shade);
    }
  }

  function duckOf(s) {
    if (!s) return 0;
    return s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
  }

  function rememberLive(slot, s) {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return;
    bodies[slot].lastLive = {
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw || 0,
      pitch: s.pitch || 0,
      duckAmount: s.duckAmount || 0,
      flags: s.flags || 0,
      weapon: s.weapon,
      side: s.side
    };
  }

  function corpseOf(slot, s) {
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) return s;
    return bodies[slot].lastLive || null;
  }

  function collectXraySubjects() {
    if (!frame) return [];
    const out = [];
    for (let slot = 0; slot < bodies.length; slot++) {
      if (mode === 'pov' && slot === povSlot) continue;
      const b = bodies[slot];
      const obj = b.model?.group?.visible ? b.model.group : b.group.visible ? b.group : null;
      if (!obj) continue;
      const s = frame.states[slot];
      if (!s?.alive) continue;
      const pose = s;
      const p = (frame.players || []).find((x) => x.slot === slot);
      const id = p?.id;
      const st = (id && frame.stats?.[id]) || {};
      const weapon = frame.weapons?.[pose?.weapon ?? s?.weapon] || '';
      const inv = inventoryAt({
        loadout: st.loadout || [],
        grenades: frame.events?.grenades,
        itemEvents: frame.events?.items,
        playerId: id,
        tick: frame.tick,
        state: s || pose,
        activeWeapon: weapon
      });
      out.push({
        id: id || `slot-${slot}`,
        object: obj,
        name: p?.name || '',
        hp: Math.max(0, Math.min(100, s.health | 0)),
        side: pose?.side === 'T' || pose?.side === 'CT' ? pose.side : sideOf(slot),
        duck: duckOf(s),
        items: xrayIconList(inv)
      });
    }
    return out;
  }

  function hudMatchStub() {
    return {
      pruneKills() {},
      snapshot() {
        return {
          gen: 1,
          hp: 0,
          dead: true,
          side: 'T',
          money: 0,
          held: '',
          primary: '',
          pistol: '',
          knife: 'knife',
          nades: [],
          clip: '',
          reserve: '',
          roundKills: 0,
          kills: [],
          clock: 0,
          scoreT: 0,
          scoreCt: 0,
          name: ''
        };
      }
    };
  }

  function hudOverlay() {
    if (!frame || povSlot < 0) return null;
    const s = frame.states[povSlot];
    if (!s) return null;
    const p = (frame.players || []).find((x) => x.slot === povSlot);
    const id = p?.id;
    const st = (id && frame.stats?.[id]) || {};
    const weapon = frame.weapons?.[s.weapon] || '';
    const inv = inventoryAt({
      loadout: st.loadout || [],
      grenades: frame.events?.grenades,
      itemEvents: frame.events?.items,
      playerId: id,
      tick: frame.tick,
      state: s,
      activeWeapon: weapon
    });
    const nades = (inv.util || []).filter((x) => x !== 'defuser' && x !== 'c4');
    const slots = hudLoadout(inv);
    const tick = frame.tick || 0;
    const rate = frame.tickRate || 64;
    const killWindow = 8 * rate;
    const nameOf = (pid) => (frame.players || []).find((x) => x.id === pid)?.name || '';
    const sideOfId = (pid) => {
      const slot = (frame.players || []).find((x) => x.id === pid)?.slot;
      const stt = slot != null ? frame.states[slot] : null;
      return stt?.side === 'CT' ? 'CT' : 'T';
    };
    const kills = (frame.events?.kills || [])
      .filter((k) => k.tick <= tick && tick - k.tick < killWindow)
      .slice(-6)
      .map((k) => ({
        killer: nameOf(k.attacker),
        victim: nameOf(k.victim),
        weapon: k.weapon,
        killerSide: sideOfId(k.attacker),
        victimSide: sideOfId(k.victim),
        at: 0
      }));
    const roundKills = (frame.events?.kills || []).filter((k) => k.attacker === id && k.tick <= tick).length;
    return {
      hp: s.alive ? Math.max(0, s.health | 0) : 0,
      dead: !s.alive,
      side: s.side === 'CT' ? 'CT' : 'T',
      money: st.money || 0,
      held: slots.held || weapon,
      primary: slots.primary,
      pistol: slots.pistol,
      knife: 'knife',
      nades,
      clip: '',
      reserve: '',
      roundKills,
      kills,
      name: p?.name || '',
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw
    };
  }

  function hudMarks() {
    if (!frame) return [];
    const out = [];
    for (let i = 0; i < (frame.states || []).length; i++) {
      if (i === povSlot) continue;
      const s = frame.states[i];
      if (!s?.alive) continue;
      out.push({ x: s.x, y: s.y, z: s.z, yaw: s.yaw, side: s.side });
    }
    return out;
  }

  function updateMatchHud() {
    if (!matchHud || !hudOn) return;
    const over = hudOverlay();
    if (!over) {
      matchHud.update({ overlay: { dead: true, hp: 0, nades: [], kills: [] } });
      return;
    }
    let tAlive = 0;
    let ctAlive = 0;
    for (const s of frame.states || []) {
      if (!s?.alive) continue;
      if (s.side === 'CT') ctAlive++;
      else tAlive++;
    }
    // One square per player in slot order, lit while alive, the spectated
    // player's outlined — the count-based fallback outlined square #1 no
    // matter who was being watched.
    const ctSquares = [];
    const tSquares = [];
    for (let slot = 0; slot < (frame.states || []).length; slot++) {
      const s = frame.states[slot];
      if (!s) continue;
      const side = s.side === 'CT' || s.side === 'T' ? s.side : sideOf(slot);
      if (side !== 'CT' && side !== 'T') continue;
      (side === 'CT' ? ctSquares : tSquares).push({ on: !!s.alive, self: slot === povSlot });
    }
    while (ctSquares.length < 5) ctSquares.push({ on: false, self: false });
    while (tSquares.length < 5) tSquares.push({ on: false, self: false });
    matchHud.update({
      src: [over.x, over.y, over.z],
      yaw: over.yaw,
      marks: hudMarks(),
      clock: frame.clock,
      ctAlive,
      tAlive,
      ctSquares,
      tSquares,
      scoreCt: frame.scoreCt,
      scoreT: frame.scoreT,
      overlay: over
    });
  }

  function syncPointerCursor() {
    const hide = isFree() && !!controls?.locked && !altHeld;
    canvas.classList.toggle('is-pointer-lock', hide);
    canvas.parentElement?.classList.toggle('is-pointer-lock', hide);
  }

  function onAlt(e) {
    if (e.code !== 'AltLeft' && e.code !== 'AltRight' && e.key !== 'Alt') return;
    const down = e.type === 'keydown';
    if (down === altHeld) return;
    altHeld = down;
    if (down) controls?.exitLock();
    else if (isFree() && visible && document.hasFocus()) controls?.requestLock();
    syncPointerCursor();
  }

  function onAltBlur() {
    if (!altHeld) return;
    altHeld = false;
    syncPointerCursor();
  }

  function cancelDeathFollow() {
    deathFollowUntilTick = null;
  }

  function followAfterDeath(deadSlot, live, tick) {
    const next = nextFollowSlot(deadSlot, live, {
      players: frame.players,
      kills: frame.events?.kills,
      tick
    });
    if (next === povSlot) return;
    povSlot = next;
    onModeChange?.(mode);
  }

  function applyFrame() {
    if (!ready || !frame) return;
    const live = liveSlots();
    const follow = mode === 'pov' || mode === 'third';
    const tick = frame.tick;
    const rate = frame.tickRate || 64;
    // A POV whose player died used to snap to the next live slot on this
    // frame. Playback now holds the death eye for half a second of demo
    // time, then follows the killer (or that same next-live fallback).
    // Seeks, round jumps, and the first sample still snap, so scrubbing
    // cannot land late.
    if (follow && live.length && !live.includes(povSlot)) {
      if (deathFollowShouldSnap(lastTick, tick, rate)) {
        cancelDeathFollow();
        followAfterDeath(povSlot, live, tick);
      } else if (deathFollowUntilTick == null) {
        deathFollowUntilTick = tick + DEATH_FOLLOW_SECONDS * rate;
      } else if (tick >= deathFollowUntilTick) {
        cancelDeathFollow();
        followAfterDeath(povSlot, live, tick);
      }
    } else {
      cancelDeathFollow();
    }
    const holdingDeath = follow && deathFollowUntilTick != null && !live.includes(povSlot);
    // Demo seconds since the last drawn frame: forward only (a scrub back
    // holds the pose at its new tick), and a jump of more than a quarter
    // second is a seek, not motion.
    const dTicks = lastTick === null ? 0 : tick - lastTick;
    const animDt = dTicks > 0 && dTicks <= rate / 4 ? dTicks / rate : 0;
    lastTick = tick;
    demoAnimDt = animDt;
    const useModels = models.ready;
    povState = null;
    const crossed = consumeShots(tick, rate);
    const hitFx = new Map();
    for (const sh of crossed) {
      const result = fireDemoShot(sh);
      const dir = bulletDirection(sh.pitch || 0, sh.yaw || 0);
      for (const h of result?.hits || []) hitFx.set(h.id, { point: h.point, dir, group: h.group });
    }
    const hurts = consumeHurts(tick, rate);
    if (dTicks < 0 || dTicks > rate) resetPovFlinch(povFlinch);
    else decayPovFlinch(povFlinch, animDt);
    const kills = frame.events?.kills || [];
    for (const ev of hurts) {
      const victimSlot = (frame.players || []).find((p) => p.id === ev.victim)?.slot;
      const hit = resolveDemoHit(ev, {
        players: frame.players,
        states: frame.states,
        shots: frame.events?.shots,
        grenades: frame.events?.grenades,
        fx: victimSlot != null ? hitFx.get(victimSlot) || null : null
      });
      if (hit.slot < 0) continue;
      const punch = applyTraceHit({
        body: bodies[hit.slot]?.model,
        blood,
        damage: hit.damage,
        hitgroup: hit.group,
        armor: hit.armor,
        helmet: hit.helmet,
        blast: hit.blast,
        point: hit.point,
        dir: hit.dir,
        kill: killedOnTick(kills, ev.victim, ev.tick)
      });
      if (hit.slot === povSlot) addPovFlinch(povFlinch, punch, { replacePitch: hit.blast });
    }
    scaledCameraPunch(povFlinch, _camPunch);

    const roundKey = frame.roundKey || '';
    if (roundKey !== corpseRound) {
      corpseRound = roundKey;
      for (const body of bodies) body.lastLive = null;
    }

    for (let slot = 0; slot < bodies.length; slot++) {
      const s = frame.states[slot];
      const b = bodies[slot];
      if (!s || !s.alive) {
        if (holdingDeath && slot === povSlot && s) {
          const duck = duckOf(s);
          const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
          orbit.target.set(s.x, s.z + eye, -s.y);
          if (mode === 'pov') {
            camera.position.copy(orbit.target);
            camera.rotation.set(
              -((s.pitch || 0) + _camPunch[0]) * DEG,
              cameraYawFromSource(s.yaw || 0) + _camPunch[1] * DEG,
              _camPunch[2] * DEG,
              'YXZ'
            );
          } else {
            applyThirdOrbit();
          }
        }
        const pose = corpseOf(slot, s);
        if (!pose) {
          b.group.visible = false;
          if (b.model) b.model.group.visible = false;
          b.prev = null;
          continue;
        }
        const visibleBody = !(mode === 'pov' && slot === povSlot);
        const duck = duckOf(pose);
        const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
        const side = pose.side === 'T' || pose.side === 'CT' ? pose.side : sideOf(slot);
        if (useModels && (side === 'T' || side === 'CT')) {
          let m = b.model;
          if (!m) {
            m = b.model = models.createBody(side);
            (pack.world || scene).add(m.group);
          } else if (m.side !== side) m.setSide(side);
          b.group.visible = false;
          m.set({
            speed: 0,
            moveYaw: pose.yaw || 0,
            viewYaw: pose.yaw || 0,
            pitch: pose.pitch || 0,
            duck,
            airborne: false,
            weapon: frame.weapons?.[pose.weapon] || '',
            alive: false
          });
          m.group.position.set(pose.x, pose.z, -pose.y);
          m.update(animDt);
          m.group.visible = visibleBody;
        } else {
          if (b.model) b.model.group.visible = false;
          b.group.visible = visibleBody;
          b.group.position.set(pose.x, pose.z, -pose.y);
          b.group.rotation.y = (pose.yaw || 0) * DEG;
          const hull = HULL_STAND + (HULL_DUCK - HULL_STAND) * duck;
          b.body.scale.y = hull;
          b.nose.position.y = eye - 4;
          const mm = mats[side] || mats.unknown;
          if (b.body.material !== mm) b.body.material = mm;
        }
        b.prev = null;
        continue;
      }
      rememberLive(slot, s);
      // Hide the body you are looking through, or you see the inside of it.
      const visible = !(mode === 'pov' && slot === povSlot);
      const duck = s.duckAmount > 0 ? s.duckAmount : (s.flags & FLAG_DUCKING) !== 0 ? 1 : 0;
      const eye = EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
      const side = sideOf(slot);

      // Velocity from the tick delta since this slot was last drawn: the same
      // numbers the radar draws, so the legs run exactly as fast as the droplet
      // moves. Nothing here is a guess about the moment being shown. Computed
      // for every slot, not only the ones with an agent model, because the
      // viewmodel's bob wants it too.
      let speed = 0;
      let moveYaw = s.yaw || 0;
      const p = b.prev;
      if (p && p.tick !== tick) {
        const dt = Math.abs(tick - p.tick);
        if (dt <= 8) {
          const dxr = (s.x - p.x) / dt;
          const dyr = (s.y - p.y) / dt;
          speed = Math.hypot(dxr, dyr) * rate;
          if (speed > 1) moveYaw = Math.atan2(dyr, dxr) * RAD;
        }
      }
      b.prev = { tick, x: s.x, y: s.y };

      if (useModels && (side === 'T' || side === 'CT')) {
        let m = b.model;
        if (!m) {
          m = b.model = models.createBody(side);
          (pack.world || scene).add(m.group);
        } else if (m.side !== side) m.setSide(side);
        b.group.visible = false;
        m.set({
          speed,
          moveYaw,
          viewYaw: s.yaw || 0,
          pitch: s.pitch || 0,
          duck,
          airborne: (s.flags & FLAG_AIRBORNE) !== 0,
          weapon: frame.weapons?.[s.weapon] || '',
          alive: true
        });
        m.group.position.set(s.x, s.z, -s.y);
        m.update(animDt);
        m.group.visible = visible;
      } else {
        if (b.model) b.model.group.visible = false;
        b.group.visible = visible;
        b.group.position.set(s.x, s.z, -s.y);
        b.group.rotation.y = (s.yaw || 0) * DEG;
        const hull = HULL_STAND + (HULL_DUCK - HULL_STAND) * duck;
        b.body.scale.y = hull;
        b.nose.position.y = eye - 4;
        const mm = mats[side] || mats.unknown;
        if (b.body.material !== mm) b.body.material = mm;
      }

      if ((mode === 'pov' || mode === 'third') && slot === povSlot) {
        eyeSmooth = s.duckAmount > 0 ? eye : eyeSmooth + (eye - eyeSmooth) * 0.35;
        orbit.target.set(s.x, s.z + eyeSmooth, -s.y);
        if (mode === 'pov') {
          camera.position.copy(orbit.target);
          camera.rotation.set(
            -((s.pitch || 0) + _camPunch[0]) * DEG,
            cameraYawFromSource(s.yaw || 0) + _camPunch[1] * DEG,
            _camPunch[2] * DEG,
            'YXZ'
          );
          povState = {
            side: s.side || side,
            weapon: frame.weapons?.[s.weapon] || '',
            speed,
            airborne: (s.flags & FLAG_AIRBORNE) !== 0,
            yaw: s.yaw || 0,
            pitch: s.pitch || 0,
            eye: camera.position,
            shots: shotsForSlot(crossed, slot)
          };
        } else {
          if (!orbit.seeded) seedOrbitFromPlayer(s);
          applyThirdOrbit();
        }
      }
    }

    applyNades();
    applyDrops();
    applyInteractives();
    updateKeypresses();
  }

  function posAtEvent(playerId, tick) {
    const p = (frame.players || []).find((x) => x.id === playerId);
    if (!p) return null;
    let s = null;
    if (sampleSlot) s = sampleSlot(p.slot, tick, _sample);
    if (!s || !Number.isFinite(s.x)) s = frame.states?.[p.slot];
    if (!s || !Number.isFinite(s.x)) return null;
    return { x: s.x, y: s.y, z: s.z, yaw: s.yaw || 0 };
  }

  function desiredDrops(tick) {
    const floor = [];
    const items = frame.events?.items || [];
    const ordered = items.length
      ? items
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => e.tick <= tick)
          .sort((a, b) => a.e.tick - b.e.tick || a.i - b.i)
      : [];
    for (const { e, i } of ordered) {
      const name = bareWeapon(e.item) || e.item;
      if (!name || isGrenade(name) || name === 'c4') continue;
      if (e.op === 'remove' && (isGun(name) || name === 'taser')) {
        const key = `${e.tick}:${e.player}:${name}:${i}`;
        let pos = dropPosCache.get(key);
        if (!pos) {
          pos = posAtEvent(e.player, e.tick);
          if (pos) dropPosCache.set(key, { x: pos.x, y: pos.y, z: pos.z, yaw: pos.yaw || 0 });
        }
        if (pos) floor.push({ key, name, pos, yaw: pos.yaw || 0 });
      } else if (e.op === 'pickup') {
        let idx = -1;
        for (let j = floor.length - 1; j >= 0; j--) {
          if (floor[j].name === name) {
            idx = j;
            break;
          }
        }
        if (idx >= 0) floor.splice(idx, 1);
      }
    }
    const bomb = frame.events?.bomb || [];
    let bombDrop = null;
    for (const b of bomb) {
      if (b.tick > tick) continue;
      if (b.type === 'dropped' && Number.isFinite(b.x)) {
        bombDrop = { key: `bomb:${b.tick}`, name: 'c4', pos: { x: b.x, y: b.y, z: b.z || 0 }, yaw: 0 };
      } else if (b.type === 'pickup' || b.type === 'planted') {
        bombDrop = null;
      }
    }
    if (bombDrop) floor.push(bombDrop);
    return floor;
  }

  function applyDrops() {
    if (!dropped || !frame) return;
    const want = desiredDrops(frame.tick);
    const sig = want.map((d) => d.key).join('|');
    if (sig === dropSig) return;
    dropSig = sig;
    dropped.clear();
    for (const d of want) {
      const spawned = dropped.spawn({ name: d.name }, { pos: d.pos, vel: { x: 0, y: 0, z: 0 }, yaw: d.yaw });
      if (spawned) {
        spawned.resting = true;
        spawned.vel.x = spawned.vel.y = spawned.vel.z = 0;
      }
    }
  }

  /** The round's utility, drawn with the practice engine rather than placeholders. */
  function applyNades() {
    if (!demoNades || !frame) return;
    const list = frame.events?.grenades || [];
    const key = frame.roundKey || '';
    if (key !== nadeRound) {
      nadeRound = key;
      demoNades.setEvents(list, frame.tickRate || 64);
      dropPosCache.clear();
      dropSig = '';
      dropped?.clear();
    }
    attachWorld();
    demoNades.update(frame.tick, {
      povSlot: mode === 'pov' && povSlot >= 0 ? povSlot : null,
      povAt: samplePovAt
    });
  }

  function isFree() {
    return mode === 'fly' || mode === 'walk';
  }

  function seedOrbitFromPlayer(s) {
    player.yaw = cameraYawFromSource(s.yaw || 0);
    player.pitch = -(s.pitch || 0) * DEG;
    const cap = (89 * Math.PI) / 180;
    player.pitch = Math.max(-cap, Math.min(cap, player.pitch));
    orbit.dist = THIRD_PERSON_BACK;
    orbit.seeded = true;
  }

  function applyThirdOrbit() {
    if (!camera || !player) return;
    camera.position.copy(orbit.target);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    placeThirdPersonCamera(camera, player.world, orbit.dist);
  }

  function setCamMode(next) {
    if (next === mode) return;
    if (next === 'fly' || next === 'walk') cancelDeathFollow();
    mode = next;
    if (next === 'third') orbit.seeded = false;
    if (!player || !controls) {
      onModeChange?.(mode);
      return;
    }
    if (isFree()) {
      player.yaw = camera.rotation.y;
      player.pitch = camera.rotation.x;
      player.setMode(next === 'walk' ? 'walk' : 'fly');
      controls.setEnabled(true);
    } else {
      controls.setEnabled(false);
    }
    syncPointerCursor();
    applyFrame();
    onModeChange?.(mode);
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const t = now || performance.now();
    const dt = lastNow ? Math.min(0.1, (t - lastNow) / 1000) : 0;
    lastNow = t;
    if (!ready || !visible) return;
    if (isFree() && player) player.update(dt);
    else if (mode === 'third') applyThirdOrbit();
    const vmDt = demoAnimDt;
    demoAnimDt = 0;
    updateViewModel(vmDt);
    nadeEffects?.update(dt, t / 1000, camera);
    interactives?.update(dt);
    shooting?.update(dt);
    dropped?.update(dt, null, () => false);
    decals?.update(dt);
    tracers?.update(dt);
    blood?.update(dt, camera);
    const flashNow = Math.max(nadeEffects?.flash || 0, demoNades?.flash || 0);
    if (flashNow !== _flashShown && flashOverlay) {
      _flashShown = flashNow;
      flashOverlay.style.opacity = _flashShown > 0.002 ? String(_flashShown) : '0';
    }
    pack?.materials?.setTime(t / 1000);
    lighting?.update();
    _xraySubjects = xray?.enabled ? collectXraySubjects() : [];
    xray?.updateLabels(camera, _xraySubjects);
    updateMatchHud();
    if (mapRenderer) mapRenderer.render(camera);
    else renderer.render(scene, camera);
  }

  return {
    canvas,
    get ready() {
      return ready;
    },
    get failed() {
      return failed;
    },
    get mode() {
      return mode;
    },
    get isFree() {
      return isFree();
    },
    get isThird() {
      return mode === 'third';
    },
    get povSlot() {
      return povSlot;
    },
    get xray() {
      return !!(xray?.enabled ?? xrayWanted);
    },
    toggleXray() {
      xrayWanted = !xrayWanted;
      if (xray) xray.enabled = xrayWanted;
      if (!xrayWanted) xray?.updateLabels(camera, []);
      return xrayWanted;
    },
    setImmerse(on) {
      hudOn = !!on;
      if (matchHud) matchHud.el.hidden = !hudOn || !visible;
    },

    /** The keypress overlay over the followed player. */
    setKeypresses(on) {
      keysOn = !!on;
      updateKeypresses();
    },
    get keypresses() {
      return keysOn;
    },
    get povName() {
      if (povSlot < 0 || !frame) return null;
      const p = (frame.players || []).find((x) => x.slot === povSlot);
      return p?.name || null;
    },
    cancelDeathFollow,

    /** Create the scene. Safe to call once; later calls are no-ops. */
    async start(container) {
      if (renderer || failed) return;
      container.appendChild(canvas);
      flashOverlay = document.createElement('div');
      flashOverlay.className = 'c3-flash';
      container.appendChild(flashOverlay);
      const mapInfo = cs3dMap(slug);
      matchHud = createMatchHud({
        root: container,
        map: { code: mapInfo?.code || slug, name: mapInfo?.name || slug, slug },
        match: hudMatchStub()
      });
      matchHud.el.hidden = !hudOn;
      buildKeysOverlay(container);
      const mounted = mountCrosshair(container, { scaleToResolution: false });
      crosshair = mounted.canvas;
      crosshairXh = mounted.crosshair;
      // Mounted while the viewer may still be in 2D: start from the real state
      // rather than assuming visible.
      setCrosshairVisible(visible);
      window.addEventListener('keydown', onAlt);
      window.addEventListener('keyup', onAlt);
      window.addEventListener('blur', onAltBlur);
      try {
        await bootScene(container);
        applyFrame();
        loop();
      } catch (err) {
        failed = String(err?.message || err);
        console.error('view3d: boot failed', err);
        boot?.finish();
      }
    },

    /** The viewer's clock, once per drawn frame. */
    setFrame(next) {
      frame = next;
      if (povSlot < 0) {
        const live = liveSlots();
        if (live.length) {
          povSlot = live[0];
          // The first frame just picked who is being watched; the host's
          // spectate label reads povName off this callback.
          onModeChange?.(mode);
        }
      }
      applyFrame();
    },

    show() {
      visible = true;
      canvas.hidden = false;
      if (flashOverlay) flashOverlay.hidden = false;
      setCrosshairVisible(true);
      if (matchHud) matchHud.el.hidden = !hudOn;
      if (isFree()) controls.setEnabled(true);
      syncPointerCursor();
      resize();
    },
    hide() {
      visible = false;
      canvas.hidden = true;
      if (flashOverlay) flashOverlay.hidden = true;
      setCrosshairVisible(false);
      if (matchHud) matchHud.el.hidden = true;
      xray?.updateLabels(camera, []);
      controls?.setEnabled(false);
      syncPointerCursor();
    },
    resize,

    /**
     * Cycle the selected player. `dir` +1 is left click (next), -1 is right
     * click (previous). Does not change fly/walk vs follow.
     */
    cyclePov(dir = 1) {
      cancelDeathFollow();
      const live = liveSlots();
      if (!live.length) return null;
      if (!live.includes(povSlot)) povSlot = live[0];
      else {
        const i = live.indexOf(povSlot);
        povSlot = live[(i + dir + live.length) % live.length];
      }
      applyFrame();
      onModeChange?.(mode);
      return this.povName;
    },

    /** Jump to this demo slot. From walk/fly, switches to player watch. */
    spectateSlot(slot) {
      const n = Number(slot);
      if (!Number.isFinite(n) || n < 0) return null;
      if (!canSpectateSlot(frame?.states, n | 0)) return null;
      cancelDeathFollow();
      povSlot = n | 0;
      if (isFree()) setCamMode('pov');
      else applyFrame();
      onModeChange?.(mode);
      return this.povName;
    },

    /** Wheel: walk → fly → pov → third, or the other way. */
    cycleCam(dir = 1) {
      setCamMode(nextCamMode(mode, dir));
      return mode;
    },

    /** F: from free roam, first person. From follow, pov ↔ third. */
    toggleFollow() {
      if (isFree()) setCamMode('pov');
      else setCamMode(mode === 'pov' ? 'third' : 'pov');
      return mode;
    },

    /** G: from follow, fly. From free roam, fly ↔ walk. */
    toggleFree() {
      if (!isFree()) setCamMode('fly');
      else setCamMode(mode === 'fly' ? 'walk' : 'fly');
      return mode;
    },

    /**
     * Unlocked fly/walk: click grabs the mouse. Else: cycle the followed player.
     * @returns {boolean}
     */
    pointerDown(button) {
      if (isFree() && !altHeld && controls && !controls.locked) {
        controls.requestLock();
        return true;
      }
      if (button === 0) this.cyclePov(1);
      else if (button === 2) this.cyclePov(-1);
      else return false;
      return true;
    },

    setMode(next) {
      if (next === 'free' || next === 'fly') setCamMode('fly');
      else if (next === 'walk') setCamMode('walk');
      else if (next === 'third') setCamMode('third');
      else setCamMode('pov');
    },

    /** Wheel: FOV in follow/free. In third person it dollies the camera. */
    zoomBy(factor) {
      if (!camera) return;
      if (mode === 'third') {
        orbit.dist = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, orbit.dist / factor));
        applyThirdOrbit();
        return;
      }
      fov = Math.max(FOV_MIN, Math.min(FOV_MAX, fov / factor));
      camera.fov = sourceVFovFromHFov(fov);
      camera.updateProjectionMatrix();
    },

    dispose() {
      cancelDeathFollow();
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onAlt);
      window.removeEventListener('keyup', onAlt);
      window.removeEventListener('blur', onAltBlur);
      controls?.dispose();
      crosshair?.remove();
      crosshairXh = null;
      flashOverlay?.remove();
      for (const b of bodies) b.model?.dispose();
      xray?.dispose();
      matchHud?.el?.remove();
      keysEl?.remove();
      keysEl = null;
      canvas.parentElement?.classList.remove('is-match');
      viewModel.dispose();
      demoNades?.dispose();
      nadeEffects?.dispose();
      dropped?.dispose();
      interactives?.dispose();
      shooting?.dispose();
      worldShots?.dispose();
      decals?.dispose();
      tracers?.dispose();
      pack?.dispose?.();
      renderer?.dispose?.();
      boot?.remove();
      canvas.remove();
      renderer = null;
      ready = false;
    }
  };
}
