// ---------------------------------------------------------------------------
// shared/sim/caller.js
// The hivemind: pick a winning round, copy it role by role, keep it in motion.
//
// Playbook.js is the library. This is the librarian. At freeze it samples a
// call and a tape. Until a recall, each bot walks to waypointAt and throws
// dueUtility. A recall is the exception, not the default:
//
//   1. process own information (percepts the bot already computed)
//   2. estimate the rest of the picture (belief: bodies, sites, clock)
//   3. predicted round winrate, and the EV of the fight we think we would take
//   4. compare to the round library; re-call only if continuing is -EV, or
//      this posture freezes when ahead (VP / Freeze). Default does not freeze
//      a 5v4. Plans in motion stay in motion until that gate fires.
//
// Sampling, not argmax: pickCall / pickRound already softmax over the top k.
// The same situation produces a family of plausible rounds, which is what
// stops a side from playing one demo forever.
// ---------------------------------------------------------------------------

import {
  assignRoles,
  dueUtility,
  matchSituation,
  pickCall,
  pickRound,
  tapeEndSeconds,
  waypointAt
} from './playbook.js';
import { INTERRUPT } from './interrupts.js';
import { BOMB_SECONDS, ROUND_SECONDS } from './constants.js';
import { costOfDeath, roundFeatures, valueOfKill, winProbability } from './objective.js';

export const CALLER_MODE = Object.freeze({ TAPE: 'tape', FREESTYLE: 'freestyle' });

/** What a recall can name. The tape is the plan; these are why it moved. */
export const CALL_DECISION = Object.freeze({
  COMMIT: 'commit',
  DELAY: 'delay',
  TURNAROUND: 'turnaround',
  FREEZE: 'freeze',
  FAKE: 'fake'
});

/**
 * Freeze / turnaround thresholds by doctrine. Default keeps walking: a 5v4
 * is not a freeze. VP and Freeze are the teams that pause when ahead
 * (INFURITY, Virtus.pro / Avangar 2022). Liquid is closer to default.
 */
export const CALLER_POSTURE = Object.freeze({
  default: Object.freeze({ freezePWin: 0.88, freezeManAdv: 3, recallMargin: 0.12, jitter: 0 }),
  vp: Object.freeze({ freezePWin: 0.55, freezeManAdv: 1, recallMargin: 0.06, jitter: 0.15 }),
  freeze: Object.freeze({ freezePWin: 0.55, freezeManAdv: 1, recallMargin: 0.04, jitter: 0 }),
  liquid: Object.freeze({ freezePWin: 0.8, freezeManAdv: 2, recallMargin: 0.1, jitter: 0.05 })
});

/** Geodesic error that means the bot has fallen off the tape. World units. */
export const TAPE_ERROR_UNITS = 180;
/** Seconds of that error before the bot is marked local. */
export const TAPE_ERROR_SECONDS = 1.5;
/** Seconds after the last waypoint/throw before the tape is exhausted. */
export const TAPE_GRACE_SECONDS = 10;
/** A TEAM redecide inside this window keeps the current tape. */
export const REPLAN_COOLDOWN_SECONDS = 3;

/**
 * Map a teamPositions name onto the shape vocabulary (entry/awp/lurk/...).
 * Unknown names become support rather than inventing a sixth role.
 */
export function shapeRole(position) {
  const p = String(position || '').toLowerCase();
  if (p.includes('awp')) return 'awp';
  if (p.includes('lurk')) return 'lurk';
  if (p.includes('anchor')) return 'anchor';
  if (p.includes('rotation') || p.includes('rotator')) return 'rotator';
  if (p.includes('banana') || p.includes('ramp') || p.includes('entry')) return 'entry';
  return 'support';
}

/**
 * Where a contact sits relative to the spawn→goal axis, the same test the
 * playbook miner uses. A contact BEHIND is the read that they over-rotated
 * the site we were hitting.
 *
 * @returns {'front'|'site'|'behind'}
 */
