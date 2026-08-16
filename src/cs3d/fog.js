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
 * Per-map multiplier on the authored fog strength, keyed by slug.
 *
 * Anubis authors an unusually long ramp — gradient 150 → 100000 over a map
 * ~4500 units across, so under 5% of the way up it at any sightline you
 * actually have — and reads clear where the game reads hazy. Multiplying the
 * strength rather than shortening the ramp keeps the shape the author gave it.
 */
const MAP_FOG = {
  anubis: 4
};

/**
 * Fog for a map, ready to hand to `scene.fogNode`.
 *
 * The DISTANCE ramp needs no special case for the 3D skybox: the loader draws
 * it at its real ×16 size and distance rather than as a miniature around the
 * camera, so the same ramp fogs the far hills exactly as much as the game does.
 *
 * The HEIGHT ramp does. It is authored against the miniature, which in the game
 * sits inside the band — Anubis fogs from y 0 to 15000, and its skybox in the
 * game is a model a few hundred units tall. Drawn at ×16 that model reaches
 * past 15000, where the ramp has already fallen to zero, so Anubis lost the
 * haze on everything distant while Nuke (band ±100000, effectively unbounded)
 * kept it. `skyNode` is the same fog with the height band scaled by the same
 * ×16, which puts the enlarged skybox back where the author put the model.
 * Scaling the band for the world pass instead would be wrong: the playable map
 * is at its authored size and its height falloff is real.
 */
export class MapFog {
  /**
   * @param {object} manifest  pack manifest (fog, bounds, sky3d)
   */
  constructor(manifest) {
    const raw = manifest?.fog || fallbackFog(manifest);
    const k = MAP_FOG[manifest?.map?.slug] || 1;
    // Applied to `strength`, which rampFactor multiplies in before the clamp,
    // so it scales the whole curve without touching the distances.
    const boost = (o) => (o ? { ...o, strength: (o.strength ?? 1) * k } : null);
    const spec = k === 1 ? raw : { cubemap: boost(raw?.cubemap), gradient: boost(raw?.gradient) };
    this.spec = spec;
    this.cube = spec?.cubemap ? layerUniforms(spec.cubemap) : null;
    this.grad = spec?.gradient ? layerUniforms(spec.gradient) : null;
    const skyScale = Number(manifest?.sky3d?.scale) || 0;
    const lift = (o) => (o ? { ...o, heightStart: o.heightStart * skyScale, heightEnd: o.heightEnd * skyScale } : null);
    this.cubeSky = skyScale > 1 && spec?.cubemap ? layerUniforms(lift(spec.cubemap)) : null;
    this.gradSky = skyScale > 1 && spec?.gradient ? layerUniforms(lift(spec.gradient)) : null;

    // Sky fit, updated by MapLighting as the real sky arrives.
    this.horizon = uniform(new THREE.Color(0.62, 0.72, 0.85));
    this.zenith = uniform(new THREE.Color(0.32, 0.5, 0.8));
    this.sunColor = uniform(new THREE.Color(1, 0.95, 0.85));
    this.toSun = uniform(new THREE.Vector3(0, 1, 0));
    this.gradColor = uniform(
      spec?.gradient ? new THREE.Color(...spec.gradient.color) : new THREE.Color(0.6, 0.68, 0.8)
    );
    this.node = this.cube || this.grad ? this._build(this.cube, this.grad) : null;
    // Swapped in for the distant pass (see main.js drawScene). Falls back to the
    // world node when the map has no 3D skybox to scale for.
    this.skyNode = this.cubeSky || this.gradSky ? this._build(this.cubeSky, this.gradSky) : this.node;
  }

  _build(cube, grad) {
    const dist = positionWorld.distance(cameraPosition);
    const height = positionWorld.y;
    // The direction we are looking, which is the direction the fog takes its
    // colour from. Horizon below ~0.35, zenith above; a wide lobe around the
    // sun carries the warm side of the haze.
    const dir = normalize(positionWorld.sub(cameraPosition));
    const up = smoothstep(0, 0.35, dir.y);
    const sun = pow(max(dot(dir, this.toSun), 0), float(6)).mul(0.5);
    const skyColor = mix(this.horizon, this.zenith, up).add(this.sunColor.mul(sun));

    const aCube = cube ? rampFactor(dist, height, cube) : float(0);
    const aGrad = grad ? rampFactor(dist, height, grad) : float(0);

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
