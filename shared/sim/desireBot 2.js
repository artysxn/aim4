// ---------------------------------------------------------------------------
// shared/sim/desireBot.js
// The scripted desire arbiter, playing an actual side of an actual round.
//
// This is the P3b integration: the point where the belief (knowledge.js), the
// footprint (exposure.js), the clocks (attention.js), the vocabulary
// (options.js), the pricing (foresight.js), the team frame (shape.js,
// geometry.js, spaceField.js), the reads (triggers.js), and the arbitration
// (arbiter.js) stop being separately tested modules and become one bot per
// body, five bodies per side, deciding at 8 Hz through the translator.
//
// The honesty boundary, restated because this file is where it would break:
// the belief consumes PERCEPTS. This controller computes those percepts from
// its own side's geometry — what my living bodies can see through the same
// catalogue the engine fights with, what my listeners heard through the
// engine's own degraded SoundLog — and hands the belief nothing else. The one
// god-view read is the kill feed, which CS shows everybody.
//
// v1 simplifications, each with its upgrade path in the plan:
//   - the belief is the team blackboard only; per-bot degraded views (5.7)
//     arrive when attention wiring lands in the observation builder
//   - travel times are euclidean-over-speed, matching the runner's own
//     pathDistance; the geodesic upgrade is a findPath swap
//   - damage attribution (noteDamageDealt) waits for the engine to expose
//     attacker on the damage event
// ---------------------------------------------------------------------------

import {
  ADHOC_THROW_MAX,
  BOMB_SECONDS,
  DECISION_EVERY_TICKS,
  FREEZE_SECONDS,
  ROUND_SECONDS,
  TICK_RATE,
  ticksFor
} from './constants.js';
import { ZONE, classifyZones, bombIsSafe, frontier } from './zones.js';
import { EnemyUtilityTracker } from './conservation.js';
import {
  angleFor,
  clearPartition,
  massFromBelief,
  partitionMotive,
  pTradedFromGeometry
} from './clearPartition.js';
import { readLedgers, threatLedger, timingLedger, utilityLedger } from './ledgers.js';
import { JointBelief, UPDATE_EVERY_TICKS } from './knowledge.js';
import { SelfFootprint } from './exposure.js';
import { LatencyGate } from './attention.js';
import { OPTION_DEFS, OPTION_IDS, OptionRunner, initiationSet } from './options.js';
import { DesireArbiter } from './arbiter.js';
import { ENEMY_KIT_VALUE, HYPOTHESIS_COUNT, priceOption } from './foresight.js';
import { firedTriggers } from './triggers.js';
import { makeShape, backfill, uncoveredPosts, homeOf } from './shape.js';
import { computeSpaceField, bestSpace } from './spaceField.js';
import { createTranslator } from './translator.js';
import { skillProfile } from './skill.js';
import { isSilenced } from './weapons.js';
import { buildObservation, weaponClassOf } from './observe.js';
import { applyProposals, POLICY_HISTORY_STEPS } from './policy.js';
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';
import { SOUND_RADIUS } from './constants.js';
import { SOUND, sector, rangeBand } from './sound.js';
import { buildClassIndex, threatField, SNIPER_CLASS, awpThreat } from './threat.js';
import { budgetDecision } from './voi.js';
import { CommBus, LEVEL, willSay } from './comms.js';
import { clutchMask, maskInitiation, riskQuantile } from './clutch.js';
import { ProtocolRunner, protocolInitiationSet } from './protocols.js';
import { classifyEvent, INTERRUPT, shouldPromote } from './interrupts.js';
import { keywordPreset, applyKeyword } from './keywords.js';
import { buildLayerGraph, legalLayerActions, pickLayerAction, libraryLabel, PROTOCOL_BODIES } from './layers.js';
import { assignZoneOwners, roleInZone } from './ownership.js';
import { sacrificeIsPriced, refragArmed } from './sacrifice.js';
import { makeSync, mixAnchor, reached } from './sync.js';
import { assignExecute, repairLadder } from './execute.js';
import { catalogFor, templateFor } from './executeCatalog.js';
import {
  TendencyTracker,
  Exp3Bandit,
  banditKey,
  econBucket,
  mixPolicyExp3,
  scoreSituation
} from './opponentModel.js';
import { decisionSearch, ExpertIterLog } from './search.js';
import { assignContracts, maskByContract, reassignOnDeath, awpSlotOf } from './contracts.js';
import { ownCore, enemyCoreFromBelief } from './cores.js';
import { situationKey, shapeFromCore } from './situationKey.js';
import { ExperienceIndex } from './experience.js';
import { StrategyAI } from './strategy.js';
import { createCaller, CALLER_MODE, TAPE_ERROR_SECONDS, TAPE_ERROR_UNITS, fightEV, pictureWinrate, shapeRole } from './caller.js';
import { PRW_REASON, createPrwLog, truePictureFrom } from './prw.js';
import { comparePlans, indexValueOf, pickPlan } from './callValue.js';
import { IGL_EVENT, createIglLog } from './iglLog.js';
import { reviewRound } from './review.js';
import { clockCovers } from './knowledgeBake.js';
import { econBucketOf } from './buy.js';
import { isPistolRound } from './match.js';

/** Layer protocol names are dash form; the runner speaks underscore ids (20.3, 20.5). */
const LAYER_PROTOCOL = Object.freeze({
  'three-man': 'three_man_take',
  'four-man': 'wick',
  'five-man': 'sync_peek'
});
/** Options that walk the bomb out of Safe. Execute is the exception. */
const LEAVES_SAFE = Object.freeze(['take_space', 'rotate', 'flank', 'advance', 'lurk']);
/** Geodesic gap (knowledge spacing mean) above which a contract plays lurk. */
const LURK_SPACING_UNITS = 1400;
/** Geodesic gap below which the pack should stay together. */
const PACK_SPACING_UNITS = 700;

function callerPosture(keyword) {
  if (keyword === 'vp' || keyword === 'liquid' || keyword === 'freeze') return keyword;
  return 'default';
}

/**
 * The believed round: bodies we know, bodies we estimate, clock, and where
 * the filter puts the other side. The caller prices this, then asks the
 * library whether continuing is still the plan.
 */
function callerPicture(R, engine, myLiving, extra = {}) {
  const state = engine.state;
  const tick = extra.tick ?? state.tick;
  const clock = extra.clock ?? (tick - state.liveTick) / TICK_RATE;
  const zoneOf = (site) => (anchor) => {
    if (!site) return false;
    const a = R.graph.anchor(anchor);
    return a ? Math.hypot(a.world.x - site.world.x, a.world.y - site.world.y) < 1200 : false;
  };
  const exp = extra.experience || null;
  return {
    // Whose round this is. `pictureFeatures` splits alive/enemyAlive into
    // ct/t by this field, so a picture without it prices a 5v2 as a 2v2 and
    // asks `winProbability` for an undefined side. The caller's own gate was
    // safe (it rebuilds the snap with `side` explicitly), but everything that
    // reads R.picture was not: `pWin_belief` in both logs, and `R.pWin`,
    // which feeds `riskQuantile` and therefore how boldly every bot peeks.
    side: R.side,
    alive: extra.alive ?? myLiving.length,
    enemyAlive: extra.enemyAlive ?? R.belief.aliveCount(),
    clock,
    secondsLeft: extra.secondsLeft ?? Math.max(0, engine.clock()),
    bombSecondsLeft: state.bomb.planted
      ? Math.max(0, BOMB_SECONDS - (tick - state.plantTick) / TICK_RATE)
      : BOMB_SECONDS,
    planted: Boolean(state.bomb.planted),
    hasKit: myLiving.some((b) => b.hasKit),
    contactRel: extra.contactRel || null,
    siteExpectedTarget: R.belief.expected(zoneOf(R.target)),
    siteExpectedOther: R.other ? R.belief.expected(zoneOf(R.other)) : 0,
    packAtTarget: myLiving.filter(
      (b) => Math.hypot(b.pos.x - R.target.world.x, b.pos.y - R.target.world.y) < 1200
    ).length,
    teamBroken: Boolean(extra.teamBroken),
    experienceMean: exp?.mean,
    experienceN: exp?.n,
    // 18.6b.1: how wrong this KIND of picture has been, gated by the index.
    // A number on a situation, never a position.
    calBias: R.calBias ?? 0
  };
}

/** Bodies standing on a site, by the same 1200u ring the picture counts with. */
function nearSite(site) {
  if (!site) return null;
  return (b) => Math.hypot(b.pos.x - site.world.x, b.pos.y - site.world.y) < 1200;
}

/**
 * One PRW row (18.6b). The believed number is what the caller acted on; the
 * true snapshot rides along SEALED — prw.js parks it out of reach until the
 * round is over, because the engine is gone by review time and a live actor
 * must never see it.
 */
function logPrw(R, engine, { tick, reason, picture = null, pWin = null, fightEv = null, decision = null, motive = null } = {}) {
  if (!R?.prw || !engine) return null;
  const pic = picture || R.picture;
  if (!pic) return null;
  return R.prw.log({
    tick,
    reason,
    situation: R.situation?.hash || null,
    picture: pic,
    pWinBelief: Number.isFinite(pWin) ? pWin : pictureWinrate(pic),
    fightEv: Number.isFinite(fightEv) ? fightEv : fightEV(pic),
    decision: decision || R.caller?.decision() || null,
    motive,
    truth: truePictureFrom(engine, {
      side: R.side,
      ourSlots: R.slots,
      enemySlots: R.enemySlots,
      inTarget: nearSite(R.target),
      inOther: nearSite(R.other),
      clock: (tick - engine.state.liveTick) / TICK_RATE
    })
  });
}

/**
 * One IGL row (9.25 stage 3): the caller spoke, so the dataset gets a line.
 * `pWin_true` and `won` stay null until roundEnd seals them — at the moment
 * of the decision the true price is not something this side can know.
 */
function logIgl(R, { tick, event, picture = null, result = null, entry = null, candidates = null }) {
  if (!R?.igl) return null;
  const pic = picture || R.picture;
  return R.igl.log({
    tick,
    round: R.roundNumber ?? null,
    event,
    situation: R.situation?.hash || null,
    picture: pic,
    decision: result?.decision || R.caller?.decision() || null,
    entry: entry || R.caller?.entry() || null,
    call: R.caller?.call() || null,
    candidates: candidates || result?.ranked || null,
    pWinBelief: Number.isFinite(result?.pWin) ? result.pWin : pic ? pictureWinrate(pic) : null,
    fightEv: Number.isFinite(result?.fightEv) ? result.fightEv : pic ? fightEV(pic) : null,
    margin: result?.margin,
    recalled: event === IGL_EVENT.RECALL,
    posture: R.caller?.posture() || null,
    motive: result?.reason || null
  });
}

/**
 * `ctx` is the log's, not the caller's: a recall is a priced team decision and
 * therefore a PRW row (18.6b). A gate that fired and kept the plan in motion
 * is not a recall and writes nothing.
 */
function applyCallerDecision(R, result, ctx = null) {
  if (result?.decision === 'turnaround' && R.other) {
    const swap = R.target;
    R.target = R.other;
    R.other = swap;
    R.caller.setGoal(R.target.world);
  }
  if (!ctx?.engine || !result) return;
  const moved = result.recalled === true || result.kept === false;
  if (!moved) return;
  logPrw(R, ctx.engine, {
    tick: ctx.tick,
    reason: ctx.reason || PRW_REASON.RECALL,
    picture: ctx.picture,
    pWin: result.pWin,
    fightEv: result.fightEv,
    decision: result.decision || null,
    motive: result.reason || (result.mode ? `recall: ${result.mode}` : null)
  });
  // The same event, in the caller's own dataset. One row per recall is the
  // whole cadence 9.25 insists on: 24 to 80 a match, never 8 Hz.
  logIgl(R, {
    tick: ctx.tick,
    event: IGL_EVENT.RECALL,
    picture: ctx.picture,
    result,
    entry: result.entry || null
  });
}

/** Neighbour whose bearing is closest to a mined hold yaw, in degrees. */
function neighbourFacing(graph, neighboursFn, fromId, yawDeg) {
  const a = graph.anchor(fromId);
  if (!a || !Number.isFinite(yawDeg)) return null;
  const rad = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(rad);
  const fy = Math.sin(rad);
  let best = null;
  let bestDot = -Infinity;
  for (const n of neighboursFn(fromId) || []) {
    const b = graph.anchor(n);
    if (!b) continue;
    const dx = b.world.x - a.world.x;
    const dy = b.world.y - a.world.y;
    const len = Math.hypot(dx, dy) || 1;
    const dot = (dx / len) * fx + (dy / len) * fy;
    if (dot > bestDot) {
      bestDot = dot;
      best = n;
    }
  }
  return best;
}

