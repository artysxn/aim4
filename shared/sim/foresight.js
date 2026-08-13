// ---------------------------------------------------------------------------
// shared/sim/foresight.js
// How an option gets a price: dPRW, through the fitted models.
//
// SIM-PLAN 6.7. Three currencies already exist in this repo and this file is
// where they become the decision rule instead of decoration:
//
//   PFW  duels/duelModel.js: predictDuel      the atom: one fight's win chance
//   xK   sum of PFW                           a readout, never an objective
//   PRW  rounds/roundWinAdapter.js            the objective
//   the bridge: coach/duelLookahead.js        expectedCtOverDuels, already
//                                             written, already tested
//
// Bots maximize PRW. PFW is how PRW is computed through fights. An
// xK-maximizing bot never enters a site because entering is always a worse
// fight than holding; PRW knows about the clock and the bomb, so the entry is
// correct at 0:40 and incorrect at 1:40 for free, and variance-seeking when
// behind falls out of the mathematics.
//
// The price of one option:
//
//   1. pose        the caller predicts where the option puts me and when
//   2. hypotheses  M layouts drawn from the joint belief (knowledge.js)
//   3. synth duels real PlayerFeatures-shaped records against each hypothesis,
//                  scored by predictDuel — infoAdvSecs from exposure.js, so
//                  unawareness is priced by a term fitted on real demos
//   4. round price expectedCtOverDuels with the trained round model as the
//                  evaluator, clock advanced to the option's arrival (6.15)
//   5. subtract    exposure spent getting there
//
// Everything model-shaped is imported from the one shared entry surface the
// trainer and viewer already use. Any second path would silently ruin the
// numbers, which duelSnapshot.js's own header already says.
//
// Budget note (6.7): this is the EXPENSIVE evaluator. The arbiter prices the
// top few candidates plus the incumbent; bulk RL rollouts skip it entirely.
// ---------------------------------------------------------------------------

import { decidedPfw } from './confidence.js';
import { predictDuel } from '../../src/replays/duels/duelModel.js';
import { paramVector } from '../../src/replays/duels/duelModelParams.js';
import { watcherSpreadDeg } from '../../src/replays/duels/duelSnapshot.js';
import { angleOffset, bearingDeg } from '../../src/replays/duels/visionState.js';
import { expectedCtOverDuels } from '../../src/replays/coach/duelLookahead.js';
import { hpBodyWeight } from '../../src/replays/coach/winProbability.js';
import { roundWinFromFeatures } from '../../src/replays/rounds/roundWinAdapter.js';
import {
  EARLY_END_ELAPSED,
  LATE_START_ELAPSED
} from '../../src/replays/coach/roundPhases.js';
import { DIST_SCALE, EQUIP_SCALE } from '../../src/replays/rounds/roundFeatures.js';
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';
import { OPTION_DEFS } from './options.js';

/** Layouts drawn per price. Stratified enough at 12; the plan's number. */
export const HYPOTHESIS_COUNT = 12;

/**
 * A hypothesis that has never heard of me still is not aiming AT me: its
 * crosshair sits this far off, closing linearly as pKnowsMe rises. `[calibrate]`
 */
export const UNAWARE_OFF_DEG = 75;

/**
 * Round-price penalty for the option's exposure share when at least one
 * hypothesis overlooks the path: the "particle mass that can see me but that I
 * cannot see" cost, flattened to v1. In win-probability units. `[calibrate]`
 */
export const EXPOSURE_LAMBDA = 0.04;

/**
 * What an unseen enemy's body armour and utility are worth on top of the gun
 * the belief names. The believed loadout only carries a weapon; valuing the
 * enemy at gun price alone reads every hypothesis as half-eco and inflates
 * every price against them. `[refine with enemy economy inference, 5.3]`
 */
export const ENEMY_KIT_VALUE = 1350;

/**
 * The round phase, from the sim's own clock — the same thresholds
 * roundPhases.js mines from a demo, minus the kill-log refinements the sim can
 * apply when it has them.
 */
export function simPhase({ elapsed, ctAlive = 5, tAlive = 5 }) {
  if (elapsed >= LATE_START_ELAPSED || (ctAlive <= 3 && tAlive <= 3)) return 'late';
  if (elapsed >= EARLY_END_ELAPSED) return 'mid';
  return 'early';
}

/**
 * A PlayerFeatures-shaped record from sim state instead of a tick record.
 * Field-for-field what duelFeatures.playerFeatures builds, so predictDuel
 * cannot tell a synthetic fighter from a demo one — which is the entire trick.
 */