export function classifyContactRel({ x, y, spawn, goal }) {
  const axx = (goal?.x || 0) - (spawn?.x || 0);
  const axy = (goal?.y || 0) - (spawn?.y || 0);
  const axLen = Math.hypot(axx, axy) || 1;
  const proj = ((x - (spawn?.x || 0)) * axx + (y - (spawn?.y || 0)) * axy) / axLen;
  const distToGoal = Math.hypot(x - (goal?.x || 0), y - (goal?.y || 0));
  if (distToGoal < 1200) return 'site';
  if (proj < -250) return 'behind';
  return 'front';
}

function postureOf(name) {
  return CALLER_POSTURE[name] || CALLER_POSTURE.default;
}

function featuresFrom(picture) {
  const alive = Number.isFinite(picture.alive) ? picture.alive : 5;
  const enemy = Number.isFinite(picture.enemyAlive) ? picture.enemyAlive : 5;
  const tAlive = picture.side === 'T' ? alive : enemy;
  const ctAlive = picture.side === 'CT' ? alive : enemy;
  const clock = Number(picture.clock) || 0;
  const secondsLeft = Number.isFinite(picture.secondsLeft)
    ? picture.secondsLeft
    : Math.max(0, ROUND_SECONDS - clock);
  return roundFeatures({
    ctAlive,
    tAlive,
    ctEff: ctAlive,
    tEff: tAlive,
    planted: Boolean(picture.planted),
    secondsLeft,
    bombSecondsLeft: Number.isFinite(picture.bombSecondsLeft)
      ? picture.bombSecondsLeft
      : BOMB_SECONDS,
    hasKit: Boolean(picture.hasKit),
    tInSite: picture.side === 'T' ? picture.packAtTarget || 0 : picture.siteExpectedTarget || 0,
    ctInSite: picture.side === 'CT' ? picture.packAtTarget || 0 : picture.siteExpectedTarget || 0,
    possessionDiff:
      ((picture.siteExpectedTarget || 0) - (picture.siteExpectedOther || 0)) /
      5 *
      (picture.side === 'T' ? 1 : -1)
  });
}

/**
 * Predicted P(this side wins) from the believed picture: bodies, clock, bomb,
 * and where the belief puts the other side. Optional experience mean is a
 * blend once it has seen the situation a handful of times.
 */
export function pictureWinrate(picture, model = null) {
  let p = winProbability(featuresFrom(picture), picture.side, model);
  const n = picture.experienceN || 0;
  if (n >= 8 && Number.isFinite(picture.experienceMean)) {
    const w = Math.min(0.35, n / 40);
    p = (1 - w) * p + w * picture.experienceMean;
  }
  return p;
}

/**
 * Expected change in round winrate from taking a fight where we think they
 * are. Behind is a worse fight than the one on our execute. Negative means
 * walking into it is -EV even if the round is currently winning.
 */
export function fightEV(picture, model = null) {
  const features = featuresFrom(picture);
  const side = picture.side;
  const dKill = valueOfKill(features, side, model);
  const dDie = -costOfDeath(features, side, model);
  const pHit =
    picture.contactRel === 'behind' ? 0.35 : picture.contactRel === 'site' ? 0.5 : 0.45;
  return pHit * dKill + (1 - pHit) * dDie;
}

/**
 * The gate. Plans in motion stay in motion. A recall is the exception:
 * continuing is -EV, or this posture freezes when ahead.
 *
 * @returns {{recall: boolean, decision: string|null, reason: string, pWin: number, fightEv: number}}
 */
