// ---------------------------------------------------------------------------
// src/cs3d/main.js
// The map explorer at aim4.io/<map>: stream the pack, light it with the map's
// own sun, and hand the operator a fly camera (default) or a walking body
// (F). Everything heavier than that (demo playback, weapons, bots) is
// CS3D-PLAN territory and lands in engine3d, not here.
// ---------------------------------------------------------------------------

import './cs3d.css';
import * as THREE from 'three/webgpu';
import { cs3dMapForPath, cs3dMap, CS3D_MAPS } from '../../shared/cs3d/maps.js';
import { cameraYawFromSource, sceneToSource, sourceToScene, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { EYE_STAND } from '../../shared/sim3d/constants.js';
import { MapPack, assetBase } from './mapLoader.js';
import { MapLighting } from './sky.js';
import { installGrade } from './grade.js';
import { createLook, createMapRenderer, loadPostLut, LIGHT_KEYS, LOOK_DEFAULTS, MAP_LOOK, setupBloom } from './look.js';
import { patchWebGPUPartialAttributeUpload, patchNodeMaterialTypeLookup } from './threePatches.js';
import { Player } from './player.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { createPracticeMatch } from './practiceMatch.js';
import { createMatchHud } from './matchHud.js';
import { practiceRadarFrame } from './practiceRadarFrame.js';
import { FpsView } from './fpsView.js';
import { DemoView } from './demoView.js';
import { DemoNades } from './demoNades.js';
import { sharedPlayerModels, liveBodies } from './playerModels.js';
import { LiveBody } from './liveBody.js';
import { createBuyMenu } from './buyMenu.js';
import { createPauseMenu } from './pauseMenu.js';
import { placeThirdPersonCamera } from './thirdPerson.js';
import { mountCrosshair } from './crosshairOverlay.js';
import { ViewModelAssets, ViewModel, createViewModelPass, VIEWMODEL_ENV_INTENSITY, VIEWMODEL_SUN } from './viewModel.js';
import { createViewModelTuner } from './vmTuner.js';
import { SunTracker, loadShadowMask } from './sunlight.js';
import { Projectiles } from './projectiles.js';
import { DroppedWeapons, dropRelease } from './droppedWeapons.js';
import { NadeEffects, HE_RADIUS, HE_DAMAGE } from './nadeEffects.js';
import { ThrowControl } from './throwing.js';
import { perfectJumpThrowState } from '../../shared/sim3d/grenade.js';
import { Interactives } from './interactives.js';
import { Shooting } from './shooting.js';
import { BulletAssets } from './bulletPack.js';
import { Decals } from './decals.js';
import { Tracers } from './tracers.js';
import {
  createRecoilState,
  fireRecoil,
  updateRecoil,
  updateRecoilIndex,
  aimPunch,
  cameraPunch,
  resetRecoil,
  applyHitFlinch
} from '../../shared/sim3d/recoil.js';
import {
  createAccuracyState,
  updateAccuracy,
  addFireInaccuracy,
  getInaccuracy,
  getSpread,
  getSpreadSeed,
  sampleCone,
  bulletDirection,
  resetAccuracy
} from '../../shared/sim3d/inaccuracy.js';
import { SettingsManager, VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX } from '../core/SettingsManager.js';
import { practiceBackbuffer } from './practiceDisplay.js';
import { createPerfFlags, displayHzHint } from './perfToggles.js';
import { cycleSpawnIndex, formatSpawnChat } from './practiceSpawn.js';
import { sourceVFovFromHFov } from '../utils/MathUtils.js';
import { loadDemoBytes, loadDemoFile, demoFromLoadedRound } from './demoData.js';
import { PracticeBots } from './practiceBots.js';
import { BloodSpray } from './blood.js';
import { flinchPunch, bloodMagnitude, ragdollImpulse } from '../../shared/sim3d/flinch.js';
import { bindImportRound, gameLabel } from './practiceImport.js';
import { nextCamMode, cycleLive, spectateTargetId, parseSpectateTarget } from './practiceCam.js';
import { fetchDemos, fetchDemoPackage, fetchDemo, fetchRoundMeta, fetchRoundTicks } from '../replays/api.js';
import { createXrayPass, xrayIconList } from './xray.js';

const params = new URLSearchParams(location.search);
const map = cs3dMapForPath(location.pathname) || cs3dMap(params.get('map')) || null;
const canvas = document.getElementById('c3-canvas');
const uiRoot = document.getElementById('c3-ui');

if (!map) {
  uiRoot.innerHTML = `<div class="c3-err" style="pointer-events:auto">Unknown map. Try ${CS3D_MAPS.map((m) => `<a href="/${m.bareRoute === false ? 'de_' : ''}${m.slug}">${m.slug}</a>`).join(', ')}.</div>`;
  throw new Error('cs3d: no map in URL');
}
document.title = `${map.name} - AIM4.io`;

const importUis = [];
let camMode = 'T';
let spectateKey = null;
/** Spectate follows the selected player's eyes until you leave spectate. */
let spectateEyes = true;
let skipNadeHurt = false;

// ---- renderer / scene ------------------------------------------------------
// WebGPU, with three's built-in WebGL2 fallback when the browser has no
// adapter (`forceWebGL` also forces it for A/B testing via ?webgl=1). The
// whole island imports from 'three/webgpu'. GLTF addons are pointed at that
// same build in vite.config.js so loaders and mixers share one Mesh/Vector3.
const forceWebGL = params.get('webgl') === '1';
const msaaBoot = params.get('msaa') !== '0' && localStorage.getItem('cs3d_msaa') !== '0';
const renderer = new THREE.WebGPURenderer({
  canvas,
  antialias: msaaBoot,
  powerPreference: 'high-performance',
  forceWebGL
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Khronos PBR Neutral, not ACES: ACES crushes saturation in the highlights,
// which turned CS2's blue skies and warm stone into pale grey. src/cs3d/grade.js
// then wraps Neutral in the contrast and saturation the game's post-processing
// applies, once the renderer's node library exists (after init()).
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
const shadows = params.get('shadows') !== '0' && localStorage.getItem('cs3d_shadows') !== '0';
renderer.shadowMap.enabled = shadows;
// The WebGPU build does not export the WebGL filter constants; its backend
// picks its own soft filtering, so only set this when the constant exists.
if (THREE.PCFSoftShadowMap !== undefined) renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
// Units, not metres: near 4u; far 120k u covers the largest map, its 3D
// skybox drawn ×16, and the sky dome. (near 1 → 4 buys back most of the
// depth precision that far range costs.)
// 90 is CS2 / Source horizontal FOV (4:3). Three.js wants the vertical that
// produces, same as the trainer's hFov slider. Passing 90 through raw made
// the world much wider than the game.
const camera = new THREE.PerspectiveCamera(
  sourceVFovFromHFov(90),
  window.innerWidth / window.innerHeight,
  4,
  120000
);
camera.rotation.order = 'YXZ';
scene.add(camera);

const player = new Player(camera);

// ---- recoil ------------------------------------------------------------------
// The spray pattern, the aim punch and the cone, all out of shared/sim3d — the
// same generator CS2 runs, seeded from the same per-weapon numbers the pack
// carries. Nothing about where a bullet goes is decided in this file; it only
// asks, and hands the answers to the camera and the tracer.
const recoilState = createRecoilState();
const accuracyState = createAccuracyState();
/**
 * The shot counter that seeds the cone.
 *
 * CS2 derives it from the command number so the client and the server draw the
 * same bullet; there is no server here, so it is just a count. Only its low
 * byte is used either way (shared/sim3d/inaccuracy.js).
 */
let shotSeed = 0;
/** Degrees, [pitch, yaw, roll]: what the bullets take, and what the camera takes. */
const _aim = [0, 0, 0];
const _cam = [0, 0, 0];

// What a bullet leaves behind: the game's own impact decals and its tracer
// streak, one pack for both (scripts/cs3d-decals.mjs).
const bulletAssets = new BulletAssets();
bulletAssets.load();
const decals = new Decals({ assets: bulletAssets, getPack: () => pack });
const tracers = new Tracers({ assets: bulletAssets, camera });

let lighting = null;
let mapRenderer = null;
let bloomPass = { render: (d) => d(), resize() {}, enabled: false, setActive() {} };
let pauseMenu = null;
let perf = null;
let xray = null;
let _xraySubjects = [];
/** Arrow Down: no HUD, crosshair, chat, or viewmodel. */
let cleanView = false;
const passStamp = { sky: 0, world: 0, bloom: 0, vm: 0, shadowDirty: 0 };
// ---- UI --------------------------------------------------------------------
const controls = new Controls(canvas, player, {
  onLock: (locked) => {
    if (
      !locked &&
      !buyMenu.open &&
      !matchHud?.chatOpen &&
      !vmTuner?.open &&
      !pauseMenu?.open
    ) {
      pauseMenu?.openMenu();
    }
    hud.setLocked(locked);
    if (locked) {
      pauseMenu?.close();
      matchHud?.closeChat();
    }
    // Losing the mouse mid-hold must not leave a pin pulled: the button-up
    // that would have thrown it never arrives.
    if (!locked) throwControl.cancel();
  },
  onToggleMode: () => {
    player.setMode(player.mode === 'fly' ? 'walk' : 'fly');
    hud.setMode(player.mode, thirdPerson);
  },
  onSpawn: () => spawnAt(null, { cycle: true }),
  // Digits: demo POV when a demo is loaded, otherwise weapon slots 1-4.
  onDigit: (n) => {
    if (camMode === 'spectate' && demoView.active) {
      const slot = (n + 9) % 10;
      if (demoView.liveSlots().includes(slot)) {
        spectateKey = spectateTargetId('demo', slot);
        spectateEyes = true;
        followSpectateTarget();
      }
      return;
    }
    if (n >= 1 && n <= 4) equipSlot(n);
  },
  // Mouse. Holding a gun: fire while held for an automatic weapon, once per
  // click otherwise. Holding a grenade: the buttons mean something else
  // entirely — press pulls the pin, the combination sets the strength, and the
  // throw is on the way UP (src/cs3d/throwing.js).
  onAttack: (button, down) => {
    attackHeld[button] = down;
    if (camMode === 'spectate') {
      if (down && controls.locked) cycleSpectate(button === 'secondary' ? -1 : 1);
      return;
    }
    if (controls.locked && player.mode === 'walk' && !thirdPerson && throwControl.active) {
      throwControl.button(button, down);
      return;
    }
    if (down) tryAttack(button);
  },
  onPlayPause: () => demoView.togglePlay(),
  onStep: (d) => demoView.step(d),
  onRound: (d) => demoView.shiftRound(d),
  onSpeed: () => setCamMode(nextCamMode(camMode)),
  onPlaceBot: () => placePracticeBot(false),
  onBoostBot: () => placePracticeBot(true),
  onDeleteBot: () => deleteAimedBot(),
  onRoundKey: (act) => {
    if (!demoView?.active) return false;
    onPlayback(act);
    return true;
  },
  onSkipNades: () => skipThrownNades(),
  onXray: () => xray?.toggle(),
  // Tap Q: next weapon in the explorer's pocket. Hold Q: full radar overview.
  onWeaponHold: (down) => handleWeaponHold(down),
  // B: the buy menu. It needs the mouse, so opening it gives the pointer back
  // and closing it takes the lock again.
  onBuy: () => buyMenu.toggle(),
  // R: magazine swap. Empty mag also starts this after the last round.
  onReload: () => tryReload(),
  // E: the game's `+use`. Opens and shuts the doors the map actually has.
  // A dropped gun under the look ray is the same key, after a miss on doors.
  onUse: () => {
    camera.getWorldDirection(_useDir);
    const eye = player.mode === 'walk' ? player.eye(_useEye) : _useEye.copy(camera.position);
    const srcEye = { x: eye.x, y: -eye.z, z: eye.y };
    const srcDir = { x: _useDir.x, y: -_useDir.z, z: _useDir.y };
    const used = interactives.use(srcEye, srcDir);
    if (used) {
      hud.setThrow(null);
      return;
    }
    const drop = dropped.tryUse(srcEye, srcDir);
    if (drop) takeDropped(drop, { replace: true });
  },
  onDropWeapon: () => dropHeldWeapon(),
  // it needs the cursor, so it drops the pointer lock while it is up.
  onCancel: () => {
    if (matchHud?.chatOpen) {
      matchHud.closeChat();
      return;
    }
    if (buyMenu.open) {
      buyMenu.close();
      return;
    }
    if (vmTuner.open) {
      vmTuner.close();
      return;
    }
    pauseMenu?.handleEsc();
  },
  onChat: () => {
    buyMenu.close();
    vmTuner.close();
    matchHud?.openChat();
  },
  onToggleHud: () => {
    cleanView = !cleanView;
    uiRoot.classList.toggle('is-clean-view', cleanView);
  }
});
let thirdPerson = false;
const match = createPracticeMatch({ side: 'T' });
let _chatRelock = false;
let _respawnAt = 0;
let _deathDropped = false;
const hud = new Hud(uiRoot, {
  map,
  sens: controls.sens,
  onSensitivity: (v) => controls.setSensitivity(v),
  onImportMount: mountImport
});
xray = createXrayPass({ renderer, scene, parent: uiRoot });
const buyMenu = createBuyMenu({
  root: uiRoot,
  getSide: () => lastSide,
  // The header switch is the only way to change sides once you are walking:
  // 1 / 2 are weapon slots then, not spawns. It changes the hands and the agent
  // model with the list, because being a CT is what it means.
  onSide: (s) => {
    setCamMode(s);
    match.givePracticeKit();
    if (match.held) equipWeapon(match.held, { draw: false });
  },
  getHeld: () => player.weapon,
  // Only a loaded pack can say a weapon is missing from it. Before it lands
  // (or without one at all) nothing is marked, because nothing is known.
  has: (name) => !vmAssets.ready || !!vmAssets.stats(name),
  onPick: (name) => {
    const r = match.buy(name);
    if (!r.ok) {
      matchHud.echo((r.reason || 'cannot buy').replace(/_/g, ' '));
      return false;
    }
    equipWeapon(r.name);
    return true;
  },
  onToggle: (open) => {
    if (open) matchHud.closeChat();
    hud.setPanelOpen(open || matchHud.chatOpen || pauseMenu?.open);
    if (open) controls.exitLock();
    else if (!matchHud.chatOpen && !pauseMenu?.open) controls.requestLock();
  }
});
const matchHud = createMatchHud({
  root: uiRoot,
  map,
  match,
  hooks: {
    onChatToggle: (open) => {
      hud.setPanelOpen(open || buyMenu.open || pauseMenu?.open);
      if (open) {
        _chatRelock = controls.locked;
        controls.exitLock();
      } else if (_chatRelock && !pauseMenu?.open) {
        _chatRelock = false;
        controls.requestLock();
      }
    },
    onEquip: (name) => equipWeapon(name),
    onReload: () => playReloadAnim(),
    onSide: (side) => {
      spawnCursor = -1;
      setCamMode(side);
    },
    onCamMode: (mode) => setCamMode(mode),
    onPlayback: (act) => onPlayback(act),
    onNoclip: () => {
      player.setMode(player.mode === 'fly' ? 'walk' : 'fly');
      hud.setMode(player.mode, thirdPerson);
    },
    onWalk: () => {
      player.setMode('walk');
      hud.setMode(player.mode, thirdPerson);
    },
    onSetpos: (x, y, z) => {
      const [sx, sy, sz] = sourceToScene(x, y, z);
      player.teleport(new THREE.Vector3(sx, sy, sz), player.yaw, player.pitch);
    },
    onGetpos: () => {
      const p = player.mode === 'walk' ? player.feet : camera.position;
      const s = sceneToSource(p.x, player.mode === 'walk' ? p.y : p.y - 64, p.z);
      const yaw = sourceYawFromCamera(player.yaw);
      const pitch = -player.pitch * (180 / Math.PI);
      return `setpos ${s[0].toFixed(2)} ${s[1].toFixed(2)} ${s[2].toFixed(2)}; setang ${pitch.toFixed(2)} ${yaw.toFixed(2)} 0`;
    },
    onSetang: (pitch, yaw) => {
      player.yaw = cameraYawFromSource(yaw);
      player.pitch = -pitch * (Math.PI / 180);
      player.syncCamera();
    },
    onRespawn: () => {
      _respawnAt = 0;
      _deathDropped = false;
      match.respawn();
      spawnAt();
    },
    onDied: () => onLocalDeath(),
    onRestart: () => {
      _respawnAt = 0;
      _deathDropped = false;
      lastSide = match.side;
      if (match.held) equipWeapon(match.held, { draw: false });
      spawnAt(match.side);
    },
    onShowPos: (on) => uiRoot.classList.toggle('is-showpos', !!on),
    onDebugSun: () => hud.toggleGrade(),
    onDebugViewmodel: () => vmTuner.toggle(),
    onDebugInspect: () => {
      inspectOn = !inspectOn;
      if (!inspectOn) hud.setInspect(null);
      inspectAt = 0;
    },
    onDebugTooltips: () => hud.toggleHelp(),
    onCommand: (cmd, args) => perf?.command(cmd, args) ?? null
  }
});
hud.setLocked(false);
hud.setMode(player.mode);
hud.setWeapon(player.weapon, player.maxSpeed);

// The flat view. Reads `pack` and `lighting` through getters because both
// are filled in by boot(), long after the key is bound. Esc menu toggles it.
const fpsView = new FpsView({
  scene,
  renderer,
  getPack: () => pack,
  getLighting: () => lighting,
  onChange: (on) => {
    hud.setFpsView(on);
    pauseMenu?.syncTools?.();
    if (!on) applyPerf();
  }
});

// ---- demo playback ---------------------------------------------------------
// Drop an .aim4replay (the compact package the local parser and the library
// both use) onto the page to watch it on this map: the game's agent models
// when the players pack is present (placeholder bodies otherwise), every
// grenade, and 1-0 for any player's POV. Rejected when the package is for a
// different map — the geometry under the ticks would be nonsense.
//
// The players pack (scripts/cs3d-models.mjs) is fetched once the map's own
// manifest is in, so it never competes with the first tiles; a body created
// before it lands is a placeholder until the next frame after it does.
const playerModels = sharedPlayerModels();
const blood = new BloodSpray({ camera });
const practiceBots = new PracticeBots({
  playerModels,
  getRoot: () => pack?.world || null,
  onDied: (bot) => dropBotGear(bot),
  onHit: ({ point, dir, damage, group, armor, helmet, blast }) => {
    if (blast && (Number(armor) || 0) > 0) return;
    if (!point) return;
    blood.spawn({
      point,
      dir,
      magnitude: bloodMagnitude({ damage, armor, hitgroup: group, helmet }),
      damage
    });
  }
});

// ---- viewmodel -------------------------------------------------------------
// The hands and the weapon in them (src/cs3d/viewModel.js), over the pack
// scripts/cs3d-weapons.mjs builds: the agents' own first-person arms on the
// game's viewmodel rig, its draw / idle / shoot / swing clips, and the weapon
// models. Shown in first-person walk mode and in a demo POV; hidden while
// flying or in third person, where there is nothing to hold it.
const vmAssets = new ViewModelAssets();
const viewModel = new ViewModel(vmAssets);
const vmPass = createViewModelPass(renderer);
vmPass.scene.add(viewModel.group);
// Whether the player is standing in the sun. Drives the viewmodel's key light
// and how much sky it reflects; see sunlight.js.
const sunTracker = new SunTracker();
// Hand, FOV and the hand offsets are account settings, shared with the trainer
// and synced to the profile — the same store the sensitivity above comes from.
const vmSettings = new SettingsManager();
const applyVmSettings = () => {
  const vm = vmSettings.data.viewmodel || {};
  viewModel.applySettings(vm);
  vmPass.setFov(Math.min(VIEWMODEL_FOV_MAX, Math.max(VIEWMODEL_FOV_MIN, Number(vm.fov) || VIEWMODEL_FOV_MAX)));
};
/**
 * Trainer backbuffer: native window, or the stored size (4:3 / custom)
 * stretched to the viewport the way Engine.applyResolution does.
 */
function applyPracticeDisplay() {
  const s = vmSettings.activeSettings();
  const displayW = window.innerWidth;
  const displayH = window.innerHeight;
  const { width: w, height: h, pixelRatio } = practiceBackbuffer(
    s,
    displayW,
    displayH,
    window.devicePixelRatio || 1
  );
  renderer.setPixelRatio(perf?.flags.dpr ?? pixelRatio);
  renderer.setSize(w, h, false);
  canvas.style.width = `${displayW}px`;
  canvas.style.height = `${displayH}px`;
  camera.aspect = w / Math.max(1, h);
  camera.fov = sourceVFovFromHFov(s.hFov ?? 90);
  camera.updateProjectionMatrix();
  mapRenderer?.resize();
  xray?.resize();
  vmPass.resize(w, h);
  lighting?.resize();
}

/**
 * Push the Y-console `r_*` flags into the live renderer.
 *
 * The flat view owns materials, tone mapping and shadows while it is on, so
 * those three stay out of this path until it is toggled off.
 */
function applyPerf() {
  if (!perf) return;
  const f = perf.flags;
  if (!f.profile) hud.setProfile(null);
  try {
    localStorage.setItem('cs3d_msaa', f.msaa ? '1' : '0');
  } catch {
    /* private mode */
  }
  applyPracticeDisplay();
  if (fpsView.enabled) return;
  bloomPass.setActive?.(f.bloom);
  lighting?.setShadowUpdates?.(f.shadows);
  if (f.shadows) lighting?.markShadowDirty();
  pack?.setShadowKeep?.(f.shadows);
  pack?.materials?.setSimple(f.simple);
}
const bootBuf = practiceBackbuffer(
  vmSettings.activeSettings(),
  window.innerWidth,
  window.innerHeight,
  window.devicePixelRatio || 1
);
perf = createPerfFlags(
  {
    msaa: msaaBoot,
    dpr: bootBuf.pixelRatio,
    bloom: params.get('bloom') !== '0',
    shadows,
    shadowBodies: true,
    simple: false,
    skyPass: true,
    profile: params.get('r_profile') === '1' || params.get('profile') === '1'
  },
  () => applyPerf()
);
applyVmSettings();
applyPracticeDisplay();
vmSettings.onChange(() => {
  applyVmSettings();
  applyPracticeDisplay();
});
const xhair = mountCrosshair(uiRoot, { settings: vmSettings, scaleToResolution: true });
// U opens the same settings as live sliders (src/cs3d/vmTuner.js).
const vmTuner = createViewModelTuner({ viewModel, vmPass, settings: vmSettings, apply: applyVmSettings });
pauseMenu = createPauseMenu({
  root: uiRoot,
  settings: vmSettings,
  crosshair: xhair.crosshair,
  getFlatView: () => fpsView.enabled,
  getThirdPerson: () => thirdPerson,
  onFlatView: () => fpsView.toggle(),
  onThirdPerson: () => {
    thirdPerson = !thirdPerson;
    hud.setMode(player.mode, thirdPerson);
  },
  onToggle: (open) => {
    if (open) {
      buyMenu.close();
      vmTuner.close();
      matchHud.closeChat();
      controls.exitLock();
    }
    hud.setPanelOpen(open || buyMenu.open || matchHud.chatOpen);
  },
  onResume: () => controls.requestLock(),
  onImportMount: mountImport,
  onLookSync: () => {
    controls.settings.data.sensitivity = vmSettings.data.sensitivity;
    controls.settings.data.rawInput = vmSettings.data.rawInput;
    const input = uiRoot.querySelector('.c3-sens input');
    if (input) input.value = vmSettings.data.sensitivity;
  }
});

/**
 * 1 / 2 / 3, the game's slots, and 4 for utility. The draw animation and its
 * lockout come free.
 *
 * 4 cycles the six grenades rather than opening a sub-slot: the explorer has
 * no inventory to hold one of each, and cycling is the fastest way to get from
 * a smoke lineup to the molotov that follows it.
 */
const attackHeld = { primary: false, secondary: false };
let held = match.held;

// ---- utility ----------------------------------------------------------------
// The throw state machine (pin, charge, release), the projectiles it puts in
// the world, and what they leave behind. See src/cs3d/throwing.js for what the
// mouse buttons mean and why.
const nadeEffects = new NadeEffects({
  getCollider: () => pack?.collider || null,
  getMovers: () => interactives.movers,
  // A CS2 smoke takes the thrower's side: sandy for T, pale blue for CT.
  getSide: () => lastSide,
  // The fire and blast sprites are camera-facing and alpha-blended, so their
  // batches have to know where the camera is to sort back to front; the smoke
  // volume uses it to flip its cull face when someone walks into a cloud.
  camera
});
// The game's own smoke and fire sheets (scripts/cs3d-fx.mjs). Shared by every
// map, so it is fetched once here rather than per pack. Effects thrown before
// it lands still simulate; they start drawing the frame it arrives.
nadeEffects
  .loadFx(`${assetBase()}/fx`)
  .catch((e) => console.warn('cs3d: grenade fx pack unavailable, utility will not draw', e));
// The map's doors, vents and glass (src/cs3d/interactives.js). Optional: a pack
// without interactives.json simply has none.
const interactives = new Interactives({
  getPack: () => pack,
  onWorldChanged: () => lighting?.markShadowDirty()
});
// Bullets: the trace, what it penetrates and what that leaves of it
// (shared/sim3d/penetration.js over the map's own surface table).
let _shotClearAt = 0;
const shooting = new Shooting({
  getWeapon: () => vmAssets.stats?.(held) || null,
  interactives,
  // The wallbang inspector — entry-to-exit lines through the geometry — is a
  // diagnostic, not part of the picture, and it does not belong on screen
  // beside a real tracer. `?traces=1` puts it back.
  traces: params.get('traces') === '1',
  hitTargets: (from, to) => practiceBots.hitTargets(from, to),
  // Every surface the round touched, in order, so the wall gets a hole and the
  // streak knows where it ended.
  onImpact: ({ point, normal, surface, dir }) => decals.add({ point, normal, surface, dir }),
  onShot: (shot) => {
    hud.setShot(shot);
    _shotClearAt = performance.now() + 2500;
    for (const h of shot.hits || []) {
      practiceBots.takeHit({
        id: h.id,
        damage: h.damage,
        group: h.group,
        point: h.point,
        dir: shot.dir,
        armor: h.armor || 0,
        helmet: !!h.helmet
      });
    }
  }
});

const projectiles = new Projectiles({
  assets: vmAssets,
  // A grenade that hits a window, a vent or a pane of glass smashes it and
  // carries on through at a fraction of its speed instead of bouncing off.
  onBounce: ({ pos, vel }) => interactives.grenadeHit(pos, vel)?.vel || null,
  onDetonate: ({ type, pos, normal, vel }) => {
    nadeEffects.spawn({ type, pos, normal, vel, side: lastSide });
    // An HE breaks the vents and glass in its radius and shoves the doors —
    // the same detonation, two behaviours, because a door has no prop_data to
    // damage. A molotov deliberately does neither (shared/sim3d/interactives.js).
    if (type === 'hegrenade' && !skipNadeHurt) {
      const stats = vmAssets.stats?.('hegrenade');
      const radius = stats?.range || HE_RADIUS;
      const maxDmg = stats?.damage || HE_DAMAGE;
      interactives.blast(pos, radius, maxDmg);
      practiceBots.blast(pos, radius, maxDmg);
      const eye = player.mode === 'walk' ? player.eye(_heEye) : _heEye.copy(camera.position);
      const src = sceneToSource(eye.x, eye.y, eye.z);
      const dist = Math.hypot(pos.x - src[0], pos.y - src[1], pos.z - src[2]);
      if (dist < radius && !match.god && !match.dead) {
        const dmg = maxDmg * (1 - dist / radius);
        const punch = flinchPunch({ blast: true, damage: dmg, armor: 0 });
        applyHitFlinch(recoilState, punch, { replacePitch: true });
        liveBody.applyFlinch(punch);
        const dir = { x: src[0] - pos.x, y: src[1] - pos.y, z: src[2] - pos.z };
        blood.spawn({
          point: { x: src[0], y: src[1], z: src[2] },
          dir,
          magnitude: bloodMagnitude({ damage: dmg }),
          damage: dmg
        });
        if (match.hurt(dmg) <= 0) {
          const impulse = ragdollImpulse(dir, dmg);
          const [fx, fy, fz] = sourceToScene(impulse.x, impulse.y, impulse.z);
          const [hx, hy, hz] = sourceToScene(src[0], src[1], src[2]);
          liveBody.startRagdoll({ force: { x: fx, y: fy, z: fz }, hitPos: { x: hx, y: hy, z: hz } });
          onLocalDeath();
        }
      }
    }
    // A flashbang you can see blinds you. The eye and the look direction are
    // the camera's, so this is honest in third person and in fly mode too.
    if (type === 'flashbang') {
      camera.getWorldDirection(_flashDir);
      nadeEffects.applyFlash(pos, camera.position, _flashDir, performance.now() / 1000);
    }
  }
});
const dropped = new DroppedWeapons({ assets: vmAssets });
const _flashDir = new THREE.Vector3();
const _useDir = new THREE.Vector3();
const _useEye = new THREE.Vector3();
const throwControl = new ThrowControl({
  jumpState: () => ({
    secondsSinceJump: player.jumpAge,
    jumpHeldOnGround: player.onGround && player.input.jump
  }),
  onThrow: ({ type, strength, perfectJumpThrow }) => {
    const eye = player.eye(_throwEye);
    const live = { x: player.vel.x, y: -player.vel.z, z: player.vel.y };
    const perfect = !!(perfectJumpThrow && player.jumpAge < Infinity);
    const latch = perfect ? perfectJumpThrowState({ eye: player.jumpEye, vel: player.jumpVel }) : null;
    projectiles.spawn({
      type,
      // Perfect jumpthrow: fly from the jump+throw-together spawn (6 ticks
      // into the jump), not the ground eye and not wherever a late-in-window
      // release has risen to.
      eye: latch ? latch.eye : { x: eye.x, y: -eye.z, z: eye.y },
      yaw: sourceYawFromCamera(player.yaw),
      pitch: -player.pitch * (180 / Math.PI),
      velocity: latch ? latch.velocity : live,
      strength
    });
    // It has left the hand. The next one is drawn a moment later.
    viewModel.showWeapon(false);
    match.consumeNade(type);
  },
  onAnim: (action) => {
    if (!viewModel.ready) return;
    if (action === 'draw') {
      if (match.held && match.held !== held) equipWeapon(match.held);
      else viewModel.redraw();
    } else viewModel.playThrow(action);
  }
});
const _throwEye = new THREE.Vector3();
const _heEye = new THREE.Vector3();

const Q_HOLD_MS = 160;
let qHoldTimer = 0;
let qOverview = false;

function qUiBusy() {
  return Boolean(matchHud?.chatOpen || buyMenu?.open || pauseMenu?.open || vmTuner?.open);
}

function clearQHold() {
  if (qHoldTimer) {
    clearTimeout(qHoldTimer);
    qHoldTimer = 0;
  }
}

function setQOverview(on) {
  qOverview = Boolean(on);
  matchHud?.setOverview(qOverview);
}

function handleWeaponHold(down, opts = {}) {
  if (down) {
    if (qUiBusy()) return;
    clearQHold();
    qHoldTimer = window.setTimeout(() => {
      qHoldTimer = 0;
      setQOverview(true);
    }, Q_HOLD_MS);
    return;
  }
  const tapped = Boolean(qHoldTimer);
  clearQHold();
  if (qOverview) {
    setQOverview(false);
    return;
  }
  if (opts.cancel || !tapped) return;
  const next = match.cycleHeld();
  if (next) equipWeapon(next);
}

/**
 * Hands, HUD, and the walking speed cap all follow the same name. Buy, the
 * loadout keys, and picking a gun up off the floor all come through here.
 *
 * The speed cap applies whether or not the weapons pack is in: it is the
 * movement sim's business, not the viewmodel's, and without the pack the
 * explorer is still a place to walk an AWP's 200 u/s around a map.
 */
function equipWeapon(name, { draw = true } = {}) {
  if (!name) return;
  held = name;
  match.hold(name);
  // Deploying a weapon clears the spray and the accuracy penalty, exactly as
  // the game's `Deploy()` does — swapping to a knife and back is a legitimate
  // way to reset a spray, and always has been. The PUNCH is not cleared: it
  // lives on the player, not the weapon, and has to decay on its own.
  recoilState.index = 0;
  recoilState.shotsFired = 0;
  resetAccuracy(accuracyState);
  if (vmAssets.ready) viewModel.setWeapon(name, { draw });
  // The body's speed cap follows what it is holding, as it does in the game.
  player.setWeapon(name);
  // A grenade puts the mouse under the throw state machine instead of the
  // trigger; anything else stands it down (and drops a pulled pin).
  throwControl.setWeapon(name);
  hud.setWeapon(player.weapon, player.maxSpeed);
  buyMenu.refresh();
}

function equipSlot(n) {
  const name = match.slot(n);
  if (name) equipWeapon(name);
}

function practiceCanDrop() {
  return (
    controls.locked &&
    player.mode === 'walk' &&
    !match.dead &&
    camMode !== 'spectate' &&
    demoView.povSlot === null
  );
}

function dropOrigin() {
  const eye = player.eye(_throwEye);
  const src = { x: eye.x, y: -eye.z, z: eye.y };
  const feetZ = player.mode === 'walk' && player.sim ? player.sim.pos.z : src.z - 64;
  const yaw = sourceYawFromCamera(player.yaw);
  const pitch = -player.pitch * (180 / Math.PI);
  const velocity = player.mode === 'walk' ? { x: player.vel.x, y: -player.vel.z, z: player.vel.y } : null;
  const toss = dropRelease({ eye: src, yaw, pitch, velocity });
  toss.pos.z = Math.max(toss.pos.z, feetZ + 12);
  toss.eye = src;
  toss.pitch = pitch;
  toss.velocity = velocity;
  toss.feetZ = feetZ;
  return toss;
}

function dropHeldWeapon() {
  if (!practiceCanDrop()) return;
  const r = match.dropHeld();
  if (!r.ok) return;
  dropped.spawn(r.item, dropOrigin());
  if (r.next) equipWeapon(r.next);
}

function takeDropped(d, { replace }) {
  const r = match.takePickup(d.item.name, d.item.ammo, { replace });
  if (!r.ok) return false;
  dropped.remove(d.id);
  if (r.displaced) {
    dropped.spawn(r.displaced, { pos: { ...d.pos }, vel: { x: 0, y: 0, z: 90 }, yaw: d.yaw });
  }
  if (r.name) equipWeapon(r.name);
  return true;
}

function onLocalDeath() {
  if (_deathDropped) return;
  _deathDropped = true;
  const { items } = match.dropDeath();
  if (items.length) dropped.spawnMany(items, dropOrigin());
  if (match.held) equipWeapon(match.held, { draw: false });
  _respawnAt = performance.now() + 2000;
}

function dropBotGear(bot) {
  if (!bot?.weapon) return;
  dropped.spawn(
    { name: bot.weapon, slot: 'primary', ammo: null },
    dropRelease({
      eye: { x: bot.origin.x, y: bot.origin.y, z: bot.origin.z + 48 },
      yaw: bot.yaw || 0,
      pitch: 8
    })
  );
}

/**
 * Pull the trigger once. The viewmodel owns the timing (deploy lockout, then
 * the weapon's own cycle time out of weapons.vdata), so this only has to ask.
 *
 * Where the bullet goes is three things added together, in this order:
 *
 *   the AIM        the player's own angles, WITHOUT the punch the camera is
 *                  showing. The camera follows 45% of the recoil and the
 *                  bullets follow all of it, so reading the direction off the
 *                  camera would silently throw the other 55% away and hand
 *                  the player a spray that does not need controlling.
 *   the PUNCH      the deterministic pattern, in full (shared/sim3d/recoil.js)
 *   the CONE       the random draw the stance and the last few shots earned
 *                  (shared/sim3d/inaccuracy.js)
 *
 * The kick is applied AFTER the bullet leaves, which is what makes the first
 * round of every spray land exactly on the crosshair.
 */
function tryAttack(button) {
  if (!controls.locked || player.mode !== 'walk' || thirdPerson || match.dead) return;
  if (button === 'primary' && !match.canFire(held)) return;
  const now = performance.now() / 1000;
  const fired = viewModel.attack(button, now);
  // The viewmodel owns the timing, so a shot only leaves the barrel when it
  // says one did — a click during the deploy lockout traces nothing.
  if (fired === false || button !== 'primary') return;
  match.consumeAmmo(held);
  const weapon = vmAssets.stats?.(held) || null;
  const eye = player.eye(_shotEye);
  const src = { x: eye.x, y: -eye.z, z: eye.y };

  // Source view angles, plus the whole aim punch.
  aimPunch(recoilState, _aim);
  const pitch = -player.pitch * (180 / Math.PI) + _aim[0];
  const yaw = sourceYawFromCamera(player.yaw) + _aim[1];

  const bullets = Math.max(1, weapon?.bullets || 1);
  const cone = weapon
    ? sampleCone({
        seed: shotSeed++,
        inaccuracy: getInaccuracy(accuracyState, weapon, playerAccuracyState()),
        spread: getSpread(weapon),
        // The shotguns carry a fixed pellet seed; everything else is 0 and the
        // pellets ride the shot's own stream (shared/sim3d/inaccuracy.js).
        spreadSeed: getSpreadSeed(weapon),
        bullets
      })
    : [{ x: 0, y: 0 }];

  let last = null;
  for (const c of cone) {
    last = shooting.fire(src, bulletDirection(pitch, yaw, c.x, c.y)) || last;
  }

  if (weapon) {
    // The order the game uses: the bullet has already gone, so this shot's
    // penalty and this shot's kick both belong to the NEXT one.
    addFireInaccuracy(accuracyState, weapon);
    fireRecoil(recoilState, weapon, { now });
    // The streak, from about where the muzzle is to wherever the round
    // stopped. Every third bullet on a rifle, every one on a pistol — the
    // weapon's own `m_nTracerFrequency` (src/cs3d/tracers.js).
    if (last?.end) {
      tracers.fire({ from: muzzleOf(src, pitch, yaw), to: last.end, weapon });
    }
  }
  if (!match.canFire(held)) tryReload();
}

function playReloadAnim() {
  if (!vmAssets.ready) return;
  viewModel.reload({ empty: match.ammoOf(held).clip === 0 });
}

function tryReload() {
  if (!controls.locked || player.mode !== 'walk' || thirdPerson || match.dead) return;
  if (throwControl.active) return;
  if (!match.beginReload(held)) return;
  playReloadAnim();
}
const _shotEye = new THREE.Vector3();

/**
 * Roughly where the barrel is, in the SOURCE frame.
 *
 * The real muzzle is a bone on a model that lives in VIEW space at its own
 * FOV, so its world position is not a thing this scene has. A tracer that
 * starts at the eye reads as coming out of the player's face; this offsets
 * down and to the right by about the distance the gun sits from the eye, which
 * is what sells it — and at 20500 units a second nobody is measuring.
 */
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

/** The player, as the accuracy model needs to see them. */
function playerAccuracyState() {
  return {
    speed: Math.hypot(player.vel.x, player.vel.z),
    velocityZ: player.vel.y,
    onGround: player.onGround,
    ducking: player.crouched,
    onLadder: !!player.onLadder,
    walking: !!player.input.walk,
    reloading: match.reloading,
    recoilIndex: recoilState.index
  };
}

/**
 * The round's utility, drawn with the practice engine rather than with
 * placeholders. It borrows `nadeEffects` outright — same smoke volume, same
 * flame sheets, same RadiusFlash — and only supplies the clock, which for a
 * demo is the playhead. See src/cs3d/demoNades.js.
 */
const demoNades = new DemoNades({
  effects: nadeEffects,
  // The grenade models the flights fly, from the weapons pack.
  assets: vmAssets,
  // A smoke takes its thrower's side, and a side is per ROUND (teams swap at
  // half), so it is resolved against the round being watched.
  sideOf: (playerId) => {
    const meta = demoView?.meta;
    const p = meta?.players?.find((q) => q.id === playerId);
    if (!p) return '';
    return (p.team === 1 ? meta.team1Side : meta.team2Side) || '';
  }
});

const demoView = new DemoView({
  camera,
  getPack: () => pack,
  playerModels,
  nades: demoNades,
  blood,
  onChange: (dv) => {
    hud.setRoster(dv.active ? dv.roster() : null);
    hud.setDemoStatus(dv.status());
    if (!dv.active) hud.setDemoStatus(null);
    // Leaving a POV: hand the fly camera the view so there is no snap.
    if (dv.povSlot === null && player.mode === 'fly') {
      player.yaw = camera.rotation.y;
      player.pitch = camera.rotation.x;
      player.flyVel.set(0, 0, 0);
    }
    syncPlaybackUi();
    if (camMode === 'spectate') syncSpectateHud();
  }
});

function acceptDemo(demo) {
  if (demo.mapCode !== map.code) {
    const wanted = CS3D_MAPS.find((m) => m.code === demo.mapCode);
    hud.showError(
      `${demo.name} is a ${wanted ? wanted.name : demo.mapCode} demo` +
        (wanted ? ` — open /${wanted.slug} and drop it there.` : ', which has no 3D map yet.')
    );
    setTimeout(() => hud.hideError(), 6000);
    return;
  }
  demoView.setDemo(demo);
  console.log(`cs3d: demo loaded — ${demo.name}, ${demo.rounds.length} rounds`);
}

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    acceptDemo(await loadDemoFile(file));
  } catch (err) {
    console.error(err);
    hud.showError(`Could not read ${file.name}: ${err.message}`);
    setTimeout(() => hud.hideError(), 6000);
  }
});