export function syntheticFighter({
  slot,
  side,
  x,
  y,
  z = 0,
  yaw = 0,
  hp = 100,
  armor = 100,
  helmet = true,
  flash = 0,
  scoped = false,
  ducking = false,
  airborne = false,
  speed = 0,
  weapon = 'ak47',
  reloading = false,
  magFraction = 1,
  sinceShot = 99
}) {
  const info = weaponInfo(weapon);
  return {
    slot,
    id: `sim${slot}`,
    side,
    x,
    y,
    z,
    yaw,
    hp,
    armor,
    helmet,
    flash,
    scoped,
    ducking,
    airborne,
    speed,
    weapon: info.id,
    price: info.price,
    category: info.category,
    oneTap: info.oneTapHeadHelmet,
    cycleSeconds: info.cycleSeconds,
    reloading,
    magFraction,
    sinceShot
  };
}

/**
 * M whole-map layouts from the joint belief, systematic resampling, so the
 * draw covers the weight mass rather than the mode: rare-but-deadly layouts
 * survive, which is the reason to sample at all.
 *
 * @returns {Array<Array<{anchor:string, level:string, weapon:string}|null>>}
 */
export function drawLayouts(belief, m, rng) {
  const total = belief.particles.reduce((s, p) => s + p.weight, 0);
  if (!(total > 0)) return [];
  const step = total / m;
  let u = rng.next() * step;
  const out = [];
  let acc = 0;
  let i = 0;
  for (let n = 0; n < m; n += 1) {
    while (i < belief.particles.length - 1 && acc + belief.particles[i].weight < u) {
      acc += belief.particles[i].weight;
      i += 1;
    }
    out.push(belief.particles[i].slots.map((sl) => (sl ? { ...sl } : null)));
    u += step;
  }
  return out;
}

/**
 * Price one option for one bot: P(my side wins the round | I take it).
 *
 * @param {object} args
 * @param {{id:string, params:object}} args.option
 * @param {{x:number, y:number, level:string, yaw:number, seconds:number}} args.pose
 *        arrival pose and travel time, from the option's micro profile
 * @param {object} args.me         syntheticFighter inputs for myself at arrival
 * @param {object} args.belief     the enemy JointBelief
 * @param {object} args.footprint  my SelfFootprint (exposure.js)
 * @param {number} args.tick
 * @param {(ax,ay,bx,by) => number} args.pathDistance      geodesic
 * @param {(id:string) => {x:number,y:number,level:string}|null} args.anchorWorld
 * @param {(ax,ay,bx,by, level:string) => boolean} args.canSee  catalogue LOS
 * @param {object} args.round      the round as it stands:
 *        {map, mySide, elapsed, secondsLeft, ctAlive, tAlive, ctEff, tEff,
 *         ctEquipSum, tEquipSum, planted, bombSecondsLeft, ctHasKit, ctKits,
 *         teammates: [{slot, side, hp, value}...] — living, me included}
 * @param {Record<number, {myFirstSeenTick?:number, myLastSeenTick?:number}>} [args.contacts]
 *        per enemy slot, my belief contact log, for infoAdvSecsHat
 * @param {import('./rng.js').Rng} args.rng
 * @param {Float64Array} [args.v]  duel params; defaults to the fitted vector
 * @param {number} [args.layoutCount]
 * @param {number} [args.quantile]  20.9: maximize this quantile of layout pWin
 *        instead of the mean. Omitted keeps the mean so existing tests hold.
 * @returns {{pWin:number, ctPct:number, parts:object}}
 */