/**
 * Freestyle candidates from the mined knowledge tables: holds winners held,
 * throws they threw at this clock, and a spacing prior on lurk vs pack.
 */
function pushKnowledgeCandidates({ R, s, b, myAnchor, elapsed, candidates, angles, tick, myLiving }) {
  const know = R.knowledge;
  if (!know) return;
  const key = {
    map: R.engine.state.map,
    side: R.side,
    call: R.caller?.call() || 'default',
    contract: myAnchor?.id || 'any'
  };
  const occ = know.anglesFor(key);
  for (let i = 0; i < Math.min(4, occ.length); i += 1) {
    const row = occ[i];
    if (!row.anchor || !R.graph.anchor(row.anchor)) continue;
    const yaw = neighbourFacing(R.graph, R.neighbours, row.anchor, row.yaw) || row.anchor;
    candidates.push({
      id: i === 0 ? 'hold_angle' : 'off_angle_hold',
      params: { spot: row.anchor, yaw },
      prior: 0.5 + Math.min(0.2, (row.share || 0) * 0.4),
      motive: `knowledge hold ${row.anchor}`
    });
  }

  let nUtil = 0;
  for (const row of know.utilityFor(key)) {
    if (nUtil >= 3) break;
    if (!clockCovers(row.clock, elapsed)) continue;
    const fromIsMine = row.from && row.from === myAnchor?.id;
    const mateOnFrom = myLiving.find((m) => {
      if (m.slot === s) return false;
      return angles.nearestAnchor(m.pos.x, m.pos.y)?.id === row.from;
    });
    if (fromIsMine && b.grenades.includes(row.type)) {
      candidates.push({
        id: 'utility_setup',
        params: {
          spot: row.from,
          from: row.from,
          at: row.at,
          utilityType: row.type
        },
        prior: 0.64,
        motive: `knowledge ${row.type} from ${row.from}`
      });
      nUtil += 1;
    } else if (mateOnFrom && !R.knowledgeFlashAsked[s]) {
      const what =
        row.type === 'flashbang'
          ? 'flash'
          : row.type === 'smokegrenade'
            ? 'smoke'
            : row.type === 'molotov' || row.type === 'incgrenade'
              ? 'molotov'
              : null;
      if (what && R.comms.requestsLeft(s) > 0 && willSay(LEVEL.REQUEST, R.profiles[s], R.rng)) {
        R.comms.send(tick, {
          level: LEVEL.REQUEST,
          from: s,
          request: { type: 'request', what, where: row.at, by: 2, worth: 0.05 }
        });
        R.knowledgeFlashAsked[s] = true;
      }
      candidates.push({
        id: 'hold_angle',
        params: { spot: myAnchor?.id ?? row.from, yaw: row.at },
        prior: 0.58,
        motive: `peeking a knowledge ${row.type}`
      });
      nUtil += 1;
    }
  }

  const means = Object.values(know.spacingFor(key))
    .map((d) => d?.mean)
    .filter((v) => Number.isFinite(v));
  if (!means.length) return null;
  return means.reduce((a, c) => a + c, 0) / means.length;
}

/** Bias lurk vs pack travel once those candidates actually exist. */
function applySpacingBias(candidates, typical) {
  if (!Number.isFinite(typical)) return;
  for (const c of candidates) {
    if (typical > LURK_SPACING_UNITS) {
      if (c.id === 'lurk') c.prior = (c.prior || 0.4) + 0.12;
      if (c.id === 'advance') c.prior = Math.max(0.05, (c.prior || 0.4) - 0.08);
    } else if (typical < PACK_SPACING_UNITS) {
      if (c.id === 'advance') c.prior = (c.prior || 0.4) + 0.1;
      if (c.id === 'lurk') c.prior = Math.max(0.05, (c.prior || 0.4) - 0.08);
    }
  }
}

/** Anchors a body is "at" within this range, world units. */
const AT_ANCHOR_UNITS = 64;
/** Rough planning speed, units/s: run speed minus corners. */
const PLAN_SPEED = 200;

/**
 * One bot's observation (observe.js), from the same side-honest sources the
 * arbiter reads: my body, my side's roster, the belief's summaries, and the
 * public clock. The enemy's economy is BELIEVED (mean loadout value over the
 * particles), never their wallet.
 */
/**
 * Solve the entry's clear partition, once per decision tick per side (19.5).
 *
 * The route is the pack's approach to the target site, and the angle set is
 * what the catalogue says overlooks it. Cached on the tick because five bots
 * asking the same question in the same 125 ms must get the same answer: the
 * whole point is that the breadth is partitioned rather than duplicated.
 */
function entryPartition(R, angles, myLiving, tick) {
  if (R.partitionTick === tick) return R.partition;
  R.partitionTick = tick;
  R.partition = null;
  if (!myLiving.length) return null;

  // The corridor: from the pack's centre of mass to the site being taken.
  const cx = myLiving.reduce((s, b) => s + b.pos.x, 0) / myLiving.length;
  const cy = myLiving.reduce((s, b) => s + b.pos.y, 0) / myLiving.length;
  const route = [
    { x: cx, y: cy },
    { x: R.target.world.x, y: R.target.world.y }
  ];
  const encounters = angles.anchorEncountersAlong(route);
  if (!encounters.length) return null;

  R.partition = clearPartition({
    angles: encounters,
    // Arrival order along the corridor is what decides who takes which slice,
    // and it is distance to the site: the man in front meets the first angle.
    // Positions ride along because the trade geometry reads the OTHER bodies
    // out of this same list: who can trade me is a fact about where my mates
    // are standing, not a separate argument.
    bodies: myLiving.map((b) => ({
      slot: b.slot,
      x: b.pos.x,
      y: b.pos.y,
      level: b.level,
      arrival: Math.hypot(R.target.world.x - b.pos.x, R.target.world.y - b.pos.y) / PLAN_SPEED
    })),
    mass: massFromBelief(R.belief),
    pTraded: pTradedFromGeometry({
      spotOf: (a) => {
        const anchor = R.graph.anchor(a.anchor);
        return anchor ? { x: anchor.world.x, y: anchor.world.y, level: anchor.level } : null;
      },
      canSee: (ax, ay, bx, by, level) => angles.canSee(ax, ay, bx, by, level)
    })
  });
  return R.partition;
}

function buildObs(R, s, b, round, myLiving, tick, angles) {
  const zoneOf = (site) => (anchor) => {
    const a = R.graph.anchor(anchor);
    return a ? Math.hypot(a.world.x - site.world.x, a.world.y - site.world.y) < 1200 : false;
  };
  const inTarget = zoneOf(R.target);
  const inOther = zoneOf(R.other);

  let believedEquip = 0;
  for (const p of R.belief.particles) {
    let v = 0;
    for (const sl of p.slots) {
      if (sl) v += (weaponInfo(sl.weapon).price || 0) + ENEMY_KIT_VALUE;
    }
    believedEquip += p.weight * v;
  }
  const enemyAlive = R.belief.aliveCount();

  const mySum = round.mySide === 'CT' ? round.ctEquipSum : round.tEquipSum;
  const myAlive = myLiving.length;

  return buildObservation({
    me: {
      x: b.pos.x,
      y: b.pos.y,
      hp: b.health,
      armor: b.armor,
      helmet: b.helmet,
      weaponClass: weaponClassOf(weaponInfo(b.weapon).category),
      hasBomb: b.hasBomb,
      side: R.side
    },
    round: {
      elapsed: round.elapsed,
      secondsLeft: round.secondsLeft,
      planted: round.planted,
      bombSecondsLeft: round.bombSecondsLeft,
      myEquipAvg: myAlive ? mySum / myAlive : 0,
      enemyEquipAvgBelieved: enemyAlive ? believedEquip / enemyAlive : 0
    },
    myAlive,
    enemyAliveBelieved: enemyAlive,
    belief: {
      siteExpected: [R.belief.expected(inTarget), R.belief.expected(inOther)],
      sitePEmpty: [R.belief.pEmpty(inTarget), R.belief.pEmpty(inOther)],
      splitEntropy: R.belief.splitEntropy([
        { name: 'target', test: inTarget },
        { name: 'other', test: inOther }
      ]),
      threatAtMe: angles.threatAt(b.pos.x, b.pos.y, (anchor, level) =>
        R.belief.massAt(anchor, level)
      )
    },
    teammates: myLiving
      .filter((m) => m.slot !== s)
      .slice(0, 4)
      .map((m) => ({ dx: m.pos.x - b.pos.x, dy: m.pos.y - b.pos.y, hp: m.health })),
    recency: {
      sinceSeenSeconds: (tick - (R.lastSeenTick ?? -Infinity)) / TICK_RATE,
      sinceHeardSeconds: (tick - (R.lastHeardTick ?? -Infinity)) / TICK_RATE
    },
    // The team's doctrine frame, shared by all five bots (20.4).
    doctrine: R.ledgers,
    viz: vizFrame(R, s, b, myLiving, inTarget, inOther)
  });
}

function vizFrame(R, s, b, myLiving, inTarget, inOther) {
  let awp = 0;
  let rifle = 0;
  if (R.threat?.rows?.length) {
    let best = null;
    let bestD = Infinity;
    for (const row of R.threat.rows) {
      const d = Math.hypot(row.spot.x - b.pos.x, row.spot.y - b.pos.y);
      if (d < bestD) {
        bestD = d;
        best = row;
      }
    }
    if (best) {
      awp = best.byClass?.[SNIPER_CLASS] ?? awpThreat(R.threat, best.spot);
      rifle = best.byClass?.rifle ?? 0;
    }
  }
  const modes = R.belief.layoutModes(
    [
      { name: 'target', test: inTarget },
      { name: 'other', test: inOther }
    ],
    2
  );
  const mate = myLiving.find((m) => m.slot !== s);
  const reqTo = R.comms?.openRequests?.(s)?.length ?? 0;
  const reqFrom = R.comms?.openRequests?.()?.filter((m) => m.from === s).length ?? 0;
  const mine = R.partition ? angleFor(R.partition, s) : null;
  return {
    awpThreat: awp,
    rifleThreat: rifle,
    uncoveredMass: R.partition?.uncoveredMass ?? 0,
    voi: R.budget?.parts?.voi ?? 0,
    secondsAffordable: R.budget?.parts?.perSecond
      ? (R.budget.parts.voi || 0) / Math.max(1e-6, R.budget.parts.perSecond)
      : 0,
    breadth: R.budget?.budget != null ? R.budget.budget / HYPOTHESIS_COUNT : 0,
    pairDx: mate ? mate.pos.x - b.pos.x : 0,
    pairDy: mate ? mate.pos.y - b.pos.y : 0,
    pairWindow: R.sync?.toleranceSeconds ?? 0,
    requestToMe: reqTo,
    requestFromMe: reqFrom,
    layout0: modes[0]?.mass ?? 0,
    layout1: modes[1]?.mass ?? 0,
    novelty: Boolean(R.budget?.parts?.capped),
    vizSpend: R.vizSpend ?? 0,
    assigned: Boolean(mine)
  };
}

/**
 * The desire side as a versusMatch controller factory.
 *
 * @param {object} cfg
 * @param {object} cfg.angles   AngleCatalogue for the map
 * @param {number} [cfg.seedOffset]  decorrelates the side's dice from the engine's
 * @param {string|number} [cfg.skill]
 * @returns {() => object}
 */
/**
 * The desire side as a versusMatch controller factory.
 *
 * `policy` (from policy.js loadPolicy) turns this into the BC hybrid of 6.17:
 * the learned head proposes priors over the candidates, the arbiter still
 * decides, forced rules still outrank everything, and an unconfident head
 * falls through to the scripted desire. `collect` receives one
 * {obs, label, side, map} sample per arbiter decision — the BC extractor's
 * dataset tap.
 */
