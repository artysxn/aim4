// ---------------------------------------------------------------------------
// src/cs3d/xray.js
// GOTV-style through-wall outlines: each player is drawn into a mask
// (their own shape, unlit, no world geometry), then a fullscreen composite
// paints a T-red or CT-blue halo around its edge. The fill stays in the
// mask so the edge can be found; it is not composited, so the playermodel
// is not painted black. Name, health and loadout icons sit in HTML above
// the head.
//
// Non-player meshes are hidden for the mask pass so the silhouette camera
// never sees a wall. Viewmodels are a different scene and never enter it.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { float, max, screenUV, texture, uniform, vec2, vec4 } from 'three/webgpu';
import { EYE_DUCK, EYE_STAND } from '../../shared/sim3d/constants.js';
import {
  bareWeapon,
  hudLoadout,
  iconImgHtml,
  iconSrc,
  isKnife
} from '../replays/viewer/equipmentIcons.js';

/** Camera / mesh layer used only by the silhouette pass. */
export const XRAY_LAYER = 1;

/** Site T / CT: `--rv-t` / `--rv-ct`. */
export const XRAY_FILL_T = 0xe60611;
export const XRAY_FILL_CT = 0x5b9fd4;

const HEAD_PAD = 14;
const RING = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
  [2, 2],
  [-2, 2],
  [2, -2],
  [-2, -2],
  [3, 0],
  [-3, 0],
  [0, 3],
  [0, -3],
  [4, 0],
  [-4, 0],
  [0, 4],
  [0, -4]
];

const _proj = new THREE.Vector3();
const _size = new THREE.Vector2();

export function xrayFillColor(side) {
  return side === 'CT' ? XRAY_FILL_CT : XRAY_FILL_T;
}

export function xrayHeadOffset(duck = 0) {
  const d = Math.max(0, Math.min(1, Number(duck) || 0));
  return EYE_STAND + (EYE_DUCK - EYE_STAND) * d + HEAD_PAD;
}

/**
 * Util icons, then the rifle slot, then the pistol. Knife is omitted; that
 * matches the GOTV stack in the reference shots.
 */
export function xrayIconList(inv) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const b = bareWeapon(name);
    if (!b || seen.has(b) || isKnife(b)) return;
    if (!iconSrc(b)) return;
    seen.add(b);
    out.push(b);
  };
  for (const u of inv?.util || []) add(u);
  const slots = hudLoadout(inv);
  add(slots.primary);
  add(slots.pistol);
  if (!slots.primary && !slots.pistol) add(slots.held || inv?.active);
  return out;
}

export function markXrayObject(root, on = true) {
  if (!root) return;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (on) o.layers.enable(XRAY_LAYER);
    else o.layers.disable(XRAY_LAYER);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function shown(obj) {
  let o = obj;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

function swapSilhouette(objects, silMat) {
  const stash = [];
  for (const obj of objects) {
    obj.traverse((o) => {
      if (!o.isMesh) return;
      stash.push([o, o.material]);
      o.material = silMat;
    });
  }
  return stash;
}

/** True when `obj` is one of `roots` or nested under one. */
export function meshBelongsTo(obj, roots) {
  const set = roots instanceof Set ? roots : new Set(roots || []);
  let o = obj;
  while (o) {
    if (set.has(o)) return true;
    o = o.parent;
  }
  return false;
}

/**
 * Hide every mesh that is not under a subject. WebGPU's camera `layers` do
 * not always isolate the silhouette pass, which left X-ray drawing an empty
 * mask (X appeared to do nothing). Restores with the returned list.
 */
function hideNonSubjects(scene, roots) {
  const hidden = [];
  if (!scene) return hidden;
  scene.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    if (meshBelongsTo(o, roots)) return;
    o.visible = false;
    hidden.push(o);
  });
  return hidden;
}

/**
 * @param {object} o
 * @param {import('three').WebGPURenderer} o.renderer
 * @param {import('three').Scene} o.scene
 * @param {HTMLElement} o.parent
 */
