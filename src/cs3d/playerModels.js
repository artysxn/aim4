// ---------------------------------------------------------------------------
// src/cs3d/playerModels.js
// The player bodies: CS2's own agent models and world-model clips, packed by
// scripts/cs3d-models.mjs, loaded once and cloned per body, animated by a
// small locomotion blend that stands in for the game's animation graph.
//
// The graph is behaviour, not data — nothing in the .vpk says "run_ne at this
// weight" — so it is re-derived here from what the tick record carries:
// speed, movement direction relative to the view, duck amount, airborne, the
// held weapon's class. That is exactly the input CS2's graph reads too, so a
// closer port only ever changes this file.
//
// What the blend does, in one paragraph. Two layers, stand and crouch, mixed
// by the duck amount. Each layer is an 8-way directional loop (n, ne, e, ...)
// picked by the angle between where the feet are going and where the eyes
// look, the two nearest directions blended by angle; the stand layer also
// blends idle → walk → run by speed. Every loop is authored in place at one
// speed (the pack measured it from the planted foot: run 182, walk 104,
// crouch 92 u/s), so all of them share one phase advanced at
// speed / (authored speed × loop length) — the same cadence rule the game's
// graph uses — and are read at that phase rather than left to free-run, which
// is what keeps the walk→run cross-blend from double-stepping. Airborne
// replaces the lot with the in-air pose. Pitch is applied after the mixer as
// a spine-to-head tilt, because every clip is authored looking level.
//
// Two build-of-three notes, because the island runs on 'three/webgpu' and
// GLTFLoader / SkeletonUtils import plain 'three' (a second copy of the core):
//   - the loaded objects (SkinnedMesh, Bone, Skeleton, AnimationClip) and the
//     mixer come from that plain copy, and everything between them stays in it;
//     the WebGPU renderer reads them by duck typing (isSkinnedMesh, skeleton.
//     boneMatrices, bindMatrix) and renders them fine.
//   - the loader's MeshStandardMaterial would be converted by the renderer at
//     first draw; instead it is rebuilt here as an explicit
//     MeshStandardNodeMaterial so the body takes the scene's sun and probe on
//     the same terms as any prop, and so a later per-map term (baked shadow
//     mask, probe volume) has a material of ours to land in.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AnimationMixer, LoopRepeat, LoopOnce } from 'three';
import { IrradianceNode, PhysicalLightingModel, float, texture, uniform, transformedNormalWorld, vec3 } from 'three/webgpu';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from '../../shared/sim/constants.js';
import { WALK_SPEED_SCALE } from '../../shared/sim3d/constants.js';
import { assetBase } from './mapLoader.js';
import { packFetch } from './packFetch.js';
import { SpecularOnlyEnvironmentNode } from './materials.js';

export const PLAYERS_PACK_VERSION = 1;

const DEG = Math.PI / 180;

/** The eight directional loops, by the angle (Source degrees, CCW = left) they move in. */
const DIRS = [
  { key: 'n', angle: 0 },
  { key: 'nw', angle: 45 },
  { key: 'w', angle: 90 },
  { key: 'sw', angle: 135 },
  { key: 's', angle: 180 },
  { key: 'se', angle: -135 },
  { key: 'e', angle: -90 },
  { key: 'ne', angle: -45 }
];
/** The in-air loops only come in five flavours. */
const AIR_DIRS = [
  { key: 'n', angle: 0 },
  { key: 'w', angle: 90 },
  { key: 's', angle: 180 },
  { key: 'e', angle: -90 }
];

/** Below this the body is standing still: idle, no phase advance. */
const IDLE_SPEED = 6;
/** Speed above which an airborne body picks a directional in-air pose. */
const AIR_MOVE_SPEED = 40;

/**
 * Bones that share the view pitch, low spine to head, and how much of it each
 * takes. The clips are authored aiming level; the game blends an aim matrix on
 * top, weighted toward the head — which is why a CS2 player looking at their
 * feet tips forward rather than folding double.
 *
 * The weights sum to 1 and the total is clamped (AIM_PITCH_LIMIT): applying a
 * raw ±89° through the spine is what put a body inside its own legs.
 */
const AIM_BONES = [
  ['spine_1', 0.1],
  ['spine_2', 0.15],
  ['spine_3', 0.25],
  ['neck_0', 0.2],
  ['head_0', 0.3]
];
/** How far the body is allowed to follow the view, degrees. */
const AIM_PITCH_LIMIT = 55;

/**
 * Skin has no subsurface term here (three has no SSS), so it takes a roughness
 * floor instead: a face rendered as a smooth dielectric is a mannequin's.
 */
const SKIN_ROUGHNESS_MIN = 0.45;

/**
 * Cloth is never a mirror, and this floor is what stops one bad texture from
 * making it one. `ctm_sas_body`'s normal map came out of VRF with an empty
 * alpha, which is where Source 2 keeps roughness, so the CT's whole torso
 * packed as roughness 0. cs3d-models now catches that at pack time; this is
 * the rail under it, because the pack on the CDN is older than the fix and a
 * roughness of zero on a vest is never right whatever produced it.
 */
const CLOTH_ROUGHNESS_MIN = 0.35;

/**
 * How broad the cloth sheen lobe is.
 *
 * Not a taste knob: three's `BRDF_Sheen` divides by `4·(N·L + N·V − N·L·N·V)`,
 * which goes to zero at the silhouette, so the lobe's peak is independent of
 * N·L and scales with `D_Charlie`'s maximum — (2 + 1/α) / 2π. At 0.35 that
 * peak is 2.4× what it is at 0.7, all of it concentrated on the rim.
 */