export function shouldRecall({
  picture,
  hit = null,
  currentDecision = null,
  posture = 'default',
  rng = null
} = {}) {
  const spec = postureOf(posture);
  const pWin = pictureWinrate(picture);
  const ev = fightEV(picture);
  const manAdv = (picture.alive ?? 5) - (picture.enemyAlive ?? 5);
  const freezeLine =
    spec.freezePWin + (spec.jitter && rng?.next ? (rng.next() - 0.5) * spec.jitter : 0);

  if (manAdv >= spec.freezeManAdv && pWin >= freezeLine) {
    return { recall: true, decision: CALL_DECISION.FREEZE, reason: 'ahead: next fight is not required', pWin, fightEv: ev };
  }

  const losing = pWin < 0.5 - spec.recallMargin || ev < -spec.recallMargin;
  if (!losing) {
    return { recall: false, decision: currentDecision, reason: 'plan stays in motion', pWin, fightEv: ev };
  }

  if (picture.contactRel === 'behind' && hit?.decision === CALL_DECISION.TURNAROUND) {
    return { recall: true, decision: CALL_DECISION.TURNAROUND, reason: 'behind and continuing is -EV', pWin, fightEv: ev };
  }
  if (hit && hit.decision && hit.decision !== CALL_DECISION.COMMIT && hit.decision !== currentDecision) {
    return { recall: true, decision: hit.decision, reason: `library ${hit.decision}`, pWin, fightEv: ev };
  }
  if (picture.teamBroken && pWin < 0.45) {
    return { recall: true, decision: hit?.decision || CALL_DECISION.DELAY, reason: 'the call has dissolved', pWin, fightEv: ev };
  }
  return {
    recall: true,
    decision:
      hit?.decision && hit.decision !== CALL_DECISION.COMMIT
        ? hit.decision
        : CALL_DECISION.TURNAROUND,
    reason: 'continuing is -EV',
    pWin,
    fightEv: ev
  };
}

/**
 * One caller per side. Pure against the playbook index; the bot supplies
 * live contractOf / awpOf / clock.
 *
 * @param {object} args
 * @param {object|null} args.playbook  indexPlaybook() result
 * @param {object} args.rng
 * @param {string} args.map
 * @param {'T'|'CT'} args.side
 * @param {string} [args.posture]  'default' | 'vp' | 'liquid' | 'freeze'
 */
