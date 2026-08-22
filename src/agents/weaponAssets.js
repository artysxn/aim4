// ---------------------------------------------------------------------------
// src/agents/weaponAssets.js
// CS2's own weapon models and viewmodel clips, for the trainer's WebGL scene.
//
// The pack is `scripts/cs3d-weapons.mjs`'s (`weapons/`): the table straight out
// of `weapons.vdata`, one glb per weapon, the first-person arms per side, the
// class clip sets (rifle / pistol / knife / grenade) and a per-weapon clip set
// on top of those. This file is the reader; `src/cs3d/viewModel.js` is the
// other one, on the WebGPU build (see packBase.js for why there are two).
//
// The trainer holds exactly three weapons — see src/weapons/index.js — so
// `TRAINER_WEAPONS` maps them onto the real thing:
//
//     rifle    → ak47           (src/weapons/ak47.js is the AK's own table)
//     pistol   → usp_silencer   (pistol.js: "USP-style semi-automatic")
//     sniper   → awp            (sniper.js: "Copies the CS AWP")
//
// Models and per-weapon clips stream on demand — 66 weapons is ~30 MB and a
// trainer run touches one — so `preload()` takes the ones a scenario is about
// to need and the arms, and nothing else is ever fetched.
// ---------------------------------------------------------------------------

import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js?three-webgl';
import { packBase, packLoader, readManifest, packVersionQuery, loadGlb } from './packBase.js';

export const WEAPONS_PACK_VERSION = 4;

/** Trainer weapon model id (weapons/index.js `model`) → the CS2 weapon it is. */
export const TRAINER_WEAPONS = Object.freeze({
  rifle: 'ak47',
  pistol: 'usp_silencer',
  sniper: 'awp'
});

/** The CS2 weapon a trainer weapon spec should be drawn as. */
export function weaponNameFor(spec) {
  return TRAINER_WEAPONS[spec?.model] || TRAINER_WEAPONS.rifle;
}

export class WeaponAssets {
  constructor({ base } = {}) {
    this.base = base || `${packBase()}/weapons`;
    this.manifest = null;
    this.ready = false;
    this.failed = null;
    /** side → Object3D template (viewmodel rig + arm meshes) */
    this.arms = {};
    /** class → Map<clip name, AnimationClip> */
    this.clips = {};
    /** weapon name → Object3D template (or null when the pack has none) */
    this.models = new Map();
    /** weapon name → Map<clip name, AnimationClip>, or null for "use the class set" */
    this.weaponSets = new Map();
    this._pending = new Map();
    this._pendingSets = new Map();
    this._rigBones = new Set();
    this._loader = null;
    this._v = '';
    this._loading = null;
  }

  /** Manifest, arms and the class clip sets. Weapon models stream separately. */
  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('aim4: weapons pack unavailable, keeping the built-in gun models —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const { manifest, base } = await readManifest('weapons', WEAPONS_PACK_VERSION, this.base.replace(/\/weapons$/, ''));
    this.manifest = manifest;
    this.base = base;
    this._v = packVersionQuery(manifest);
    this._loader = packLoader();

    const jobs = [];
    for (const [side, a] of Object.entries(manifest.viewmodel.arms || {})) {
      jobs.push(
        this._fetch(a.file).then((gltf) => {
          gltf.scene.traverse((o) => {
            if (!o.isMesh) return;
            o.frustumCulled = false;
          });
          this.arms[side] = gltf.scene;
        })
      );
    }
    for (const [key, s] of Object.entries(manifest.viewmodel.anims || {})) {
      jobs.push(
        this._fetch(s.file).then((gltf) => {
          const map = new Map();
          for (const c of gltf.animations) map.set(c.name, c);
          this.clips[key] = map;
        })
      );
    }
    await Promise.all(jobs);
    if (!this.arms.T && !this.arms.CT) throw new Error('weapons pack has no viewmodel arms');
    this._rigBones = new Set();
    for (const s of Object.values(this.arms)) s.traverse((o) => this._rigBones.add(o.name));
    let dropped = 0;
    for (const map of Object.values(this.clips)) dropped += this.trimToRig(map);
    if (dropped) console.log(`aim4: viewmodel clips — ${dropped} tracks for weapon-side bones dropped`);
  }

  _fetch(file) {
    return loadGlb(this._loader, `${this.base}/${file}${this._v}`).catch((e) => {
      throw new Error(`${file}: ${e?.message || e}`);
    });
  }

  /** The table row for a weapon, by bare name (`ak47`). */
  stats(name) {
    return this.manifest?.weapons?.[String(name || '').replace(/^weapon_/, '')] || null;
  }

