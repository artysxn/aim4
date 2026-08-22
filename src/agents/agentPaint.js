// ---------------------------------------------------------------------------
// src/agents/agentPaint.js
// How a CS2 agent is shaded in the trainer: the light, and the paint.
//
// Both exist because a trainer arena is not a map. The 3D map practice mode
// lights a body from the map's baked probe grid and the map's sun, so a player
// darkens under a ceiling and brightens in the open — correct there, and wrong
// here twice over. The arenas have no bake to sample, and more importantly a
// TARGET whose readability changes with which way it happens to be facing is a
// target that trains the wrong thing.
//
// ## The light: baked into the model's own frame
//
// `staticLighting()` patches a standard material so its lighting normal skips
// the object's world rotation. three normally does
//
//     transformedNormal = normalMatrix * objectNormal;   // model → view
//
// and `normalMatrix` carries the model's rotation as well as the camera's.
// Dropping the model half — `mat3( viewMatrix ) * objectNormal` — lights the
// body as though its own local axes were the world's. So:
//
//   · turning a bot around changes nothing about how it is lit;
//   · moving it across the arena changes nothing either;
//   · but a raised arm is still lit as a raised arm, because the normal is
//     still the SKINNED one. That is the difference between this and baking a
//     bind-pose term into the vertices, which would light a running body as
//     though it were standing to attention.
//
// The camera's rotation stays in, because the lights themselves live in view
// space; taking it out too would nail the highlight to the screen.
//
// ## The paint: four body groups, from the skin weights
//
// The agents ship five materials, split by what a surface is made of (cloth,
// gasmask, gloves), not by which part of the body it is — so "colour the head"
// cannot be done by material. What DOES know is the skeleton: every vertex is
// weighted to bones, and a bone knows whether it is a head, a torso, an arm or
// a leg. `buildVertexGroups` reads the dominant bone per vertex once per
// geometry and `applyGroupColors` writes the four colours into a vertex-colour
// attribute, which costs no extra draw calls and no shader of our own.
//
// The geometry is shared by every body cloned from one template, so a colour
// change is one buffer rewrite for all of them.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** The four paintable parts, in the order the colour array uses. */
export const BODY_GROUPS = Object.freeze(['head', 'torso', 'arms', 'legs']);

const HEAD = 0;
const TORSO = 1;
const ARMS = 2;
const LEGS = 3;

/**
 * Which part of the body a bone belongs to.
 *
 * Order matters: `arm_lower_L_TWIST` is an arm and `head_0_TWIST` is a head,
 * so the specific prefixes are tested before anything generic. Shoulders
 * (`clavicle`, `scapula`, `scap_*`) are TORSO, matching the pack's own hit
 * table — its arm boxes start at `arm_upper_*` and the chest boxes cover the
 * rest.
 */
export function groupForBone(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return TORSO;
  if (n.startsWith('head') || n.startsWith('neck') || n.startsWith('eye') || n === 'jiggle_hood') return HEAD;
  if (n.startsWith('arm_') || n.startsWith('hand_') || n.startsWith('finger_')) return ARMS;
  if (n.startsWith('leg_') || n.startsWith('ankle') || n.startsWith('ball_') || n.startsWith('jiggle_climbinggear')) return LEGS;
  return TORSO;
}

/**
 * Per-vertex body group for one skinned mesh, cached on its geometry.
 *
 * The dominant bone, not a weighted mix: a blend across a shoulder would paint
 * a band of neither colour, and the point of the flat mode is that a part
 * reads as one flat colour you can pick out instantly.
 */
export function buildVertexGroups(mesh) {
  const geo = mesh?.geometry;
  if (!geo) return null;
  if (geo.userData.agentGroups) return geo.userData.agentGroups;
  const pos = geo.getAttribute('position');
  const idx = geo.getAttribute('skinIndex');
  const wgt = geo.getAttribute('skinWeight');
  const n = pos ? pos.count : 0;
  const groups = new Uint8Array(n);
  const bones = mesh.skeleton?.bones || [];
  if (idx && wgt && bones.length) {
    for (let v = 0; v < n; v++) {
      let best = -1;
      let bestW = -1;
      for (let c = 0; c < 4; c++) {
        const w = wgt.getComponent(v, c);
        if (w > bestW) {
          bestW = w;
          best = idx.getComponent(v, c);
        }
      }
      // A vertex weighted to nothing is torso; better one flat body than a
      // hole of undefined colour.
      groups[v] = bestW > 0 && bones[best] ? groupForBone(bones[best].name) : TORSO;
    }
  } else {
    groups.fill(TORSO);
  }
  geo.userData.agentGroups = groups;
  return groups;
}

const _c = new THREE.Color();