const SHEEN_ROUGHNESS = 0.7;

/**
 * How much of the albedo comes back as sheen. See buildMaterial for why the
 * sheen is the albedo at all.
 *
 * The lobe's peak is `sunIntensity/4 × D_Charlie(α) × sheenColor`, and the
 * diffuse beside it is `N·L × sunIntensity × albedo/π`. With the sheen tied to
 * the albedo the two scale together and the ratio is all that is left:
 * `π·D_Charlie/(4·N·L) × SHEEN_SCALE`, about 0.5 × SHEEN_SCALE / N·L. So at
 * half a unit of scale a fabric edge lit square-on comes back at half the
 * brightness of the surface it is on, and a rim the sun only grazes — the worst
 * case, N·L small — at roughly the same brightness as the lit side. That is a
 * sheen. Anything that reads as a light source is this number being too high.
 */
const SHEEN_SCALE = 0.5;

/** Ambient a body falls back to when the map ships no probe grid, per axis. */
const FALLBACK_AMBIENT = 0.18;

/**
 * Ceiling on the ORM's AO influence. The agents' own `g_flAmbientOcclusionMasking`
 * runs 0.4 on almost everything and 0.99 on the SAS torso; at 0.99 a dark or
 * empty channel takes the body to black, at 0.4 the same channel is ordinary
 * shading. Half is the most a crease may cost.
 */
const AO_MASK_MAX = 0.5;

/** Material names already reported by buildMaterial; one line each, not per body. */
const SEEN_MATS = new Set();

/** channelStats results, by texture image, so a shared ORM is read once. */
const STATS = new WeakMap();

/**
 * min / max / mean of a packed texture's R, G and B, 0..1.
 *
 * The point is to stop guessing at what is in the ORM. Every rail in
 * buildMaterial exists because a channel came out of VRF holding something
 * other than what its slot means — the normal's alpha empty, the occlusion
 * slot's constant stand-in zero — and from the client the only way to know
 * which is to look. 32×32 is enough for "is this channel degenerate": a real
 * AO or metalness map has structure at any resolution, a constant fill has
 * none at any.
 */
function channelStats(tex) {
  const img = tex?.image;
  if (!img) return null;
  if (STATS.has(img)) return STATS.get(img);
  let out = null;
  try {
    let d = null;
    if (ArrayBuffer.isView(img.data)) {
      // A data-backed texture (DataTexture): the bytes are already here.
      d = img.data;
    } else {
      const N = 32;
      const ctx = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, N, N);
      d = ctx.getImageData(0, 0, N, N).data;
    }
    const ch = [0, 1, 2].map(() => ({ min: 255, max: 0, sum: 0 }));
    let n = 0;
    for (let i = 0; i + 3 < d.length; i += 4) {
      n++;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c];
        if (v < ch[c].min) ch[c].min = v;
        if (v > ch[c].max) ch[c].max = v;
        ch[c].sum += v;
      }
    }
    if (!n) throw new Error('empty');
    const norm = (o) => ({ min: o.min / 255, max: o.max / 255, mean: o.sum / n / 255 });
    out = { r: norm(ch[0]), g: norm(ch[1]), b: norm(ch[2]) };
  } catch {
    out = null; // a texture nothing here can read; the rails fall back to their defaults
  }
  STATS.set(img, out);
  return out;
}

const pct = (v) => (v === undefined ? '?' : Math.round(v * 100));

/** Drops whatever is accumulated into it (see DiffuseSunLightingModel). */
const DISCARD_ACCUMULATOR = { addAssign() {} };

/**
 * The physical BRDF with the sun's mirror lobe removed.
 *
 * Every other surface in these maps takes the sun as an `IrradianceNode` —
 * world geometry, props, the 3D skybox (materials.js setupLightMap) — which
 * three accumulates as indirect DIFFUSE. That is forced by the bake: CS2 ships
 * the sun's visibility as a mask, not as anything view dependent, so no
 * lightmapped surface in the map can show a specular highlight at all.
 *
 * A body was the one exception, because it is lit by the real DirectionalLight
 * (which it needs, for the dynamic shadow the bake cannot give a moving
 * player). So a player standing beside a crate got a GGX highlight the crate
 * could not have, at an intensity tuned for diffuse — which is most of what
 * "they look like they are from another dimension" was.
 *
 * Only the mirror lobe goes. The sheen accumulates into `sheenSpecularDirect`,
 * a different variable, so cloth keeps reading as cloth; reflections still
 * arrive from the sky probe through `indirectSpecular`, exactly as they do for
 * every prop in the map.
 */
class DiffuseSunLightingModel extends PhysicalLightingModel {
  direct(input, ...rest) {
    const rl = input.reflectedLight;
    const real = rl.directSpecular;
    rl.directSpecular = DISCARD_ACCUMULATOR;
    try {
      return super.direct(input, ...rest);
    } finally {
      rl.directSpecular = real;
    }
  }
}

