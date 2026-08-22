// ---------------------------------------------------------------------------
// buildBotTarget.js
// Builds a bot Target with one of three models. All three expose the same
// tagging contract, so a scenario never knows which it got:
//
//   t.colliders   — meshes tagged userData.{target, zone, points, crit}
//   t.headMesh    — head mesh (LOS checks, bot muzzle position)
//   t.model       — bot model; call t.model.aimAt(...) and t.model.update(...)
//
//   AgentBotModel   CS2's own CT agent and its world-model animations, with
//                   the game's own hit capsules. The default, and what the
//                   selection below reaches for first.
//   CSBotModel      the built-in skeletal bot, whose capsules ARE its limbs.
//                   Still the fallback whenever the CS2 pack is not in hand —
//                   a cold page, a dead CDN, a replay of a run recorded
//                   before any of this existed.
//   ClassicBotModel a cylinder and a sphere. A training preference, for
//                   people who want the shape and nothing else.
// ---------------------------------------------------------------------------

import { Target } from '../components/Target.js';
import { CSBotModel } from './CSBotModel.js';
import { ClassicBotModel } from './ClassicBotModel.js';
import { AgentBotModel } from './AgentBotModel.js';
import { sharedAgentModels } from '../agents/agentModels.js';
import { sharedWeaponAssets } from '../agents/weaponAssets.js';

/** The CT agent's own rifle, hung off the model's `wpn` bone. */
export const BOT_WEAPON = 'm4a1_silencer';

/**
 * How long an agent bot takes to fall over, seconds.
 *
 * The default target death is 0.18 s of scale-up and fade, which on a real
 * body is a blink. Measured on `death_chest_a` (the clip the CT pack actually
 * picks, 2.47 s long): the head goes 1.80 m → 0.15 m between t = 0.8 and
 * t = 1.2 and the body is settled from there on. So this is "long enough to
 * land, and not a second of lying still afterwards".
 *
 * It does not gate respawns — every scenario that reuses a bot slot does it on
 * its own `setTimeout`, not on the target being reaped — so a longer corpse
 * costs nothing but the corpse.
 */
export const AGENT_DEATH_TIME = 1.3;

/** Training-only: use the static cylinder/sphere bot instead of CSBotModel. */
export function useClassicBotModel(settings, variant) {
  if (variant === 'competitive') return false;
  return settings?.data?.bots?.classicModel === true;
}

/**
 * Use CS2's own CT agent for bots.
 *
 * Two gates, and the second is the one that matters: the pack is a few MB off
 * a CDN, so on a cold page the first run of the session may start before it
 * has landed. `ready` is false until every model and clip set is in hand, and
 * a bot built from a half-loaded pack would have no hit capsules at all — so
 * that run gets the built-in skeletal bot and the next one gets the agent.
 */
export function useAgentBotModel(settings, variant) {
  if (settings?.data?.bots?.classicModel === true) return false;
  if (settings?.data?.bots?.agentModel === false) return false;
  return sharedAgentModels().ready;
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

/**
 * A bot wearing CS2's own CT agent, animated by the game's world-model clips.
 *
 * Tagged by hand rather than through `tagBotTarget`, for one reason worth
 * spelling out: `t.visuals` exists so Target can fade and then DISPOSE what it
 * holds, and this model's meshes are SkeletonUtils clones that share their
 * geometry and textures with the template every future bot is cloned from.
 * Disposing them would empty the pack on the first kill. So the visuals list
 * stays empty, the fade goes through `model.setOpacity` (materials this bot
 * owns), and `dispose` is the model's own.
 */
export function buildAgentBotTarget({
  bodyPoints = 35,
  headPoints = 100,
  headCrit = true,
  bodyCrit = false,
  widthScale = 1,
  scale = 1,
  instant = false,
  side = 'CT',
  weapon = BOT_WEAPON
} = {}) {
  const models = sharedAgentModels();
  const guns = sharedWeaponAssets();
  // Always armed. The other two builders take a `rifle: false`, and nothing
  // passes it; an agent that is meant to read as a CS player at forty metres
  // reads as one because of the silhouette, and the rifle is most of it.
  const held = weapon ? guns.cloneModel(weapon) : null;
  const t = new Target();
  const model = new AgentBotModel({
    models,
    side,
    widthScale,
    scale,
    weapon: held
  });
  t.object.add(model.root);

  // No `markDecal` here, deliberately: a bot is not a wall. The option exists
  // on the other two builders and PeekswitchBots passes it, which tags their
  // capsules as bullet-hole surfaces; agent bots do not take that, so shooting
  // one leaves sparks and no decal.
  for (const m of model.colliders) {
    const isHead = m.userData.zone === 'head';
    m.userData.target = t;
    m.userData.points = isHead ? headPoints : bodyPoints;
    m.userData.crit = isHead ? headCrit : bodyCrit;
    t.colliders.push(m);
  }
  t.visuals = [];
  t.model = model;
  t.rig = model.root;
  t.headMesh = model.headMesh;

  t.dyingDuration = AGENT_DEATH_TIME;
  t.deathHandler = (p, dt) => {
    if (p === 0) model.die();
    else model.stepDeath(dt);
    // The fall plays over the whole window; the fade is the last third of it,
    // so a body is on its way down before it starts going see-through.
    model.setOpacity(p < 0.66 ? 1 : 1 - (p - 0.66) / 0.34);
  };
  const disposeTarget = t.dispose.bind(t);
  t.dispose = () => {
    t.colliders.length = 0; // the model owns these; do not let Target free them twice
    disposeTarget();
    model.dispose();
  };

  if (instant) {
    t.spawnDuration = 0;
    t.spawnT = 0;
    t.object.scale.setScalar(1);
  }
  return t;
}

/** Pick agent / animated / classic bot from training settings + scenario variant. */
export function buildBotTargetFromSettings(settings, variant, opts = {}) {
  if (useClassicBotModel(settings, variant)) return buildClassicBotTarget(opts);
  if (useAgentBotModel(settings, variant)) return buildAgentBotTarget(opts);
  return buildCSBotTarget(opts);
}