export function desireController({
  angles,
  seedOffset = 7,
  skill = 'average',
  policy = null,
  collect = null,
  keyword = null,
  searchEnabled = true,
  memoryEnabled = true,
  playbook = null,
  knowledge = null,
  call = null,
  matchId = null,
  /**
   * 9.25 stage 1. Off by default, and that default is a scheduling decision
   * rather than a design one: turning the head on changes which tape a caller
   * draws at freeze and which one it recalls to, which is exactly what §15.1's
   * 4.3a acceptance row measures ("5v5 behind keeps; default 5v4 walks; VP 5v4
   * freezes"). It is one word here once the sweep has graded it, and 9.25 is
   * clear that it must be on before C3 (5v5) or the side that gets the first
   * pick starts freezing like VP by accident.
   */
  valueHead = false,
  /**
   * 9.25 stage 2: the opening call becomes an EXP3 arm keyed by
   * (side, econ, score), so two losses on the B hit make the third less
   * likely. Off by the same scheduling logic as `valueHead` — it changes which
   * call a side opens with, which is a measured behaviour — and on it is what
   * makes a series look like a series (6.10, P5b).
   */
  callBandit = false
} = {}) {
  return () => {
    /** Per-round state, rebuilt in roundStart. */
    let R = null;

    // Match-level brains (6.10, 18). Survive roundStart. Off during bulk RL
    // via searchEnabled; memoryEnabled false keeps the determinism hash of a
    // run that never reads the index.
    const tracker = new TendencyTracker();
    const bandit = new Exp3Bandit();
    const index = new ExperienceIndex();
    const strategy = new StrategyAI({ index, bandit });
    const expert = new ExpertIterLog();
    let matchRng = null;
    let contracts = null;

    // ---- geometry helpers, per graph ------------------------------------

    function nearestAnchors(graph, x, y, level, n) {
      const out = [];
      for (const [id, a] of graph.anchors) {
        if (a.level !== level) continue;
        out.push({ id, d: Math.hypot(a.world.x - x, a.world.y - y) });
      }
      out.sort((p, q) => p.d - q.d);
      return out.slice(0, n).map((p) => p.id);
    }

    function buildNeighbours(graph) {
      const map = new Map();
      for (const [id, a] of graph.anchors) {
        map.set(id, nearestAnchors(graph, a.world.x, a.world.y, a.level, 4).filter((o) => o !== id));
      }
      return (anchor) => map.get(anchor) || [];
    }

    /**
     * What gates each zone, for the doctrine classifier (20.2).
     *
     * The doctrine's Safe clause is "an enemy cannot reach it without first
     * taking another zone we are watching", so the classifier needs to know
     * which zones sit between a zone and the enemy. The honest derivation is a
     * path query per zone; the approximation used here is a neighbour that is
     * closer to the enemy's half than the zone itself, which is the same claim
     * for the overwhelming majority of map geometry and costs one distance
     * comparison instead of a search. `[refine: derive from findPath once the
     * layer graph is baked, 20.3]`
     */
    function buildGates(graph, neighbours, enemyOrigin) {
      const map = new Map();
      const distTo = (id) => {
        const a = graph.anchor(id);
        return a ? Math.hypot(a.world.x - enemyOrigin.x, a.world.y - enemyOrigin.y) : Infinity;
      };
      for (const [id] of graph.anchors) {
        const mine = distTo(id);
        map.set(
          id,
          neighbours(id).filter((n) => distTo(n) < mine)
        );
      }
      return (anchor) => map.get(anchor) || [];
    }

    /**
     * The round-start shape: where this side stands when nothing is
     * happening. CT splits the sites and keeps a rotator; T stacks the
     * target's approach. Baked library shapes replace this table in P4.
     */
    function buildShape(graph, side, slots, target, other, positionOf = () => null) {
      const posts = [];
      const roleAt = (slot, i, fallback) => shapeRole(positionOf(slot)) || fallback[i];
      if (side === 'CT') {
        const nearA = nearestAnchors(graph, target.world.x, target.world.y, target.level, 2);
        const nearB = nearestAnchors(graph, other.world.x, other.world.y, other.level, 2);
        const midX = (target.world.x + other.world.x) / 2;
        const midY = (target.world.y + other.world.y) / 2;
        const mid = nearestAnchors(graph, midX, midY, target.level, 1);
        const homes = [nearA[0], nearA[1] || nearA[0], nearB[0], nearB[1] || nearB[0], mid[0]];
        const fallback = ['anchor', 'support', 'anchor', 'support', 'rotator'];
        slots.forEach((slot, i) =>
          posts.push({ slot, role: roleAt(slot, i, fallback), home: homes[i] })
        );
      } else {
        // Rally OUTSIDE the site, on the spawn side of it. The nearest
        // anchors to a site are that site's own defensive spots; a T shape
        // built from them walks into the CT guns at 0:05 and calls it
        // "holding my post". The rally ring is close enough to hit from,
        // far enough to be T ground until the execute.
        const tSpawns = graph.spawns.filter((s) => s.side === 'T');
        const sx = tSpawns.reduce((s, p) => s + p.x, 0) / Math.max(1, tSpawns.length);
        const sy = tSpawns.reduce((s, p) => s + p.y, 0) / Math.max(1, tSpawns.length);
        const ring = [];
        for (const [id, a] of graph.anchors) {
          if (a.level !== target.level) continue;
          const dSite = Math.hypot(a.world.x - target.world.x, a.world.y - target.world.y);
          if (dSite < 700 || dSite > 2000) continue;
          ring.push({ id, dSpawn: Math.hypot(a.world.x - sx, a.world.y - sy) });
        }
        ring.sort((p, q) => p.dSpawn - q.dSpawn);
        const rally = ring.slice(0, 4).map((p) => p.id);
        const fallbackRally = nearestAnchors(graph, sx, sy, target.level, 4);
        while (rally.length < 4) rally.push(fallbackRally[rally.length] || fallbackRally[0]);
        const midX = (target.world.x + other.world.x) / 2;
        const midY = (target.world.y + other.world.y) / 2;
        const lurk = nearestAnchors(graph, midX, midY, target.level, 1)[0];
        const homes = [rally[0], rally[1], rally[2], rally[3], lurk];
        const fallback = ['entry', 'support', 'support', 'support', 'lurk'];
        slots.forEach((slot, i) =>
          posts.push({ slot, role: roleAt(slot, i, fallback), home: homes[i] })
        );
      }
      return makeShape({ call: side === 'T' ? `hit_${target.id}` : 'default_ct', posts });
    }

    return {
      name: 'desire',
      /** The decision log the inspector reads: {tick, slot, id, motive}. */
      log: [],

      /**
       * The round's graded PRW rows (18.6b), drained after `roundEnd` has
       * scored them. Both curves on one clock, which is what the inspector
       * draws; the row is also the aux head's training sample (9.14).
       */
      prwRows() {
        return R?.prw ? R.prw.drain() : null;
      },

      /**
       * The round's IGL rows (9.25 stage 3), sealed by `roundEnd`: one per
       * freeze or recall, with `pWin_true`, `won` and `attrib` filled in.
       */
      iglRows() {
        return R?.igl ? R.igl.drain() : null;
      },

      /** The last review: drops, attributions, calibrations, residuals. */
      review() {
        return R?.review || null;
      },

      roundStart({ engine, graph, side, slots, target, other, sites, match = null }) {
        const profiles = {};
        for (const slot of slots) profiles[slot] = skillProfile(skill);

        const rng = engine.rng.fork();
        for (let i = 0; i < seedOffset; i += 1) rng.next();

        const enemySlots = engine.state.bodies
          .filter((b) => b.side !== side)
          .map((b) => b.slot)
          .sort((a, b) => a - b);

        R = {
          engine,
          graph,
          side,
          slots,
          target,
          other,
          sites,
          rng,
          profiles,
          enemySlots,
          translator: createTranslator(engine, { siteAnchorIds: sites, slots }),
          belief: new JointBelief({ anchors: [...graph.anchors.keys()], rng: rng.fork() }),
          neighbours: buildNeighbours(graph),
          shape: buildShape(graph, side, slots, target, other),
          footprints: Object.fromEntries(slots.map((s) => [s, new SelfFootprint()])),
          runners: Object.fromEntries(
            slots.map((s) => [
              s,
              new OptionRunner({
                slot: s,
                gate: new LatencyGate({ rng: rng.fork(), profile: profiles[s] })
              })
            ])
          ),
          arbiters: Object.fromEntries(
            slots.map((s) => [s, new DesireArbiter({ traits: profiles[s], rng: rng.fork() })])
          ),
          /** Per enemy index: when my side first/last saw them (belief clock). */
          contacts: {},
          /** Last-step samples for change detection. */
          last: Object.fromEntries(
            slots.map((s) => {
              const b = engine.state.bodies[s];
              return [s, { hp: b.health, mag: b.magAmmo, x: b.pos.x, y: b.pos.y, focus: null }];
            })
          ),
          lastSoundTick: -1,
          planted: false,
          afterplant: null,
          retakeStage: null,
          lastEvidenceTick: -Infinity,
          lastRotate: {},
          /** Tick each zone was last swept by our eyes, for the classifier. */
          sweptAt: {},
          /** The doctrine reads, recomputed on the team frame (20.2, 20.4). */
          zones: null,
          ledgers: null,
          /** What we believe the enemy still holds (19.7, law 2). */
          enemyUtility: new EnemyUtilityTracker({ side: side === 'T' ? 'CT' : 'T', alive: 5 }),
          comms: new CommBus({ rng: rng.fork() }),
          protocol: new ProtocolRunner(),
          lastEffectTick: -1,
          keyword: keywordPreset(keyword),
          owners: null,
          layerGraph: null,
          layerAction: null,
          sync: makeSync({
            kind: mixAnchor(rng),
            event: 'detonate',
            atSeconds: 70
          }),
          opportunity: null,
          lastOurDeathTick: null,
          lastOurDeathPos: null,
          threat: null,
          budget: null,
          iglSlot: slots[0],
          /** Drawn once per round: the spread around the risk quantile (20.9). */
          audacity: rng.next(),
          executes: catalogFor(engine.state.map),
          executeBySlot: null,
          executeTick: -1,
          vizSpend: 0
        };
        // Gates point away from the enemy's half, so each side's map is
        // shielded from where its opponents come from.
        const enemySpawns = graph.spawns.filter((s) => s.side !== side);
        const ox = enemySpawns.reduce((s, p) => s + p.x, 0) / Math.max(1, enemySpawns.length);
        const oy = enemySpawns.reduce((s, p) => s + p.y, 0) / Math.max(1, enemySpawns.length);
        R.gates = buildGates(graph, R.neighbours, { x: ox, y: oy });
        // Which anchors belong to which site, resolved once. The threat ledger
        // asks this of every particle slot several times a second.
        R.siteZones = [target, other].filter(Boolean).map((site) => {
          const members = new Set();
          for (const [id, a] of graph.anchors) {
            if (Math.hypot(a.world.x - site.world.x, a.world.y - site.world.y) < 1200) {
              members.add(id);
            }
          }
          return { id: site.id, world: site.world, contains: (anchor) => members.has(anchor) };
        });
        R.owners = assignZoneOwners({
          zones: [...graph.anchors.keys()],
          roster: R.shape.posts,
          iglSlot: R.iglSlot,
          distance: (home, zone) => {
            const a = graph.anchor(home);
            const b = graph.anchor(zone);
            if (!a || !b) return Infinity;
            return Math.hypot(a.world.x - b.world.x, a.world.y - b.world.y);
          }
        });
        R.layerGraph = buildLayerGraph(graph, { neighbours: R.neighbours, gates: R.gates });
        if (!matchRng) matchRng = rng.fork();
        contracts = assignContracts({ map: engine.state.map, side, slots });
        R.contracts = contracts;
        const positionOf = (slot) => contracts.find((c) => c.slot === slot)?.position || null;
        R.shape = buildShape(graph, side, slots, target, other, positionOf);

        const ownSpawns = graph.spawns.filter((s) => s.side === side);
        const spawn = {
          x: ownSpawns.reduce((s, p) => s + p.x, 0) / Math.max(1, ownSpawns.length),
          y: ownSpawns.reduce((s, p) => s + p.y, 0) / Math.max(1, ownSpawns.length)
        };
        R.caller = createCaller({
          playbook,
          rng: rng.fork(),
          map: engine.state.map,
          side,
          slots,
          posture: callerPosture(keyword),
          // 9.25 stage 1. Injected, never imported: callValue.js prices plans
          // with caller.js's own arithmetic, so the dependency runs one way.
          // With these null the caller is stage 0's librarian, unchanged.
          compare: valueHead ? comparePlans : null,
          pick: valueHead ? pickPlan : null
        });
        R.knowledge = knowledge;
        // One PRW log per side per round (18.6b). Always on: the inspector's
        // two curves do not depend on memory being enabled, and nothing the
        // log does can reach a decision.
        R.prw = createPrwLog({ side, map: engine.state.map });
        R.prwOpened = false;
        R.calBias = 0;
        R.roundNumber = match?.state?.round ?? null;
        // The caller's own dataset (9.25 stage 3): one row per freeze or
        // recall. Always on for the same reason the PRW log is — observing a
        // decision cannot change it — and drained per round like the rest.
        R.igl = createIglLog({
          side,
          map: engine.state.map,
          econ: econBucketOf(slots.map((s) => engine.state.bodies[s])),
          matchId: matchId || null
        });
        R.tapeErrorSince = {};
        R.callerNotedBehind = false;
        R.knowledgeFlashAsked = {};
        R.promotedAtDeaths = 0;
        R.promotedAtBroken = 0;
        R.commandedKeyword = keyword != null && keyword !== 'default';
        const awpSeat = awpSlotOf({ map: engine.state.map, side, slots });
        // Two econ units, deliberately. The playbook matches tapes on the
        // miner's 0-5 bucket; the bandit keys on 6.10's named bucket. They are
        // not interchangeable and conflating them silently produces a key
        // space nothing else in the file shares.
        const ourBodies = slots.map((s) => engine.state.bodies[s]);
        const econTape = econBucketOf(ourBodies);
        const econKey = econBucket(
          ourBodies.filter(Boolean).reduce((s, b) => s + (weaponInfo(b.weapon).price || 0), 0) /
            Math.max(1, ourBodies.filter(Boolean).length)
        );

        // ---- 9.25 stage 2: EXP3 over legal calls -------------------------
        // "24 rounds is not a backprop set. It is a bandit." The machinery is
        // 6.10's and already runs for layer actions; what was missing is that
        // the CALL was never an arm and the key's `score` slot was never
        // filled, so a series could not look like a series. Two losses on the
        // B hit and the weight falls — that is the whole feature.
        //
        // Keyed by (side, econ, score) exactly as written: score is coarse
        // (up / even / down, pistol tagged) because a 24-round horizon cannot
        // afford a key per scoreline.
        const scoreState = match?.state?.score || null;
        const ourTeam = match?.teamOf ? match.teamOf(slots[0]) : null;
        R.banditKey = banditKey({
          side,
          econ: econKey,
          score: scoreSituation({
            us: ourTeam && scoreState ? scoreState[ourTeam] || 0 : 0,
            them: ourTeam && scoreState ? scoreState[ourTeam === 'A' ? 'B' : 'A'] || 0 : 0,
            pistol: match?.state ? isPistolRound(match.state) : false
          })
        });
        let openingCall = call;
        if (callBandit && matchRng && playbook?.calls?.[side]?.length) {
          const legal = playbook.calls[side].map(([name]) => ({ id: name }));
          const prior = legal.find((c) => c.id === call) || legal[0];
          openingCall =
            mixPolicyExp3(legal, {
              policyPick: prior,
              bandit,
              key: R.banditKey,
              rng: matchRng,
              idOf: (c) => c.id
            })?.id || call;
        }
        R.openingCall = openingCall;
        // The freeze picture: 5v5, full clock, nothing believed yet. Built by
        // the same function every later picture is, so the head is scoring one
        // arithmetic all round rather than two.
        const freezePicture = callerPicture(
          R,
          engine,
          slots.map((s) => engine.state.bodies[s]).filter((b) => b && b.alive !== false),
          { clock: 0 }
        );
        R.caller.roundStart({
          contractOf: () => null,
          awpOf: (slot) => slot === awpSeat,
          // 9.25 stage 1: the prior, not a hint. Stage 2's bandit may have
          // already moved it off the strategy's suggestion.
          strategyCall: openingCall,
          econ: econTape,
          picture: freezePicture,
          spawn,
          goal: target.world
        });
        // Deliberately NOT assigned to R.picture: the PRW log falls back to
        // R.picture, and seeding it here would put a row on the board before
        // the first team frame, which is 4.2b's cadence and not this one.
        logIgl(R, { tick: engine.state.tick, event: IGL_EVENT.FREEZE, picture: freezePicture });
        if (R.caller.teamMode() === CALLER_MODE.TAPE) {
          const posts = R.shape.posts.map((p) => {
            const role = R.caller.roleOf(p.slot);
            const home = role ? role.waypoints?.[0]?.[1] || role.contract : null;
            if (home && graph.anchor(home)) {
              return { ...p, home, role: role.awp ? 'awp' : p.role };
            }
            return p;
          });
          R.shape = makeShape({ call: R.caller.call() || R.shape.call, posts });
        }
        R.owners = assignZoneOwners({
          zones: [...graph.anchors.keys()],
          roster: R.shape.posts,
          iglSlot: R.iglSlot,
          distance: (home, zone) => {
            const a = graph.anchor(home);
            const b = graph.anchor(zone);
            if (!a || !b) return Infinity;
            return Math.hypot(a.world.x - b.world.x, a.world.y - b.world.y);
          }
        });
        R.obsHist = new Map();
      },

      tick({ engine, i, tick }) {
        if (!R || engine.state.phase === 'over') return;
        if (i < ticksFor(FREEZE_SECONDS)) return;
        if (tick % DECISION_EVERY_TICKS !== 0) return;

        const state = engine.state;
        const bodies = state.bodies;
        const events = [];

        // ---- A. percepts into the team belief ---------------------------

        const myLiving = R.slots.map((s) => bodies[s]).filter((b) => b.alive);
        R.ownCore = ownCore(myLiving);
        R.enemyCore = enemyCoreFromBelief(R.belief, R.graph);

        // Kill feed: public in CS, public here.
        R.enemySlots.forEach((es, idx) => {
          if (!bodies[es].alive && !R.belief.dead.has(idx)) {
            const dead = bodies[es];
            R.belief.killed(idx);
            const dOther = R.other
              ? Math.hypot(dead.pos.x - R.other.world.x, dead.pos.y - R.other.world.y)
              : Infinity;
            const dTarget = Math.hypot(dead.pos.x - R.target.world.x, dead.pos.y - R.target.world.y);
            const classified = classifyEvent(
              { type: 'death', slot: es },
              {
                side: R.side,
                sideOf: (slot) => bodies[slot]?.side,
                teamDeaths: 0,
                brokenCount: 0,
                roundSeconds: (tick - state.liveTick) / TICK_RATE,
                farSide: dOther + 400 < dTarget,
                awperSlot: /awp/i.test(dead.weapon || '') ? es : null
              }
            );
            if (classified.clazz === INTERRUPT.OPPORTUNITY) {
              R.opportunity = { tick, reason: classified.reason, at: { x: dead.pos.x, y: dead.pos.y } };
            }
            if (R.caller) {
              const clock = (tick - state.liveTick) / TICK_RATE;
              const contractOf = (slot) => {
                const body = bodies[slot];
                return body?.alive ? angles.nearestAnchor(body.pos.x, body.pos.y)?.id || null : null;
              };
              const awpOf = (slot) =>
                /awp/i.test((R.contracts || []).find((row) => row.slot === slot)?.position || '');
              const picture = callerPicture(R, engine, myLiving, { tick, clock });
              const prwCtx = {
                engine,
                tick,
                picture,
                reason:
                  classified.clazz === INTERRUPT.OPPORTUNITY
                    ? PRW_REASON.OPPORTUNITY
                    : PRW_REASON.RECALL
              };
              if (classified.clazz === INTERRUPT.IGNORE) {
                applyCallerDecision(
                  R,
                  R.caller.considerPicture(picture, { contractOf, awpOf }),
                  prwCtx
                );
              } else {
                applyCallerDecision(
                  R,
                  R.caller.onInterrupt({
                    clazz: classified.clazz,
                    slots: classified.slots || [],
                    contractOf,
                    awpOf,
                    ...picture
                  }),
                  prwCtx
                );
              }
            }
          }
        });
        for (const s of R.slots) {
          if (!bodies[s].alive && R.footprints[s].deadSinceTick === null) {
            const last = R.last[s];
            R.lastOurDeathTick = tick;
            R.lastOurDeathPos = last
              ? { x: last.x, y: last.y, level: bodies[s].level }
              : { x: bodies[s].pos.x, y: bodies[s].pos.y, level: bodies[s].level };
            const moved = reassignOnDeath({ contracts: R.contracts || [], deadSlot: s, tick });
            if (moved?.directive) {
              this.log.push({
                tick,
                slot: s,
                id: 'reassign',
                motive: `cover ${moved.directive.cover} from ${moved.directive.toSlot}`
              });
              if (moved.to) {
                R.contracts = (R.contracts || []).map((c) => (c.slot === moved.to.slot ? moved.to : c));
              }
            }
            const victim = R.lastOurDeathPos;
            R.belief.deathRecord({
              canSeeFrom: (anchor) => {
                const a = R.graph.anchor(anchor);
                if (!a || a.level !== victim.level) return false;
                return angles.canSee(a.world.x, a.world.y, victim.x, victim.y, a.level);
              }
            });
            R.footprints[s].noteDeath(tick);
            logPrw(R, engine, {
              tick,
              reason: PRW_REASON.DEATH,
              picture: callerPicture(R, engine, myLiving, {
                tick,
                clock: (tick - state.liveTick) / TICK_RATE
              }),
              motive: `lost slot ${s}`
            });
            events.push({ type: 'death', slot: s });
            for (const o of R.slots) {
              if (o !== s) R.runners[o].gate.onEvent(tick, 'death');
            }
          }
        }

        // Sightings, through the same catalogue the engine fights with.
        const seenAnchors = new Set();
        R.enemySlots.forEach((es, idx) => {
          const enemy = bodies[es];
          if (!enemy.alive) return;
          for (const w of myLiving) {
            if (w.level !== enemy.level) continue;
            if (!angles.canSee(w.pos.x, w.pos.y, enemy.pos.x, enemy.pos.y, w.level)) continue;
            const at = angles.nearestAnchor(enemy.pos.x, enemy.pos.y);
            if (!at) continue;
            R.belief.sighting(idx, at.id, { weapon: enemy.weapon });
            seenAnchors.add(at.id);
            R.lastEvidenceTick = tick;
            R.lastSeenTick = tick;
            const c = R.contacts[idx] || { myFirstSeenTick: tick };
            c.myLastSeenTick = tick;
            if (c.myFirstSeenTick === undefined) c.myFirstSeenTick = tick;
            R.contacts[idx] = c;
            if (R.caller && !R.callerNotedBehind && c.myFirstSeenTick === tick) {
              const clock = (tick - state.liveTick) / TICK_RATE;
              const picture = callerPicture(R, engine, myLiving, { tick, clock });
              const intel = R.caller.considerIntel({
                x: enemy.pos.x,
                y: enemy.pos.y,
                ...picture,
                contractOf: (slot) => {
                  const body = bodies[slot];
                  return body?.alive ? angles.nearestAnchor(body.pos.x, body.pos.y)?.id || null : null;
                },
                awpOf: (slot) =>
                  /awp/i.test((R.contracts || []).find((row) => row.slot === slot)?.position || '')
              });
              if (intel.rel === 'behind') R.callerNotedBehind = true;
              applyCallerDecision(R, intel, { engine, tick, picture });
            }
            break;
          }
        });

        // Negative information: ground my side can see and nobody stands on.
        const swept = new Set();
        for (const [id, a] of R.graph.anchors) {
          if (seenAnchors.has(id)) continue;
          for (const w of myLiving) {
            if (w.level !== a.level) continue;
            if (angles.canSee(w.pos.x, w.pos.y, a.world.x, a.world.y, w.level)) {
              swept.add(id);
              break;
            }
          }
        }
        if (swept.size) R.belief.cleared(swept);
        // Ground we are looking at right now is ground the doctrine calls
        // checked, and it goes stale on its own clock (20.2).
        for (const id of swept) R.sweptAt[id] = tick;
        for (const id of seenAnchors) R.sweptAt[id] = tick;

        // Sound: the engine's own degraded percepts, teammate steps excluded
        // the way a human excludes them — "that's just where Dan is". The log
        // is a sliding window, so items are claimed by tick, never by index.
        //
        // Grenade conservation (19.7): throw and detonate both emit type
        // 'grenade'. A new enemy effect this tick is the pop; a grenade sound
        // without one is a throw that left their hands.
        const popsThisTick = new Set();
        for (const e of state.effects) {
          if (e.startTick <= R.lastEffectTick) continue;
          if (e.side === R.side) continue;
          const seen = myLiving.some(
            (w) =>
              w.level === e.level &&
              angles.canSee(w.pos.x, w.pos.y, e.x, e.y, w.level)
          );
          if (seen) R.enemyUtility.sawDetonation({ type: e.type, tick: e.startTick });
          popsThisTick.add(e.startTick);
        }
        R.lastEffectTick = tick;

        for (const p of engine.sounds.items) {
          if (p.tick <= R.lastSoundTick) continue;
          const listener = bodies[p.listener];
          if (!listener || listener.side !== R.side || !listener.alive) continue;
          const isGrenade = p.type === SOUND.GRENADE;
          if (!isGrenade && p.type !== 'footstep' && p.type !== 'gunshot' && p.type !== 'landing') {
            continue;
          }

          const radius = SOUND_RADIUS[p.type] ?? 1100;
          const explainedByMate = myLiving.some((m) => {
            if (m.slot === p.listener) return false;
            const d = Math.hypot(m.pos.x - listener.pos.x, m.pos.y - listener.pos.y);
            return (
              rangeBand(d, radius) === p.band &&
              sector(listener.pos.x, listener.pos.y, m.pos.x, m.pos.y) === p.sector
            );
          });
          if (explainedByMate) continue;

          if (isGrenade && !popsThisTick.has(p.tick)) {
            R.enemyUtility.heardThrow({ tick: p.tick });
          }

          R.lastEvidenceTick = tick;
          R.lastHeardTick = tick;
          R.belief.heard((anchor) => {
            const a = R.graph.anchor(anchor);
            if (!a) return 0;
            const d = Math.hypot(a.world.x - listener.pos.x, a.world.y - listener.pos.y);
            if (d > radius * 1.2) return 0;
            const sectorMatch =
              sector(listener.pos.x, listener.pos.y, a.world.x, a.world.y) === p.sector;
            const bandMatch = rangeBand(d, radius) === p.band;
            return (sectorMatch ? 0.7 : 0.1) + (bandMatch ? 0.3 : 0);
          });
        }
        const soundItems = engine.sounds.items;
        if (soundItems.length) R.lastSoundTick = soundItems[soundItems.length - 1].tick;

        if (tick % UPDATE_EVERY_TICKS === 0) {
          R.belief.propagate(R.neighbours, 0.2);
          if (R.belief.ess() < R.belief.count / 2) R.belief.resample(R.neighbours);
        }

        // ---- B. footprints and change events ----------------------------

        const massAt = (anchor, level) => R.belief.massAt(anchor, level);
        for (const s of R.slots) {
          const b = bodies[s];
          const last = R.last[s];
          if (!b.alive) continue;

          if (b.magAmmo < last.mag) {
            R.footprints[s].noteShot(tick, {
              x: b.pos.x,
              y: b.pos.y,
              level: b.level,
              silenced: isSilenced(b.weapon)
            });
          }
          const moved = Math.hypot(b.pos.x - last.x, b.pos.y - last.y);
          if (b.gait === 'run' && moved > 20) {
            R.footprints[s].noteFootstep(tick, { x: b.pos.x, y: b.pos.y, level: b.level });
          }
          const watchers = angles
            .exposedTo(b.pos.x, b.pos.y)
            .filter((e) => massAt(e.anchor, e.level) > 0.05)
            .map((e) => e.anchor);
          if (watchers.length) {
            R.footprints[s].noteSeenBy(tick, [...new Set(watchers)], DECISION_EVERY_TICKS / TICK_RATE);
          }

          if (b.health < last.hp) {
            events.push({ type: 'damage', slot: s });
            R.runners[s].gate.onEvent(tick, 'damage');
          }
          if (b.focus !== null && b.focus !== last.focus) {
            events.push({ type: 'contact', slot: s });
            R.runners[s].gate.onEvent(tick, 'contact');
          }

          R.last[s] = { hp: b.health, mag: b.magAmmo, x: b.pos.x, y: b.pos.y, focus: b.focus };
        }
        for (const e of R.translator.events.splice(0)) events.push(e);
        if (state.bomb.planted && !R.planted) {
          R.planted = true;
          for (const s of R.slots) R.runners[s].gate.onEvent(tick, 'bomb_planted');
          R.caller?.retire();
          logPrw(R, engine, {
            tick,
            reason: PRW_REASON.PLANT,
            picture: callerPicture(R, engine, myLiving, {
              tick,
              clock: (tick - state.liveTick) / TICK_RATE
            }),
            motive: 'bomb down'
          });
        }

        if (R.caller) {
          const clock = (tick - state.liveTick) / TICK_RATE;
          const contractOf = (slot) => {
            const body = bodies[slot];
            return body?.alive ? angles.nearestAnchor(body.pos.x, body.pos.y)?.id || null : null;
          };
          const awpOf = (slot) =>
            /awp/i.test((R.contracts || []).find((row) => row.slot === slot)?.position || '');
          const ctx = {
            side: R.side,
            sideOf: (slot) => bodies[slot]?.side,
            teamDeaths: R.slots.filter((slot) => !bodies[slot].alive).length,
            brokenCount: R.caller.brokenCount(),
            roundSeconds: clock,
            awperSlot: R.slots.find((slot) => awpOf(slot)) ?? null,
            plannedSite: R.caller.plannedSite(),
            contactExpected: R.caller.teamMode() === CALLER_MODE.TAPE
          };
          const picture = callerPicture(R, engine, myLiving, { tick, clock });
          for (const ev of events) {
            const deathsBefore = Number.isInteger(ev.slot)
              ? R.slots.filter((slot) => slot !== ev.slot && !bodies[slot].alive).length
              : ctx.teamDeaths;
            const classified = classifyEvent(ev, { ...ctx, teamDeaths: deathsBefore });
            applyCallerDecision(
              R,
              R.caller.onInterrupt({
                clazz: classified.clazz,
                slots: classified.slots || [],
                contractOf,
                awpOf,
                ...picture
              }),
              { engine, tick, picture }
            );
          }
          const promo = shouldPromote({
            brokenCount: R.caller.brokenCount(),
            teamDeaths: ctx.teamDeaths
          });
          const deathsUp = ctx.teamDeaths > (R.promotedAtDeaths || 0);
          const brokenUp = R.caller.brokenCount() > (R.promotedAtBroken || 0);
          if (promo.promote && (deathsUp || brokenUp)) {
            R.promotedAtDeaths = Math.max(R.promotedAtDeaths || 0, ctx.teamDeaths);
            R.promotedAtBroken = Math.max(R.promotedAtBroken || 0, R.caller.brokenCount());
            applyCallerDecision(
              R,
              R.caller.onInterrupt({
                clazz: INTERRUPT.TEAM,
                contractOf,
                awpOf,
                ...picture,
                teamBroken: true
              }),
              { engine, tick, picture }
            );
          }
        }

        // ---- C. the shared team frame -----------------------------------

        const aliveFlags = [];
        for (const s of R.slots) aliveFlags[s] = bodies[s].alive;
        const travelSeconds = (slot, anchorId) => {
          const a = R.graph.anchor(anchorId);
          const b = bodies[slot];
          if (!a || !b?.alive) return Infinity;
          return Math.hypot(a.world.x - b.pos.x, a.world.y - b.pos.y) / PLAN_SPEED;
        };
        const holes = uncoveredPosts(R.shape, aliveFlags, travelSeconds);

        const field = computeSpaceField({
          anchors: [...R.graph.anchors.keys()],
          myReachSeconds: (id) => Math.min(...R.slots.map((s) => travelSeconds(s, id))),
          enemyReachSeconds: (id) => {
            const m = massAt(id, R.graph.anchor(id)?.level || 'default');
            return m > 0.05 ? 0 : m > 0.005 ? 4 : Infinity;
          },
          value: (id) => {
            const a = R.graph.anchor(id);
            const site = R.side === 'T' ? R.target : null;
            if (!a) return 0;
            if (site) {
              const d = Math.hypot(a.world.x - site.world.x, a.world.y - site.world.y);
              return Math.max(0.1, 1 - d / 3000);
            }
            return 0.4;
          },
          dangerMass: (id) => massAt(id, R.graph.anchor(id)?.level || 'default')
        });

        // ---- C2. the doctrine frame (20.2, 20.4) ------------------------
        //
        // The four-class map and the four ledgers, computed once for the team
        // rather than once per bot: they are a property of what the side knows,
        // and five bots on one side know the same thing. This is the block the
        // observation carries (7.2) and the reason a policy can learn the
        // theory instead of a map's vocabulary.
        const holdingSet = new Set();
        for (const b of myLiving) {
          const at = angles.nearestAnchor(b.pos.x, b.pos.y);
          if (at) holdingSet.add(at.id);
        }
        R.zones = classifyZones({
          zones: [...R.graph.anchors.keys()],
          holding: (z) => holdingSet.has(z),
          enemyMass: (z) => massAt(z, R.graph.anchor(z)?.level || 'default'),
          sweptTick: (z) => R.sweptAt[z],
          gates: R.gates,
          tick
        });

        // Law 1 acting on law 2 (19.7): a body that dies takes its unthrown
        // utility with it, so the ceiling falls with the roster.
        R.enemyUtility.bodiesLost(R.belief.aliveCount());
        R.ledgers = readLedgers({
          classification: R.zones,
          // Ours exact, theirs BELIEVED and bounded by what their buy could
          // contain minus every throw we heard and every detonation we saw
          // (19.7, law 2). The asymmetry is the point: it is the position a
          // real team is in, and it makes the late round a count rather than
          // a guess.
          utility: R.enemyUtility.ledger({
            ours: myLiving.flatMap((b) => b.grenades)
          }),
          threat: threatLedger({
            sites: R.siteZones.map((s) => s.id),
            // Membership is fixed for the round, so the belief's per-particle
            // test is a Set lookup rather than a distance query: countDist
            // walks 256 particles x 5 slots per site per decision tick, and
            // doing geometry inside that loop was the single most expensive
            // thing the doctrine frame added.
            countDist: (siteId) =>
              R.belief.countDist(R.siteZones.find((s) => s.id === siteId).contains),
            secondsToConvert: (siteId) => {
              const site = R.siteZones.find((s) => s.id === siteId);
              let best = Infinity;
              for (const b of myLiving) {
                best = Math.min(
                  best,
                  Math.hypot(site.world.x - b.pos.x, site.world.y - b.pos.y) / PLAN_SPEED
                );
              }
              return best;
            }
          }),
          timing: timingLedger({
            contested: [...R.zones.entries()]
              .filter(([, c]) => c === ZONE.UNKNOWN)
              .slice(0, 8)
              .map(([z]) => z),
            ourEta: (z) => Math.min(...R.slots.map((s) => travelSeconds(s, z))),
            theirEta: (z) => {
              const m = massAt(z, R.graph.anchor(z)?.level || 'default');
              return m > 0.05 ? 0 : m > 0.005 ? 4 : Infinity;
            }
          }),
          tick,
          liveTick: state.liveTick,
          roundSeconds: ROUND_SECONDS
        });

        // ---- C3. threat, budget, layers, protocols, comms (19.3–19.4, 20.x)

        R.comms.deliver(tick);

        const teamClock = Math.max(0, engine.clock());
        const inTarget = (anchor) => {
          const a = R.graph.anchor(anchor);
          return a
            ? Math.hypot(a.world.x - R.target.world.x, a.world.y - R.target.world.y) < 1200
            : false;
        };
        const inOther = (anchor) => {
          if (!R.other) return false;
          const a = R.graph.anchor(anchor);
          return a
            ? Math.hypot(a.world.x - R.other.world.x, a.world.y - R.other.world.y) < 1200
            : false;
        };
        const split = R.belief.splitEntropy([
          { name: 'target', test: inTarget },
          { name: 'other', test: inOther }
        ]);
        // Split entropy is bits of ignorance; VOI here is a scalar stand-in so
        // we do not price every option twice per tick. `[calibrate]`
        R.budget = budgetDecision({
          voi: Math.max(0, split) * 0.02,
          resolvable: 0.35,
          dPRWPerSecond: teamClock < 40 ? 0.02 : 0.004,
          layoutCount: 8,
          cap: HYPOTHESIS_COUNT,
          gatherAvailable: true
        });
        if (R.budget.decision === 'widen') {
          R.vizSpend = Math.min(1, (R.vizSpend || 0) + 1 / 32);
        }

        const threatSpots = [];
        const seenSpot = new Set();
        const pushSpot = (id) => {
          if (!id || seenSpot.has(id) || threatSpots.length >= 8) return;
          const a = R.graph.anchor(id);
          if (!a) return;
          seenSpot.add(id);
          threatSpots.push({ x: a.world.x, y: a.world.y, level: a.level, anchor: id });
        };
        for (const b of myLiving) {
          const at = angles.nearestAnchor(b.pos.x, b.pos.y);
          if (at) pushSpot(at.id);
        }
        pushSpot(R.target.id);
        if (R.other) pushSpot(R.other.id);
        R.threat = threatSpots.length
          ? threatField({
              belief: R.belief,
              catalogue: angles,
              spots: threatSpots,
              cap: 8
            })
          : null;

        const ourNades = myLiving.flatMap((b) => b.grenades);
        const layerUtil = {
          smoke: ourNades.filter((g) => g === 'smokegrenade').length,
          flash: ourNades.filter((g) => g === 'flashbang').length,
          molotov: ourNades.filter((g) => g === 'molotov' || g === 'incgrenade').length
        };
        const front = frontier(R.zones, R.gates);
        const layerCandidates = legalLayerActions({
          classification: R.zones,
          frontier: front,
          utility: layerUtil,
          alive: myLiving.length,
          gates: R.gates
        });
        const heuristic = pickLayerAction(layerCandidates, { clock: teamClock, utility: layerUtil });
        const ourEquip =
          myLiving.reduce((s, b) => s + (weaponInfo(b.weapon).price || 0), 0) /
          Math.max(1, myLiving.length);
        const econNow = econBucket(ourEquip);
        const sit = situationKey({
          map: engine.state.map,
          side: R.side,
          phase: state.bomb.planted ? 'after-plant' : 'early',
          secondsLeft: teamClock,
          ours: myLiving.length,
          theirs: R.belief.aliveCount(),
          econUs: econNow,
          shape: shapeFromCore(R.ownCore),
          read: shapeFromCore(R.enemyCore)
        });
        const idOf = (c) => libraryLabel(c);
        let layered = heuristic;
        if (memoryEnabled && matchRng && layerCandidates.length) {
          layered = strategy.select(layerCandidates, {
            key: sit.hash,
            policyPick: heuristic,
            rng: matchRng,
            idOf,
            side: R.side,
            econ: econNow
          });
        } else if (matchRng && layerCandidates.length) {
          layered = mixPolicyExp3(layerCandidates, {
            policyPick: heuristic,
            bandit,
            key: banditKey({ side: R.side, econ: econNow }),
            rng: matchRng,
            idOf
          });
        }
        if (searchEnabled && layerCandidates.length) {
          const searched = decisionSearch({
            candidates: layerCandidates,
            policyPick: layered,
            evaluate: (c) => (PROTOCOL_BODIES[c.protocol] || 1) * 0.05 - (R.belief.massAt?.(c.convert) || 0),
            sampleLayouts: () => [{}],
            K: 8,
            maxMs: 4,
            rng: matchRng,
            enabled: true,
            idOf
          });
          layered = searched.pick || layered;
          expert.push(searched.disagreement);
        }
        R.layerAction = layered;
        R.situation = sit;

        const exp = memoryEnabled ? index.read(sit.hash) : null;
        // 18.6b.1 lands here and nowhere else: the bias is an INPUT to the
        // maximization the bot already performs. Memory off leaves it zero,
        // so a run that never reads the index still hashes the same.
        R.calBias = memoryEnabled ? index.calibrationFor(sit.hash) : 0;
        // 9.25 stage 1's third ingredient, refreshed for the situation the
        // caller is actually in. Off with memory, because a head that reads
        // an index a run never touched would change that run's hash.
        if (valueHead) {
          R.caller.useHead(memoryEnabled ? indexValueOf(index, sit.hash) : null);
        }
        R.picture = callerPicture(R, engine, myLiving, {
          tick,
          clock: (tick - state.liveTick) / TICK_RATE,
          secondsLeft: teamClock,
          experience: exp
        });
        R.pWin = pictureWinrate(R.picture);

        // The team frame is the logging cadence 18.6b asks for; prw.js rate-
        // limits it, and the events above are never rate-limited.
        logPrw(R, engine, {
          tick,
          reason: R.prwOpened ? PRW_REASON.FRAME : PRW_REASON.FREEZE,
          picture: R.picture,
          pWin: R.pWin,
          motive: R.layerAction ? libraryLabel(R.layerAction) : R.caller?.call() || null
        });
        R.prwOpened = true;

        if (!R.commandedKeyword && R.caller) {
          const freezeKw = R.caller.freezeKeyword();
          if (freezeKw) R.keyword = keywordPreset(freezeKw);
          else if (R.keyword.id === 'vp' || R.keyword.id === 'freeze') {
            R.keyword = keywordPreset('default');
          }
        }

        const protoTarget = R.layerAction?.convert ?? front[0] ?? R.target.id;
        const protoCtx = {
          side: R.side,
          clockSeconds: teamClock,
          ours: myLiving.length,
          theirs: R.belief.aliveCount(),
          available: myLiving.length,
          targetZone: protoTarget,
          targetZoneClass: R.zones.get(protoTarget) ?? null,
          zoneClass: R.zones.get(protoTarget) ?? null,
          utilityInHand: layerUtil.smoke + layerUtil.molotov + layerUtil.flash > 0,
          utilityLeft: layerUtil.smoke + layerUtil.molotov + layerUtil.flash,
          abort: R.layerAction?.abort ?? null
        };
        const protoId = LAYER_PROTOCOL[R.layerAction?.protocol];
        if (
          protoId &&
          R.protocol.mayReplace(tick) &&
          R.protocol.active?.id !== protoId &&
          protocolInitiationSet(protoCtx).has(protoId)
        ) {
          R.protocol.begin(tick, protoId, {
            params: {
              target: protoTarget,
              site: R.target.id,
              spot: protoTarget,
              abort: R.layerAction.abort
            },
            roster: R.shape.posts.map((p) => ({
              slot: p.slot,
              role: p.role,
              focus: p.focus,
              alive: bodies[p.slot]?.alive
            }))
          });
        }
        const protoStep = R.protocol.step(tick, protoCtx);
        R.protocolBySlot = new Map();
        for (const a of protoStep.assignments) R.protocolBySlot.set(a.slot, a);

        // ---- D. decide, per living bot ----------------------------------

        const elapsed = (tick - state.liveTick) / TICK_RATE;
        const secondsLeft = Math.max(0, engine.clock());
        const equip = (b) => (weaponInfo(b.weapon).price || 0) + (b.armor > 0 ? 1000 : 0);
        let ctSum = 0;
        let tSum = 0;
        let ctAlive = 0;
        let tAlive = 0;
        for (const b of bodies) {
          if (!b.alive) continue;
          if (b.side === 'CT') {
            ctAlive += 1;
            ctSum += equip(b);
          } else {
            tAlive += 1;
            tSum += equip(b);
          }
        }
        const round = {
          map: state.map,
          mySide: R.side,
          elapsed,
          secondsLeft,
          ctAlive,
          tAlive,
          ctEquipSum: ctSum,
          tEquipSum: tSum,
          planted: state.bomb.planted,
          bombSecondsLeft: state.bomb.planted
            ? Math.max(0, 40 - (tick - state.plantTick) / TICK_RATE)
            : 0,
          ctHasKit: bodies.some((b) => b.alive && b.side === 'CT' && b.hasKit),
          teammates: myLiving.map((b) => ({ slot: b.slot, side: b.side, hp: b.health, value: equip(b) }))
        };

        // The one scripted override left: a loose bomb is a rule state, not a
        // preference. The nearest T retrieves; the REST converge on the drop,
        // because a lone retriever walking into whatever killed the carrier
        // is how a side feeds four bodies to one crossfire. It patches EVERY
        // intent — a rule applied only on decision steps loses to the
        // committed path re-sending the old intent, and the retriever turns
        // around every 125 ms forever.
        const dropAnchor = state.bomb.dropped
          ? nearestAnchors(
              R.graph,
              state.bomb.dropped.x,
              state.bomb.dropped.y,
              state.bomb.dropped.level || 'default',
              1
            )[0]
          : null;
        const patchLooseBomb = (slot, intent) => {
          if (R.side !== 'T' || !state.bomb.dropped) return intent;
          const b = bodies[slot];
          if (b.hasBomb) return intent;
          const d = Math.hypot(b.pos.x - state.bomb.dropped.x, b.pos.y - state.bomb.dropped.y);
          const nearest = myLiving.every(
            (m) =>
              m.slot === slot ||
              Math.hypot(m.pos.x - state.bomb.dropped.x, m.pos.y - state.bomb.dropped.y) >= d
          );
          if (nearest) {
            intent.objective = 'pickupBomb';
          } else if (dropAnchor && d > 600) {
            // Escort: converge until close enough to trade for the carrier.
            intent.move = { mode: 'advance', target: dropAnchor, gait: 'run' };
            intent.combat = { posture: 'free', preAim: null };
          }
          return intent;
        };

        // Seat counter for the mimic key: the BC dataset stamps decisions
        // "T0".."CT4" in decision order within a tick (sim-collect-bc.mjs),
        // so inference keys the embedding the same positional way. Real
        // SteamID64 keys replace this when demo-labelled datasets arrive.
        let decideSeat = 0;
        for (const s of R.slots) {
          const b = bodies[s];
          if (!b.alive) continue;
          const runner = R.runners[s];

          const myAnchor = angles.nearestAnchor(b.pos.x, b.pos.y);
          const targetId = runner.active?.params?.target ?? runner.active?.params?.spot ?? null;
          const targetAnchor = targetId ? R.graph.anchor(targetId) : null;
          const arrived = targetAnchor
            ? Math.hypot(targetAnchor.world.x - b.pos.x, targetAnchor.world.y - b.pos.y) <
              AT_ANCHOR_UNITS
            : false;

          const stepped = runner.step(tick, events, {
            myAnchor: myAnchor?.id,
            arrived,
            planted: state.bomb.planted,
            defused: Boolean(state.bomb.defusedBy),
            // The translator owns the one-shot, so it is the authority on
            // whether this slot's utility order has fired.
            thrown: R.translator.hasThrown(s)
          });

          if (runner.active && !runner.mayReplace(tick)) {
            R.translator.setIntent(s, patchLooseBomb(s, stepped.intent));
            continue;
          }

          // Candidates: home, the frame, the reads, and the objective.
          let home = R.shape.posts.find((p) => p.slot === s);

          // The afterplant is a different round (4.9): the pre-plant approach
          // posts do not cover the bomb, and five Ts holding them lose to any
          // retake that walks past. Once the bomb is down, home becomes a
          // spread of the nearest anchors that can actually see it.
          if (R.side === 'T' && state.bomb.planted) {
            if (!R.afterplant) {
              const covering = nearestAnchors(
                R.graph,
                state.bomb.x,
                state.bomb.y,
                R.graph.levelFor(state.bomb.z),
                12
              ).filter((id) => {
                const a = R.graph.anchor(id);
                return (
                  a && angles.canSee(a.world.x, a.world.y, state.bomb.x, state.bomb.y, a.level)
                );
              });
              // Two posts, not twelve: a defense spread one-per-angle meets
              // the retake stack one man at a time and loses every meeting.
              // Two or three bodies per post keeps every contact a crossfire.
              R.afterplant = covering.length ? covering.slice(0, 2) : [R.target.id];
            }
            const living = R.slots.filter((sl) => bodies[sl].alive);
            const post = R.afterplant[living.indexOf(s) % R.afterplant.length];
            home = { slot: s, role: 'anchor', home: post };
          }

          const candidates = [];
          let spacingTypical = null;
          if (home) {
            // Pre-aim the approach the belief points at: preAim moves offA at
            // contact, offA moves crossW, and crossW is the largest fitted
            // term in the duel model (6.8). Never leave it null on a hold.
            let preAim = null;
            let preMass = 0;
            for (const n of R.neighbours(home.home)) {
              const a = R.graph.anchor(n);
              const m = a ? massAt(n, a.level) : 0;
              const row = R.threat?.rows.find((r) => r.anchor === n);
              const score = m + (row ? (row.byClass[SNIPER_CLASS] || 0) * 0.5 : 0);
              if (score > preMass) {
                preMass = score;
                preAim = n;
              }
            }
            if (!preAim) preAim = R.neighbours(home.home)[0] ?? null;
            // Afterplant, the crosshair rests on the bomb: the defuser has to
            // come to it, and a hold that punishes the channel the instant it
            // starts is what covering the bomb MEANS.
            if (R.side === 'T' && state.bomb.planted) {
              preAim =
                nearestAnchors(
                  R.graph,
                  state.bomb.x,
                  state.bomb.y,
                  R.graph.levelFor(state.bomb.z),
                  1
                )[0] ?? preAim;
            }
            candidates.push({
              id: 'hold_angle',
              params: { spot: home.home, yaw: preAim },
              isHome: true,
              prior: 0.55,
              motive: 'holding my post'
            });
          }

          const onTape = R.caller && R.caller.isOnTape(s, elapsed);
          if (onTape) {
            const wp = R.caller.waypoint(s, elapsed);
            if (wp) {
              const a = R.graph.anchor(wp);
              const err = a ? Math.hypot(a.world.x - b.pos.x, a.world.y - b.pos.y) : 0;
              if (err > TAPE_ERROR_UNITS) {
                R.tapeErrorSince[s] = R.tapeErrorSince[s] ?? tick;
                if ((tick - R.tapeErrorSince[s]) / TICK_RATE > TAPE_ERROR_SECONDS) {
                  R.caller.markLocal(s);
                }
              } else {
                R.tapeErrorSince[s] = null;
              }
              if (R.caller.isOnTape(s, elapsed)) {
                const arrivedTape = err < AT_ANCHOR_UNITS * 2;
                const frozen = R.caller.decision() === 'freeze';
                if (!frozen || arrivedTape) {
                  candidates.push({
                    id: arrivedTape || frozen ? 'hold_angle' : 'advance',
                    params: arrivedTape || frozen ? { spot: wp, yaw: wp } : { target: wp, gait: 'run' },
                    prior: 0.86,
                    motive: `tape: ${wp}`
                  });
                }
              }
            }
            for (const u of R.caller.due(s, elapsed)) {
              if (!b.grenades.includes(u.type)) continue;
              candidates.push({
                id: 'utility_setup',
                params: {
                  spot: u.from,
                  from: u.from,
                  at: u.at,
                  utilityType: u.type,
                  fromX: u.fx,
                  fromY: u.fy,
                  atX: u.ax,
                  atY: u.ay,
                  flight: u.flight,
                  tapeIndex: u.index
                },
                prior: 0.92,
                motive: `tape throw ${u.type}`
              });
            }
          }

          if (!(R.caller && R.caller.isOnTape(s, elapsed))) {
            spacingTypical = pushKnowledgeCandidates({
              R,
              s,
              b,
              myAnchor,
              elapsed,
              candidates,
              angles,
              tick,
              myLiving
            });
          }

          // The read that concentrates a defense: when the belief puts the
          // enemy pack at one site and my post is elsewhere, wanting to be
          // where the round is about to happen is the whole job (6.14).
          // Gated three ways, each learned from a failed eval: only the
          // reacting side rotates, only on actual evidence (a uniform prior
          // "reads" two anywhere), and never twice in quick succession.
          const evidenceFresh = tick - (R.lastEvidenceTick ?? -Infinity) < ticksFor(8);
          const rotateReady = tick - (R.lastRotate?.[s] ?? -Infinity) > ticksFor(20);
          if (R.side === 'CT' && !state.bomb.planted && evidenceFresh && rotateReady) {
            for (const site of [R.target, R.other]) {
              const inSite = (anchor) => {
                const a = R.graph.anchor(anchor);
                return a
                  ? Math.hypot(a.world.x - site.world.x, a.world.y - site.world.y) < 1200
                  : false;
              };
              const expected = R.belief.expected(inSite);
              const myD = Math.hypot(b.pos.x - site.world.x, b.pos.y - site.world.y);
              if (expected >= 2.5 && myD > 1400) {
                candidates.push({
                  id: 'rotate',
                  params: { site: site.id, target: site.id },
                  prior: 0.72,
                  motive: `their pack reads ${expected.toFixed(1)} strong at ${site.id}`
                });
              }
            }
          }
          // The bomb-cover mask (20.12): a T with the bomb down has two legal
          // wants — cover it, or trade the man covering it. Wandering options
          // price better than a fight at the bomb precisely because the price
          // cannot see the forfeit, so they are masked, not outbid.
          const bombMasked = R.side === 'T' && state.bomb.planted;

          if (!bombMasked) {
            for (const run of bestSpace(field, (id) => id !== myAnchor?.id, 1)) {
              candidates.push({
                id: 'take_space',
                params: { target: run.anchor, gait: 'walk' },
                prior: 0.45 + Math.max(0, Math.min(0.2, run.opportunity / 4))
              });
            }
          }
          if (
            R.opportunity &&
            tick - R.opportunity.tick < ticksFor(8) &&
            R.side === 'T' &&
            !state.bomb.planted &&
            !bombMasked
          ) {
            const dest = nearestAnchors(
              R.graph,
              R.opportunity.at.x,
              R.opportunity.at.y,
              b.level,
              1
            )[0];
            if (dest) {
              candidates.push({
                id: 'take_space',
                params: { target: dest, gait: 'run' },
                prior: 0.7,
                motive: R.opportunity.reason
              });
            }
          }

          // Utility: the reactive rung of the ladder (6.22). A held heavy
          // nade wants the ground the belief is angriest about inside throw
          // range: the T smokes the watcher he is about to walk at, the CT
          // burns the approach he is holding. One shot, priced through
          // foresight like every other want; the arbiter is free to prefer
          // holding it, which is what saving utility for the late round IS.
          if (!bombMasked && !state.bomb.planted && b.grenades.length) {
            const heavy = b.grenades.find(
              (g) => g === 'smokegrenade' || g === 'molotov' || g === 'incgrenade'
            );
            if (heavy) {
              let at = null;
              let atMass = 0;
              for (const id of nearestAnchors(R.graph, b.pos.x, b.pos.y, b.level, 12)) {
                if (id === myAnchor?.id) continue;
                const a = R.graph.anchor(id);
                if (!a || a.level !== b.level) continue;
                const d = Math.hypot(a.world.x - b.pos.x, a.world.y - b.pos.y);
                if (d < 260 || d > ADHOC_THROW_MAX) continue;
                // The ad-hoc throw is a straight lob that stops at the first
                // wall (engine.throwGrenade walks this exact line), so gate on
                // the same walk: a blocked line means smoking one's own feet.
                const ux = (a.world.x - b.pos.x) / d;
                const uy = (a.world.y - b.pos.y) / d;
                let carry = 0;
                for (let step = 20; step <= d; step += 20) {
                  if (R.graph.isSolidWorld(b.pos.x + ux * step, b.pos.y + uy * step, b.level)) break;
                  carry = step;
                }
                if (carry < d * 0.7) continue;
                const m = massAt(id, a.level);
                if (m > atMass) {
                  atMass = m;
                  at = id;
                }
              }
              if (at && atMass > 0.2) {
                candidates.push({
                  id: 'utility_setup',
                  params: { spot: myAnchor?.id ?? at, utilityType: heavy, at },
                  prior: 0.5 + Math.min(0.25, atMass * 0.5),
                  motive: `${heavy === 'smokegrenade' ? 'smoking' : 'burning'} ${at}: the read puts ${atMass.toFixed(2)} there`
                });
              }
            }
          }
          if (holes.length && home && !holes.includes(home.home)) {
            const fill = backfill(R.shape, R.shape.posts.find((p) => p.home === holes[0])?.slot ?? s, aliveFlags, travelSeconds);
            if (fill && fill.slot === s) {
              candidates.push({
                id: 'rotate',
                params: { site: holes[0], target: holes[0] },
                prior: 0.75,
                motive: `backfilling ${holes[0]}: nobody is watching it`
              });
            }
          }
          if (b.health < 40 && !bombMasked) {
            const coverIds = nearestAnchors(R.graph, b.pos.x, b.pos.y, b.level, 3);
            candidates.push({
              id: 'fall_back',
              params: { target: coverIds[coverIds.length - 1] },
              prior: 0.5,
              motive: 'hurt: resetting to cover'
            });
          }

          const hurtMate = myLiving.find((m) => m.slot !== s && m.focus !== null && m.health < 50);
          const myPost = homeOf(R.shape, s);
          const packAtTarget = myLiving.filter((m) => {
            const d = Math.hypot(m.pos.x - R.target.world.x, m.pos.y - R.target.world.y);
            return d < 1400;
          }).length;
          const trigCtx = {
            clockPastCommitWindow: R.side === 'T' && !state.bomb.planted && elapsed > 30,
            matePfw: hurtMate ? 0.3 : null,
            iAmLurk: myPost?.role === 'lurk',
            packContactFar: Boolean(R.lastSeenTick) && packAtTarget >= 2 && myPost?.role === 'lurk',
            packCommitted: R.side === 'T' && elapsed > 20 && packAtTarget >= 2,
            clockUnderLurk: secondsLeft < 55,
            refragWindow: refragArmed({ tick, deathTick: R.lastOurDeathTick })
          };
          const syncGo = reached(R.sync, {
            secondsLeft,
            percepts: engine.sounds.items.slice(-8)
          });
          for (const t of firedTriggers(trigCtx, {
            anticipation: R.profiles[s].anticipation ?? 0.5,
            rng: R.rng
          })) {
            for (const armId of t.arms) {
              if (armId === 'execute_entry') {
                const mate = myLiving.find((m) => m.slot !== s);
                const sac = sacrificeIsPriced({
                  tradeCovered: myLiving.length >= 2,
                  partnerArrivalSeconds: mate
                    ? Math.hypot(mate.pos.x - b.pos.x, mate.pos.y - b.pos.y) / PLAN_SPEED
                    : Infinity
                });
                if (sac.donation) continue;
                if (!syncGo.go && !syncGo.late && secondsLeft > 25) continue;
                const partition = entryPartition(R, angles, myLiving, tick);
                const mine = partition ? angleFor(partition, s) : null;
                if (R.executeTick !== tick) {
                  R.executeTick = tick;
                  R.executeBySlot = null;
                  const tpl = templateFor(R.executes, { site: R.target.id });
                  if (tpl) {
                    const nades = myLiving.flatMap((m) => m.grenades || []);
                    const ladder = repairLadder({
                      template: tpl,
                      availableMeans: new Set(nades),
                      availableNades: nades,
                      bodies: myLiving
                    });
                    R.executeLadder = ladder;
                    if (ladder.steps?.length) {
                      const asg = assignExecute({
                        steps: ladder.steps,
                        bodies: myLiving.map((m) => ({
                          slot: m.slot,
                          x: m.pos.x,
                          y: m.pos.y,
                          grenades: m.grenades || [],
                          role: homeOf(R.shape, m.slot)?.role,
                          deathPermission: true
                        }))
                      });
                      R.executeBySlot = new Map();
                      for (const p of asg.pairs) {
                        const slot = p.row.slot;
                        const effect = p.col.effect;
                        R.executeBySlot.set(slot, {
                          optionId: effect === 'grantExposure' || effect === 'denySightline'
                            ? 'utility_setup'
                            : 'execute_entry',
                          params: { site: R.target.id, step: p.col.id },
                          motive: asg.motive
                        });
                      }
                    }
                  }
                }
                candidates.push({
                  id: 'execute_entry',
                  params: {
                    site: R.target.id,
                    target: R.target.id,
                    preAim: mine?.anchor ?? null
                  },
                  trigger: { id: t.id, motive: t.motive },
                  prior: 0.6,
                  motive: partition
                    ? `entry: ${mine ? `mine is ${mine.label}` : 'no angle assigned'}, ${partitionMotive(partition)}`
                    : undefined
                });
                if (
                  willSay(LEVEL.REQUEST, R.profiles[s], R.rng) &&
                  R.comms.requestsLeft(s) > 0
                ) {
                  R.comms.send(tick, {
                    level: LEVEL.REQUEST,
                    from: s,
                    request: {
                      type: 'request',
                      what: 'flash',
                      where: R.target.id,
                      by: 2,
                      worth: 0.05
                    }
                  });
                }
              } else if (armId === 'trade' && hurtMate) {
                const mateAnchor = angles.nearestAnchor(hurtMate.pos.x, hurtMate.pos.y);
                if (mateAnchor) {
                  candidates.push({
                    id: 'trade',
                    params: { mate: hurtMate.slot, spot: mateAnchor.id },
                    trigger: { id: t.id, motive: t.motive },
                    prior: 0.6
                  });
                }
              } else if (armId === 'lurk') {
                const lurkSpot = myPost?.home ?? myAnchor?.id;
                if (lurkSpot) {
                  candidates.push({
                    id: 'lurk',
                    params: { spot: lurkSpot },
                    trigger: { id: t.id, motive: t.motive },
                    prior: 0.62
                  });
                }
              } else if (armId === 'refrag' && R.lastOurDeathPos) {
                const spot = nearestAnchors(
                  R.graph,
                  R.lastOurDeathPos.x,
                  R.lastOurDeathPos.y,
                  R.lastOurDeathPos.level,
                  1
                )[0];
                if (spot) {
                  candidates.push({
                    id: 'refrag',
                    params: { spot },
                    trigger: { id: t.id, motive: t.motive },
                    prior: 0.65
                  });
                }
              } else if (armId === 'take_space' && t.id === 'lurk_arm') {
                const dest = myPost?.home ?? myAnchor?.id;
                if (dest) {
                  candidates.push({
                    id: 'take_space',
                    params: { target: dest, gait: 'walk' },
                    trigger: { id: t.id, motive: t.motive },
                    prior: 0.55
                  });
                }
              }
            }
          }

          const assigned = R.protocolBySlot?.get(s) || R.executeBySlot?.get(s);
          if (assigned?.optionId && OPTION_DEFS[assigned.optionId]) {
            candidates.push({
              id: assigned.optionId,
              params: assigned.params || {},
              prior: 0.78,
              motive: assigned.motive || 'protocol assignment'
            });
          }

          for (const msg of R.comms.openRequests(s)) {
            if (msg.request?.what !== 'flash' || !b.grenades.includes('flashbang')) continue;
            candidates.push({
              id: 'utility_setup',
              params: {
                spot: myAnchor?.id ?? msg.request.where,
                utilityType: 'flashbang',
                at: msg.request.where
              },
              prior: 0.68,
              motive: `serving flash at ${msg.request.where}`
            });
            R.comms.serve(msg.id);
            break;
          }

          if (b.hasBomb && !state.bomb.planted) {
            // Early the carrier may still want other things; past the commit
            // window the plant is a rule (the round is forfeit without it).
            candidates.push({
              id: 'plant',
              params: { spot: R.target.id },
              prior: 0.9,
              forced: elapsed > 35,
              motive: `carrying: getting the bomb down at ${R.target.id}`
            });
          }
          if (R.side === 'CT' && state.bomb.planted && !state.bomb.defusedBy) {
            // The retake is a rule (not retaking loses by forfeit), but
            // commitment is a TEAM act (19.5): converging strung out feeds
            // the afterplant one body at a time. Assemble at a staging anchor
            // first; the defuse clock sets the desperation deadline.
            if (!R.retakeStage) {
              // Site anchors cluster: the first half-dozen are all inside the
              // site itself, so the staging search reaches out far enough to
              // find ground OUTSIDE the afterplant's guns.
              R.retakeStage =
                nearestAnchors(
                  R.graph,
                  state.bomb.x,
                  state.bomb.y,
                  R.graph.levelFor(state.bomb.z),
                  16
                ).find((id) => {
                  const a = R.graph.anchor(id);
                  if (!a) return false;
                  const d = Math.hypot(a.world.x - state.bomb.x, a.world.y - state.bomb.y);
                  return d > 500 && d < 1400;
                }) || null;
            }
            const stage = R.retakeStage ? R.graph.anchor(R.retakeStage) : null;
            const livingCt = myLiving.length;
            const assembled = stage
              ? myLiving.filter(
                  (m) =>
                    Math.hypot(m.pos.x - stage.world.x, m.pos.y - stage.world.y) < 800
                ).length
              : livingCt;
            const ready =
              !stage ||
              livingCt <= 1 ||
              assembled >= Math.min(2, livingCt) ||
              round.bombSecondsLeft < 22;
            if (ready) {
              candidates.push({
                id: 'defuse',
                params: { mode: 'direct' },
                prior: 0.95,
                forced: true,
                motive:
                  round.bombSecondsLeft < 22
                    ? 'the clock decides: retaking now'
                    : `retaking together, ${assembled} of ${livingCt} assembled`
              });
            } else {
              candidates.push({
                id: 'rotate',
                params: { site: R.retakeStage, target: R.retakeStage },
                prior: 0.9,
                forced: true,
                motive: `grouping at ${R.retakeStage} for the retake`
              });
            }
          }

          // The observation is built when anything wants it: the policy's
          // proposals now, the collector's sample after the decision. Both
          // read the same floats, which is the whole point of observe.js.
          const obs =
            policy || collect
              ? buildObs(R, s, b, round, myLiving, tick, angles)
              : null;
          const seatKey = `${R.side}${decideSeat}`;
          if (obs) decideSeat += 1;
          const myContract = (R.contracts || []).find((c) => c.slot === s);
          const hist = (R.obsHist && R.obsHist.get(s)) || [];
          const policyCtx = {
            player: seatKey,
            map: engine.state.map,
            contract: myContract?.position,
            call: R.caller?.call() || null,
            history: hist
          };
          applySpacingBias(candidates, spacingTypical);
          if (policy && obs) {
            applyProposals(candidates, policy.probs(obs, policyCtx));
            if (typeof policy.forward === 'function') {
              const heads = policy.forward(obs, policyCtx);
              const utilProbs = heads?.utility;
              if (utilProbs) {
                for (const c of candidates) {
                  if (c.id !== 'utility_setup') continue;
                  const p = utilProbs.get?.(c.params.utilityType) ?? 0;
                  c.prior = Math.min(0.95, (c.prior || 0.4) + p * 0.35);
                }
              }
            }
          }
          if (obs) {
            if (!R.obsHist) R.obsHist = new Map();
            const next = hist.concat([obs]);
            while (next.length > POLICY_HISTORY_STEPS - 1) next.shift();
            R.obsHist.set(s, next);
          }

          const clutch = clutchMask({
            side: R.side,
            alive: myLiving.length,
            enemiesAlive: R.belief.aliveCount(),
            bombDown: state.bomb.planted,
            hasBomb: b.hasBomb,
            hasKit: Boolean(b.hasKit),
            secondsLeft,
            bombSecondsLeft: round.bombSecondsLeft,
            defusing: Boolean(b.channel),
            secondsToObjective: travelSeconds(s, R.target.id),
            posture:
              R.keyword.id === 'vp' ? 'vp' : R.keyword.id === 'liquid' ? 'liquid' : null,
            syncPeers: myLiving.filter(
              (m) =>
                m.slot !== s &&
                Math.hypot(m.pos.x - b.pos.x, m.pos.y - b.pos.y) < 400
            ).length
          });
          let legal = maskInitiation(initiationSet(engine, s), clutch);
          legal = applyKeyword(legal, R.keyword, {
            slot: s,
            hasTradeCover: myLiving.length >= 2
          });
          const afterKeyword = new Set(legal);
          if (myContract) {
            const paramsById = {};
            for (const c of candidates) paramsById[c.id] = c.params;
            legal = maskByContract(legal, myContract, { paramsById, clock: secondsLeft });
          }
          const afterContract = new Set(legal);
          if (R.owners && myAnchor) {
            const role = roleInZone({ assignment: R.owners, slot: s, zone: myAnchor.id });
            if (role.status === 'guest') {
              for (const id of OPTION_IDS) {
                if (OPTION_DEFS[id].family === 'peek') legal.delete(id);
              }
            }
          }
          if (
            R.side === 'T' &&
            b.hasBomb &&
            !state.bomb.planted &&
            myAnchor &&
            bombIsSafe(R.zones, myAnchor.id)
          ) {
            const executeOn = Boolean(R.executeBySlot?.get(s));
            const committed = R.caller?.decision() === 'commit';
            const wp = R.caller?.isOnTape(s, elapsed) ? R.caller.waypoint(s, elapsed) : null;
            const wpOutside = Boolean(wp && R.graph.anchor(wp) && !bombIsSafe(R.zones, wp));
            if (!executeOn && !committed && !wpOutside) {
              for (const id of LEAVES_SAFE) legal.delete(id);
            }
          }
          if (assigned?.optionId) legal.add(assigned.optionId);
          if (R.caller) {
            for (const c of candidates) {
              if (typeof c.motive !== 'string' || !c.motive.startsWith('tape')) continue;
              if (legal.has(c.id)) continue;
              let reason = 'mask';
              if (!afterKeyword.has(c.id)) reason = clutch.restricted ? clutch.motive : `keyword ${R.keyword.id}`;
              else if (!afterContract.has(c.id)) reason = 'contract';
              else reason = 'carrier or guest';
              if (R.caller.noteVeto(s, c.id, reason)) {
                this.log.push({ tick, slot: s, id: 'tape_veto', motive: `${c.id} masked by ${reason}` });
              }
            }
          }

          const layoutCount =
            R.budget?.decision === 'widen'
              ? Math.min(HYPOTHESIS_COUNT, R.budget.budget || HYPOTHESIS_COUNT)
              : 4;

          const q = riskQuantile({
            pWin: Number.isFinite(R.pWin) ? R.pWin : 0.5,
            manDelta: myLiving.length - R.belief.aliveCount(),
            baseline: R.profiles[s].riskQuantile ?? 0.5,
            audacity: R.audacity,
            posture:
              R.keyword.id === 'vp' ? 'vp' : R.keyword.id === 'liquid' ? 'liquid' : null,
            role: homeOf(R.shape, s)?.role
          });
          const decision = R.arbiters[s].decide({
            tick,
            runner,
            candidates,
            initiation: legal,
            price: (c) => {
              const spotId = c.params.spot ?? c.params.target ?? c.params.site ?? myAnchor?.id;
              const a = spotId ? R.graph.anchor(spotId) : null;
              const pose = a
                ? {
                    x: a.world.x,
                    y: a.world.y,
                    level: a.level,
                    yaw: b.yaw,
                    seconds: Math.hypot(a.world.x - b.pos.x, a.world.y - b.pos.y) / PLAN_SPEED
                  }
                : { x: b.pos.x, y: b.pos.y, level: b.level, yaw: b.yaw, seconds: 0 };
              return priceOption({
                option: { id: c.id, params: c.params },
                pose,
                me: {
                  slot: s,
                  side: R.side,
                  hp: b.health,
                  armor: b.armor,
                  helmet: b.helmet,
                  weapon: b.weapon,
                  confidenceBias: R.profiles[s].confidenceBias ?? 0
                },
                belief: R.belief,
                footprint: R.footprints[s],
                tick,
                pathDistance: (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by),
                anchorWorld: (id) => {
                  const an = R.graph.anchor(id);
                  return an ? { x: an.world.x, y: an.world.y, level: an.level } : null;
                },
                canSee: (ax, ay, bx, by, level) => angles.canSee(ax, ay, bx, by, level),
                round,
                contacts: R.contacts,
                rng: R.rng,
                layoutCount,
                quantile: q
              });
            }
          });

          // The dataset tap: what was decided, where. Staying with the
          // incumbent is a decision too — a dataset of only switches teaches
          // a policy that never holds anything.
          if (collect && obs) {
            const label = decision.chosen?.id ?? runner.active?.id ?? null;
            if (label) {
              collect({
                obs,
                label,
                side: R.side,
                map: state.map,
                tick,
                contract: myContract?.position || null,
                hist
              });
            }
          }

          if (decision.chosen) {
            runner.begin(tick, decision.chosen.id, decision.chosen.params);
            this.log.push({ tick, slot: s, id: decision.chosen.id, motive: decision.motive });
            if (decision.chosen.id === 'rotate') {
              if (!R.lastRotate) R.lastRotate = {};
              R.lastRotate[s] = tick;
            }
          }

          const out = runner.active
            ? runner.step(tick, [], {
                myAnchor: myAnchor?.id,
                arrived: false,
                planted: state.bomb.planted,
                defused: Boolean(state.bomb.defusedBy)
              })
            : stepped;

          R.translator.setIntent(s, patchLooseBomb(s, out.intent));
        }

        R.translator.step();
        if (R.caller) {
          for (const s of R.slots) {
            if (!R.translator.hasThrown(s)) continue;
            const idx = R.translator.tapeIndex(s);
            if (idx != null) R.caller.noteThrown(s, idx);
          }
        }
      },

      roundEnd({ outcome } = {}) {
        if (!R) return;
        const won = outcome?.winner === R.side;
        const call = R.layerAction ? libraryLabel(R.layerAction) : null;

        // ---- the review (18.6b) -----------------------------------------
        // The round is over, so the sealed truth may be scored. The largest
        // TRUE drop is the moment; the residual there says whether the team
        // called badly or simply could not see. The former is a lesson about
        // the call, the latter is a lesson about the picture, and writing the
        // second one as the first is how a caller learns to be timid.
        const graded = R.prw ? R.prw.grade() : [];
        const verdict = graded.length ? reviewRound({ rows: graded, k: 1 }) : null;
        const attrib = verdict?.attribs?.[0]?.kind === 'perc' ? 'perc' : 'call';
        R.review = verdict;
        if (memoryEnabled && verdict) {
          // One sample per situation per ROUND, not per row. A situation that
          // held for forty team frames is one visit's worth of evidence, and
          // writing it forty times would let frame density walk straight
          // through a gate that exists to require repeated evidence (18.3).
          for (const [key, row] of verdict.calibrations) {
            index.writeCalibration({ key, residual: row.mean });
          }
        }

        // 9.25 stage 3: the round's outcome and its 18.6 verdict go onto every
        // decision the caller made in it, and the true price is joined off the
        // graded PRW rows. A trainer then drops `exec` and `perc` without
        // having to re-run the review.
        if (R.igl) R.igl.seal({ won, attrib, prwRows: graded });

        // The key the round was actually keyed on. This used to be a hardcoded
        // `(side, full, even)`, which meant a round SELECTED on `T|eco|even`
        // paid its reward into `T|full|even` — the weights never moved for the
        // key that drew them, and the `score` slot 9.25 stage 2 names was
        // never filled by anything. `R.banditKey` is built at freeze from
        // (side, econ, score) and is the same key throughout.
        const bk = R.banditKey || banditKey({ side: R.side, econ: 'full' });
        if (memoryEnabled && R.situation) {
          strategy.last = {
            key: R.situation.hash,
            // With the call bandit on, the arm that was pulled is the opening
            // call it chose, not the layer action's label.
            call: callBandit && R.openingCall ? R.openingCall : call,
            banditKey: bk
          };
          strategy.observeRound({ won, attrib });
        } else if (call) {
          bandit.reward(bk, call, won ? 1 : 0);
        }
        tracker.observe({
          site: R.target?.id,
          firstContactSeconds: 20,
          lurkSeen: (R.ownCore?.lurkers?.length || 0) > 0,
          buy: 'full'
        });
      }
    };
  };
}