/**
 * A body's material: CS2's `csgo_character.vfx`, as close as a node material
 * gets, lit by the map's own baked light.
 *
 * Two things make the difference between "a CS2 player" and the wet plastic
 * mannequin the first pass drew:
 *
 * **The light.** A body used to take the scene's global sky probe as its
 * diffuse ambient and its reflection — an environment with no occlusion, so a
 * player in a sealed hall got exactly the sky a player in the open yard did,
 * blue and from above, with a mirror sheen over it. The map's world geometry
 * has not been lit that way since the bake landed, and its props have not
 * either (materials.js: probe irradiance per vertex, sky probe reflections
 * only). This does for a moving body what the vertex bake does for a static
 * prop: `ambient` is the ambient cube from the map's own probe grid, sampled
 * at the body's chest every frame (mapLoader.js ProbeGrid), evaluated per pixel
 * against the surface normal. The sky probe keeps its reflection and loses its
 * diffuse, exactly as everything else in the map does.
 *
 * **The BRDF.** `F_CLOTH_SHADING` is most of a player: vest, fatigues,
 * balaclava. Cloth is not a smooth dielectric — it has a sheen lobe with a
 * wide, soft falloff — and drawn as one it reads as latex. three's physical
 * material has a sheen term, so the vmat's `g_flSheenScale` and tint go
 * straight into it. Skin (`F_SUBSURFACE_SCATTERING`) has no equivalent here;
 * it takes a roughness floor instead, which at least stops it shining.
 */
class BodyMaterial extends THREE.MeshPhysicalNodeMaterial {
  /** @param {{ambient: import('three/webgpu').UniformNode[]}} lighting shared by one body's materials */
  constructor(lighting) {
    super();
    this.cs3dLighting = lighting;
    // The scene's sun and its shadow map still light the body — that is the
    // dynamic half CS2 also keeps for players. Only the ambient changes.
  }

  setupLightMap() {
    const amb = this.cs3dLighting?.ambient;
    if (!amb) return null;
    // Ambient cube: Σ nᵢ² · cube[the axis nᵢ points down]. Written with max()
    // rather than a branch — max(n,0)² and max(−n,0)² are the same selection,
    // and one of the pair is always zero — because it is the same expression on
    // both backends and needs no conditional node.
    //
    // × π for the same reason materials.js does it: the bake stores radiance
    // and three's indirect diffuse wants irradiance, so a body and the crate
    // beside it come out of one bake at one brightness.
    const n = transformedNormalWorld;
    const sq = (v) => {
      const c = v.max(float(0));
      return c.mul(c);
    };
    const irr = amb[0]
      .mul(sq(n.x))
      .add(amb[1].mul(sq(n.x.negate())))
      .add(amb[2].mul(sq(n.y)))
      .add(amb[3].mul(sq(n.y.negate())))
      .add(amb[4].mul(sq(n.z)))
      .add(amb[5].mul(sq(n.z.negate())));
    return new IrradianceNode(irr.mul(float(Math.PI)));
  }

  setupEnvironment(builder) {
    const node = super.setupEnvironment(builder);
    // Reflections yes, diffuse no: the probe grid is the diffuse now.
    if (!node || !this.cs3dLighting?.ambient) return node;
    return new SpecularOnlyEnvironmentNode(node.envNode);
  }

  setupLightingModel() {
    return new DiffuseSunLightingModel(
      this.useClearcoat,
      this.useSheen,
      this.useIridescence,
      this.useAnisotropy,
      this.useTransmission,
      this.useDispersion
    );
  }
}