  /** Weapon model, fetched once. Resolves to null when the pack has no such weapon. */
  model(name) {
    const key = String(name || '').replace(/^weapon_/, '');
    if (this.models.has(key)) return Promise.resolve(this.models.get(key));
    if (this._pending.has(key)) return this._pending.get(key);
    const w = this.stats(key);
    if (!w?.file) return Promise.resolve(null);
    const job = this._fetch(w.file)
      .then((gltf) => {
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = false;
          o.castShadow = true;
        });
        this.models.set(key, gltf.scene);
        this._pending.delete(key);
        return gltf.scene;
      })
      .catch((e) => {
        console.warn(`aim4: weapon model ${key} failed`, e);
        this.models.set(key, null);
        this._pending.delete(key);
        return null;
      });
    this._pending.set(key, job);
    return job;
  }

  /**
   * This weapon's own clip set, fetched once, or null when CS2 ships none and
   * the class default has to do.
   */
  weaponClips(name) {
    const key = String(name || '').replace(/^weapon_/, '');
    if (this.weaponSets.has(key)) return Promise.resolve(this.weaponSets.get(key));
    if (this._pendingSets.has(key)) return this._pendingSets.get(key);
    const s = this.manifest?.viewmodel?.weaponAnims?.[key];
    if (!s?.file) return Promise.resolve(null);
    const own = new Set(this.stats(key)?.bones || []);
    const job = this._fetch(s.file)
      .then((gltf) => {
        const map = new Map();
        for (const c of gltf.animations) map.set(c.name, c);
        this.trimToRig(map, own);
        this.weaponSets.set(key, map);
        this._pendingSets.delete(key);
        return map;
      })
      .catch((e) => {
        console.warn(`aim4: viewmodel clips for ${key} failed, using the class set`, e);
        this.weaponSets.set(key, null);
        this._pendingSets.delete(key);
        return null;
      });
    this._pendingSets.set(key, job);
    return job;
  }

  /**
   * An independent copy of a loaded weapon model, ready to put in a scene.
   *
   * `Object3D.clone()` is not enough and fails QUIETLY: every weapon in this
   * pack is a SkinnedMesh (the M4 ships seven bones — `clip`, `trigger`,
   * `bolt`, the grip marker — because its viewmodel clips animate them), and a
   * plain clone leaves the copy's `skeleton` pointing at the TEMPLATE's bones.
   * The template is in no scene, so its bones' world matrices are identity,
   * and every vertex ends up transformed by the bind matrix inverse alone —
   * the gun is still there, still `visible`, still in the right place in the
   * hierarchy, and draws nothing you can see. SkeletonUtils.clone rebuilds the
   * bone graph and rebinds to it.
   *
   * Materials are per copy as well, so fading one bot's rifle out does not
   * fade every other bot's.
   */
  cloneModel(name) {
    const tmpl = this.models.get(String(name || '').replace(/^weapon_/, ''));
    if (!tmpl) return null;
    const copy = cloneSkinned(tmpl);
    const mine = new Map();
    copy.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      let m = mine.get(o.material);
      if (!m) mine.set(o.material, (m = o.material.clone()));
      o.material = m;
    });
    return copy;
  }

  /** Model + clips for every weapon the trainer can hold. */
  async preload(names = Object.values(TRAINER_WEAPONS)) {
    if (!this.ready) await this.load();
    if (!this.ready) return false;
    await Promise.all(names.flatMap((n) => [this.model(n), this.weaponClips(n)]));
    return true;
  }

  /**
   * Drop clip channels aimed at bones nothing in the scene carries. Left in,
   * each is one PropertyBinding warning per track per action — thousands.
   *
   * `own` is the held weapon's own bone list from the manifest: a weapon's
   * clips animate its own skeleton as well as the arms (`slide` on a pistol,
   * `bolt_action` on the AWP), and now that the models ship those bones those
   * tracks are the point, not noise.
   */
  trimToRig(map, own = null) {
    let dropped = 0;
    for (const clip of map.values()) {
      const kept = clip.tracks.filter((t) => {
        const bone = t.name.slice(0, t.name.lastIndexOf('.'));
        return this._rigBones.has(bone) || !!own?.has(bone);
      });
      dropped += clip.tracks.length - kept.length;
      clip.tracks = kept;
    }
    return dropped;
  }

  /**
   * Drop clip channels whose nodes are not in the mixer graph. Manifest bone
   * names often do not match the cloned glb, and each miss is a warning plus a
   * failed bind.
   */
  trimClipsToGraph(map, root) {
    if (!map || !root) return 0;
    const names = new Set();
    root.traverse((o) => {
      if (o.name) names.add(o.name);
    });
    let dropped = 0;
    for (const clip of map.values()) {
      const kept = clip.tracks.filter((t) => {
        const i = t.name.lastIndexOf('.');
        return names.has(i >= 0 ? t.name.slice(0, i) : t.name);
      });
      dropped += clip.tracks.length - kept.length;
      clip.tracks = kept;
    }
    return dropped;
  }
}

let shared = null;
export function sharedWeaponAssets() {
  if (!shared) shared = new WeaponAssets();
  return shared;
}
/** Test seam: install a stub pack (and clear it with no argument). */
export function setSharedWeaponAssets(assets) {
  shared = assets || null;
}