export function priceOption({
  option,
  pose,
  me,
  belief,
  footprint,
  tick,
  pathDistance,
  anchorWorld,
  canSee,
  round,
  contacts = {},
  rng,
  v = null,
  layoutCount = HYPOTHESIS_COUNT,
  quantile = null
}) {
  const def = OPTION_DEFS[option.id];
  if (!def) throw new Error(`foresight: unknown option ${option.id}`);
  const params = v || paramVector();
  const arriveTick = tick + Math.round(pose.seconds * 64);

  const enemySide = round.mySide === 'CT' ? 'T' : 'CT';
  // A hold fights planted; everything else fights on the move at arrival,
  // and the fitted model's per-class movement term is what makes a swing an
  // expensive commitment instead of a teleporting statue. `[refine: per-style
  // arrival speed from the pose trace]`
  const arriveSpeed = me.speed ?? (def.family === 'hold' ? 0 : 220);
  const myFighter = syntheticFighter({
    ...me,
    x: pose.x,
    y: pose.y,
    yaw: pose.yaw,
    speed: arriveSpeed
  });

  // The world as it stands when I get there, not as it is now (6.15): the
  // clock has burned the travel time before any of the fights below happen.
  const secondsLeft = Math.max(0, round.secondsLeft - pose.seconds);
  const elapsed = round.elapsed + pose.seconds;
  const phase = simPhase({ elapsed, ctAlive: round.ctAlive, tAlive: round.tAlive });

  // Side totals for the branch evaluator, from the caller's living roster.
  const bySlot = {};
  for (const t of round.teammates || []) {
    bySlot[t.slot] = { side: t.side, weight: hpBodyWeight(t.hp), value: t.value || 0 };
  }

  // The bag speaks the trained model's units: equipment over EQUIP_SCALE,
  // distances over DIST_SCALE. Raw dollars saturate the fitted terms.
  const bagBase = {
    ctAlive: round.ctAlive,
    tAlive: round.tAlive,
    ctEff: round.ctEff ?? round.ctAlive,
    tEff: round.tEff ?? round.tAlive,
    equipDiff:
      ((round.ctAlive ? round.ctEquipSum / round.ctAlive : 0) -
        (round.tAlive ? round.tEquipSum / round.tAlive : 0)) /
      EQUIP_SCALE,
    utilDiff: 0,
    possessionDiff: 0,
    duelEdge: 0,
    openDuels: 0,
    centroidDist: 0,
    nearestDist: 0,
    secondsLeft,
    planted: Boolean(round.planted),
    bombSecondsLeft: round.bombSecondsLeft ?? 0,
    ctHasKit: Boolean(round.ctHasKit),
    ctKits: round.ctKits ?? 0,
    geometryKnown: false
  };

  const scoreBag = (bag, s) =>
    roundWinFromFeatures(
      {
        ...bag,
        ctAlive: s.ctAlive,
        tAlive: s.tAlive,
        ctEff: s.ctEff,
        tEff: s.tEff,
        equipDiff:
          ((s.ctAlive ? s.ctSum / s.ctAlive : 0) - (s.tAlive ? s.tSum / s.tAlive : 0)) /
          EQUIP_SCALE
      },
      round.map,
      phase
    ).ct;

  const layouts = drawLayouts(belief, layoutCount, rng);
  if (!layouts.length) {
    const ct = scoreBag(bagBase, {
      ctAlive: round.ctAlive,
      tAlive: round.tAlive,
      ctEff: bagBase.ctEff,
      tEff: bagBase.tEff,
      ctSum: round.ctEquipSum,
      tSum: round.tEquipSum
    });
    const pWin = round.mySide === 'CT' ? ct / 100 : 1 - ct / 100;
    return { pWin, ctPct: ct, parts: { layouts: 0, pContact: 0, duels: 0 } };
  }

  let ctSum = 0;
  let contactLayouts = 0;
  let duelCount = 0;
  const layoutWins = [];

  for (const layout of layouts) {
    // Which hypotheses can trade fire with my arrival pose?
    const visible = [];
    for (let slot = 0; slot < layout.length; slot += 1) {
      const sl = layout[slot];
      if (!sl) continue;
      const w = anchorWorld(sl.anchor);
      if (!w || (w.level || 'default') !== (pose.level || 'default')) continue;
      if (!canSee(pose.x, pose.y, w.x, w.y, pose.level || 'default')) continue;
      const h = { anchor: sl.anchor, level: sl.level, x: w.x, y: w.y, slot };
      const dist = Math.hypot(w.x - pose.x, w.y - pose.y);
      const pk = footprint.pKnowsMe(h, arriveTick, pathDistance);
      visible.push({ slot, sl, w, h, dist, pk });
    }

    const duels = [];
    if (visible.length) {
      contactLayouts += 1;

      // Every visible hypothesis is a watcher on me; the spread across them is
      // the crossfire term, same formula the CT setup problem reads backwards.
      const bearings = visible.map((e) => bearingDeg(pose.x, pose.y, e.w.x, e.w.y));
      const spreadA = watcherSpreadDeg(bearings);

      for (let i = 0; i < visible.length; i += 1) {
        const e = visible[i];
        const foe = syntheticFighter({
          slot: 10 + e.slot, // keep synthetic enemy slots clear of my team's
          side: enemySide,
          x: e.w.x,
          y: e.w.y,
          yaw: bearingDeg(e.w.x, e.w.y, pose.x, pose.y),
          weapon: e.sl.weapon
        });
        const myOff = angleOffset(pose.yaw, bearings[i]);
        const foeOff = UNAWARE_OFF_DEG * (1 - e.pk);
        const infoAdvSecs = footprint.infoAdvSecsHat(
          e.h,
          arriveTick,
          pathDistance,
          contacts[e.slot] || {}
        );

        // The other watchers, as threats on me. Threats on the hypothesis from
        // my own teammates arrive with trade geometry (6.12), not here.
        const threatsOnA = [];
        for (let j = 0; j < visible.length; j += 1) {
          if (j === i) continue;
          const o = visible[j];
          threatsOnA.push({
            p: syntheticFighter({
              slot: 10 + o.slot,
              side: enemySide,
              x: o.w.x,
              y: o.w.y,
              yaw: bearingDeg(o.w.x, o.w.y, pose.x, pose.y),
              weapon: o.sl.weapon
            }),
            dist: o.dist,
            off: UNAWARE_OFF_DEG * (1 - o.pk),
            selfOff: angleOffset(pose.yaw, bearings[j])
          });
        }

        const pair = {
          aSlot: myFighter.slot,
          bSlot: foe.slot,
          dist: e.dist,
          losClear: true,
          aSeesB: myOff <= 53,
          bSeesA: foeOff <= 53,
          offA: myOff,
          offB: foeOff,
          infoAdvSecs,
          a: myFighter,
          b: foe
        };
        let pa = predictDuel(
          { pair, threatsOnA, threatsOnB: [], spreadA, spreadB: 0 },
          params
        );
        // The PFW a bot DECIDES with (8.2): the fitted confidence bias
        // distorts the predicted duel before anything is priced on it. A
        // zero bias is exactly the model's own number.
        if (me.confidenceBias) pa = decidedPfw(pa, me.confidenceBias);
        duels.push({ aSlot: myFighter.slot, bSlot: foe.slot, pa });
        bySlot[foe.slot] = {
          side: enemySide,
          weight: 1,
          value: (weaponInfo(e.sl.weapon).price || 0) + ENEMY_KIT_VALUE
        };
      }
    }
    duelCount += duels.length;

    // Base for THIS layout: my side's roster plus the believed bodies in it.
    const layoutAlive = layout.filter(Boolean).length;
    const enemyEquip = layout
      .filter(Boolean)
      .reduce((s, sl) => s + (weaponInfo(sl.weapon).price || 0) + ENEMY_KIT_VALUE, 0);
    const base = {
      ctAlive: round.mySide === 'CT' ? round.ctAlive : layoutAlive,
      tAlive: round.mySide === 'T' ? round.tAlive : layoutAlive,
      ctEff: round.mySide === 'CT' ? bagBase.ctEff : layoutAlive,
      tEff: round.mySide === 'T' ? bagBase.tEff : layoutAlive,
      ctSum: round.mySide === 'CT' ? round.ctEquipSum : enemyEquip,
      tSum: round.mySide === 'T' ? round.tEquipSum : enemyEquip
    };

    const bag = {
      ...bagBase,
      openDuels: duels.length,
      duelEdge: duels.reduce((s, d) => {
        const pCt = round.mySide === 'CT' ? d.pa : 1 - d.pa;
        return s + (2 * pCt - 1);
      }, 0),
      nearestDist: visible.length ? Math.min(...visible.map((e) => e.dist)) / DIST_SCALE : 0
    };

    const resolved = duels.length
      ? expectedCtOverDuels({ base, duels, bySlot, evaluate: (s) => scoreBag(bag, s) })
      : null;
    const layoutCt = resolved
      ? resolved.ct
      : scoreBag(bag, { ...base });
    ctSum += layoutCt;
    layoutWins.push(round.mySide === 'CT' ? layoutCt / 100 : 1 - layoutCt / 100);
  }

  let ct = ctSum / layouts.length;
  const pContact = contactLayouts / layouts.length;
  let pWin = round.mySide === 'CT' ? ct / 100 : 1 - ct / 100;
  if (Number.isFinite(quantile) && layoutWins.length) {
    const q = Math.min(1, Math.max(0, quantile));
    const sorted = layoutWins.slice().sort((a, b) => a - b);
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    pWin = sorted[i];
    ct = round.mySide === 'CT' ? pWin * 100 : (1 - pWin) * 100;
  }

  // The exposure spent getting there: mass that overlooks the path, times the
  // style's share of its duration spent visible. A jiggle pays a quarter of
  // what a wide swing pays for the same corridor.
  pWin = Math.max(0, Math.min(1, pWin - EXPOSURE_LAMBDA * def.exposure * pContact));

  return {
    pWin,
    ctPct: ct,
    parts: {
      layouts: layouts.length,
      pContact,
      duels: duelCount,
      exposure: def.exposure,
      travelSeconds: pose.seconds,
      phase
    }
  };
}

