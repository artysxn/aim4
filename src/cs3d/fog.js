// ---------------------------------------------------------------------------
// src/cs3d/fog.js
// The map's atmosphere, from its own two fog entities.
//
// This is the single biggest thing separating a Source 2 map on screen from
// the same map in the game. CS2 draws every surface through a haze that grows
// with distance and thins with height; take it away and a 3000-unit sightline
// is as crisp as a wall two feet in front of you, the 3D skybox reads as a
// cardboard cut-out instead of a horizon, and the whole scene looks like a
// model rather than a place. Both entities are on every map:
//
//   env_cubemap_fog    the main layer. Its colour is the SKY, in the direction
//                      you are looking: the haze goes warm toward the sun and
//                      cool away from it, and brightens toward the zenith. All
//                      ten maps have one.
//   env_gradient_fog   a flat-coloured layer composited over the top; six of
//                      the ten maps use it.
//
// Both are the same shape — a distance ramp times a height ramp, each with its
// own exponent — so one Fn covers both.
//
// The sky colour is a measured three-term fit (horizon, zenith, a lobe around
// the sun) rather than a per-pixel lookup into the prefiltered environment.
// That is deliberate: the fog colour then lives in uniforms, so swapping the
// procedural sky for the map's real one is a uniform write instead of a shader
// rebuild across every material in the scene. A cubemap fog reads its sky at
// `cubemapfoglodbiase` blur anyway, and at that blur a sky IS a vertical
// gradient with a sun lobe on it.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  dot,
  float,
  fog,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec3
} from 'three/webgpu';

/** Guard against a fog whose start and end are the same number. */
const span = (a, b) => (Math.abs(b - a) < 1e-3 ? 1e-3 : b - a);

/**
 * A distance × height ramp, Source 2's shape for both fog entities:
 *
 *   distance   0 at `start`, 1 at `end`, raised to `falloff`
 *   height     1 at or below `heightStart`, 0 at or above `heightEnd`,
 *              raised to `heightExponent`
 *
 * times the entity's strength, capped at its max opacity.
 */
function rampFactor(dist, height, p) {
  const d = clamp(dist.sub(p.start).div(p.range), 0, 1);
  const h = clamp(p.heightEnd.sub(height).div(p.heightRange), 0, 1);
  return clamp(pow(d, p.falloff).mul(pow(h, p.heightExponent)).mul(p.strength), 0, 1).mul(p.maxOpacity);
}

/** Uniforms for one fog layer, from its manifest block. */
function layerUniforms(o) {
  return {
    start: uniform(o.start),
    range: uniform(span(o.start, o.end)),
    falloff: uniform(Math.max(0.01, o.falloff ?? 1)),
    strength: uniform(o.strength ?? 1),
    maxOpacity: uniform(clampNum(o.maxOpacity ?? 1, 0, 1)),
    heightEnd: uniform(o.heightEnd),
    heightRange: uniform(span(o.heightStart, o.heightEnd)),
    heightExponent: uniform(Math.max(0.01, o.heightExponent ?? 1))
  };
}

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : hi));

/**
 * Fog for a map, ready to hand to `scene.fogNode`.
 *
 * The 3D skybox needs no special case: the loader draws it at its real ×16
 * size and distance rather than as a miniature around the camera, so the same
 * distance ramp fogs the far hills exactly as much as the game does — which is
 * a lot, and is why the game's horizon looks like a horizon.
 */
export class MapFog {
  /**
   * @param {object} manifest  pack manifest (fog, bounds)
   */
  constructor(manifest) {
    const spec = manifest?.fog || fallbackFog(manifest);
    this.spec = spec;
    this.cube = spec?.cubemap ? layerUniforms(spec.cubemap) : null;
    this.grad = spec?.gradient ? layerUniforms(spec.gradient) : null;

    // Sky fit, updated by MapLighting as the real sky arrives.
    this.horizon = uniform(new THREE.Color(0.62, 0.72, 0.85));
    this.zenith = uniform(new THREE.Color(0.32, 0.5, 0.8));
    this.sunColor = uniform(new THREE.Color(1, 0.95, 0.85));
    this.toSun = uniform(new THREE.Vector3(0, 1, 0));
    this.gradColor = uniform(
      spec?.gradient ? new THREE.Color(...spec.gradient.color) : new THREE.Color(0.6, 0.68, 0.8)
    );
    this.node = this.cube || this.grad ? this._build() : null;
  }

  _build() {
    const dist = positionWorld.distance(cameraPosition);
    const height = positionWorld.y;
    // The direction we are looking, which is the direction the fog takes its
    // colour from. Horizon below ~0.35, zenith above; a wide lobe around the
    // sun carries the warm side of the haze.
    const dir = normalize(positionWorld.sub(cameraPosition));
    const up = smoothstep(0, 0.35, dir.y);
    const sun = pow(max(dot(dir, this.toSun), 0), float(6)).mul(0.5);
    const skyColor = mix(this.horizon, this.zenith, up).add(this.sunColor.mul(sun));

    const aCube = this.cube ? rampFactor(dist, height, this.cube) : float(0);
    const aGrad = this.grad ? rampFactor(dist, height, this.grad) : float(0);

    // Two "over" composites folded into the one (colour, factor) pair a
    // FogNode can express: sky haze first, flat gradient layer on top.
    const cubeShare = aCube.mul(aGrad.oneMinus());
    const total = cubeShare.add(aGrad);
    const color = skyColor.mul(cubeShare).add(this.gradColor.mul(aGrad)).div(max(total, float(1e-4)));
    return fog(vec3(color), total);
  }

  /**
   * Point the haze at the sky that is actually on screen.
   * @param {{horizon: THREE.Color, zenith: THREE.Color, sunColor: THREE.Color, toSun: THREE.Vector3}} o
   */
  setSky({ horizon, zenith, sunColor, toSun }) {
    if (horizon) this.horizon.value.copy(horizon);
    if (zenith) this.zenith.value.copy(zenith);
    if (sunColor) this.sunColor.value.copy(sunColor);
    if (toSun) this.toSun.value.copy(toSun);
  }
}

/**
 * A pack from before the fog entities were read still has to look like a map
 * and not a diorama, so size a single haze layer off the map's own bounds:
 * clear for the first eighth of the diagonal, fully hazed a little past it,
 * thinning out over the height the map actually occupies.
 */
function fallbackFog(manifest) {
  const b = manifest?.bounds;
  if (!b?.min || !b?.max) return null;
  const dx = b.max[0] - b.min[0];
  const dz = b.max[2] - b.min[2];
  const diag = Math.max(1000, Math.hypot(dx, dz));
  const top = b.max[1];
  return {
    gradient: null,
    cubemap: {
      start: diag * 0.12,
      end: diag * 1.6,
      falloff: 1.2,
      maxOpacity: 0.9,
      heightStart: b.min[1],
      heightEnd: top + (top - b.min[1]) * 2,
      heightExponent: 1
    }
  };
}