// ?demo=<id|url> opens a demo without a drop.
//
// A bare id is a library demo, fetched as a package from the replays API —
// that is the link the 2D viewer's "watch in 3D" button hands over. Anything
// containing a slash is treated as a URL, which is what makes dev deep-links
// work against a file on disk (Vite serves /@fs/).
if (params.get('demo')) {
  const ref = params.get('demo');
  const isId = /^[A-Za-z0-9_-]+$/.test(ref);
  // Absolute: the API is a different host in production, and a bare path here
  // resolved against the site, where the SPA catch-all rewrite answers 200
  // with train.html — so the 2D viewer's "watch in 3D" link handed the demo
  // loader a page of HTML instead of a package on aim4.io.
  const src = isId ? null : ref;
  const load = isId
    ? fetchDemoPackage(ref).then((buf) => acceptDemo(loadDemoBytes(buf, ref)))
    : fetch(src).then(async (res) => {
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error || `HTTP ${res.status}`);
        }
        acceptDemo(loadDemoBytes(await res.arrayBuffer(), ref.split('/').pop()));
      });
  load.catch((err) => {
    console.error('cs3d: ?demo= failed', err);
    hud.showError(`Could not open that demo: ${err.message}`);
  });
}

// ---- pack ------------------------------------------------------------------
let pack = null;
let lastSide = 'T';
let spawnCursor = -1;