/**
 * Write the four group colours into the geometry's vertex-colour attribute.
 *
 * `THREE.Color.set` converts an sRGB hex into the renderer's working space, so
 * what lands in the buffer is linear — which is what three expects a `color`
 * attribute to hold. Skipping that step is the classic washed-out result.
 */
export function applyGroupColors(geo, colors) {
  const groups = geo?.userData?.agentGroups;
  if (!groups) return null;
  const n = groups.length;
  let attr = geo.getAttribute('color');
  if (!attr || attr.count !== n || attr.itemSize !== 3) {
    attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    geo.setAttribute('color', attr);
  }
  const rgb = new Float32Array(BODY_GROUPS.length * 3);
  for (let g = 0; g < BODY_GROUPS.length; g++) {
    _c.set(colors?.[BODY_GROUPS[g]] ?? '#ffffff');
    rgb[g * 3] = _c.r;
    rgb[g * 3 + 1] = _c.g;
    rgb[g * 3 + 2] = _c.b;
  }
  const out = attr.array;
  for (let v = 0; v < n; v++) {
    const g = groups[v] * 3;
    out[v * 3] = rgb[g];
    out[v * 3 + 1] = rgb[g + 1];
    out[v * 3 + 2] = rgb[g + 2];
  }
  attr.needsUpdate = true;
  return attr;
}

/** Cache key suffix, so three does not share a program between the two modes. */
export const STATIC_LIGHT_KEY = 'agent-static-light';

/** The chunk that carries the model's rotation into the lighting normal. */
const NORMAL_CHUNK = 'defaultnormal_vertex';

/**
 * `defaultnormal_vertex` with the model's rotation taken out of it, or null if
 * this three build does not say what we expect.
 *
 * Built from `THREE.ShaderChunk` and NOT from the shader three hands to
 * `onBeforeCompile` — at that point the source still reads
 * `#include <defaultnormal_vertex>`, because `resolveIncludes` runs afterwards
 * inside WebGLProgram. Searching the unexpanded source for the line finds
 * nothing, silently, and the material compiles exactly as it would have: the
 * first version of this did that, and measured identical brightness with the
 * patch on and off, which is how it was caught.
 */
function staticNormalChunk() {
  const src = THREE.ShaderChunk?.[NORMAL_CHUNK];
  if (typeof src !== 'string') return null;
  const swaps = [
    ['transformedNormal = normalMatrix * transformedNormal;', 'transformedNormal = mat3( viewMatrix ) * transformedNormal;'],
    ['transformedTangent = ( modelViewMatrix * vec4( transformedTangent, 0.0 ) ).xyz;', 'transformedTangent = mat3( viewMatrix ) * transformedTangent;']
  ];
  let out = src;
  let applied = 0;
  for (const [from, to] of swaps) {
    if (!out.includes(from)) continue;
    out = out.replace(from, to);
    applied++;
  }
  // The tangent line only exists alongside a normal map; the normal one is the
  // one that must be there.
  return applied ? out : null;
}

let _staticChunk;
let _warned = false;

/**
 * Light this material in the model's own frame — see the header.
 *
 * Checked against what the chunk actually says, so a three upgrade that
 * rewrites it leaves the body shading with its facing (and says so once)
 * rather than compiling something wrong.
 */
export function staticLighting(material) {
  if (_staticChunk === undefined) _staticChunk = staticNormalChunk();
  if (!_staticChunk) {
    if (!_warned) {
      _warned = true;
      console.warn(`aim4: three ${THREE.REVISION} writes ${NORMAL_CHUNK} differently; agent bodies will shade with their facing`);
    }
    return material;
  }
  const include = `#include <${NORMAL_CHUNK}>`;
  material.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes(include)) return;
    shader.vertexShader = shader.vertexShader.replace(include, _staticChunk);
  };
  const base = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${base ? base() : ''}|${STATIC_LIGHT_KEY}`;
  return material;
}

/**
 * Strip a material back to a flat, still-shaded surface.
 *
 * Everything that carries colour goes (`map`, and the ambient occlusion baked
 * into the pack's ORM); everything that carries FORM stays. The normal map in
 * particular is worth keeping — it is what stops a flat-coloured body reading
 * as a silhouette, and it does not tint anything.
 */
export function flattenMaterial(m, { color = null, vertexColors = false, keepNormalMap = true } = {}) {
  m.map = null;
  m.aoMap = null;
  m.metalnessMap = null;
  m.metalness = 0;
  if (!keepNormalMap) m.normalMap = null;
  m.vertexColors = !!vertexColors;
  // White, so the vertex colours are the colour; a tint here would multiply.
  if (vertexColors) m.color.set('#ffffff');
  else if (color) m.color.set(color);
  m.needsUpdate = true;
  return m;
}
