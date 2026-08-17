// ---------------------------------------------------------------------------
// src/replays/viewer/view3d.js
// The 3D map inside the timeline viewer, in place of the radar canvas.
//
// This is deliberately NOT the standalone explorer (src/cs3d/main.js). That
// page owns a clock, a HUD and a key map; here the timeline already owns all
// three, and the 3D view is a renderer that gets told what to show. One
// direction of data: the viewer samples a tick, hands over the same `states`
// array the radar draws from, and this positions bodies against it. Nothing
// here reads a demo file, so 3D and 2D can never disagree about the moment
// being watched — they are the same numbers.
//
// It stays mounted once created. Switching back to 2D hides the canvas and
// stops the render loop; switching in again is a class toggle, not a reload,
// because streaming Nuke's pack costs seconds and the whole point of the
// button is flicking between the two views of one moment.
//
// Camera modes (F toggles the pair, G the other pair):
//   pov     recorded first person. Left click next player, right click previous.
//   third   behind that same player. Mouse look orbits; click still cycles.
//   fly     Map Practice noclip. WASD + pointer lock; G from a follow mode
//           lands here first.
//   walk    Map Practice walking body. Same Player as /nuke, same sim.
// Zoom changes the field of view (max 90). In third person the wheel dollies.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import '../../cs3d/cs3d.css';
import { MapPack } from '../../cs3d/mapLoader.js';
import { MapLighting } from '../../cs3d/sky.js';
import { patchWebGPUPartialAttributeUpload } from '../../cs3d/threePatches.js';
import { createLook, createMapRenderer, loadPostLut, installMapGrade, setupBloom } from '../../cs3d/look.js';
import { createBootScreen } from '../../cs3d/bootScreen.js';
import { sharedPlayerModels } from '../../cs3d/playerModels.js';
import { ViewModelAssets, ViewModel, createViewModelPass } from '../../cs3d/viewModel.js';
import { cs3dMap } from '../../../shared/cs3d/maps.js';
import { cameraYawFromSource } from '../../../shared/sim3d/units.js';
import {
  HULL_STAND,
  HULL_DUCK,
  EYE_STAND,
  EYE_DUCK,
  HULL_HALF_WIDE
} from '../../../shared/sim3d/constants.js';
import { FLAG_DUCKING, FLAG_AIRBORNE } from '../shared/tickFormat.js';
import { Player } from '../../cs3d/player.js';
import { Controls } from '../../cs3d/controls.js';
import { placeThirdPersonCamera, THIRD_PERSON_BACK } from '../../cs3d/thirdPerson.js';
import { mountCrosshair } from '../../cs3d/crosshairOverlay.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const TEAM_COLOR = { T: 0xd9a24a, CT: 0x5b87e0 };
const NADE_COLOR = {
  smokegrenade: 0xc8ccd0,
  flashbang: 0xfff0a8,
  hegrenade: 0xd8503a,
  molotov: 0xe87a28,
  incgrenade: 0xe87a28,
  decoy: 0x7fc46a
};
const SMOKE_SECONDS = 18;
const FIRE_SECONDS = 7;
const POP_SECONDS = 0.3;
const SMOKE_RADIUS = 144;
const FIRE_RADIUS = 110;

/** Scratch for the viewmodel's ambient sample; see updateViewModel. */
const _vmCube = new Float32Array(18);
const _vmColor = new THREE.Color();

const FOV_DEFAULT = 90;
const FOV_MIN = 25;
const FOV_MAX = 90;
const ORBIT_MIN = 40;
const ORBIT_MAX = 500;