/**
 * How much a drawn shot is worth to the body who collects it. `[calibrate]`
 *
 * A shoulder peek does not reveal anything; it CHANGES THE ENEMY'S STATE
 * (19.6). The AWP is cycling, the rifler is in recoil recovery, and both have
 * committed a crosshair to a place the baiter is no longer in. The fitted duel
 * model already prices exactly that through the defender's awareness term, so
 * the bait is expressed as a bump to the partner's information advantage
 * rather than as a bonus somebody invented.
 */
export const BAIT_INFO_SECONDS = 0.6;

/**
 * Price two bodies as ONE decision (SIM-PLAN 19.6).
 *
 * A bait and its punish are not two options that happen to be adjacent: the
 * peeker's price IS the partner's gain inside the window, minus the peeker's
 * own risk of being clipped. Single-body foresight cannot express that shape at
 * all, because the value never lands on the body paying for it.
 *
 * It stops at two, deliberately and permanently. Two is where Counter-Strike's
 * coupling actually lives (trade pairs, bait and punish, entry and refrag), and
 * the combinatorics past two are neither affordable nor true to the game.
 *
 * @param {object} args
 * @param {object} args.bait     {option, pose, me} for the body drawing the shot
 * @param {object} args.punish   {option, pose, me} for the body collecting it
 * @param {object} args.shared   everything priceOption needs that both share
 *   (belief, footprint per body, tick, pathDistance, anchorWorld, canSee,
 *   round, contacts, rng, layoutCount)
 * @param {number} [args.windowSeconds]  how long the drawn shot stays paid for
 * @returns {{pWin:number, parts:object}} the PAIR's value, attributed
 */