/** Which clip set animates a weapon; grenades and the bomb use pistol legs. */
export function weaponClassOf(weaponName) {
  const w = String(weaponName || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (!w) return 'rifle';
  if (w === 'knife' || w.startsWith('knife') || w === 'bayonet') return 'knife';
  if (w === 'c4') return 'c4';
  if (/grenade|flashbang|molotov|decoy|smoke|incgrenade/.test(w)) return 'grenade';
  if (['glock', 'hkp2000', 'usp_silencer', 'p250', 'fiveseven', 'tec9', 'cz75a', 'elite', 'deagle', 'revolver', 'taser'].includes(w)) return 'pistol';
  return 'rifle';
}

/** Locomotion set for a weapon class (grenade / c4 have no loops of their own). */
const LOCO_SET = { rifle: 'rifle', pistol: 'pistol', knife: 'knife', grenade: 'pistol', c4: 'pistol' };

/**
 * Weapon run speed for the cadence and gait anchors. Knife skins are knives
 * (250); a grenade in hand runs at 245 (the corpus, see deriveFlags.js).
 */
export function runSpeedOf(weaponName) {
  const cls = weaponClassOf(weaponName);
  if (cls === 'knife') return WEAPON_SPEED.knife;
  if (cls === 'grenade') return 245;
  const w = String(weaponName || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  return WEAPON_SPEED[w] ?? DEFAULT_WEAPON_SPEED;
}

const wrap180 = (d) => {
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d;
};

// ---------------------------------------------------------------------------

export class PlayerModels {
  /**
   * @param {object} [o]
   * @param {string} [o.base]  pack URL prefix; default `${assetBase()}/players`
   */
  constructor({ base } = {}) {
    this.base = base || `${assetBase()}/players`;
    this.manifest = null;
    this.ready = false;
    this.failed = null;
    /** side → { scene: Object3D (skinned template), hitboxes } */
    this.models = {};
    /** set → Map<clip name, AnimationClip> */
    this.clips = {};
    /** set → { run, walk, crouch } authored u/s */
    this.gait = {};
    /**
     * The map's baked ambient, for bodies to stand in. Set by whoever owns the
     * pack (main.js, view3d.js) once it has loaded; null falls back to a flat
     * ambient, which is what a pack from before the grid gets.
     */
    this.getProbeGrid = () => null;
    this._loading = null;
  }

  /** Fetch the manifest, both models and every clip set. Resolves to `ready`. */
  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('cs3d: player models unavailable, keeping placeholder bodies —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const res = await packFetch(`${this.base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`no players pack (${res.status} from ${this.base}/manifest.json)`);
    const manifest = await res.json();
    if (manifest.version !== PLAYERS_PACK_VERSION) {
      throw new Error(`players pack is v${manifest.version}; this build reads v${PLAYERS_PACK_VERSION}. Re-run cs3d-models.`);
    }
    this.manifest = manifest;
    const v = `?v=${encodeURIComponent(manifest.generated || String(manifest.version))}`;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const load = (file) =>
      new Promise((resolve, reject) => loader.load(`${this.base}/${file}${v}`, resolve, undefined, (e) => reject(new Error(`${file}: ${e?.message || e}`))));

    const modelJobs = Object.entries(manifest.models).map(async ([side, m]) => {
      const gltf = await load(m.file);
      const scene = gltf.scene;
      scene.traverse((o) => {
        if (!o.isMesh) return;
        // Bounds are the bind pose; a running body leaves them every stride.
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      this.models[side] = { scene, hitboxes: m.hitboxes, bones: m.bones, name: m.name };
    });
    const clipJobs = Object.entries(manifest.anims).map(async ([set, a]) => {
      const gltf = await load(a.file);
      const map = new Map();
      for (const clip of gltf.animations) map.set(clip.name, clip);
      this.clips[set] = map;
      this.gait[set] = a.gaitSpeed || {};
    });
    await Promise.all([...modelJobs, ...clipJobs]);
    if (!this.models.T || !this.models.CT) throw new Error('players pack lacks a T or CT model');
    // The clip skeleton carries ten helper bones the agents do not have
    // (wpnHand_L/R, wpnTip, attachHand/Foot, attachWorld …). A track aimed at
    // a bone that is not there is a warning per track per action from
    // PropertyBinding — thousands, with ten bodies — so drop them once here.
    const bones = new Set();
    for (const m of Object.values(this.models)) m.scene.traverse((o) => bones.add(o.name));
    let dropped = 0;
    for (const map of Object.values(this.clips)) {
      for (const clip of map.values()) {
        const kept = clip.tracks.filter((t) => bones.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        dropped += clip.tracks.length - kept.length;
        clip.tracks = kept;
      }
    }
    if (dropped) console.log(`cs3d: player clips — ${dropped} tracks on helper bones the models lack were dropped`);
  }

  /**
   * The body material for ONE body: the loader's PBR maps, the vmat's shading
   * model, and this body's own ambient uniforms (see BodyMaterial).
   *
   * Per body rather than shared, because the ambient is a property of where
   * that body is standing. Two agents × five materials is ten pipelines per
   * body — next to a map's three hundred, that is not the cost worth saving.
   */
  buildMaterial(src, lighting) {
    const cs3d = src.userData?.cs3d || {};
    const m = new BodyMaterial(lighting);
    m.name = src.name;
    m.color.copy(src.color);
    m.map = src.map || null;
    m.normalMap = src.normalMap || null;
    if (src.normalScale) m.normalScale.copy(src.normalScale);
    m.roughnessMap = src.roughnessMap || null;
    m.aoMap = src.aoMap || null;
    // ---- the AO rail, which is what blacked out the CT's torso -------------
    //
    // three's AO is `1 + (ao − 1)·intensity`, multiplied into the body's whole
    // indirect diffuse — and for a body that IS its light, because the probe
    // grid is where a moving player's ambient comes from. So an AO channel of
    // zero at intensity 1 renders black, full stop.
    //
    // Both halves of that were wrong here.
    //
    // The intensity: `g_flAmbientOcclusionMasking` is not three's
    // `aoMapIntensity` any more than `g_flSheenScale` was its `sheen`. The
    // agents ship 0.4 on nearly everything and 0.99 on exactly two materials —
    // `ctm_sas_body` and `ctm_sas_bodylegs`, which are exactly the two that
    // rendered black while the head, gloves and defuser beside them at 0.4 came
    // out fine. Capped, because no crease on a character should be able to take
    // more than half its ambient light away.
    //
    // The channel: an all-zero AO is VRF's constant stand-in for a slot with no
    // texture (`TextureAmbientOcclusion [0,0,0,0]`), which cs3d-models packs
    // faithfully as zeros — and read at face value that is "fully occluded"
    // rather than "no AO map". Same failure as the normal map's empty alpha
    // being read as roughness 0, and the same answer: measure the channel and
    // do not believe a degenerate one.
    const orm = m.aoMap || m.roughnessMap;
    const stats = orm ? channelStats(orm) : null;
    const aoEmpty = !!stats && stats.r.max <= 2 / 255;
    if (aoEmpty) m.aoMap = null;
    m.aoMapIntensity = Math.max(0, Math.min(AO_MASK_MAX, Number.isFinite(cs3d.aoMasking) ? cs3d.aoMasking : 1));
    m.roughness = src.roughness;
    m.metalness = src.metalness;
    m.metalnessMap = src.metalnessMap || null;
    // **Cloth and skin are dielectrics.** `csgo_character.vfx` has no metal
    // path for `F_CLOTH_SHADING` or `F_SUBSURFACE_SCATTERING`, and here the
    // difference is not subtle: metalness kills the diffuse term outright, so
    // a metal body is lit by its reflections alone — and the only reflection a
    // body gets is the sky probe, deliberately crushed to a hundredth
    // (sky.js SKY_PROBE_SCALE). Measured on this scene, the same cloth at
    // metalness 1 is 11× darker than at 0 and EVERY pixel of it reads as black,
    // with one bright blob wherever the mirror happens to catch the sky. That
    // is the CT's vest: `ctm_sas_body`'s metalness channel comes out of VRF
    // saturated, the same way its roughness came out empty, and the ORM's blue
    // channel carries it straight through. The rail is here for the same reason
    // CLOTH_ROUGHNESS_MIN is: a pack older than the packer's guard is still the
    // pack on the CDN, and no vest is a mirror whatever produced the texture.
    if (cs3d.cloth || cs3d.sss) {
      m.metalness = 0;
      m.metalnessMap = null;
    }
    m.side = THREE.FrontSide;
    // Cloth: the sheen lobe CS2 gives fatigues, vests and balaclavas.
    //
    // **The sheen is the albedo.** `g_flSheenTintColor` is a tint over the
    // surface's own colour, not a colour of its own — fabric sheen is light off
    // the fibres, and the fibres are whatever colour the cloth is. Read as a
    // standalone colour (three's `sheenColor`, default white) the lobe is an
    // additive white light that owes nothing to the texture under it, and since
    // its peak sits at the silhouette and is independent of N·L, that is
    // literally a rim light welded to every body: measured on this scene it more
    // than doubled the brightest pixel on tan fatigues and multiplied it by
    // **18** on the CT's near-black kit, where the vest's own colour then
    // accounted for about 5% of what you saw. Hence the black torsos that
    // rendered as grey smears and the halo around everyone.
    //
    // Driven from the base map instead, the two scale together: black cloth
    // gets a black sheen (nothing), tan cloth gets a tan one, and no lighting
    // condition can make either brighter than the material's own colour allows.
    // `g_flSheenScale` rides along as the weight it is, clamped, over
    // SHEEN_SCALE — the vmats ship 0.667, 1.0 and 1.2, and three's `sheen` is
    // documented as a 0..1 weight over an already strong lobe.
    //
    // Same class of error as the sun's mirror lobe (DiffuseSunLightingModel),
    // and the reason that fix did not take: only the GGX highlight was removed,
    // and the cloth lobe beside it was left holding a white light.
    if (cs3d.cloth && cs3d.sheen > 0) {
      const tint = Array.isArray(cs3d.sheenTint) ? cs3d.sheenTint : [1, 1, 1];
      const k = Math.min(1, cs3d.sheen) * SHEEN_SCALE;
      // `texture()` decodes the map's sRGB to working space, so this is the
      // same linear albedo the diffuse term uses.
      const albedo = m.map ? texture(m.map).rgb : vec3(m.color.r, m.color.g, m.color.b);
      // The weight rides in the node; this only turns the lobe on (`useSheen`),
      // and `sheenColor` is unused once `sheenNode` is set.
      m.sheen = 1;
      m.sheenRoughness = SHEEN_ROUGHNESS;
      m.sheenNode = albedo.mul(vec3(tint[0], tint[1], tint[2])).mul(float(k));
    }
    // Roughness floors. Skin has no subsurface term here (three has no SSS) and
    // cloth has no business being glossy at all; both stop a surface reading as
    // wet, and the cloth one is also what keeps a texture that lost its
    // roughness channel from rendering as chrome.
    const floor = cs3d.sss ? SKIN_ROUGHNESS_MIN : cs3d.cloth ? CLOTH_ROUGHNESS_MIN : 0;
    if (floor > 0 && m.roughnessMap) {
      m.roughnessNode = texture(m.roughnessMap).g.max(float(floor));
    }
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) if (t) t.anisotropy = 8;
    // What the pack actually said about this material, once per material name.
    // Every rail above is a guess about a texture nobody can see from here: if
    // a body still reads wrong, this is the line that says whether the vmat
    // flagged it cloth at all, and what it asked for.
    if (!SEEN_MATS.has(m.name)) {
      SEEN_MATS.add(m.name);
      const band = (c) => (c ? `${pct(c.min)}-${pct(c.max)}(µ${pct(c.mean)})` : 'n/a');
      console.log(
        `cs3d: body material ${m.name || '(unnamed)'} —` +
          ` cloth=${!!cs3d.cloth} sss=${!!cs3d.sss} sheen=${cs3d.sheen ?? 0}` +
          ` ao=${cs3d.aoMasking ?? 1}→${m.aoMapIntensity}${aoEmpty ? ' (channel empty, AO dropped)' : ''}` +
          ` metal=${m.metalness}` +
          ` | ORM%  AO ${band(stats?.r)}  rough ${band(stats?.g)}  metal ${band(stats?.b)}`
      );
    }
    return m;
  }

  /** A new body for a side ('T' | 'CT'). Only valid once `ready`. */
  createBody(side) {
    return new PlayerBody(this, side);
  }
}

/**
 * One loader per page. The explorer, the timeline's 3D view and (later) the
 * bots all draw the same two agents, and the pack is 9 MB: fetch it once and
 * clone bodies from it wherever they are needed.
 */
let shared = null;
export function sharedPlayerModels() {
  if (!shared) shared = new PlayerModels();
  return shared;
}

// ---------------------------------------------------------------------------

/**
 * One animated body. Drive it with `set(state)` every frame and `update(dt)`;
 * `group` is the scene object to place (position in scene units, `rotation.y`
 * is the Source yaw in radians — the packed model faces +x).
 */
export class PlayerBody {
  constructor(models, side) {
    this.models = models;
    this.side = null;
    this.group = new THREE.Group();
    this.group.name = 'player';
    liveBodies.add(this);
    /**
     * This body's ambient cube, six irradiance uniforms in scene axis order
     * (+x, −x, +y up, −y, +z, −z), resampled from the map's probe grid every
     * frame. Shared by every material on the body.
     */
    this.lighting = { ambient: Array.from({ length: 6 }, () => uniform(new THREE.Color(FALLBACK_AMBIENT, FALLBACK_AMBIENT, FALLBACK_AMBIENT))) };
    this._cube = new Float32Array(18);
    this.model = null;
    this.mixer = null;
    this.actions = new Map(); // `${set}/${name}` → AnimationAction
    this.aimBones = [];
    this.oneShot = null; // { action, until }
    /** Blend inputs, smoothed. */
    this.speed = 0;
    this.relYaw = 0;
    this.air = 0;
    this.duck = 0;
    this.pitch = 0;
    this.phase = 0;
    this.locoSet = 'rifle';
    /** set → weight, eased, so a weapon switch cross-fades the locomotion set. */
    this.setWeights = new Map();
    this.runSpeed = DEFAULT_WEAPON_SPEED;
    this.state = {
      speed: 0,
      moveYaw: 0,
      viewYaw: 0,
      pitch: 0,
      duck: 0,
      airborne: false,
      weapon: '',
      alive: true
    };
    this.setSide(side);
  }

  /** Swap the team model (teams change sides at half). */
  setSide(side) {
    if (side === this.side) return;
    const tmpl = this.models.models[side];
    if (!tmpl) return;
    if (this.model) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
      this.group.remove(this.model);
      for (const m of this._ownMaterials || []) m.dispose();
    }
    this.side = side;
    this.model = cloneSkinned(tmpl.scene);
    // Materials are this body's own, because the ambient in them is where this
    // body is standing. SkeletonUtils.clone shares them with the template.
    const mine = new Map();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      let m = mine.get(o.material);
      if (!m) mine.set(o.material, (m = this.models.buildMaterial(o.material, this.lighting)));
      o.material = m;
    });
    this._ownMaterials = [...mine.values()];
    this.group.add(this.model);
    this.mixer = new AnimationMixer(this.model);
    this.actions.clear();
    this.setWeights.clear();
    this.oneShot = null;
    // The packed model root (rotated −90° about x): under it everything is in
    // Source's frame, which is where the aim tilt is expressed.
    const rootMotion = this.model.getObjectByName('root_motion');
    this.frameNode = rootMotion ? rootMotion.parent : this.model;
    this.aimBones = [];
    for (const [name, w] of AIM_BONES) {
      const b = this.model.getObjectByName(name);
      if (b) this.aimBones.push({ bone: b, w, base: b.quaternion.clone() });
    }
    this._tilted = false;
    this.hitboxes = tmpl.hitboxes;
  }

  /** Per-frame inputs. Angles in Source degrees; speed u/s; duck 0..1. */
  set(state) {
    Object.assign(this.state, state);
  }

  _action(set, name, loop = true) {
    const key = `${set}/${name}`;
    let a = this.actions.get(key);
    if (a) return a;
    const clip = this.models.clips[set]?.get(name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    a.weight = 0;
    // Loops are read at the shared phase, not free-run (see header).
    a.timeScale = loop ? 0 : 1;
    a.play();
    this.actions.set(key, a);
    return a;
  }

  /**
   * Play a full-body clip once over the locomotion (plant, throw, death).
   * Locomotion weights are scaled down by the one-shot's weight while it runs.
   */
  playOnce(set, name, { fade = 0.12 } = {}) {
    const a = this._action(set, name, false);
    if (!a) return null;
    a.reset();
    a.weight = 1;
    a.fadeIn(fade);
    this.oneShot = { action: a, fade };
    return a;
  }

  /**
   * Advance the blend and the mixer. `dt` seconds of wall time (or demo time,
   * when scrubbing).
   */
  update(dt) {
    if (!this.model) return;
    const s = this.state;
    const g = this.group;
    g.visible = !!s.alive;
    if (!s.alive) return;
    g.rotation.y = s.viewYaw * DEG;

    // Smooth the blend inputs: a demo's per-tick velocity is quantised to
    // ¼ u / tick, and the direction of a nearly-still body is noise.
    //
    // On |dt|, not dt. These always converge toward the target, whichever way
    // the clock is running — a viewer scrubbing back hands out a negative
    // delta, and `1 − e^(−dt/τ)` for dt < 0 is negative, which walks each of
    // these AWAY from its target and grows without bound as the step gets
    // bigger. The phase and the mixer below do want the sign; a smoother never
    // does.
    const ease = (tau) => 1 - Math.exp(-Math.abs(dt) / tau);
    const k = ease(0.08);
    this.speed += (s.speed - this.speed) * k;
    const rel = s.speed > IDLE_SPEED ? wrap180(s.moveYaw - s.viewYaw) : this.relYaw;
    this.relYaw += wrap180(rel - this.relYaw) * k;
    this.relYaw = wrap180(this.relYaw);
    this.air += ((s.airborne ? 1 : 0) - this.air) * ease(0.06);
    this.duck += (Math.max(0, Math.min(1, s.duck)) - this.duck) * ease(0.05);
    this.pitch += (s.pitch - this.pitch) * ease(0.04);

    const cls = weaponClassOf(s.weapon);
    const set = this.models.clips[LOCO_SET[cls]] ? LOCO_SET[cls] : 'rifle';
    this.locoSet = set;
    this.runSpeed = runSpeedOf(s.weapon);

    // Order matters, and not only for the obvious reason. `_unaim` has to run
    // before BOTH of the next two lines: before `_blend`, because it creates
    // actions lazily and a new binding snapshots the bone it finds as the pose
    // to blend back toward at partial weight; and before `mixer.update`,
    // because that is what may or may not overwrite the bone at all.
    this._unaim();
    this._blend(set, dt);
    this.mixer.update(dt);
    this._aim();
    this._light();
  }

  /**
   * The map's baked ambient where this body is standing, into its uniforms.
   *
   * Sampled at chest height rather than at the feet: the grid is interpolated,
   * and a point 40 units up is the better single answer for a whole body
   * (feet-height cells sit inside the floor's own darkening).
   */
  _light() {
    const grid = this.models.getProbeGrid?.();
    const amb = this.lighting.ambient;
    if (!grid) return;
    const p = this.group.position;
    const cube = grid.sample(p.x, p.y + 40, p.z, this._cube);
    for (let c = 0; c < 6; c++) amb[c].value.setRGB(cube[c * 3], cube[c * 3 + 1], cube[c * 3 + 2]);
  }

  /**
   * Locomotion weights and the shared phase. The current set eases in and the
   * previous one out (a weapon switch cross-fades rifle legs into knife legs
   * rather than popping); each set with any weight gets the same blend.
   */
  _blend(set, dt) {
    const sw = this.setWeights;
    if (!sw.has(set)) sw.set(set, sw.size ? 0 : 1);
    const ease = 1 - Math.exp(-dt / 0.12);
    let total = 0;
    for (const [k, w] of sw) {
      const nw = w + ((k === set ? 1 : 0) - w) * ease;
      if (k !== set && nw < 1e-3) sw.delete(k);
      else {
        sw.set(k, nw);
        total += nw;
      }
    }

    // Everything under a running one-shot is scaled down by its weight.
    let locoScale = 1;
    if (this.oneShot) {
      const a = this.oneShot.action;
      const clip = a.getClip();
      if (a.time >= clip.duration - 1e-3 || !a.isRunning()) {
        a.fadeOut(this.oneShot.fade);
        this.oneShot = null;
      } else locoScale = 1 - a.getEffectiveWeight();
    }

    // Zero every loop's weight, then add the ones that carry it. Actions are
    // created lazily; a set that lacks a clip simply contributes nothing.
    for (const a of this.actions.values()) if (a.timeScale === 0) a.weight = 0;

    let phaseAdvanced = false;
    for (const [k, w] of sw) {
      const scale = (w / (total || 1)) * locoScale;
      if (scale < 1e-4) continue;
      // The phase advances once, on the current set's cadence.
      this._blendSet(k, scale, k === set && !phaseAdvanced ? dt : 0);
      if (k === set) phaseAdvanced = true;
    }
  }

  /** One locomotion set's loops at `scale` of the body's weight. */
  _blendSet(set, scale, dt) {
    const gait = this.models.gait[set] || {};
    const speed = this.speed;
    const duck = this.duck;
    const air = this.air;
    const walkRef = this.runSpeed * WALK_SPEED_SCALE;
    const runRef = this.runSpeed;

    // Gait weights on the stand layer: idle → walk → run by speed.
    let wIdle = 0;
    let wWalk = 0;
    let wRun = 0;
    if (speed <= IDLE_SPEED) wIdle = 1;
    else if (speed < walkRef) {
      wWalk = (speed - IDLE_SPEED) / (walkRef - IDLE_SPEED);
      wIdle = 1 - wWalk;
    } else if (speed < runRef) {
      wRun = (speed - walkRef) / (runRef - walkRef);
      wWalk = 1 - wRun;
    } else wRun = 1;
    // Crouch layer: idle_crouch → crouch loop.
    const crouchRef = Math.max(20, this.runSpeed * 0.34);
    const wCrouchMove = speed <= IDLE_SPEED ? 0 : Math.min(1, (speed - IDLE_SPEED) / (crouchRef - IDLE_SPEED));

    // Directional weights: the two nearest of eight.
    const dir = dirWeights(DIRS, this.relYaw);
    const airDir = speed > AIR_MOVE_SPEED ? dirWeights(AIR_DIRS, this.relYaw) : null;

    // Shared phase: cadence is a weighted mix of each active loop's cycles/s.
    const cps = (name, w) => {
      if (!(w > 0)) return 0;
      const clip = this.models.clips[set]?.get(name);
      const authored = gait[name.split('_')[0]];
      if (!clip || !authored || clip.duration <= 0) return 0;
      return (w * speed) / (authored * clip.duration);
    };
    let rate = 0;
    let rateW = 0;
    for (const [gaitName, w] of [
      ['walk', wWalk * (1 - duck)],
      ['run', wRun * (1 - duck)],
      ['crouch', wCrouchMove * duck]
    ]) {
      if (!(w > 0)) continue;
      rate += cps(`${gaitName}_n`, w);
      rateW += w;
    }
    if (rateW > 0 && dt > 0) {
      this.phase += (rate / rateW) * dt;
      this.phase -= Math.floor(this.phase);
    }

    const ground = (1 - air) * scale;
    const airW = air * scale;

    const add = (name, w) => {
      if (!(w > 1e-4)) return;
      const a = this._action(set, name, true);
      if (!a) return;
      a.weight += w;
      const d = a.getClip().duration;
      a.time = d > 0 ? this.phase * d : 0;
    };
    // Stand layer.
    add('idle', ground * (1 - duck) * wIdle);
    for (const [d, w] of dir) {
      add(`walk_${d}`, ground * (1 - duck) * wWalk * w);
      add(`run_${d}`, ground * (1 - duck) * wRun * w);
    }
    // Crouch layer.
    add('idle_crouch', ground * duck * (1 - wCrouchMove));
    for (const [d, w] of dir) add(`crouch_${d}`, ground * duck * wCrouchMove * w);
    // Airborne.
    if (airW > 1e-4) {
      if (airDir) {
        for (const [d, w] of airDir) {
          add(`inair_${d}`, airW * (1 - duck) * w);
          add(`inair_crouch_${d}`, airW * duck * w);
        }
      } else {
        add('inair_stand', airW * (1 - duck));
        add('inair_crouch_stand', airW * duck);
      }
    }
    // Idle poses hold a still frame; do not let the phase scrub them.
    for (const name of ['idle', 'idle_crouch', 'inair_stand', 'inair_crouch_stand']) {
      const a = this.actions.get(`${set}/${name}`);
      if (a) a.time = 0;
    }
  }

  /**
   * Put the spine back the way the mixer left it, undoing the last frame's
   * tilt.
   *
   * The tilt is applied on top of the animated pose, out of band, which is only
   * safe if the pose underneath is rewritten every frame. It is not.
   * `PropertyMixer.apply` ends with a compare — if this frame's blended value
   * is bit-identical to the previous frame's, it never calls
   * `binding.setValue` and the bone keeps whatever it is currently holding.
   * Which, after `_aim`, is OUR quaternion, not the clip's.
   *
   * So on any frame that does not move the pose — paused, a redraw forced by a
   * keypress, a scrub that lands on the tick it is already on, stepping back
   * through ticks whose spine barely differs — the tilt was multiplied onto a
   * bone that already carried it. Twice is a lean, five times is a body folded
   * through its own chest with its arms over its head, and it compounded down
   * the chain because each bone inherits its parent's error as well as its own.
   * Restoring first makes the whole thing idempotent: apply once to a known
   * pose, every frame, whatever the mixer decided to do.
   */
  _unaim() {
    if (!this._tilted) return;
    for (const b of this.aimBones) b.bone.quaternion.copy(b.base);
    this._tilted = false;
  }

  /**
   * View pitch as a spine-to-head tilt about the body's lateral axis, applied
   * on top of the mixer's pose. In the model root frame (Source: +x forward,
   * +y left, +z up) a positive Source pitch (looking down) is a positive
   * rotation about +y.
   */
  _aim() {
    if (!this.aimBones.length) return;
    // Whatever the mixer settled on is this frame's base, and what `_unaim`
    // restores next frame. Captured for every bone before any of them moves:
    // the parent walk below reads live values, so a bone must not see a parent
    // that has been tilted for one frame and not the other.
    for (const b of this.aimBones) b.base.copy(b.bone.quaternion);
    // Clamped: the view goes to ±89°, the body does not follow it there.
    const total = Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, this.pitch)) * DEG;
    if (Math.abs(total) < 1e-4) return;
    for (const { bone, w } of this.aimBones) {
      _qDelta.setFromAxisAngle(_yAxis, total * w);
      // Parent's orientation in the model root frame (Source axes), from live
      // local values — the chain stops under the −90° root, so +y is lateral.
      _qParent.identity();
      for (let p = bone.parent; p && p !== this.frameNode && p !== this.model; p = p.parent) _qParent.premultiply(p.quaternion);
      _qTmp.copy(_qParent).invert().multiply(_qDelta).multiply(_qParent);
      bone.quaternion.premultiply(_qTmp);
    }
    this._tilted = true;
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
    }
    for (const m of this._ownMaterials || []) m.dispose();
    this._ownMaterials = [];
    this.group.removeFromParent();
    liveBodies.delete(this);
  }
}

