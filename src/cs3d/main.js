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
import { cameraYawFromSource, sceneToSource } from '../../shared/sim3d/units.js';
import { MapPack } from './mapLoader.js';
import { MapLighting } from './sky.js';
import { bloom, screenUV, texture } from 'three/webgpu';
import { installGrade, makeLut } from './grade.js';
import { patchWebGPUPartialAttributeUpload } from './threePatches.js';
import { Player } from './player.js';
import { Controls } from './controls.js';
import { Hud } from './hud.js';
import { FpsView } from './fpsView.js';
import { DemoView } from './demoView.js';
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

// ---- UI --------------------------------------------------------------------
const controls = new Controls(canvas, player, {
  onLock: (locked) => hud.setLocked(locked),
  onToggleMode: () => {
    player.setMode(player.mode === 'fly' ? 'walk' : 'fly');
    hud.setMode(player.mode);
  },
  onSpawn: (side) => spawnAt(side),
  // Digits belong to the demo when one is loaded (1-0 → slots 0-9), and to
  // the T/CT spawns in the plain explorer.
  onDigit: (n) => {
    if (demoView.active) demoView.setPov((n + 9) % 10);
    else if (n === 1) spawnAt('T');
    else if (n === 2) spawnAt('CT');
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
  onFpsView: () => fpsView.toggle()
});
const hud = new Hud(uiRoot, {
  map,
  sens: controls.sens,
  onSensitivity: (v) => controls.setSensitivity(v)
});
hud.setLocked(false);
hud.setMode(player.mode);

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
// both use) onto the page to watch it on this map: placeholder bodies, every
// grenade, and 1-0 for any player's POV. Rejected when the package is for a
// different map — the geometry under the ticks would be nonsense.
const demoView = new DemoView({
  camera,
  getPack: () => pack,
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
  const src = isId ? `/api/replays/demos/${ref}/package` : ref;
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
    let post;
    if (manifest.post?.lut && manifest.post.lutDim) {
      try {
        const res = await fetch(`${pack.base}/${manifest.post.lut}${pack.v}`);
        if (res.ok) post = { lut: makeLut(await res.arrayBuffer(), manifest.post.lutDim), dim: manifest.post.lutDim };
      } catch (e) {
        console.warn('cs3d: colour grade failed to load', e);
      }
    }
    const knobs = installGrade(renderer, params, post);
    if (knobs) setupGradePanel(knobs);
    // After the grade: the composite bakes that curve in, then takes tone
    // mapping off the scene render.
    if (setupBloom(manifest)) console.log('cs3d: bloom from the map post-processing volume');
    lighting = new MapLighting(scene, camera, manifest, { shadows, renderer });
    pack.lightmapIntensity = lighting.lightmapIntensity;
    // The world's sun. Lightmapped geometry adds it itself, masked by the
    // baked shadow atlas, because CS2 leaves the sun out of the irradiance
    // bake; null on a pack that predates the mask.
    pack.sun = lighting.worldSun();
    // The map's own skybox, if it was exported (scripts/cs3d-sky.mjs). It
    // replaces the procedural dome and becomes the ambient probe; the
    // procedural one stays as the fallback for a pack without it.
    if (manifest.sky?.equirect) {
      lighting.loadSkybox(pack.base, manifest.sky, pack.v).catch(() => {});
    }
    // Place the camera before anything renders: T spawn, eye height, looking along the spawn yaw.
    const s = (manifest.spawns?.T?.[0] || manifest.spawns?.CT?.[0]) || null;
    if (s) {
      player.yaw = cameraYawFromSource(s.yaw || 0);
      camera.position.set(s.pos[0], s.pos[1] + 64.5, s.pos[2]);
      player.syncCamera();
    }
    await pack.load(manifest);
    // The material library exists now; any lighting slider set before this
    // had nothing to write to.
    reapplyLight();
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
let inspectOn = true;
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
 * The lighting knobs are multipliers over whatever the map's own numbers
 * worked out to, not absolutes — so 1.25 means "a quarter brighter than this
 * map asked for" and reads the same on every map.
 *
 * `sun` moves the world and the props together on purpose: the world's sun is
 * an analytic term inside the lightmapped materials and the props' is a real
 * directional light, and moving one without the other would light a crate
 * differently from the floor it stands on.
 */
const LIGHT_KEYS = new Set(['sun', 'bake', 'sky']);
const lightBase = {};
const lightMult = { sun: 1, bake: 1, sky: 1 };

function applyLight(key, mult) {
  lightMult[key] = mult;
  const mats = pack?.materials;
  if (key === 'sun') {
    if (lightBase.sun === undefined) lightBase.sun = lighting?.sunIntensity ?? 1;
    const v = lightBase.sun * mult;
    if (mats) mats.sun.intensity.value = v;
    if (lighting?.sun) lighting.sun.intensity = v;
  } else if (key === 'bake') {
    if (!mats) return;
    if (lightBase.bake === undefined) lightBase.bake = mats.lightmapIntensity.value;
    mats.lightmapIntensity.value = lightBase.bake * mult;
  } else if (key === 'sky') {
    if (lightBase.sky === undefined) lightBase.sky = lighting?.envIntensity ?? scene.environmentIntensity ?? 1;
    scene.environmentIntensity = lightBase.sky * mult;
  }
}

/** The materials only exist once the pack has loaded; re-apply then. */
function reapplyLight() {
  for (const k of LIGHT_KEYS) if (lightMult[k] !== 1) applyLight(k, lightMult[k]);
}

function setupGradePanel(knobs) {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(GRADE_STORE) || '{}');
  } catch {
    /* first run */
  }
  const defs = [
    { key: 'sun', label: 'sun ×', min: 0, max: 3, step: 0.05 },
    { key: 'bake', label: 'bounce ×', min: 0, max: 3, step: 0.05 },
    { key: 'sky', label: 'sky probe ×', min: 0, max: 3, step: 0.05 },
    { key: 'brightness', label: 'brightness', min: 0.2, max: 3, step: 0.01 },
    { key: 'contrast', label: 'contrast', min: 0.5, max: 2.5, step: 0.01 },
    { key: 'saturation', label: 'saturation', min: 0, max: 2.5, step: 0.01 },
    { key: 'vibrance', label: 'vibrance', min: 0, max: 2, step: 0.01 },
    { key: 'lift', label: 'black lift', min: 0, max: 0.08, step: 0.001 }
  ].map((d) => {
    // Lighting knobs are multipliers (reset 1); grade knobs start wherever
    // installGrade landed.
    const reset = LIGHT_KEYS.has(d.key) ? 1 : knobs[d.key].value;
    const value = Number.isFinite(saved[d.key]) ? saved[d.key] : reset;
    if (LIGHT_KEYS.has(d.key)) applyLight(d.key, value);
    else knobs[d.key].value = value;
    return { ...d, value, reset };
  });
  hud.buildGrade(defs, (key, value) => {
    if (LIGHT_KEYS.has(key)) applyLight(key, value);
    else if (knobs[key]) knobs[key].value = value;
    else return;
    saved[key] = value;
    try {
      localStorage.setItem(GRADE_STORE, JSON.stringify(saved));
    } catch {
      /* private mode */
    }
  });
}

// ---- bloom -----------------------------------------------------------------
/**
 * The map's bloom, without giving up the two-pass depth clear.
 *
 * Both wanted the same thing — control of where the scene is drawn — so the
 * scene goes into an HDR render target instead of the canvas, keeping the two
 * passes and the depth clear between them exactly as they were, and a single
 * fullscreen composite adds the bloom and puts it on screen.
 *
 * The scene is rendered with tone mapping OFF so the target holds linear HDR.
 * That is not a detail: the vmat thresholds bloom at 1.055, a number that only
 * means anything before tone mapping, and Source 2 extracts bloom from HDR for
 * the same reason. The composite then applies the graded curve and the map's
 * LUT once, at the end, which is also where the exposure lands.
 *
 * Tone mapping is switched once at setup, never per frame: it is part of every
 * material's shader cache key, so flipping it each frame would recompile the
 * world twice a frame. `PostProcessing.update()` bakes the graded curve into
 * the composite while the renderer still reports it, and the scene is left on
 * NoToneMapping afterwards.
 *
 * `?bloom=0` turns it off, which also restores the direct-to-canvas path.
 */
let sceneRT = null;
let composite = null;

function setupBloom(manifest) {
  const b = manifest.post?.bloom;
  // BLOOM_BLEND_SCREEN is the mode both maps author, and its strength is the
  // one that is actually non-zero (Dust 2 0.184, Nuke 0.0112).
  const strength = b ? b.screenStrength || b.strength || 0 : 0;
  if (!(strength > 0) || params.get('bloom') === '0') return false;
  try {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT = new THREE.RenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType, // linear HDR: bloom needs values above 1
      depthBuffer: true,
      // The scene still wants its multisampling; a plain target would hand back
      // the aliasing the canvas was created with `antialias: true` to avoid.
      // three's own PassNode takes the renderer's count the same way.
      samples: renderer.samples
    });
    const src = texture(sceneRT.texture, screenUV);
    const bl = bloom(src, strength, b.computeRadius ?? 0, b.threshold ?? 1);
    // Added rather than screen-blended: screen is defined on 0..1 and this is
    // an HDR buffer. At these strengths the two agree to well under a bit.
    composite = new THREE.PostProcessing(renderer, src.add(bl));
    // Bake the composite now, while the renderer still reports the graded
    // curve; from here on the scene renders untone-mapped.
    composite.update();
    renderer.toneMapping = THREE.NoToneMapping;
    return true;
  } catch (e) {
    // Never let the grade cost us the map: fall back to drawing straight to
    // the canvas with tone mapping in the materials, exactly as before.
    console.warn('cs3d: bloom unavailable, rendering direct', e);
    sceneRT?.dispose?.();
    sceneRT = null;
    composite = null;
    return false;
  }
}