function combinedMovers() {
  return {
    emit: (minX, minY, minZ, maxX, maxY, maxZ, visit) => {
      interactives.movers.emit(minX, minY, minZ, maxX, maxY, maxZ, visit);
      practiceBots.emitWalk(minX, minY, minZ, maxX, maxY, maxZ, visit);
    },
    rayHit: (from, to) => interactives.movers.rayHit(from, to)
  };
}

function aimSegment() {
  const eye = player.mode === 'walk' ? player.eye(_useEye) : _useEye.copy(camera.position);
  camera.getWorldDirection(_useDir);
  const from = { x: eye.x, y: -eye.z, z: eye.y };
  const dir = { x: _useDir.x, y: -_useDir.z, z: _useDir.y };
  const to = { x: from.x + dir.x * 8192, y: from.y + dir.y * 8192, z: from.z + dir.z * 8192 };
  return { from, to };
}

function placePracticeBot(boost) {
  const placed = practiceBots.place(player, lastSide, { boost });
  if (boost && placed.feet) {
    if (player.mode !== 'walk') {
      player.setMode('walk');
      hud.setMode(player.mode, thirdPerson);
    }
    player.teleport(placed.feet, placed.yaw, placed.pitch);
  }
}

function deleteAimedBot() {
  const { from, to } = aimSegment();
  practiceBots.deleteAimed(from, to);
}