export function createCaller({ playbook = null, rng, map, side, slots, posture = 'default' }) {
  let entry = null;
  let call = null;
  let decision = null;
  let teamMode = CALLER_MODE.FREESTYLE;
  let roles = new Map();
  const thrown = new Map();
  const localOff = new Set();
  let spawn = { x: 0, y: 0 };
  let goal = { x: 0, y: 0 };
  let plannedSite = null;
  let retired = false;
  let tapeEnd = null;
  let lastRedecideClock = -Infinity;
  let vetoCount = 0;
  const vetoed = new Map();

  function thrownSet(slot) {
    let s = thrown.get(slot);
    if (!s) {
      s = new Set();
      thrown.set(slot, s);
    }
    return s;
  }

  function applyTape(next, nextDecision, contractOf, awpOf) {
    entry = next || null;
    decision = nextDecision || null;
    thrown.clear();
    localOff.clear();
    vetoed.clear();
    retired = false;
    tapeEnd = null;
    if (!entry) {
      teamMode = CALLER_MODE.FREESTYLE;
      roles = new Map();
      plannedSite = null;
      return;
    }
    teamMode = CALLER_MODE.TAPE;
    call = entry.call || call;
    plannedSite = entry.plant?.site || plannedSite;
    roles = assignRoles(slots, entry, contractOf, { awpOf });
    tapeEnd = 0;
    for (const role of roles.values()) {
      tapeEnd = Math.max(tapeEnd, tapeEndSeconds(role));
    }
  }

  function applyDecision(nextDecision) {
    decision = nextDecision || decision;
  }

  function lookup(picture, contactRel) {
    if (!playbook) return null;
    return matchSituation(playbook, {
      side,
      clock: picture.clock,
      alive: picture.alive,
      enemyAlive: picture.enemyAlive,
      contactRel: contactRel || picture.contactRel,
      call,
      rng
    });
  }

  function evaluate(picture, { contactRel = null, teamBroken = false, contractOf, awpOf } = {}) {
    const snap = {
      side,
      alive: picture.alive,
      enemyAlive: picture.enemyAlive,
      clock: picture.clock,
      secondsLeft: picture.secondsLeft,
      bombSecondsLeft: picture.bombSecondsLeft,
      planted: picture.planted,
      hasKit: picture.hasKit,
      contactRel: contactRel || picture.contactRel || null,
      siteExpectedTarget: picture.siteExpectedTarget,
      siteExpectedOther: picture.siteExpectedOther,
      packAtTarget: picture.packAtTarget,
      teamBroken: teamBroken || picture.teamBroken,
      experienceMean: picture.experienceMean,
      experienceN: picture.experienceN
    };
    const hit = lookup(snap, snap.contactRel);
    const gate = shouldRecall({
      picture: snap,
      hit,
      currentDecision: decision,
      posture,
      rng
    });
    if (!gate.recall) {
      if (decision === CALL_DECISION.FREEZE) applyDecision(CALL_DECISION.COMMIT);
      return { kept: true, reason: gate.reason, pWin: gate.pWin, fightEv: gate.fightEv, rel: snap.contactRel };
    }
    if (gate.decision === CALL_DECISION.FREEZE) {
      applyDecision(CALL_DECISION.FREEZE);
      return {
        kept: true,
        recalled: true,
        decision: CALL_DECISION.FREEZE,
        reason: gate.reason,
        pWin: gate.pWin,
        fightEv: gate.fightEv,
        rel: snap.contactRel
      };
    }
    if (gate.decision === CALL_DECISION.DELAY) {
      applyDecision(CALL_DECISION.DELAY);
      return {
        kept: true,
        recalled: true,
        decision: CALL_DECISION.DELAY,
        reason: gate.reason,
        pWin: gate.pWin,
        fightEv: gate.fightEv,
        rel: snap.contactRel
      };
    }
    return {
      kept: false,
      rel: snap.contactRel,
      pWin: gate.pWin,
      fightEv: gate.fightEv,
      ...redecide({
        contactRel: snap.contactRel || 'front',
        clock: snap.clock,
        alive: snap.alive,
        enemyAlive: snap.enemyAlive,
        contractOf,
        awpOf
      })
    };
  }

  function redecide({ contactRel, clock, alive, enemyAlive, contractOf, awpOf }) {
    if (
      Number.isFinite(lastRedecideClock) &&
      Number.isFinite(clock) &&
      clock - lastRedecideClock < REPLAN_COOLDOWN_SECONDS
    ) {
      return { kept: true, reason: 'cooldown' };
    }
    if (Number.isFinite(clock)) lastRedecideClock = clock;
    if (!playbook) {
      applyTape(null, null, contractOf, awpOf);
      return { mode: CALLER_MODE.FREESTYLE, reason: 'no playbook' };
    }
    const hit = matchSituation(playbook, {
      side,
      clock,
      alive,
      enemyAlive,
      contactRel,
      call,
      rng
    });
    if (!hit) {
      applyTape(null, null, contractOf, awpOf);
      return { mode: CALLER_MODE.FREESTYLE, reason: 'no close match' };
    }
    applyTape(hit.entry, hit.decision, contractOf, awpOf);
    return { mode: CALLER_MODE.TAPE, decision: hit.decision, entry: hit.entry };
  }

  return {
    map,
    side,
    slots,

    roundStart({ econ = null, contractOf = () => null, awpOf = () => false, strategyCall = null, spawn: sp, goal: g } = {}) {
      if (sp) spawn = sp;
      if (g) goal = g;
      lastRedecideClock = -Infinity;
      vetoCount = 0;
      if (!playbook) {
        applyTape(null, null, contractOf, awpOf);
        return { mode: CALLER_MODE.FREESTYLE };
      }
      call = pickCall(playbook, { side, prefer: strategyCall, rng }) || 'default';
      const picked = pickRound(playbook, { side, call, econ, rng });
      applyTape(picked, picked?.plant ? 'commit' : null, contractOf, awpOf);
      return { mode: teamMode, call, entry };
    },

    /**
     * New information. Most of the time the tape continues. A contact behind
     * is a read, not a recall: we only move the plan when the picture says
     * continuing is -EV, or this posture freezes when ahead.
     */
    considerIntel(args = {}) {
      if (teamMode !== CALLER_MODE.TAPE && !retired) {
        return { kept: true, rel: null };
      }
      const rel = classifyContactRel({ x: args.x, y: args.y, spawn, goal });
      if (teamMode !== CALLER_MODE.TAPE) {
        return { kept: true, rel };
      }
      return evaluate(
        { ...args, contactRel: rel },
        { contactRel: rel, contractOf: args.contractOf, awpOf: args.awpOf }
      );
    },

    /**
     * Man-count / belief update with no new contact. Used when we get a pick:
     * VP freezes a 5v4, default keeps walking.
     */
    considerPicture(picture = {}, { contractOf = () => null, awpOf = () => false } = {}) {
      if (teamMode !== CALLER_MODE.TAPE) return { kept: true };
      return evaluate(picture, { contactRel: picture.contactRel || null, contractOf, awpOf });
    },

    onInterrupt({ clazz, slots: broken = [], contractOf = () => null, awpOf = () => false, clock, alive, enemyAlive, contactRel, ...picture }) {
      if (clazz === INTERRUPT.LOCAL) {
        for (const s of broken) localOff.add(s);
        return { mode: teamMode };
      }
      if (clazz === INTERRUPT.TEAM || clazz === INTERRUPT.OPPORTUNITY) {
        if (teamMode !== CALLER_MODE.TAPE) return { kept: true };
        const teamBroken = clazz === INTERRUPT.TEAM;
        return evaluate(
          { clock, alive, enemyAlive, contactRel, ...picture, teamBroken },
          { contactRel, teamBroken, contractOf, awpOf }
        );
      }
      return { kept: true };
    },

    noteThrown(slot, index) {
      thrownSet(slot).add(index);
    },
    markLocal(slot) {
      localOff.add(slot);
    },
    /**
     * Drop every slot off the tape for the rest of the round. Used at plant,
     * when the afterplant priors must outrank a schedule that has run out.
     */
    retire() {
      retired = true;
      teamMode = CALLER_MODE.FREESTYLE;
    },
    noteVeto(slot, optionId, reason) {
      let set = vetoed.get(slot);
      if (!set) {
        set = new Set();
        vetoed.set(slot, set);
      }
      if (set.has(optionId)) return false;
      set.add(optionId);
      vetoCount += 1;
      return { slot, optionId, reason };
    },
    vetoCount() {
      return vetoCount;
    },
    brokenCount() {
      return localOff.size;
    },
    isOnTape(slot, seconds) {
      if (retired) return false;
      if (teamMode !== CALLER_MODE.TAPE || !roles.has(slot) || localOff.has(slot)) return false;
      if (
        Number.isFinite(seconds) &&
        Number.isFinite(tapeEnd) &&
        seconds > tapeEnd + TAPE_GRACE_SECONDS
      ) {
        return false;
      }
      return true;
    },
    modeOf(slot) {
      return this.isOnTape(slot) ? CALLER_MODE.TAPE : CALLER_MODE.FREESTYLE;
    },
    teamMode() {
      return teamMode;
    },
    decision() {
      return decision;
    },
    posture() {
      return posture;
    },
    /** Keyword to apply while this recall holds: VP freeze vs a generic hold. */
    freezeKeyword() {
      if (decision !== CALL_DECISION.FREEZE) return null;
      return posture === 'vp' ? 'vp' : 'freeze';
    },
    call() {
      return call;
    },
    entry() {
      return entry;
    },
    plannedSite() {
      return plannedSite;
    },
    spawn() {
      return spawn;
    },
    goal() {
      return goal;
    },
    setGoal(g) {
      if (g) goal = g;
    },
    roleOf(slot) {
      return roles.get(slot) || null;
    },
    waypoint(slot, seconds) {
      return waypointAt(roles.get(slot), seconds);
    },
    due(slot, seconds) {
      return dueUtility(roles.get(slot), seconds, thrownSet(slot));
    }
  };
}