/**
 * Every body that exists right now — the walking one, the demo's, a bot's.
 *
 * The sun's shadow map is not redrawn per frame (sky.js: the map is static and
 * the sun does not move, so the pass only runs when the shadow volume has
 * shifted). A body is neither static nor still, so whoever owns the sun needs
 * to know when one of these is on screen. This is that list.
 */
export const liveBodies = new Set();

const _yAxis = new THREE.Vector3(0, 1, 0);
const _qDelta = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();

/**
 * Weights of the two directional loops bracketing `angle` (Source degrees,
 * wrapped), as [key, weight] pairs. Directions are on an evenly spaced ring
 * for DIRS; AIR_DIRS is 90° spaced.
 */
function dirWeights(ring, angle) {
  const step = 360 / ring.length;
  let best = null;
  let bestD = 1e9;
  for (const d of ring) {
    const dd = Math.abs(wrap180(angle - d.angle));
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  const off = wrap180(angle - best.angle); // signed offset from the nearest
  const t = Math.min(1, Math.abs(off) / step);
  if (t < 1e-4) return [[best.key, 1]];
  // Neighbour on the side of the offset.
  const nb = ring.reduce((acc, d) => {
    const dd = wrap180(d.angle - best.angle);
    if (Math.sign(dd) === Math.sign(off) && Math.abs(Math.abs(dd) - step) < 1e-3) return d;
    return acc;
  }, null);
  if (!nb) return [[best.key, 1]];
  return [
    [best.key, 1 - t],
    [nb.key, t]
  ];
}