function skipThrownNades() {
  skipNadeHurt = true;
  projectiles.fastForward();
  skipNadeHurt = false;
  projectiles.clear();
  nadeEffects.clear();
  throwControl.cancel();
}

function spectateIds() {
  const ids = demoView.liveSlots().map((s) => spectateTargetId('demo', s));
  for (const b of practiceBots.alive()) ids.push(spectateTargetId('bot', b.id));
  return ids;
}

function cycleSpectate(dir) {
  spectateEyes = true;
  spectateKey = cycleLive(spectateIds(), spectateKey, dir);
  followSpectateTarget();
  syncSpectateHud();
}

function spectateOverlay() {
  const t = parseSpectateTarget(spectateKey);
  if (!t) return null;
  if (t.kind === 'demo') return demoView.hudOverlay(t.id);
  return practiceBots.overlay(t.id);
}

function followSpectateTarget() {
  if (camMode !== 'spectate' || !spectateEyes) {
    demoView.followSlot(null);
    return;
  }
  const t = parseSpectateTarget(spectateKey);
  if (t?.kind === 'demo') demoView.followSlot(t.id);
  else demoView.followSlot(null);
}

function applySpectateEyes() {
  const t = camMode === 'spectate' && spectateEyes ? parseSpectateTarget(spectateKey) : null;
  for (const b of practiceBots.list) {
    if (b.body?.group) b.body.group.visible = !!b.alive && !(t?.kind === 'bot' && t.id === b.id);
  }
  if (t?.kind !== 'bot') return;
  const b = practiceBots.list.find((x) => x.id === t.id);
  if (!b) return;
  const [x, y, z] = sourceToScene(b.origin.x, b.origin.y, b.origin.z + EYE_STAND);
  camera.position.set(x, y, z);
  camera.rotation.set(-b.pitch * (Math.PI / 180), cameraYawFromSource(b.yaw), 0, 'YXZ');
}