export function priceOptionPair({ bait, punish, shared, windowSeconds = 1.4 }) {
  const priceOne = (body, extra = {}) =>
    priceOption({
      option: body.option,
      pose: body.pose,
      me: body.me,
      footprint: body.footprint ?? shared.footprint,
      ...shared,
      ...extra
    });

  // What each body is worth alone, which is the baseline the pair has to beat.
  const soloBait = priceOne(bait);
  const soloPunish = priceOne(punish);

  // The punisher's world with the shot already drawn: the enemy's crosshair is
  // committed elsewhere and his weapon is cycling, so the partner arrives with
  // an information advantage he did not have to buy himself.
  const baitedPunish = priceOne(punish, {
    contacts: withBaitInfo(shared.contacts || {}, shared.tick, windowSeconds)
  });

  // The peeker pays his exposure and collects nothing directly; the pair's
  // value is what the partner gains, minus what the bait costs the baiter.
  // That cost is not invented here: it is the exposure term priceOption has
  // already subtracted from the bait's own price, read back out of its card.
  const partnerGain = baitedPunish.pWin - soloPunish.pWin;
  const baitCost = EXPOSURE_LAMBDA * soloBait.parts.exposure * soloBait.parts.pContact;
  const pWin = soloPunish.pWin + partnerGain - baitCost;

  return {
    pWin,
    parts: {
      soloBait: soloBait.pWin,
      soloPunish: soloPunish.pWin,
      baitedPunish: baitedPunish.pWin,
      partnerGain,
      baitCost,
      windowSeconds,
      // The pair is only worth running if the drawn shot actually pays for the
      // peek. This is the number the motive string should quote.
      worthIt: partnerGain > baitCost
    }
  };
}

/**
 * Age every contact by the bait window, which is how the duel model reads
 * "they just committed a shot somewhere else" (infoAdvSecsHat consumes the
 * contact log). Copied rather than mutated: pricing must never move state.
 */
function withBaitInfo(contacts, tick, windowSeconds) {
  const out = {};
  const bump = Math.round(BAIT_INFO_SECONDS * 64);
  for (const [slot, c] of Object.entries(contacts)) {
    out[slot] = { ...c, myLastSeenTick: (c.myLastSeenTick ?? tick) + bump };
  }
  return out;
}
