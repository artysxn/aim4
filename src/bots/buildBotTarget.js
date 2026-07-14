// ---------------------------------------------------------------------------
// buildBotTarget.js
// Wraps a CSBotModel in the shared Target lifecycle (spawn pop-in, death fade,
// collider registry) with the same tagging contract the old cylinder+sphere
// bots used, so every scenario's raycast/score pipeline keeps working:
//
//   t.colliders   — capsule meshes tagged userData.{target, zone, points, crit}
//   t.headMesh    — head capsule (LOS checks, bot muzzle position)
//   t.model       — the CSBotModel; call t.model.aimAt(...) instead of lookAt
//                   and t.model.update(dt, { crouch }) once per frame
// ---------------------------------------------------------------------------

import { Target } from '../components/Target.js';
import { CSBotModel } from './CSBotModel.js';

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

  // Tag in place — the capsules stay parented to their bones (Target.addCollider
  // would re-parent them to the root and break the skeleton).
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
  t.rig = model.root; // legacy handle — no longer scaled for crouch
  t.headMesh = model.headMesh;

  if (instant) {
    t.spawnDuration = 0;
    t.spawnT = 0;
    t.object.scale.setScalar(1);
  }
  return t;
}