function syncSpectateHud() {
  const ids = spectateIds();
  if (camMode === 'spectate' && ids.length && !ids.includes(spectateKey)) {
    spectateKey = ids[0];
    followSpectateTarget();
  }
  const over = camMode === 'spectate' ? spectateOverlay() : null;
  matchHud.setCamMode(camMode);
  matchHud.setSpectateName(over?.name || (camMode === 'spectate' ? 'Bot' : ''));
}

function setCamMode(mode) {
  if (mode !== 'T' && mode !== 'CT' && mode !== 'spectate') return;
  const prev = camMode;
  camMode = mode;
  if (mode === 'spectate') {
    player.setMode('fly');
    hud.setMode('fly', thirdPerson);
    const ids = spectateIds();
    if (!ids.includes(spectateKey)) spectateKey = ids[0] || null;
    spectateEyes = true;
    followSpectateTarget();
  } else if (prev === 'spectate' || lastSide !== mode) {
    demoView.followSlot(null);
    spawnCursor = -1;
    spawnAt(mode);
  } else {
    lastSide = mode;
    match.setSide(mode);
  }
  matchHud.setCamMode(mode);
  syncSpectateHud();
}

function syncPlaybackUi() {
  const on = demoView.active;
  const playing = !!demoView.playing;
  matchHud.setPlayback(on, playing);
  for (const ui of importUis) ui.setPlayback(on, playing);
}

function onPlayback(act) {
  if (act === 'pause') demoView.togglePlay();
  else if (act === 'restart') demoView.restart();
  else if (act === 'exit') {
    demoView.clear();
    if (camMode === 'spectate') setCamMode(lastSide);
  }
  syncPlaybackUi();
}

async function loadLibraryDemo(id) {
  return loadDemoBytes(await fetchDemoPackage(id), id);
}

async function loadPracticeRound(record, roundIndex) {
  let rec = record;
  let row = rec?.rounds?.[roundIndex];
  if (!row?.file && rec?.id) {
    rec = await fetchDemo(rec.id);
    row = rec?.rounds?.[roundIndex];
  }
  if (!row?.file) throw new Error('This game has no 3D replay data.');
  let meta;
  let ticks;
  try {
    [meta, ticks] = await Promise.all([
      fetchRoundMeta(row.file),
      fetchRoundTicks(row.file, 1)
    ]);
  } catch (err) {
    throw new Error(err?.message || 'This game has no 3D replay data.');
  }
  if (!meta || !ticks) throw new Error('This game has no 3D replay data.');
  try {
    return demoFromLoadedRound({
      name: gameLabel(rec),
      manifest: rec,
      mapCode: String(meta.map || rec.map || '').toUpperCase(),
      stem: row.file,
      meta,
      ticks
    });
  } catch {
    throw new Error('This game has no 3D replay data.');
  }
}

function importRound(demo) {
  acceptDemo(demo);
  setCamMode('spectate');
  pauseMenu?.close();
  controls.requestLock();
  syncPlaybackUi();
}

function mountImport(el) {
  if (!el) return;
  const ui = bindImportRound(el, {
    mapCode: map.code,
    fetchDemos,
    loadRound: loadPracticeRound,
    onImport: importRound
  });
  ui.onAction(onPlayback);
  importUis.push(ui);
}

function switchTeam() {
  spawnCursor = -1;
  spawnAt(lastSide === 'CT' ? 'T' : 'CT');
}

function spawnAt(side, { cycle = false } = {}) {
  if (!pack?.manifest) return;
  if (match.dead) match.respawn();
  _respawnAt = 0;
  _deathDropped = false;
  // A fresh body: no punch left over from the last one, and no holes in the
  // walls from the last practice run.
  resetRecoil(recoilState);
  resetAccuracy(accuracyState);
  decals.clear();
  tracers.clear();
  if (side) {
    lastSide = side;
    match.setSide(side);
  }
  match.givePracticeKit();
  buyMenu.refresh();
  if (match.held) equipWeapon(match.held, { draw: false });
  const list = pack.spawns(lastSide);
  if (!list.length) return;
  spawnCursor = cycle
    ? cycleSpawnIndex(spawnCursor, list.length)
    : Math.floor(Math.random() * list.length);
  const s = list[spawnCursor];
  const feet = new THREE.Vector3(s.pos[0], s.pos[1] + 0.5, s.pos[2]);
  const yaw = cameraYawFromSource(s.yaw || 0);
  if (player.mode !== 'walk') {
    player.setMode('walk');
    hud.setMode(player.mode, thirdPerson);
  }
  player.teleport(feet, yaw, 0);
  if (cycle) matchHud.echo(formatSpawnChat(lastSide, spawnCursor, list.length));
}