// ---- render ----------------------------------------------------------------
/**
 * Two passes: the 3D skybox, then a depth clear, then the map.
 *
 * The skybox is drawn at its true ×16 size and distance, which is what makes
 * its parallax and the map's own haze come out right — but it also means its
 * ground genuinely passes through the map's floor (Dust 2's rock, Nuke's
 * asphalt). Sharing one depth buffer, whichever is nearer wins, and the
 * skybox's ground surfaces inside the playable space as a sheet of sludge.
 *
 * Source draws the skybox first and clears depth before the world, so the world
 * wins wherever it exists and the skybox shows only through the gaps. That is
 * exactly the rule wanted: the ground is hidden inside the map because there is
 * a floor in front of it, while hills, palms and rooftops stay visible over the
 * walls because nothing there occludes them — no bounds test, no per-map
 * tuning, and nothing that has to know which part of the skybox is "ground".
 *
 * One scene, so lights, fog and the probe stay shared; only the two roots are
 * toggled. `scene.background` has to be pulled for the second pass because
 * three unshifts it onto the render list whatever `autoClear` says.
 */
function renderFrame() {
  // The flat view is one pass to the canvas and nothing else. There is no 3D
  // skybox to draw first, so the depth clear and the second render have nothing
  // to separate, and the composite's HDR target and fullscreen pass would only
  // put the map's LUT back over greys chosen to be exact.
  if (fpsView.enabled) {
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    return;
  }
  // With bloom on, both passes go to the HDR target and the composite puts the
  // result on screen; without it, straight to the canvas as before.
  if (composite) renderer.setRenderTarget(sceneRT);
  drawScene();
  if (composite) {
    renderer.setRenderTarget(null);
    composite.render();
  }
}

