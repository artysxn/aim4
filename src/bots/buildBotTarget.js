// ---------------------------------------------------------------------------
// buildBotTarget.js
// Builds a bot Target with either the animated CSBotModel or the static
// ClassicBotModel (cylinder + sphere). Both expose the same tagging contract:
//
//   t.colliders   — meshes tagged userData.{target, zone, points, crit}
//   t.headMesh    — head mesh (LOS checks, bot muzzle position)
//   t.model       — bot model; call t.model.aimAt(...) and t.model.update(...)
// ---------------------------------------------------------------------------

import { Target } from '../components/Target.js';
import { CSBotModel } from './CSBotModel.js';
import { ClassicBotModel } from './ClassicBotModel.js';

/** Training-only: use the static cylinder/sphere bot instead of CSBotModel. */
export function useClassicBotModel(settings, variant) {
  if (variant === 'competitive') return false;
  return settings?.data?.bots?.classicModel === true;
}

function tagBotTarget(t, model, {
  bodyPoints,
  headPoints,
  headCrit,
  bodyCrit,
  markDecal
}) {
  for (const m of model.colliders) {
    const isHead = m.userData.zone === 'head';
    m.userData.target = t;
    m.userData.points = isHead ? headPoints : bodyPoints;
    m.userData.crit = isHead ? headCrit : bodyCrit;
    if (markDecal) markDecal(m);
    t.colliders.push(m);
  }
  t.visuals = model.visualMeshes;
  t.model = model;
  t.rig = model.root;
  t.headMesh = model.headMesh;
}

export function buildClassicBotTarget({
  colors,
  bodyPoints = 35,
  headPoints = 100,
  headCrit = true,
  bodyCrit = false,
  widthScale = 1,
  scale = 1,
  markDecal = null,
  instant = false
} = {}) {
  const t = new Target();
  const model = new ClassicBotModel({
    bodyColor: colors?.enemyBody ?? 0xff5544,
    headColor: colors?.enemyHead ?? 0xffd24a,
    widthScale,
    scale
  });
  t.object.add(model.root);
  tagBotTarget(t, model, { bodyPoints, headPoints, headCrit, bodyCrit, markDecal });

  if (instant) {
    t.spawnDuration = 0;
    t.spawnT = 0;
    t.object.scale.setScalar(1);
  }
  return t;
}

export function buildCSBotTarget({
  colors,
  bodyPoints = 35,
  headPoints = 100,
  headCrit = true,
  bodyCrit = false,
  widthScale = 1,
  scale = 1,
  rifle = true,
  markDecal = null,
  instant = false
} = {}) {
  const t = new Target();
  const model = new CSBotModel({
    bodyColor: colors?.enemyBody ?? 0xff5544,
    headColor: colors?.enemyHead ?? 0xffd24a,
    widthScale,
    scale,
    rifle
  });
  t.object.add(model.root);
  tagBotTarget(t, model, { bodyPoints, headPoints, headCrit, bodyCrit, markDecal });

  if (instant) {
    t.spawnDuration = 0;
    t.spawnT = 0;
    t.object.scale.setScalar(1);
  }
  return t;
}

/** Pick animated vs classic bot from training settings + scenario variant. */
export function buildBotTargetFromSettings(settings, variant, opts = {}) {
  const builder = useClassicBotModel(settings, variant)
    ? buildClassicBotTarget
    : buildCSBotTarget;
  return builder(opts);
}