async function boot() {
  pack = new MapPack({
    slug: map.slug,
    scene,
    renderer,
    onProgress: (p) => hud.setProgress(p),
    onPhys: (collider) => {
      // The doors first: binding them masks their static leaf hulls out of the
      // BVH, and every tracer built after this has to see that already done.
      interactives.setCollider(collider);
      player.setCollider(collider, combinedMovers());
      // Not the same collision set: a grenade passes through `playerclip` and
      // is stopped by `grenadeclip`, so it gets its own tracer over the same
      // BVH (src/cs3d/hullWorld.js).
      projectiles.setCollider(collider, interactives.movers);
      dropped.setCollider(collider, interactives.movers);
      // ...and a bullet a third set again: through the clips, stopped by the
      // drawn world, free through `passbullets` brushes (src/cs3d/rayWorld.js).
      shooting.setCollider(collider, interactives.movers);
    },
    onWorldChanged: () => {
      lighting?.markShadowDirty();
      // Tiles arrived: the floor under the player may be new geometry, and
      // anything the sun tracker cached about it is stale.
      sunTracker.setWorld(pack?.world || null);
      projectiles.attach(pack?.world || null);
      dropped.attach(pack?.world || null);
      nadeEffects.attach(pack?.world || null);
      demoNades.attach(pack?.world || null);
      interactives.attach(pack?.world || null);
      shooting.attach(pack?.world || null);
      decals.attach(pack?.world || null);
      tracers.attach(pack?.world || null);
      blood.attach(pack?.world || null);
    }
  });
  try {
    // WebGPU needs its device before anything touches the renderer.
    await renderer.init();
    // r169 cannot upload part of an attribute on WebGPU, which is exactly what
    // streaming tiles into a BatchedMesh does. See threePatches.js.
    patchWebGPUPartialAttributeUpload(renderer);
    // ...and three's node-material lookup, which is keyed by constructor name
    // and queried by `material.type`. Those agree in dev and cannot agree in a
    // minified build, so on the deployed site every plain material fell back to
    // an empty NodeMaterial and drew as an untextured box. See threePatches.js.
    const repaired = patchNodeMaterialTypeLookup(renderer, THREE);
    if (repaired) console.log(`cs3d: node material lookup repaired for ${repaired} material types (minified build)`);
    hud.setBackend(renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl');
    // Manifest first: the sun, exposure and spawns come from it, and the
    // lighting has to exist before the first tile arrives.
    const manifest = await pack.fetchManifest();
    // The map's colour grade, before any material compiles. The LUT is part of
    // the tone mapping function every material calls, so it cannot arrive
    // later: a material built without it would keep the ungraded curve.
    const post = await loadPostLut(pack, manifest);
    const knobs = installGrade(renderer, params, post);
    look.setKnobs(knobs);
    if (knobs) setupGradePanel(knobs, manifest.map?.slug);
    // After the grade: the composite bakes that curve in, then takes tone
    // mapping off the scene render.
    const bloom = setupBloom(renderer, manifest, params);
    bloomPass = bloom;
    if (bloomPass.enabled) console.log('cs3d: bloom from the map post-processing volume');
    bloomPass.setActive?.(perf.flags.bloom);
    mapRenderer = createMapRenderer({
      renderer,
      scene,
      getPack: () => pack,
      getLighting: () => lighting,
      bloom: () => bloomPass,
      overlayAfter: params.get('vm') === 'after',
      getTwoPass: () => perf.flags.skyPass,
      stamp: passStamp,
      // Silhouettes first, then the gun, both inside the scene pass.
      overlay: () => {
        let drew = false;
        if (!cleanView && xray?.enabled) {
          xray.render(camera, _xraySubjects);
          drew = true;
        }
        if (viewModel.visible && viewModel.ready) {
          vmPass.render();
          drew = true;
        }
        return drew;
      }
    });
    lighting = new MapLighting(scene, camera, manifest, { shadows: perf.flags.shadows, renderer });
    // The gun reflects the same sky the map stands under. Without it every
    // metallic surface in the viewmodel pass is black (see setEnvironment).
    vmPass.setEnvironment(scene.environment);
    // ...and stands in the same sun. The tracker reads the map's own baked
    // answer for the floor underfoot, so it needs the mask and the drawn world.
    sunTracker.setWorld(pack.world);
    // Grenades and what they leave behind ride on the world root, so the two
    // pass render and the flat view treat them exactly like map geometry.
    projectiles.attach(pack.world);
    dropped.attach(pack.world);
    nadeEffects.attach(pack.world);
    demoNades.attach(pack.world);
    interactives.attach(pack.world);
    shooting.attach(pack.world);
    // Bullet holes ride on the world root like everything else, so the two
    // pass render and the flat view treat them as map geometry.
    decals.attach(pack.world);
    tracers.attach(pack.world);
    blood.attach(pack.world);
    // The map's doors and breakables, alongside the tiles. Optional: a pack
    // without interactives.json simply has none, and nothing waits on it.
    interactives
      .load(pack.base, pack.v)
      .then((ok) => ok && console.log(`cs3d: ${interactives.count} interactives`))
      .catch((e) => console.warn('cs3d: interactives failed', e));
    loadShadowMask(pack.base, manifest.shadowMask, pack.v)
      .then((mask) => sunTracker.setMask(mask))
      .catch((e) => console.warn('cs3d: shadow mask unavailable, viewmodel keeps full sun', e));
    pack.lightmapIntensity = lighting.lightmapIntensity;
    // The world's sun. Lightmapped geometry adds it itself, masked by the
    // baked shadow atlas, because CS2 leaves the sun out of the irradiance
    // bake; null on a pack that predates the mask.
    pack.sun = lighting.worldSun();
    // Smoke is half diffuse-lit (CS2's `m_flDiffuseAmount` 0.5), so the cards
    // shade against the map's own sun rather than a made-up one.
    nadeEffects.setLight(pack.sun ? { ...pack.sun, ambient: lighting.skyAmbient } : null);
    // ...and each puff reads the ambient cube where it stands, the same grid
    // the player models and the viewmodel are lit from.
    nadeEffects.setProbeGrid(() => pack?.probeGrid || null);
    // The 3D skybox's own ambient (see MapLighting.skyAmbient). Pushed again
    // once loadSkybox has measured the real sky, since it refines the hue.
    pack.skyAmbient = lighting.skyAmbient;
    // The map's own skybox, if it was exported (scripts/cs3d-sky.mjs). It
    // replaces the procedural dome and becomes the ambient probe; the
    // procedural one stays as the fallback for a pack without it.
    if (manifest.sky?.equirect) {
      lighting
        .loadSkybox(pack.base, manifest.sky, pack.v)
        .then(() => {
          pack.materials?.setSkyAmbient(lighting.skyAmbient);
          // loadSkybox re-derives environmentIntensity from the real sky; the
          // look's sky knob is the value that stands (same in the 3D viewer).
          look.apply('sky');
          // The real sky replaces the procedural probe, so the gun takes the
          // new one too — at the viewmodel's own strength, not the world's.
          vmPass.setEnvironment(scene.environment);
        })
        .catch(() => {});
    }
    // Camera at a T spawn for the load view. Walk + kit land after phys is in.
    const s = (manifest.spawns?.T?.[0] || manifest.spawns?.CT?.[0]) || null;
    if (s) {
      player.yaw = cameraYawFromSource(s.yaw || 0);
      camera.position.set(s.pos[0], s.pos[1] + 64.5, s.pos[2]);
      player.syncCamera();
    }
    // Player models alongside the tiles: their 9 MB would otherwise sit in
    // front of the first geometry request.
    // Bodies stand in the map's own baked light (mapLoader.js ProbeGrid), not
    // in a global sky probe — the same rule the map's props follow.
    playerModels.getProbeGrid = () => pack?.probeGrid || null;
    playerModels.load().then((ok) => ok && console.log('cs3d: player models ready'));
    // The hands, alongside the tiles. Once they land the body is armed with
    // whatever slot is selected, so the first frame after the pack arrives has
    // a weapon in it rather than waiting for a keypress.
    vmAssets.load().then((ok) => {
      if (ok === false) return;
      viewModel.setSide(lastSide);
      equipWeapon(held);
      console.log('cs3d: viewmodel ready');
    });
    await pack.load(manifest);
    spawnAt('T');
    // The material library exists now; any lighting knob set before this had
    // nothing to write to. Same call, same order as the timeline's 3D view.
    look.applyAll();
    applyPerf();
    // The smoke's pipelines, built by running the pass once with a decoy cloud
    // buried under the map (see SmokePass.warm). Synchronous and on the load
    // path on purpose: this is the cost the first grenade used to pay, and the
    // place to pay it is behind the progress bar.
    //
    // It replaced two `compileAsync` prewarms that each spent most of a second
    // compiling pipelines the real pass then did not use — a hand-written copy
    // of the pass's scene and render state that had drifted out of sync with
    // it. Measured on Nuke: first grenade 1.3 s before, ~20 ms after.
  } catch (e) {
    console.error(e);
    hud.showError(e.message || String(e));
  }
}

// ---- inspector -------------------------------------------------------------
// What the crosshair is on: the vmat behind it, the material actually built
// from it and the tile's own tint. `I` toggles it. The raycast walks every
// instance of every BatchedMesh, so it runs a few times a second rather than
// per frame, and only while the panel is up.
//
// Off on load: it is a debugging tool, it covers a third of the screen, and its
// raycast is the most expensive thing on the frame when it is up.
let inspectOn = false;
let inspectAt = 0;
const _ray = new THREE.Raycaster();
_ray.far = 8192;
const _fwd = new THREE.Vector3();

const f3 = (v, n = 3) => (Array.isArray(v) ? v.map((x) => (+x).toFixed(n)).join(', ') : null);
const hex = (rgb) =>
  Array.isArray(rgb) ? `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}` : null;
/** Linear → sRGB, because every colour in the pack is linear and eyes are not. */
const toSrgb = (rgb) =>
  Array.isArray(rgb) ? rgb.map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055)) : null;
const texRow = (t) => (t ? `#${t.index} ${t.w}x${t.h} ${t.kind} ${(t.bytes / 1024).toFixed(0)}kB` : null);
const onOff = (v) => (v ? 'yes' : 'no');

function updateInspector(now) {
  if (!inspectOn || now - inspectAt < 120) return;
  inspectAt = now;
  camera.getWorldDirection(_fwd);
  _ray.set(camera.position, _fwd);
  let p = null;
  try {
    p = pack.pick(_ray);
  } catch (e) {
    hud.setInspect([['', 'inspect failed'], ['error', e.message]]);
    return;
  }
  if (!p) {
    hud.setInspect([['', 'nothing under the crosshair']]);
    return;
  }
  const m = p.manifest || {};
  const live = p.live;
  const t = p.textures || {};
  const rows = [
    ['', 'what'],
    ['source', p.kind.source + (p.kind.propsTwin ? ' (props twin)' : '')],
    ['name', String(m.name || '(unknown)').split('/').pop()],
    ['path', m.name || null],
    ['shader', m.shader || null],
    ['material id', `m${p.id}${p.kind.interim ? ' (interim, still streaming)' : ''}`],
    ['batch / tile', p.hit.batchId !== null ? `tile ${p.hit.batchId} of ${m.tiles ?? '?'}` : null],
    ['distance', `${p.hit.distance.toFixed(0)} u`],
    ['uv', p.hit.uv ? f3(p.hit.uv) : null],

    ['', 'flags'],
    ['lightmapped', onOff(m.lightmapped)],
    ['alpha mode', m.alphaMode || null],
    ['alpha cutoff', m.alphaCutoff ?? null],
    ['double sided', onOff(m.doubleSided)],
    ['decal', onOff(m.decal)],
    ['unlit', onOff(m.unlit)],
    ['water', onOff(m.water)],
    ['glass', onOff(m.glass)],
    ['blend layers', m.blend ? `yes (softness ${m.blend.softness}, scale2 ${f3(m.blend.scale2, 2)})` : 'no'],
    ['tint mask', m.tintMask !== undefined ? `yes (tex #${m.tintMask})` : 'no'],
    ['emissive', m.emissive ? `${f3(m.emissive, 2)} x${m.emissiveIntensity ?? '?'}` : 'no'],

    ['', 'colour'],
    ['material colour', m.color ? `${hex(toSrgb(m.color))}  linear ${f3(m.color)}` : null],
    ['tile tint', p.tile.tint ? `${hex(toSrgb(p.tile.tint))}  linear ${f3(p.tile.tint)}` : 'none (untinted)'],
    ['tint source', p.tile.tintFrom || null],
    ['blend paint', p.tile.blendPaint !== null && p.tile.blendPaint !== undefined ? p.tile.blendPaint.toFixed(3) : null],
    ['albedo average', m.avg ? `${hex(m.avg.map((c) => c / 255))}  ${m.avg.join(', ')}` : null],

    ['', 'surface'],
    ['roughness', live ? `${live.roughness?.toFixed?.(3) ?? live.roughness}${live.maps?.roughnessMap ? ' x map(G)' : ''}` : m.roughness],
    ['metalness', live ? `${live.metalness?.toFixed?.(3) ?? live.metalness}${live.maps?.metalnessMap ? ' x map(B)' : ''}` : m.metalness],
    ['opacity', live ? `${live.opacity}${live.transparent ? ' (transparent)' : ''}` : m.opacity],
    ['ao map', live ? onOff(live.maps?.aoMap) : null],
    ['alpha test', live?.alphaTest ? live.alphaTest : null],
    ['side / depth', live ? `${live.side}, depthWrite ${onOff(live.depthWrite)}` : null],
    ['three material', live?.type || null],
    ['custom nodes', live ? Object.entries(live.nodes).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none' : null],

    ['', 'textures'],
    ['base', texRow(t.base)],
    ['normal', texRow(t.normal)],
    ['orm (AO/rough/metal)', texRow(t.orm)],
    ['tint mask', texRow(t.tintMask)],
    ['emissive mask', texRow(t.emissiveMask)],
    ['blend layer 2', texRow(t.blendBase)],
    ['blend normal 2', texRow(t.blendNormal)],
    ['blend modulation', texRow(t.blendMod)],
    ['blend heights', texRow(t.blendHeights)],

    ['', 'geometry'],
    ['triangles', m.tris ?? null],
    ['vertices', m.verts ?? null]
  ];
  hud.setInspect(rows);
}

// ---- grade panel -----------------------------------------------------------
/**
 * The tone-mapping knobs, live. `G` shows them.
 *
 * Every one is a uniform inside the grade function, so dragging a slider is a
 * uniform write and nothing recompiles — the whole point of this over editing
 * constants and re-packing to see a change.
 *
 * Values persist in localStorage and are echoed as a query string, so a look
 * that works can come back as `?contrast=…&saturation=…` or be read off and
 * made the default.
 */
const GRADE_STORE = 'cs3d_grade';

/**
 * The knobs themselves live in look.js (`createLook`), shared with the
 * timeline's 3D view so a demo renders exactly as this page does: sun and sky
 * are absolute values written over what the map worked out, bake is a
 * multiplier over the pack's lightmap intensity, the rest are the grade
 * uniforms. `sun` moves the world and the props together on purpose: the
 * world's sun is an analytic term inside the lightmapped materials and the
 * props' is a real directional light, and moving one without the other would
 * light a crate differently from the floor it stands on.
 */
const look = createLook({ scene, getPack: () => pack, getLighting: () => lighting, slug: map.slug });

/**
 * Slider defaults a single map overrides, keyed by slug.
 *
 * Anubis takes twice the bounce: it is 89% lightmapped, far more than any
 * other map, so the baked indirect is doing nearly all of its shading and the
 * one number tuned on Nuke leaves it flat. Everything not listed here uses the
 * `def` on the slider itself.
 */
const MAP_GRADE = MAP_LOOK;

function setupGradePanel(knobs, slug) {
  const perMap = MAP_GRADE[slug] || {};
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(GRADE_STORE) || '{}');
  } catch {
    /* first run */
  }
  // `def` is where each slider loads and where reset returns it, the values
  // dialled in against the game on Nuke. What a knob does is look.js's
  // business (`createLook`); this panel only moves them.
  const defs = [
    { key: 'sun', label: 'sun ×', min: 0, max: 5, step: 0.05, def: LOOK_DEFAULTS.sun },
    { key: 'bake', label: 'bounce ×', min: 0, max: 3, step: 0.05, def: LOOK_DEFAULTS.bake },
    { key: 'sky', label: 'sky probe ×', min: 0, max: 3, step: 0.05, def: LOOK_DEFAULTS.sky },
    { key: 'brightness', label: 'brightness', min: 0.2, max: 3, step: 0.01, def: LOOK_DEFAULTS.brightness },
    { key: 'contrast', label: 'contrast', min: 0.5, max: 2.5, step: 0.01, def: LOOK_DEFAULTS.contrast },
    { key: 'saturation', label: 'saturation', min: 0, max: 2.5, step: 0.01, def: LOOK_DEFAULTS.saturation },
    { key: 'vibrance', label: 'vibrance', min: 0, max: 2, step: 0.01, def: LOOK_DEFAULTS.vibrance },
    { key: 'lift', label: 'black lift', min: 0, max: 0.08, step: 0.001, def: LOOK_DEFAULTS.lift }
  ].map((d) => {
    // A per-map override is the map's default, so reset returns there too.
    const reset = perMap[d.key] ?? d.def;
    // The map's defaults WIN over anything saved. A stored value from another
    // map is nearly always wrong for this one — the numbers are per-map now
    // (Anubis' bounce is 2, everything else 0.9) — and a stale store silently
    // pinning a slider is impossible to tell apart from a broken default.
    // Tweaks still persist while you stay on the map; loading one resets them.
    const value = reset;
    saved[d.key] = value;
    look.set(d.key, value);
    return { ...d, value, reset };
  });
  try {
    localStorage.setItem(GRADE_STORE, JSON.stringify(saved));
  } catch {
    /* private mode */
  }
  hud.buildGrade(defs, (key, value) => {
    if (!LIGHT_KEYS.has(key) && !knobs[key]) return;
    look.set(key, value);
    saved[key] = value;
    try {
      localStorage.setItem(GRADE_STORE, JSON.stringify(saved));
    } catch {
      /* private mode */
    }
  });
}

