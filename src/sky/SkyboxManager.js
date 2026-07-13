// ---------------------------------------------------------------------------
// SkyboxManager.js — optional cubemap sky with hue/sat/brightness/contrast/opacity.
// Blends toward colors.bg when opacity < 1 so the background color still shows.
// Optional in-shader glow (skyboxPostFx) — bright-region extract + blur + add.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { skyboxById } from './skyboxCatalog.js';
import { resolveSkyboxGlowConfig } from '../utils/skyboxGlowConfig.js';

const SKY_RADIUS = 420;

const SKY_VERTEX = /* glsl */`
varying vec3 vWorldDir;
void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = worldPos.xyz - cameraPosition;
  vec4 mvPos = viewMatrix * vec4(worldPos.xyz, 1.0);
  gl_Position = projectionMatrix * mvPos;
}
`;

const SKY_FRAGMENT = /* glsl */`
uniform samplerCube tCube;
uniform vec3 uBgColor;
uniform float uOpacity;
uniform float uHue;
uniform float uSaturation;
uniform float uBrightness;
uniform float uContrast;
uniform float uGlowStrength;
uniform float uGlowRadius;
uniform float uGlowThreshLo;
uniform float uGlowThreshHi;
varying vec3 vWorldDir;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 gradeSky(vec3 texLin) {
  vec3 hsv = rgb2hsv(clamp(texLin, 0.0, 1.0));
  hsv.x = fract(hsv.x + uHue);
  hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0);
  vec3 col = hsv2rgb(hsv);
  col = (col - 0.5) * uContrast + 0.5;
  col *= uBrightness;
  return clamp(col, 0.0, 1.0);
}

vec3 sampleSky(vec3 dir) {
  return gradeSky(pow(texture(tCube, dir).rgb, vec3(2.2)));
}

vec3 extractGlow(vec3 col) {
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float mask = smoothstep(uGlowThreshLo, uGlowThreshHi, lum);
  return col * mask;
}

vec3 blurSkyGlow(vec3 dir) {
  float s = uGlowRadius;
  vec3 sum = extractGlow(sampleSky(dir));
  float w = 1.0;
  sum += extractGlow(sampleSky(normalize(dir + vec3(s, 0.0, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(-s, 0.0, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(0.0, s, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(0.0, -s, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(0.0, 0.0, s))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(0.0, 0.0, -s))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(s, s, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(-s, s, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(s, -s, 0.0))));
  sum += extractGlow(sampleSky(normalize(dir + vec3(-s, -s, 0.0))));
  w += 9.0;
  return sum / w;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 col = sampleSky(dir);

  if (uGlowStrength > 0.0) {
    vec3 glow = blurSkyGlow(dir);
    col += glow * uGlowStrength;
    col = clamp(col, 0.0, 1.0);
  }

  vec3 bg = pow(uBgColor, vec3(2.2));
  col = mix(bg, col, uOpacity);
  col = pow(col, vec3(1.0 / 2.2));

  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyboxManager {
  constructor(scene) {
    this.scene = scene;
    this._mesh = null;
    this._material = null;
    this._loader = new THREE.CubeTextureLoader();
    this._cache = new Map();
    this._loadToken = 0;
    this._activeId = null;
    this._enabled = false;
  }

  _ensureMesh() {
    if (this._mesh) return;
    const geo = new THREE.BoxGeometry(SKY_RADIUS, SKY_RADIUS, SKY_RADIUS);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tCube: { value: null },
        uBgColor: { value: new THREE.Color(0x0a0a0a) },
        uOpacity: { value: 1 },
        uHue: { value: 0 },
        uSaturation: { value: 1 },
        uBrightness: { value: 1 },
        uContrast: { value: 1 },
        uGlowStrength: { value: 0 },
        uGlowRadius: { value: 0.055 },
        uGlowThreshLo: { value: 0.18 },
        uGlowThreshHi: { value: 0.55 }
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false
    });
    this._mesh = new THREE.Mesh(geo, this._material);
    this._mesh.name = 'customSkybox';
    this._mesh.renderOrder = -1000;
    this._mesh.frustumCulled = false;
    this.scene.add(this._mesh);
    this._mesh.visible = false;
  }

  syncUniforms(settings) {
    if (!this._material) return;
    const s = settings ?? {};
    const u = this._material.uniforms;
    u.uBgColor.value.set(s.colors?.bg ?? '#0a0a0a');
    u.uOpacity.value = clamp01((s.skyboxOpacity ?? 100) / 100);
    u.uHue.value = (s.skyboxHue ?? 0) / 360;
    u.uSaturation.value = clamp((s.skyboxSaturation ?? 100) / 100, 0, 3);
    u.uBrightness.value = clamp((s.skyboxBrightness ?? 100) / 100, 0, 3);
    u.uContrast.value = clamp((s.skyboxContrast ?? 100) / 100, 0, 3);

    const gc = resolveSkyboxGlowConfig(s.skyboxGlowConfig);
    const postFx = s.skyboxPostFx !== false;
    const enabled = s.customSkybox === true && postFx;
    u.uGlowStrength.value = enabled ? gc.strength : 0;
    u.uGlowRadius.value = gc.radius;
    u.uGlowThreshLo.value = gc.threshold;
    u.uGlowThreshHi.value = Math.max(gc.threshold + 0.01, gc.thresholdSoft);
  }

  _loadTexture(entry) {
    if (this._cache.has(entry.id)) {
      const tex = this._cache.get(entry.id);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return Promise.resolve(tex);
    }
    return new Promise((resolve, reject) => {
      this._loader.load(
        entry.urls,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          this._cache.set(entry.id, tex);
          resolve(tex);
        },
        undefined,
        reject
      );
    });
  }

  apply(settings) {
    const s = settings ?? {};
    const enabled = s.customSkybox === true;
    this._enabled = enabled;

    if (!enabled) {
      if (this._mesh) this._mesh.visible = false;
      return;
    }

    this._ensureMesh();
    const entry = skyboxById(s.skyboxId);
    if (!entry) {
      this._mesh.visible = false;
      return;
    }

    this.syncUniforms(s);
    this._mesh.visible = true;

    if (this._activeId === entry.id && this._material.uniforms.tCube.value) return;

    const token = ++this._loadToken;
    this._loadTexture(entry)
      .then((tex) => {
        if (token !== this._loadToken) return;
        this._activeId = entry.id;
        this._material.uniforms.tCube.value = tex;
        this._mesh.visible = this._enabled;
      })
      .catch((err) => {
        console.error('[skybox] failed to load cubemap', entry.id, err);
        if (token === this._loadToken) this._mesh.visible = false;
      });
  }

  update(camera) {
    if (!this._mesh?.visible || !camera) return;
    this._mesh.position.copy(camera.position);
  }

  dispose() {
    if (this._mesh) {
      this.scene.remove(this._mesh);
      this._mesh.geometry.dispose();
      this._material.dispose();
      this._mesh = null;
      this._material = null;
    }
    for (const tex of this._cache.values()) tex.dispose();
    this._cache.clear();
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}