function drawScene() {
  const sky = pack.sky3d;
  const world = pack.world;
  if (!sky || !world) {
    renderer.render(scene, camera);
    return;
  }
  const dome = lighting?.dome || null;
  // The shadow map is driven by hand (`shadow.autoUpdate = false`). The distant
  // pass must not consume a pending request, or the map's shadows get baked
  // from a scene with no map in it.
  const shadow = lighting?.sun?.castShadow ? lighting.sun.shadow : null;
  const wantShadow = shadow ? shadow.needsUpdate : false;
  if (shadow) shadow.needsUpdate = false;
  // Restored, not forced back on: the dome retires itself (visible = false)
  // the moment the map's real skybox lands, and forcing it would raise it from
  // the dead once a frame.
  const skyWas = sky.visible;
  const domeWas = dome ? dome.visible : false;

  world.visible = false;
  renderer.render(scene, camera); // clears colour + depth; background, dome, skybox
  renderer.clearDepth();

  world.visible = true;
  sky.visible = false;
  if (dome) dome.visible = false;
  if (shadow) shadow.needsUpdate = wantShadow;
  const background = scene.background;
  scene.background = null;
  renderer.autoClear = false;
  renderer.render(scene, camera);
  renderer.autoClear = true;
  scene.background = background;
  sky.visible = skyWas;
  if (dome) dome.visible = domeWas;
}

// ---- loop ------------------------------------------------------------------
let last = performance.now();
const _src = [0, 0, 0];
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  player.update(dt);
  // After the player: in POV the demo owns the camera, and writing second wins.
  demoView.update(now);
  if (demoView.active) hud.setDemoStatus(demoView.status());
  lighting?.update();
  pack.materials?.setTime(now / 1000);
  if (renderer.backend) renderFrame();
  updateInspector(now);
  // HUD read-outs are cheap; positions shown in Source coordinates.
  const p = camera.position;
  const s = sceneToSource(p.x, p.y - (player.mode === 'walk' ? player.eyeSmooth : 64), p.z);
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
  if (sceneRT) {
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT.setSize(Math.max(1, s.x), Math.max(1, s.y));
  }
  lighting?.resize();
});

boot();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  window.__cs3d = { THREE, scene, camera, player, get pack() { return pack; }, renderer, lighting: () => lighting, fpsView, demoView };
}