/**
 * The viewmodel, every frame.
 *
 * It is shown when there is a body to hold it: walking in first person, or
 * inside a demo POV, where it takes that player's weapon and their speed. The
 * flat view (V) still holds the gun. In fly mode or third person there is
 * nothing to hold it and it is hidden — which also skips its pass entirely.
 */
function updateViewModel(dt, inThird) {
  if (!viewModel.ready) return;
  const pov = demoView.active && demoView.povSlot !== null ? demoView.povState() : null;
  const show = !cleanView && (pov ? true : player.mode === 'walk' && !inThird);
  viewModel.visible = show;
  if (!show) return;
  if (pov) {
    // A recorded POV: the weapon, the speed and the view are the demo's, and
    // the gun kicks on the ticks the demo says that player pulled the trigger.
    if (pov.side) viewModel.setSide(pov.side);
    if (pov.weapon) viewModel.setWeapon(pov.weapon, { draw: false });
    // A real clock, not 0: `attack` is a rate gate that stores `now + cycle`,
    // so a literal 0 makes the first shot set nextAttack to the cycle time and
    // every later one fail `0 < cycle`. The gun then kicks once per weapon and
    // never again for the rest of the demo. The demo already says which ticks
    // that player fired on, so the gate is not wanted here at all — hand it a
    // time it cannot refuse.
    for (let i = 0; i < pov.shots; i++) viewModel.attack('primary', performance.now() / 1000 + i * 1e-4);
    viewModel.update(dt, {
      speed: pov.speed,
      onGround: !pov.airborne,
      viewYaw: pov.yaw,
      viewPitch: pov.pitch,
      punch: pov.punch || [0, 0, 0],
      viewPunch: [0, 0]
    });
  } else {
    viewModel.setSide(lastSide);
    // The punch goes to the gun as well as to the camera, and the two take
    // different fractions of it — that difference is the gun climbing out of
    // frame during a spray (src/cs3d/viewModel.js VIEWMODEL_RECOIL).
    aimPunch(recoilState, _aim);
    viewModel.update(dt, {
      speed: Math.hypot(player.vel.x, player.vel.z),
      onGround: player.onGround,
      viewYaw: sourceYawFromCamera(player.yaw),
      viewPitch: -player.pitch * (180 / Math.PI),
      punch: _aim,
      viewPunch: recoilState.viewPunch,
      now: performance.now() / 1000
    });
  }
  // The gun stands in the map's own light, like every other moving thing.
  const eye = pov ? pov.eye : camera.position;
  const grid = pack?.probeGrid;
  if (grid) {
    const cube = grid.sample(eye.x, eye.y, eye.z, _vmCube);
    // The ambient cube's upward and lateral terms, as one fill colour.
    _vmColor.setRGB(
      (cube[6] + cube[0] + cube[3]) / 3,
      (cube[7] + cube[1] + cube[4]) / 3,
      (cube[8] + cube[2] + cube[5]) / 3
    );
    vmPass.setAmbient(_vmColor, 1.6);
  }
  // ...and in its sun. The pass's scene is view space, so the world direction
  // has to be rotated into it — that is the whole point: turn on the spot and
  // the highlight travels down the barrel instead of riding along with you.
  // Indoors the sun is not cut, only turned down (sunlight.js INDOOR).
  if (lighting?.sun) {
    // Feet, not eyes: the question is which patch of floor the player is
    // standing on, and in the air it is the floor below them.
    const shade = sunTracker.update(dt, pov ? pov.eye : player.feet);
    _toSunView.copy(lighting.toSun).applyQuaternion(_invView.copy(camera.quaternion).invert());
    vmPass.setSun(_toSunView, lighting.sunColor, VIEWMODEL_SUN * shade);
    // The sky it reflects turns with the view for the same reason, and dims
    // with the same factor: a gun in a doorway should not mirror open sky.
    vmPass.setViewRotation(camera.quaternion);
    vmPass.setEnvironment(vmPass.scene.environment, VIEWMODEL_ENV_INTENSITY * shade);
  }
}

function renderFrame() {
  passStamp.sky = 0;
  passStamp.world = 0;
  passStamp.bloom = 0;
  passStamp.vm = 0;
  if (fpsView.enabled) {
    const t = performance.now();
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    passStamp.world = performance.now() - t;
    if (viewModel.visible && viewModel.ready) {
      const t2 = performance.now();
      vmPass.render();
      passStamp.vm = performance.now() - t2;
    }
    return;
  }
  // The viewmodel rides along inside this call (createMapRenderer's `overlay`),
  // last and with its own depth, so the gun is never clipped by a wall the
  // player is standing against — and never drawn after the bloom composite.
  if (mapRenderer) mapRenderer.render(camera);
  else {
    const t = performance.now();
    renderer.render(scene, camera);
    passStamp.world = performance.now() - t;
    if (viewModel.visible && viewModel.ready) {
      const t2 = performance.now();
      vmPass.render();
      passStamp.vm = performance.now() - t2;
    }
  }
}

// ---- live body / third person ----------------------------------------------
// The explorer's walking body wears the same agent model the demo bodies do,
// driven from the movement sim (src/cs3d/liveBody.js). T puts the camera
// behind it — the way to watch the locomotion blend run on live input, and
// the path a bot's body will take.
const liveBody = new LiveBody(playerModels, () => pack?.world || null);

function collectPracticeXraySubjects() {
  const out = [];
  if (demoView.active) out.push(...demoView.xraySubjects());
  for (const b of practiceBots.list) {
    const obj = b.body?.group;
    if (!obj || !obj.visible) continue;
    const snap = practiceBots.overlay(b.id);
    out.push({
      id: `bot-${b.id}`,
      object: obj,
      name: snap?.name || 'Bot',
      hp: snap?.hp ?? b.hp,
      side: snap?.side || b.side,
      duck: 0,
      items: xrayIconList({
        util: snap?.nades || [],
        primary: snap?.primary || b.weapon,
        items: [snap?.primary, snap?.pistol, snap?.held, b.weapon].filter(Boolean),
        active: snap?.held || b.weapon
      })
    });
  }
  const live = liveBody.body?.group;
  if (live?.visible) {
    const snap = match.snapshot();
    out.push({
      id: 'you',
      object: live,
      name: snap.name || 'You',
      hp: snap.dead ? 0 : snap.hp,
      side: liveBody.side || lastSide,
      duck: liveBody.body.duck || 0,
      items: xrayIconList({
        util: snap.nades || [],
        primary: snap.primary,
        items: [snap.primary, snap.pistol, snap.held].filter(Boolean),
        active: snap.held
      })
    });
  }
  return out;
}

// ---- loop ------------------------------------------------------------------
let last = performance.now();
let lastPresent = 0;
let presentMs = 16.67;

function shouldPresent(now) {
  const cap = perf?.flags.fpsMax ?? 0;
  if (cap && now - lastPresent < 1000 / cap - 0.25) return false;
  presentMs = lastPresent > 0 ? now - lastPresent : 16.67;
  lastPresent = now;
  return true;
}
const _src = [0, 0, 0];
const _vmCube = new Float32Array(18);
const _vmColor = new THREE.Color();
const _toSunView = new THREE.Vector3();
const _invView = new THREE.Quaternion();
/** Milliseconds between shadow-map redraws while a body is on screen. */
const DYNAMIC_SHADOW_MS = 33;
let _bodyShadowAt = 0;
/**
 * The flashbang whiteout. A DOM layer rather than a post pass: it is a flat
 * white fill over everything including the HUD, which is what the game's is,
 * and it costs nothing on the frames where it is off.
 */
const flashOverlay = document.createElement('div');
flashOverlay.className = 'c3-flash';
uiRoot.appendChild(flashOverlay);
let _flashShown = 0;
const FRAME_RING = 200;
const frameMs = new Float64Array(FRAME_RING);
let frameI = 0;
let frameN = 0;
let profileAt = 0;