export function createXrayPass({ renderer, scene, parent }) {
  let enabled = false;
  let rt = null;
  let glowMat = null;
  let glowReady = false;
  const fillUniform = uniform(new THREE.Color(XRAY_FILL_T));
  const texel = uniform(new THREE.Vector2(1, 1));
  const silMat = new THREE.MeshBasicNodeMaterial({
    toneMapped: false,
    fog: false,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide
  });
  // RGB + opaque alpha. A Color uniform alone often writes a=0 on WebGPU, which
  // emptied the mask (names with no outline). Black RGB with a=1 filled bodies.
  silMat.colorNode = vec4(fillUniform, float(1));

  const xrayCam = new THREE.PerspectiveCamera();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const prevClear = new THREE.Color();
  const labels = document.createElement('div');
  labels.className = 'c3-xray-labels';
  labels.hidden = true;
  parent.appendChild(labels);
  const tags = new Map();

  function ensureRt() {
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(1, _size.x | 0);
    const h = Math.max(1, _size.y | 0);
    if (!rt) {
      rt = new THREE.RenderTarget(w, h, {
        type: THREE.UnsignedByteType,
        depthBuffer: true,
        samples: 0
      });
      rt.texture.colorSpace = THREE.NoColorSpace;
      buildGlow();
    } else if (rt.width !== w || rt.height !== h) {
      rt.setSize(w, h);
    }
    texel.value.set(1 / w, 1 / h);
  }

  function buildGlow() {
    glowMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: false
    });
    try {
      const fill = texture(rt.texture, screenUV);
      let halo = fill.a;
      for (const [x, y] of RING) {
        const uv = screenUV.add(texel.mul(vec2(x, y)));
        halo = max(halo, texture(rt.texture, uv).a);
      }
      const edge = max(halo.sub(fill.a), float(0));
      // Rim only. Interior alpha stays 0 so the textured body is not covered,
      // and we never composite the mask's fill (that used to paint players black).
      glowMat.colorNode = vec4(fill.rgb, edge);
      glowReady = true;
    } catch (e) {
      console.warn('cs3d: x-ray glow unavailable, drawing rim from mask alpha', e);
      const fill = texture(rt.texture, screenUV);
      glowMat.colorNode = vec4(fill.rgb, fill.a.mul(float(0)));
      glowReady = true;
    }
    quad.material = glowMat;
  }

  function render(camera, subjects) {
    if (!enabled || !camera || !subjects?.length) return;
    const live = subjects.filter((s) => s.object && shown(s.object));
    if (!live.length) return;
    ensureRt();
    if (!glowReady) return;

    const terrorists = [];
    const cts = [];
    for (const s of live) {
      if (xrayFillColor(s.side) === XRAY_FILL_CT) cts.push(s.object);
      else terrorists.push(s.object);
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevBg = scene.background;
    const prevFog = scene.fogNode;
    const prevAlpha = renderer.getClearAlpha?.() ?? 1;
    renderer.getClearColor?.(prevClear);
    const objects = live.map((s) => s.object);
    const stash = swapSilhouette(objects, silMat);
    const hidden = hideNonSubjects(scene, objects);

    xrayCam.copy(camera);
    xrayCam.layers.enableAll();

    try {
      renderer.setRenderTarget(rt);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      scene.background = null;
      scene.fogNode = null;
      renderer.clear();
      renderer.autoClear = false;

      if (terrorists.length) {
        for (const o of cts) o.visible = false;
        fillUniform.value.setHex(XRAY_FILL_T);
        renderer.render(scene, xrayCam);
        for (const o of cts) o.visible = true;
      }
      if (cts.length) {
        for (const o of terrorists) o.visible = false;
        fillUniform.value.setHex(XRAY_FILL_CT);
        renderer.render(scene, xrayCam);
        for (const o of terrorists) o.visible = true;
      }
    } finally {
      for (const o of cts) o.visible = true;
      for (const o of terrorists) o.visible = true;
      for (const o of hidden) o.visible = true;
      for (const [o, m] of stash) o.material = m;
      scene.background = prevBg;
      scene.fogNode = prevFog;
      renderer.setClearColor?.(prevClear, prevAlpha);
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = false;
    try {
      renderer.render(quadScene, quadCam);
    } catch (e) {
      console.warn('cs3d: x-ray composite failed', e);
    }
    renderer.autoClear = prevAuto;
  }

  function updateLabels(camera, subjects) {
    if (!enabled || !camera || !parent) {
      labels.hidden = true;
      return;
    }
    const live = (subjects || []).filter((s) => s.object && shown(s.object));
    if (!live.length) {
      labels.hidden = true;
      return;
    }
    labels.hidden = false;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const seen = new Set();
    for (const s of live) {
      const id = String(s.id);
      seen.add(id);
      s.object.updateWorldMatrix(true, false);
      const duck = s.duck ?? 0;
      _proj.set(0, xrayHeadOffset(duck), 0);
      s.object.localToWorld(_proj);
      _proj.project(camera);
      if (_proj.z < 0 || _proj.z > 1 || Math.abs(_proj.x) > 1.15 || Math.abs(_proj.y) > 1.15) {
        const el = tags.get(id);
        if (el) el.hidden = true;
        continue;
      }
      let el = tags.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'c3-xray-tag';
        labels.appendChild(el);
        tags.set(id, el);
      }
      const name = String(s.name || '').trim();
      const hp = Math.max(0, Math.min(100, Math.round(Number(s.hp) || 0)));
      const side = s.side === 'CT' ? 'CT' : 'T';
      const key = `${name}|${hp}|${side}|${(s.items || []).join(',')}`;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.className = `c3-xray-tag is-${side.toLowerCase()}`;
        const icons = (s.items || []).map((n) => iconImgHtml(n, 'c3-xray-icon')).join('');
        el.innerHTML =
          `<div class="c3-xray-icons">${icons}</div>` +
          (name ? `<div class="c3-xray-name">${esc(name)}</div>` : '') +
          `<div class="c3-xray-hp">${hp}%</div>` +
          `<div class="c3-xray-ptr"></div>`;
      }
      el.hidden = false;
      const x = (_proj.x * 0.5 + 0.5) * w;
      const y = (-_proj.y * 0.5 + 0.5) * h;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of tags) {
      if (!seen.has(id)) {
        el.remove();
        tags.delete(id);
      }
    }
  }

  function resize() {
    if (rt) ensureRt();
  }

  function dispose() {
    labels.remove();
    tags.clear();
    rt?.dispose();
    silMat.dispose();
    glowMat?.dispose();
    quad.geometry.dispose();
  }

  return {
    get enabled() {
      return enabled;
    },
    set enabled(on) {
      enabled = !!on;
      if (!enabled) {
        labels.hidden = true;
        for (const el of tags.values()) el.hidden = true;
      }
    },
    toggle() {
      this.enabled = !enabled;
      return enabled;
    },
    render,
    updateLabels,
    resize,
    dispose
  };
}
