// ---------------------------------------------------------------------------
// shared/sim3d/gripPlacement.js
// Where a weapon sits in the viewmodel's hand when the pack could not work it
// out — the fallback both viewmodels use (src/cs3d/viewModel.js on WebGPU,
// src/weapons/AgentViewmodel.js on WebGL).
//
// `scripts/cs3d-weapons.mjs` solves each weapon's `vmOffset` by matching the
// model's barrel span to the `wpnEnd` / `wpnTip` helper bones the viewmodel
// clips pose, and writes `[0, 0, 0]` when it cannot. For knives and grenades
// that is deliberate and correct — they are held rather than aimed, and
// already sit right. Three GUNS come out at zero anyway:
//
//   usp_silencer  rejected by the length gate at 2.28x its helper span
//   elite         rejected by the lateral gate: the model is a PAIR, so its
//                 muzzle slice averages across both barrels (9.94 sideways)
//   revolver      rejected at 1.59x — helpers that sit somewhere else entirely
//
// A zero offset leaves those three floating forward of the hand, which is what
// the USP-S looks like in the 3D viewer. This places them by their own grip
// marker instead.
//
// No `three` import on purpose: the two viewmodels are built against different
// three entry points (`three/webgpu` and `three`), so this touches only the
// Object3D methods both share and hands back plain numbers.
// ---------------------------------------------------------------------------

/**
 * The bone every weapon model carries where the right hand grips it.
 * `scripts/cs3d-weapons.mjs` keeps it in the packed model's own bone list.
 */
export const GRIP_BONE = 'ag1_hand_r';

/**
 * Where a CORRECTLY placed weapon's grip marker ends up, in the mount frame
 * (x forward, y up, z right — Source units).
 *
 * These are `gripLocal + vmOffset` measured off the pack's own solved weapons
 * — i.e. where their grip markers actually land once placed. Over the 32 the
 * packer does solve (gripPlacement.test.js recomputes all of this from the pack
 * on every run):
 *
 *   pistol   7 weapons, median (−2.75, −2.96, 0.00), interquartile range ≤0.71
 *   rifle   25 weapons, median (−3.43, −4.51, −0.18), interquartile range ≤0.47
 *
 * Tight within a class and clearly different between them, which is what makes
 * a class-wide target a usable rule rather than a fudge. The middle half is the
 * honest measure here rather than the full range: `rifle` is 25 weapons and
 * holds two real oddities (the MP7 grips 1.7 units short of the rest, the
 * sawed-off 1.4 high) that stretch the extremes to 3.1 without saying anything
 * about where the class as a whole sits.
 *
 * The numbers below are the ones the trainer has been placing its pistol by
 * since before this file existed. Both sit within 0.26 of their class median,
 * and they stay as they are rather than being re-derived: a shared module is no
 * reason to silently move a weapon that already looked right.
 *
 * The right fix is still upstream — the packer could fall back to this same
 * rule and bake it into `vmOffset` — but that needs a re-pack and a re-upload,
 * and every already-deployed pack would still want this.
 */
export const GRIP_TARGET = {
  pistol: [-2.63, -2.86, 0],
  rifle: [-3.33, -4.77, -0.24]
};

/**
 * This weapon's placement, solved from its grip marker, or `null` when the
 * pack's own `vmOffset` should be used instead.
 *
 * `null` — not a zero vector — for everything the rule does not cover, so a
 * caller can write `solved || packed` and get the right thing either way.
 *
 * Gated on `muzzle`, which the pack writes only for weapons that fire. Class
 * alone is not enough: the packer files the C4 and the healthshot under
 * `rifle`, and both come out at zero for the honest reason that they have no
 * barrel to align. They are carried in two hands, not gripped like a rifle,
 * and shoving them to a rifle's grip point would break two models to fix
 * three.
 *
 * Measure on the TEMPLATE, before it is parented to the weapon mount: this
 * reads a world position, and under the mount that would already include the
 * placement it is trying to work out.
 *
 * @param {object} model  the weapon's Object3D, un-parented
 * @param {object} weapon the manifest row (`vmOffset`, `class`, `muzzle`)
 * @returns {number[]|null}
 */
export function gripFallbackOffset(model, weapon) {
  if (!model || !weapon) return null;
  const packed = weapon.vmOffset;
  const placed = packed && (packed[0] !== 0 || packed[1] !== 0 || packed[2] !== 0);
  if (placed) return null;
  // A weapon that does not fire has no barrel, and this rule is about barrels.
  if (!Array.isArray(weapon.muzzle)) return null;
  const target = GRIP_TARGET[weapon.class];
  if (!target) return null;
  const grip = model.getObjectByName?.(GRIP_BONE);
  if (!grip) return null;
  model.updateMatrixWorld(true);
  const e = grip.matrixWorld.elements;
  return [target[0] - e[12], target[1] - e[13], target[2] - e[14]];
}