function updateProfile(now, dtMs) {
  frameMs[frameI] = dtMs;
  frameI = (frameI + 1) % FRAME_RING;
  if (frameN < FRAME_RING) frameN++;
  if (now - profileAt < 250) return;
  profileAt = now;
  const n = frameN;
  const copy = Array.from(frameMs.subarray(0, n)).sort((a, b) => a - b);
  const at = (p) => copy[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const avg = copy.reduce((s, x) => s + x, 0) / n;
  const p10 = at(0.9);
  const p99 = at(0.99);
  const fps = (ms) => (ms > 0.05 ? Math.round(1000 / ms) : 0);
  const f = perf.flags;
  const info = renderer.info?.render;
  const draws = info?.calls != null ? `  draw ${info.calls}` : '';
  const med = copy[Math.floor((n - 1) / 2)];
  const lock = displayHzHint(med);
  hud.setProfile(
    `${fps(avg)} fps  avg ${avg.toFixed(1)}ms${lock ? `  ${lock}` : ''}\n` +
      `1% ${fps(p99)} (${p99.toFixed(1)}ms)  10% ${fps(p10)} (${p10.toFixed(1)}ms)\n` +
      `sky ${passStamp.sky.toFixed(1)}  world ${passStamp.world.toFixed(1)}  bloom ${passStamp.bloom.toFixed(1)}  vm ${passStamp.vm.toFixed(1)}\n` +
      `shadow ${passStamp.shadowDirty ? 'dirty' : 'cached'}${draws}\n` +
      `msaa ${f.msaa ? 1 : 0}  dpr ${f.dpr}  bloom ${f.bloom ? 1 : 0}  shadows ${f.shadows ? 1 : 0}\n` +
      `bodies ${f.shadowBodies ? 1 : 0}  simple ${f.simple ? 1 : 0}  skypass ${f.skyPass ? 1 : 0}\n` +
      `fps_max ${f.fpsMax}`
  );
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const lockEyes = camMode === 'spectate' && spectateEyes && spectateKey;
  if (!lockEyes) player.update(dt);
  else player.flyVel.set(0, 0, 0);
  // Recoil, after the body and before anything reads the camera.
  //
  // The punch is NOT fed back into the player's own yaw and pitch: it is a
  // layer over them, so it decays away on its own and the aim underneath is
  // exactly where the mouse left it. That is the game's model and it is the
  // reason a spray recovers to the same spot rather than drifting.
  {
    const weapon = vmAssets.stats?.(held) || null;
    const cycle = weapon ? (Array.isArray(weapon.cycleTime) ? weapon.cycleTime[0] : weapon.cycleTime) || 0.1 : 0.1;
    updateRecoil(recoilState, dt);
    updateRecoilIndex(recoilState, dt, cycle, now / 1000);
    if (weapon) updateAccuracy(accuracyState, weapon, playerAccuracyState(), dt);
    // Holding an automatic weapon's trigger keeps firing at its cycle time, and
    // it has to happen HERE — before the camera and the viewmodel read the
    // punch, and after the decay. A shot moves the view punch instantly (it is
    // a position kick, not a velocity), so a shot fired between the camera's
    // read and the viewmodel's leaves the gun counter-rotating by a degree
    // against a camera that has not moved, once per shot, at ten a second.
    if (
      viewModel.ready &&
      attackHeld.primary &&
      viewModel.isAuto &&
      !(demoView.active && demoView.povSlot !== null)
    ) {
      tryAttack('primary');
    }
    // The camera takes its share of the punch. `povSlot`, not `active`: a demo
    // is `active` from the moment it is dropped, but it only OWNS the camera
    // while a POV is selected — and with one loaded and no POV chosen the
    // player is still walking around shooting, and would otherwise be doing it
    // with a frozen crosshair.
    if (player.mode === 'walk' && !thirdPerson && demoView.povSlot === null) {
      cameraPunch(recoilState, _cam);
      // Source QAngle into three's camera: pitch is positive DOWN there and up
      // here, and yaw is positive LEFT in both. Roll is Source z.
      camera.rotation.set(
        player.pitch - _cam[0] * (Math.PI / 180),
        player.yaw + _cam[1] * (Math.PI / 180),
        (_cam[2] || 0) * (Math.PI / 180),
        'YXZ'
      );
    }
  }
  // The walking body's own agent model, posed from the sim every frame; shown
  // in third person, kept in step (hidden) in first.
  const inThird = thirdPerson && player.mode === 'walk';
  liveBody.setSide(lastSide);
  liveBody.update(player, dt, { visible: inThird && camMode !== 'spectate', alive: !match.dead });
  practiceBots.update(dt);
  if (inThird) placeThirdPersonCamera(camera, player.world);
  updateViewModel(dt, inThird);
  // Utility. The throw state machine first (it is what spawns projectiles),
  // then the projectiles themselves at a fixed 64 Hz, then whatever they left
  // behind. All three are no-ops when nothing has been thrown.
  throwControl.update(dt);
  projectiles.update(dt);
  dropped.update(
    dt,
    player.mode === 'walk' && !match.dead && camMode !== 'spectate'
      ? { x: player.sim.pos.x, y: player.sim.pos.y, z: player.sim.pos.z }
      : null,
    (d) => takeDropped(d, { replace: false })
  );
  nadeEffects.update(dt, now / 1000);
  blood.update(dt, camera);
  // The doors swing here, which moves both what is drawn and what the tracer
  // sees — they are the same box (src/cs3d/interactives.js).
  interactives.update(dt);
  shooting.update(dt);
  // The holes and the streaks. Both are no-ops until the bullet pack lands and
  // until something has actually been shot.
  decals.update(dt);
  tracers.update(dt);
  if (throwControl.active) hud.setThrow(throwControl.status());
  if (_shotClearAt && now > _shotClearAt) {
    _shotClearAt = 0;
    hud.setShot(null);
  }
  // After the player: in POV the demo owns the camera, and writing second wins.
  demoView.update(now);
  applySpectateEyes();
  // The overlay is the worse of the two blinds: one you walked into yourself,
  // and one the player whose eyes you are borrowing walked into. Read AFTER
  // demoView.update, which is what recomputes the demo's.
  const flashNow = Math.max(nadeEffects.flash, demoNades.flash);
  if (flashNow !== _flashShown) {
    _flashShown = flashNow;
    flashOverlay.style.opacity = _flashShown > 0.002 ? String(_flashShown) : '0';
  }
  if (demoView.active) hud.setDemoStatus(demoView.status());
  // A body on screen is a shadow caster that walks and animates, so the sun's
  // cached shadow map (sky.js: static map, static sun, redraw only when the
  // volume moves) has to be redrawn while one is visible. Only while one is —
  // an empty map keeps the cheap path — and at 30 Hz, not per frame: the pass
  // draws the whole map, which measured about a third again on top of a frame,
  // and a walking player's shadow being one 30th of a second stale is not
  // something anyone can see.
  if (
    perf?.flags.shadowBodies &&
    lighting?.sun?.castShadow &&
    now - _bodyShadowAt >= DYNAMIC_SHADOW_MS
  ) {
    for (const b of liveBodies) {
      if (!b.group.visible || !b.group.parent) continue;
      _bodyShadowAt = now;
      lighting.markShadowDirty();
      break;
    }
  }
  lighting?.update();
  passStamp.shadowDirty = lighting?.sun?.shadow?.needsUpdate ? 1 : 0;
  pack?.materials?.setTime(now / 1000);
  _xraySubjects = !cleanView && xray?.enabled ? collectPracticeXraySubjects() : [];
  xray?.updateLabels(camera, _xraySubjects);
  const presented = !renderer.backend || shouldPresent(now);
  if (renderer.backend && presented) renderFrame();
  updateInspector(now);
  if (perf?.flags.profile && presented) updateProfile(now, presentMs);
  // HUD read-outs are cheap; positions shown in Source coordinates.
  // The walking body reports its feet (the camera may be behind it in third
  // person); the fly camera reports the ground under its eyes.
  const p = player.mode === 'walk' ? player.feet : camera.position;
  const s = sceneToSource(p.x, player.mode === 'walk' ? p.y : p.y - 64, p.z);
  _src[0] = s[0];
  _src[1] = s[1];
  _src[2] = s[2];
  const speed = player.mode === 'walk' ? Math.hypot(player.vel.x, player.vel.z) : player.flyVel.length();
  hud.setStatus(_src, speed);
  if (presented) hud.tickFps();
  if (_respawnAt && now >= _respawnAt && camMode !== 'spectate') {
    _respawnAt = 0;
    match.respawn();
    spawnAt();
  }
  match.tick(dt);
  const demo = demoView.active ? demoView.status() : null;
  const marks = demoView.active ? demoView.marks.slice() : [];
  const overlay = camMode === 'spectate' ? spectateOverlay() : null;
  if (camMode !== 'spectate' && (!demoView.active || demoView.povSlot === null)) {
    marks.push({ x: _src[0], y: _src[1], z: _src[2], yaw: sourceYawFromCamera(player.yaw), self: true, side: lastSide });
  }
  for (const b of practiceBots.alive()) {
    marks.push({ x: b.origin.x, y: b.origin.y, z: b.origin.z, yaw: b.yaw, side: b.side });
  }
  let ctAlive;
  let tAlive;
  if (demoView.active) {
    ctAlive = demoView.marks.filter((p) => p.side === 'CT').length;
    tAlive = demoView.marks.filter((p) => p.side === 'T').length;
  }
  const hudSrc = overlay && Number.isFinite(overlay.x) ? [overlay.x, overlay.y, overlay.z] : _src;
  const hudYaw = overlay && overlay.yaw != null ? overlay.yaw : sourceYawFromCamera(player.yaw);
  if (camMode === 'spectate') syncSpectateHud();
  const radarFrame = demoView.active
    ? demoView.radarFrame()
    : practiceRadarFrame({
        match,
        player,
        src: hudSrc,
        yaw: hudYaw,
        pitch: overlay?.pitch ?? -player.pitch * (180 / Math.PI),
        bots: practiceBots,
        projectiles,
        nadeEffects,
        overlay
      });
  matchHud.update({
    src: hudSrc,
    yaw: hudYaw,
    marks,
    clock: demo ? demo.clock : undefined,
    ctAlive,
    tAlive,
    overlay: overlay || undefined,
    radarFrame
  });
}

window.addEventListener('resize', () => applyPracticeDisplay());

boot();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  // `frame` too: a hidden tab gets no rAF, so driving it by hand is the only
  // way to render (and screenshot) the real path from a headless session.
  window.__cs3d = { THREE, scene, camera, player, nadeEffects, demoNades, projectiles, dropped, throwControl, get pack() { return pack; }, renderer, lighting: () => lighting, fpsView, demoView, playerModels, practiceBots, viewModel, vmPass, vmTuner, buyMenu, pauseMenu, match, matchHud, frame, renderFrame, sunTracker, get mapRenderer() { return mapRenderer; }, get perf() { return perf; } };
}
