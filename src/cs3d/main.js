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
import { cameraYawFromSource, sceneToSource, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { MapPack } from './mapLoader.js';
import { MapLighting } from './sky.js';
import { installGrade } from './grade.js';
import { createLook, createMapRenderer, loadPostLut, LIGHT_KEYS, LOOK_DEFAULTS, MAP_LOOK, setupBloom } from './look.js';
import { patchWebGPUPartialAttributeUpload } from './threePatches.js';
import { Player } from './player.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { FpsView } from './fpsView.js';
import { DemoView } from './demoView.js';
import { sharedPlayerModels } from './playerModels.js';
import { LiveBody } from './liveBody.js';
import { createBuyMenu } from './buyMenu.js';
import { placeThirdPersonCamera } from './thirdPerson.js';
import { mountCrosshair } from './crosshairOverlay.js';
import { ViewModelAssets, ViewModel, createViewModelPass } from './viewModel.js';
import { createViewModelTuner } from './vmTuner.js';
import { SettingsManager, VIEWMODEL_FOV_MIN, VIEWMODEL_FOV_MAX } from '../core/SettingsManager.js';
import { loadDemoBytes, loadDemoFile } from './demoData.js';

const params = new URLSearchParams(location.search);
const map = cs3dMapForPath(location.pathname) || cs3dMap(params.get('map')) || null;
const canvas = document.getElementById('c3-canvas');
const uiRoot = document.getElementById('c3-ui');

if (!map) {
  uiRoot.innerHTML = `<div class="c3-err" style="pointer-events:auto">Unknown map. Try ${CS3D_MAPS.map((m) => `<a href="/${m.bareRoute === false ? 'de_' : ''}${m.slug}">${m.slug}</a>`).join(', ')}.</div>`;
  throw new Error('cs3d: no map in URL');
}
document.title = `${map.name} - AIM4.io`;

// ---- renderer / scene ------------------------------------------------------
// WebGPU, with three's built-in WebGL2 fallback when the browser has no
// adapter (`forceWebGL` also forces it for A/B testing via ?webgl=1). The
// whole island imports from 'three/webgpu' because that build ships its own
// copy of the core: mixing it with plain 'three' would give two different
// Mesh/Vector3 classes and nothing would line up.
const forceWebGL = params.get('webgl') === '1';
const renderer = new THREE.WebGPURenderer({
  canvas,
  antialias: true,
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
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 4, 120000);
camera.rotation.order = 'YXZ';
scene.add(camera);

const player = new Player(camera);
let lighting = null;
let mapRenderer = null;

// ---- UI --------------------------------------------------------------------
const controls = new Controls(canvas, player, {
  onLock: (locked) => hud.setLocked(locked),
  onToggleMode: () => {
    player.setMode(player.mode === 'fly' ? 'walk' : 'fly');
    hud.setMode(player.mode, thirdPerson);
  },
  onSpawn: (side) => spawnAt(side),
  // Digits belong to the demo when one is loaded (1-0 → slots 0-9), and to
  // the T/CT spawns in the plain explorer.
  onDigit: (n) => {
    if (demoView.active) demoView.setPov((n + 9) % 10);
    // Walking: 1/2/3 are the weapon slots the way the game has them, and the
    // draw animation plays. Flying, there is no body to arm, so 1 and 2 stay
    // the T and CT spawns.
    else if (player.mode === 'walk' && n >= 1 && n <= 3) equipSlot(n);
    else if (n === 1) spawnAt('T');
    else if (n === 2) spawnAt('CT');
  },
  // Mouse: fire while held for an automatic weapon, once per click otherwise.
  onAttack: (button, down) => {
    attackHeld[button] = down;
    if (down) tryAttack(button);
  },
  onPlayPause: () => demoView.togglePlay(),
  onStep: (d) => demoView.step(d),
  onRound: (d) => demoView.shiftRound(d),
  onSpeed: () => demoView.cycleSpeed(),
  onPovExit: () => demoView.active && demoView.povSlot !== null && demoView.setPov(demoView.povSlot),
  onHelp: () => hud.toggleHelp(),
  onInspect: () => {
    inspectOn = !inspectOn;
    if (!inspectOn) hud.setInspect(null);
    inspectAt = 0;
  },
  onGrade: () => hud.toggleGrade(),
  onFpsView: () => fpsView.toggle(),
  // Q: the next weapon in the explorer's pocket — the run-speed cap and the
  // hands both follow it.
  onWeapon: () => equipWeapon(player.cycleWeapon()),
  // T: third person — the camera behind the walking body's own agent model,
  // animated live from the movement sim (the same body the demos drive).
  onThirdPerson: () => {
    thirdPerson = !thirdPerson;
    hud.setMode(player.mode, thirdPerson);
  },
  // B: the buy menu. It needs the mouse, so opening it gives the pointer back
  // and closing it takes the lock again.
  onBuy: () => buyMenu.toggle(),
  // Backslash: the viewmodel placement sliders. Same deal as the buy menu —
  // it needs the cursor, so it drops the pointer lock while it is up.
  onVmTune: () => vmTuner.toggle(),
  onCancel: () => {
    buyMenu.close();
    vmTuner.close();
  }
});
let thirdPerson = false;
const hud = new Hud(uiRoot, {
  map,
  sens: controls.sens,
  onSensitivity: (v) => controls.setSensitivity(v)
});
const buyMenu = createBuyMenu({
  root: uiRoot,
  getSide: () => lastSide,
  // The header switch is the only way to change sides once you are walking:
  // 1 / 2 are weapon slots then, not spawns. It changes the hands and the agent
  // model with the list, because being a CT is what it means.
  onSide: (s) => {
    lastSide = s;
  },
  getHeld: () => player.weapon,
  // Only a loaded pack can say a weapon is missing from it. Before it lands
  // (or without one at all) nothing is marked, because nothing is known.
  has: (name) => !vmAssets.ready || !!vmAssets.stats(name),
  onPick: (name) => equipWeapon(name),
  onToggle: (open) => {
    hud.setPanelOpen(open);
    if (open) controls.exitLock();
    else controls.requestLock();
  }
});
hud.setLocked(false);
hud.setMode(player.mode);
hud.setWeapon(player.weapon, player.maxSpeed);
mountCrosshair(uiRoot);

// The flat view (V). Reads `pack` and `lighting` through getters because both
// are filled in by boot(), long after the key is bound.
const fpsView = new FpsView({
  scene,
  renderer,
  getPack: () => pack,
  getLighting: () => lighting,
  onChange: (on) => hud.setFpsView(on)
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
// Hand, FOV and the hand offsets are account settings, shared with the trainer
// and synced to the profile — the same store the sensitivity above comes from.
const vmSettings = new SettingsManager();
const applyVmSettings = () => {
  const vm = vmSettings.data.viewmodel || {};
  viewModel.applySettings(vm);
  vmPass.setFov(Math.min(VIEWMODEL_FOV_MAX, Math.max(VIEWMODEL_FOV_MIN, Number(vm.fov) || VIEWMODEL_FOV_MAX)));
};
applyVmSettings();
vmSettings.onChange(applyVmSettings);
// The vm camera is constructed at aspect 1 and was only ever corrected by the
// resize listener, so the first frames of every session drew the viewmodel
// stretched across the width of the window until something resized it (F11,
// a drag, anything). Set it up front from the size we already have.
vmPass.resize(window.innerWidth, window.innerHeight);
// U opens the same settings as live sliders (src/cs3d/vmTuner.js).
const vmTuner = createViewModelTuner({ viewModel, vmPass, settings: vmSettings, apply: applyVmSettings });

/** 1 / 2 / 3, the game's slots. The draw animation and its lockout come free. */
const SLOTS = { 1: 'ak47', 2: 'glock', 3: 'knife' };
const attackHeld = { primary: false, secondary: false };
let held = 'knife';

/**
 * Hold a weapon by name — the slot keys, Q, and every row of the buy menu all
 * come through here.
 *
 * The speed cap applies whether or not the weapons pack is in: it is the
 * movement sim's business, not the viewmodel's, and without the pack the
 * explorer is still a place to walk an AWP's 200 u/s around a map.
 */
function equipWeapon(name, { draw = true } = {}) {
  if (!name) return;
  held = name;
  if (vmAssets.ready) viewModel.setWeapon(name, { draw });
  // The body's speed cap follows what it is holding, as it does in the game.
  player.setWeapon(name);
  hud.setWeapon(player.weapon, player.maxSpeed);
  buyMenu.refresh();
}

function equipSlot(n) {
  equipWeapon(SLOTS[n]);
}

/**
 * Pull the trigger once. The viewmodel owns the timing (deploy lockout, then
 * the weapon's own cycle time out of weapons.vdata), so this only has to ask.
 */
function tryAttack(button) {
  if (!controls.locked || player.mode !== 'walk' || thirdPerson) return;
  viewModel.attack(button, performance.now() / 1000);
}

const demoView = new DemoView({
  camera,
  getPack: () => pack,
  playerModels,
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
  const apiBase = String(import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
  const src = isId ? `${apiBase}/api/replays/demos/${ref}/package` : ref;
  fetch(src, isId ? { credentials: 'include' } : undefined)
    .then(async (res) => {
      if (!res.ok) {
        // The API answers JSON on failure; a package is bytes.
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }
      acceptDemo(loadDemoBytes(await res.arrayBuffer(), isId ? ref : ref.split('/').pop()));
    })
    .catch((err) => {
      console.error('cs3d: ?demo= failed', err);
      hud.showError(`Could not open that demo: ${err.message}`);
    });
}

// ---- pack ------------------------------------------------------------------
let pack = null;
let lastSide = 'T';
let spawnIndex = 0;

function spawnAt(side) {
  if (!pack?.manifest) return;
  if (side) {
    lastSide = side;
    spawnIndex = 0;
    // Half the guns are one side's only; a respawn on the other side changes
    // what the list should be showing.
    buyMenu.refresh();
  } else {
    spawnIndex++;
  }
  const list = pack.spawns(lastSide);
  if (!list.length) return;
  const s = list[spawnIndex % list.length];
  // Spawn origins are at the feet; the fly camera wants eye height above them.
  const feet = new THREE.Vector3(s.pos[0], s.pos[1] + 0.5, s.pos[2]);
  const yaw = cameraYawFromSource(s.yaw || 0);
  if (player.mode === 'walk') {
    player.teleport(feet, yaw, 0);
  } else {
    player.yaw = yaw;
    player.pitch = 0;
    player.flyVel.set(0, 0, 0);
    camera.position.copy(feet).setY(feet.y + 64);
    player.syncCamera();
  }
}

async function boot() {
  pack = new MapPack({
    slug: map.slug,
    scene,
    renderer,
    onProgress: (p) => hud.setProgress(p),
    onPhys: (collider) => player.setCollider(collider),
    onWorldChanged: () => lighting?.markShadowDirty()
  });
  try {
    // WebGPU needs its device before anything touches the renderer.
    await renderer.init();
    // r169 cannot upload part of an attribute on WebGPU, which is exactly what
    // streaming tiles into a BatchedMesh does. See threePatches.js.
    patchWebGPUPartialAttributeUpload(renderer);
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
    const bloomPass = setupBloom(renderer, manifest, params);
    if (bloomPass.enabled) console.log('cs3d: bloom from the map post-processing volume');
    mapRenderer = createMapRenderer({
      renderer,
      scene,
      getPack: () => pack,
      getLighting: () => lighting,
      bloom: bloomPass,
      overlayAfter: params.get('vm') === 'after',
      // The gun, in the same target as the world (see createMapRenderer).
      overlay: () => {
        if (!viewModel.visible || !viewModel.ready) return false;
        vmPass.render();
        return true;
      }
    });
    lighting = new MapLighting(scene, camera, manifest, { shadows, renderer });
    // The gun reflects the same sky the map stands under. Without it every
    // metallic surface in the viewmodel pass is black (see setEnvironment).
    vmPass.setEnvironment(scene.environment);
    pack.lightmapIntensity = lighting.lightmapIntensity;
    // The world's sun. Lightmapped geometry adds it itself, masked by the
    // baked shadow atlas, because CS2 leaves the sun out of the irradiance
    // bake; null on a pack that predates the mask.
    pack.sun = lighting.worldSun();
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
    // Place the camera before anything renders: T spawn, eye height, looking along the spawn yaw.
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
    // The material library exists now; any lighting knob set before this had
    // nothing to write to. Same call, same order as the timeline's 3D view.
    look.applyAll();
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
 * inside a demo POV, where it takes that player's weapon and their speed. In
 * fly mode, third person, or the flat view there is nothing to hold a gun and
 * it is hidden — which also skips its pass entirely.
 */
function updateViewModel(dt, inThird) {
  if (!viewModel.ready) return;
  const pov = demoView.active && demoView.povSlot !== null ? demoView.povState() : null;
  const show = !fpsView.enabled && (pov ? true : player.mode === 'walk' && !inThird);
  viewModel.visible = show;
  if (!show) return;
  if (pov) {
    // A recorded POV: the weapon, the speed and the view are the demo's, and
    // the gun kicks on the ticks the demo says that player pulled the trigger.
    if (pov.side) viewModel.setSide(pov.side);
    if (pov.weapon) viewModel.setWeapon(pov.weapon, { draw: false });
    for (let i = 0; i < pov.shots; i++) viewModel.attack('primary', 0);
    viewModel.update(dt, { speed: pov.speed, onGround: !pov.airborne, viewYaw: pov.yaw, viewPitch: pov.pitch });
  } else {
    // Holding an automatic weapon's trigger keeps firing at its cycle time.
    if (attackHeld.primary && viewModel.isAuto) tryAttack('primary');
    viewModel.setSide(lastSide);
    viewModel.update(dt, {
      speed: Math.hypot(player.vel.x, player.vel.z),
      onGround: player.onGround,
      viewYaw: sourceYawFromCamera(player.yaw),
      viewPitch: -player.pitch * (180 / Math.PI)
    });
  }
  // The gun stands in the map's own light, like every other moving thing.
  const grid = pack?.probeGrid;
  if (grid) {
    const p = pov ? pov.eye : camera.position;
    const cube = grid.sample(p.x, p.y, p.z, _vmCube);
    // The ambient cube's upward and lateral terms, as one fill colour.
    _vmColor.setRGB(
      (cube[6] + cube[0] + cube[3]) / 3,
      (cube[7] + cube[1] + cube[4]) / 3,
      (cube[8] + cube[2] + cube[5]) / 3
    );
    vmPass.setAmbient(_vmColor, 1.6);
  }
}

function renderFrame() {
  if (fpsView.enabled) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return;
  }
  // The viewmodel rides along inside this call (createMapRenderer's `overlay`),
  // last and with its own depth, so the gun is never clipped by a wall the
  // player is standing against — and never drawn after the bloom composite.
  if (mapRenderer) mapRenderer.render(camera);
  else {
    renderer.render(scene, camera);
    if (viewModel.visible && viewModel.ready) vmPass.render();
  }
}

// ---- live body / third person ----------------------------------------------
// The explorer's walking body wears the same agent model the demo bodies do,
// driven from the movement sim (src/cs3d/liveBody.js). T puts the camera
// behind it — the way to watch the locomotion blend run on live input, and
// the path a bot's body will take.
const liveBody = new LiveBody(playerModels, () => pack?.world || null);

// ---- loop ------------------------------------------------------------------
let last = performance.now();
const _src = [0, 0, 0];
const _vmCube = new Float32Array(18);
const _vmColor = new THREE.Color();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  player.update(dt);
  // The walking body's own agent model, posed from the sim every frame; shown
  // in third person, kept in step (hidden) in first.
  const inThird = thirdPerson && player.mode === 'walk';
  liveBody.setSide(lastSide);
  liveBody.update(player, dt, { visible: inThird });
  if (inThird) placeThirdPersonCamera(camera, player.world);
  updateViewModel(dt, inThird);
  // After the player: in POV the demo owns the camera, and writing second wins.
  demoView.update(now);
  if (demoView.active) hud.setDemoStatus(demoView.status());
  lighting?.update();
  pack.materials?.setTime(now / 1000);
  if (renderer.backend) renderFrame();
  updateInspector(now);
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
  hud.tickFps();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  mapRenderer?.resize();
  vmPass.resize(window.innerWidth, window.innerHeight);
  lighting?.resize();
});

boot();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__cs3d = { THREE, scene, camera, player, get pack() { return pack; }, renderer, lighting: () => lighting, fpsView, demoView, playerModels, viewModel, vmPass, vmTuner, buyMenu };
}