export function createView3d({ slug, onModeChange }) {
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
  let lastNow = 0;

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
  let vmPass = null;
  /** The POV player's state for the viewmodel, rebuilt by applyFrame(). */
  let povState = null;
  /** Tick the shot scan last ran to, so each shot kicks the gun exactly once. */
  let shotTick = null;
  /** One line the first time the gun actually draws, so "no hands" is answerable. */
  let vmDrew = false;

  const bodies = [];
  const nades = new Map();
  let geo = null;
  let mats = null;

  function buildActors() {
    geo = {
      body: new THREE.CylinderGeometry(HULL_HALF_WIDE, HULL_HALF_WIDE, 1, 12),
      nose: new THREE.BoxGeometry(18, 9, 9),
      nade: new THREE.SphereGeometry(5, 10, 8),
      smoke: new THREE.SphereGeometry(SMOKE_RADIUS, 20, 14),
      fire: new THREE.CylinderGeometry(FIRE_RADIUS, FIRE_RADIUS, 6, 20),
      pop: new THREE.SphereGeometry(30, 12, 8)
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
      group.visible = false;
      // `model` is the animated agent once the pack is in; `prev` the last
      // sample this slot was drawn at, for the velocity the blend runs on.
      bodies.push({ group, body, nose, model: null, prev: null });
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
    camera = new THREE.PerspectiveCamera(FOV_DEFAULT, 16 / 9, 4, 120000);
    camera.rotation.order = 'YXZ';
    camera.fov = fov;
    scene.add(camera);
    player = new Player(camera);
    controls = new Controls(canvas, player, { pageKeys: false, lockOnClick: false });
    controls.setEnabled(false);
    const _look = player.look.bind(player);
    player.look = (dx, dy, rpc) => {
      _look(dx, dy, rpc);
      if (mode === 'third') applyThirdOrbit();
    };

    await renderer.init();
    patchWebGPUPartialAttributeUpload(renderer);

    const mapName = cs3dMap(slug)?.name || slug;
    boot = createBootScreen(container, mapName);

    pack = new MapPack({
      slug,
      scene,
      renderer,
      onProgress: (p) => boot.setProgress(p),
      onPhys: (collider) => player.setCollider(collider),
      onWorldChanged: () => lighting?.markShadowDirty()
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
    mapRenderer = createMapRenderer({
      renderer,
      scene,
      getPack: () => pack,
      getLighting: () => lighting,
      bloom: bloomPass,
      overlayAfter: new URLSearchParams(location.search).get('vm') === 'after',
      // Inside the scene pass, never after it — see createMapRenderer.
      overlay: () => {
        if (!viewModel.visible || !viewModel.ready) return false;
        vmPass.render();
        return true;
      }
    });
    lighting = new MapLighting(scene, camera, manifest, { shadows: true, renderer });
    pack.lightmapIntensity = lighting.lightmapIntensity;
    pack.sun = lighting.worldSun();
    pack.skyAmbient = lighting.skyAmbient;
    if (manifest.sky?.equirect) {
      lighting
        .loadSkybox(pack.base, manifest.sky, pack.v)
        .then(() => {
          pack.materials?.setSkyAmbient(lighting.skyAmbient);
          look.apply('sky');
        })
        .catch(() => {});
    }

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
      if (ok === false) return; // ViewModelAssets already logged why
      // Hands first, then something in them, so the first POV frame is armed
      // rather than waiting for the tick's weapon to resolve.
      viewModel.setSide('T');
      viewModel.setWeapon('knife', { draw: false });
      console.log(`cs3d: viewmodel ready (${Object.keys(vmAssets.manifest?.weapons || {}).length} weapons)`);
    });

    await pack.load(manifest);
    look.applyAll();
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
  function shotsCrossed(slot, tick, rate) {
    const shots = frame?.events?.shots;
    const from = shotTick;
    shotTick = tick;
    if (!shots?.length || from === null || !(tick > from) || tick - from > rate) return 0;
    const who = (frame.players || []).find((x) => x.slot === slot)?.id;
    let n = 0;
    for (const sh of shots) {
      if (sh.tick > from && sh.tick <= tick && (sh.slot === slot || (who !== undefined && sh.player === who))) n++;
    }
    return n;
  }

  /**
   * The gun, once per drawn frame.
   *
   * `dt` is wall time on purpose, unlike the bodies: sway and bob are the
   * viewer's own motion over a held frame, and a paused demo should still
   * settle rather than freeze mid-swing. What the demo owns — the weapon, the
   * angles, the speed, the trigger — comes from `povState`.
   */
  function updateViewModel(dt) {
    if (!viewModel.ready) return;
    const pov = mode === 'pov' ? povState : null;
    viewModel.visible = !!pov;
    if (!pov) return;
    if (!vmDrew) {
      vmDrew = true;
      console.log(`cs3d: viewmodel drawing — ${pov.side || '?'} hands, ${pov.weapon || 'no weapon in the tick'}`);
    }
    // Only a real side. `sideOf` falls back to '' when the round has no team
    // record for a slot, and `setSide('')` is not a no-op: it rebuilds the arms
    // and the mixer and clears every action. One '' frame between two 'CT'
    // frames would rebuild the rig twice a frame and leave the hands in bind
    // pose with no animation ever running.
    if (pov.side === 'T' || pov.side === 'CT') viewModel.setSide(pov.side);
    viewModel.setWeapon(pov.weapon || 'knife', { draw: false });
    for (let i = 0; i < pov.shots; i++) viewModel.attack('primary', 0);
    viewModel.update(dt, { speed: pov.speed, onGround: !pov.airborne, viewYaw: pov.yaw, viewPitch: pov.pitch });
    // The gun stands in the map's own light where that player stands, the same
    // ambient cube their body takes (mapLoader.js ProbeGrid).
    const grid = pack?.probeGrid;
    if (!grid) return;
    const cube = grid.sample(pov.eye.x, pov.eye.y, pov.eye.z, _vmCube);
    _vmColor.setRGB(
      (cube[6] + cube[0] + cube[3]) / 3,
      (cube[7] + cube[1] + cube[4]) / 3,
      (cube[8] + cube[2] + cube[5]) / 3
    );
    vmPass.setAmbient(_vmColor, 1.6);
  }

  function applyFrame() {
    if (!ready || !frame) return;
    const live = liveSlots();
    const follow = mode === 'pov' || mode === 'third';
    // A POV whose player died falls to the next live one rather than freezing.
    if (follow && live.length && !live.includes(povSlot)) {
      povSlot = live.find((s) => s > povSlot) ?? live[0];
    }
    const tick = frame.tick;
    const rate = frame.tickRate || 64;
    // Demo seconds since the last drawn frame: forward only (a scrub back
    // holds the pose at its new tick), and a jump of more than a quarter
    // second is a seek, not motion.
    const dTicks = lastTick === null ? 0 : tick - lastTick;
    const animDt = dTicks > 0 && dTicks <= rate / 4 ? dTicks / rate : 0;
    lastTick = tick;
    const useModels = models.ready;
    povState = null;

    for (let slot = 0; slot < bodies.length; slot++) {
      const s = frame.states[slot];
      const b = bodies[slot];
      if (!s || !s.alive) {
        b.group.visible = false;
        if (b.model) b.model.group.visible = false;
        b.prev = null;
        continue;
      }
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
          camera.rotation.set(-(s.pitch || 0) * DEG, cameraYawFromSource(s.yaw || 0), 0, 'YXZ');
          povState = {
            side,
            weapon: frame.weapons?.[s.weapon] || '',
            speed,
            airborne: (s.flags & FLAG_AIRBORNE) !== 0,
            yaw: s.yaw || 0,
            pitch: s.pitch || 0,
            eye: camera.position,
            shots: shotsCrossed(slot, tick, rate)
          };
        } else {
          if (!orbit.seeded) seedOrbitFromPlayer(s);
          applyThirdOrbit();
        }
      }
    }

    applyNades();
  }

  function nadeMesh(key, g, color, opacity) {
    let n = nades.get(key);
    if (n?.geo === g) return n.mesh;
    if (n) {
      n.mesh.removeFromParent();
      n.mesh.material.dispose();
    }
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 })
    );
    (pack.world || scene).add(mesh);
    nades.set(key, { mesh, geo: g });
    return mesh;
  }

  function dropNade(key) {
    const n = nades.get(key);
    if (!n) return;
    n.mesh.removeFromParent();
    n.mesh.material.dispose();
    nades.delete(key);
  }

  /** Derived fresh each frame, so scrubbing backwards needs no undo log. */
  function applyNades() {
    const list = frame.events?.grenades || [];
    const tick = frame.tick;
    const rate = frame.tickRate || 64;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const color = NADE_COLOR[g.type] ?? 0xffffff;
      const path = Array.isArray(g.path) ? g.path : [];
      const det = g.detonateTick ?? (path.length ? path[path.length - 1].tick : g.throwTick);

      if (tick >= g.throwTick && tick < det && path.length >= 2) {
        let k = 0;
        while (k + 2 < path.length && path[k + 1].tick <= tick) k++;
        const p0 = path[k];
        const p1 = path[Math.min(k + 1, path.length - 1)];
        const span = Math.max(1, p1.tick - p0.tick);
        const t = Math.max(0, Math.min(1, (tick - p0.tick) / span));
        const mesh = nadeMesh(i, geo.nade, color, 1);
        mesh.position.set(
          p0.x + (p1.x - p0.x) * t,
          p0.z + (p1.z - p0.z) * t,
          -(p0.y + (p1.y - p0.y) * t)
        );
        continue;
      }
      const at = g.at || (path.length ? path[path.length - 1] : null);
      const since = Number.isFinite(g.detonateTick) ? (tick - g.detonateTick) / rate : -1;
      if (at && since >= 0) {
        if (g.type === 'smokegrenade' && since < SMOKE_SECONDS) {
          nadeMesh(i, geo.smoke, 0xb8bcc0, 0.72).position.set(at.x, at.z + 30, -at.y);
          continue;
        }
        if ((g.type === 'molotov' || g.type === 'incgrenade') && since < FIRE_SECONDS) {
          nadeMesh(i, geo.fire, 0xe06818, 0.5).position.set(at.x, at.z + 4, -at.y);
          continue;
        }
        if ((g.type === 'flashbang' || g.type === 'hegrenade') && since < POP_SECONDS) {
          nadeMesh(i, geo.pop, color, 0.8 * (1 - since / POP_SECONDS)).position.set(at.x, at.z + 8, -at.y);
          continue;
        }
      }
      dropNade(i);
    }
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
    } else if (next === 'third') {
      controls.setEnabled(true);
      controls.requestLock();
    } else {
      controls.setEnabled(false);
    }
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
    updateViewModel(dt);
    pack?.materials?.setTime(t / 1000);
    lighting?.update();
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
    get povName() {
      if (povSlot < 0 || !frame) return null;
      const p = (frame.players || []).find((x) => x.slot === povSlot);
      return p?.name || null;
    },

    /** Create the scene. Safe to call once; later calls are no-ops. */
    async start(container) {
      if (renderer || failed) return;
      container.appendChild(canvas);
      crosshair = mountCrosshair(container);
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
        if (live.length) povSlot = live[0];
      }
      applyFrame();
    },

    show() {
      visible = true;
      canvas.hidden = false;
      if (crosshair) crosshair.hidden = false;
      if (isFree() || mode === 'third') controls.setEnabled(true);
      resize();
    },
    hide() {
      visible = false;
      canvas.hidden = true;
      if (crosshair) crosshair.hidden = true;
      controls?.setEnabled(false);
    },
    resize,

    /**
     * Cycle the selected player. `dir` +1 is left click (next), -1 is right
     * click (previous). Does not change fly/walk vs follow.
     */
    cyclePov(dir = 1) {
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
     * Unlocked fly/walk/third: click grabs the mouse. Else: cycle.
     * @returns {boolean}
     */
    pointerDown(button) {
      if ((mode === 'third' || isFree()) && controls && !controls.locked) {
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
      camera.fov = fov;
      camera.updateProjectionMatrix();
    },

    dispose() {
      cancelAnimationFrame(raf);
      controls?.dispose();
      crosshair?.remove();
      for (const key of [...nades.keys()]) dropNade(key);
      for (const b of bodies) b.model?.dispose();
      viewModel.dispose();
      pack?.dispose?.();
      renderer?.dispose?.();
      boot?.remove();
      canvas.remove();
      renderer = null;
      ready = false;
    }
  };
}
