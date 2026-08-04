// ---------------------------------------------------------------------------
// replays/coach/coach.js
// Reads one round and says what went wrong.
//
// Two passes. The first walks the round at COACH_SAMPLE_HZ (plus kill / death /
// assist ticks), recording the win probability and who was standing where —
// that series feeds the graph and is also what every rule below reasons
// against. The second walks the deaths and asks, of each, whether it cost
// something it did not have to.
//
// Pure: positions arrive through a sampler the caller supplies, so this runs
// in node against a round file with no DOM anywhere near it.
// ---------------------------------------------------------------------------

import {
  deadPlayersAt,
  decidedSideAt,
  liveEquipment,
  plantSituationAt,
  winProbability,
  winProbabilityWithDuels
} from './winProbability.js';
import {
  mapControlAdvantageEnabled,
  possessionSharesAt
} from './mapControlAdvantage.js';
import {
  buildZonePresence,
  hasControlField,
  prepareControlField
} from '../zones/zoneOverlay.js';
import { findRoundDecided } from './roundDecided.js';
import { ALONE_DISTANCE, findCore, nearestTeammate } from './cores.js';
import { findSiteExecuteFlags } from './siteExecute.js';
import { coachCategory, coachText } from './coachMessages.js';
import { findUtilityFlags } from './utilityMistakes.js';
import { findShotFlags } from './shotMistakes.js';
import { findDuelFlags } from './duelMistakes.js';
import {
  alivePositionsBySide,
  sitePresenceAdvantage
} from './sitePresenceAdvantage.js';
import { hasBombSites } from '../zones/bombSites.js';
import { roundWinAtTick } from '../rounds/roundWinAdapter.js';
import { createReloadTracker } from '../duels/reloadTracker.js';
import { phaseBounds } from './roundPhases.js';

/**
 * Win-chance series samples per second (baseline cadence).
 *
 * Half a second (2 Hz) is enough for slow drifts; kill / death / assist ticks
 * are force-sampled so fight swings still land on the chart. At 64 tick that
 * baseline is every 32nd tick.
 */
export const COACH_SAMPLE_HZ = 2;

/** Tick stride for the coach / win-graph series at a given demo tick rate. */
export function coachSampleStride(tickRate = 64) {
  return Math.max(1, Math.round((tickRate || 64) / COACH_SAMPLE_HZ));
}

/**
 * Light 3-point smooth on CT win% (and duel overlay). Keeps T complementary.
 * @param {Array<{ct:number,t:number,ctDuel:number|null,tDuel:number|null}>} series
 */
function smoothWinSeries(series) {
  if (!series || series.length < 3) return;
  const cts = series.map((s) => s.ct);
  const duels = series.map((s) => s.ctDuel);
  for (let i = 0; i < series.length; i++) {
    const prev = cts[i - 1] ?? cts[i];
    const cur = cts[i];
    const next = cts[i + 1] ?? cts[i];
    const sm = prev * 0.25 + cur * 0.5 + next * 0.25;
    series[i].ct = sm;
    series[i].t = 100 - sm;
    const dc = duels[i];
    if (dc == null) continue;
    const dprev = duels[i - 1] ?? dc;
    const dnext = duels[i + 1] ?? dc;
    const dsm = dprev * 0.25 + dc * 0.5 + dnext * 0.25;
    series[i].ctDuel = dsm;
    series[i].tDuel = 100 - dsm;
  }
}

/**
 * Baseline stride ticks plus combat events that move win chance hard.
 * Assists share the kill tick (assister field on the kill event).
 */
function winSeriesSampleTicks(from, to, stride, kills) {
  const ticks = new Set();
  for (let tick = from; tick <= to; tick += stride) ticks.add(tick);
  ticks.add(from);
  ticks.add(to);
  for (const k of kills) {
    const t = k.tick || 0;
    if (t >= from && t <= to) ticks.add(t);
  }
  return [...ticks].sort((a, b) => a - b);
}

/** A kill this soon after a death answers it. */
const TRADE_SECONDS = 3;
/** A frag this soon before dying means the death is not coached as a mistake. */
const FRAG_GRACE_SECONDS = 5;
/** An advantage has to have been held this long before losing it is a mistake. */
const HOLD_SECONDS = 3;
/** Below this at freezetime, the round was lost on the buy; say nothing. */
const HOPELESS = 25;
/** Above this live win chance, a solo duel is throwing value away. */
const DOMINANT = 75;
/**
 * Above this the round is won on health and guns rather than on bodies.
 *
 * The headcount gate on `advantage-lost` misses those rounds entirely, and an
 * untraded death in one still costs a rifle and the next round's buy.
 */
const WON_ROUND = 70;
/** Pad around a multikill when checking who dealt damage. */
const DAMAGE_PAD_SECONDS = 4;
/** Max gap between consecutive kills that still counts as one multikill. */
const MULTIKILL_GAP_SECONDS = 4;
/** Rifle-buy floor: average equip of the wiped group must clear this. */
const MULTIKILL_EQUIP_PER = 2500;
/** Aim cone: looking "at" an enemy means yaw within this many degrees. */
const AIM_DEGREES = 15;
/** Victim not facing the killer (unaware openness) at or beyond this. */
const UNAWARE_DEGREES = 30;
/** Unchecked-position needs a living stack at least this large. */
const UNCHECKED_GROUP = 3;
/** Molly must have been down at least this long before the death counts. */
const MOLLY_AWARE_SECONDS = 1;
/** How long fire stays relevant after landing (matches radar burn life). */
const MOLLY_LIFE_SECONDS = 7;
/** World units: killer in or next to the fire pool. */
const MOLLY_NEAR_UNITS = 150;
/** Same-floor tolerance when matching a killer to a molly. */
const MOLLY_SAME_Z = 200;

const PISTOLS = new Set([
  'glock',
  'usp_silencer',
  'hkp2000',
  'p250',
  'fiveseven',
  'tec9',
  'cz75a',
  'deagle',
  'revolver',
  'elite'
]);

const pct = (n) => `${Math.round(n)}%`;

function bareWeapon(name) {
  return String(name || '')
    .replace(/^weapon_/, '')
    .toLowerCase();
}

/** True when every listed loadout is pistols / knife / util only. */
function sideOnPistols(loadouts) {
  const list = loadouts || [];
  if (!list.length) return false;
  return list.every((items) => {
    if (!items?.length) return false;
    return items.every((w) => {
      const b = bareWeapon(w);
      return (
        PISTOLS.has(b) ||
        b === 'knife' ||
        b.startsWith('knife') ||
        b === 'c4' ||
        b === 'taser' ||
        b === 'flashbang' ||
        b === 'smokegrenade' ||
        b === 'hegrenade' ||
        b === 'molotov' ||
        b === 'incgrenade' ||
        b === 'decoy'
      );
    });
  });
}

/** Victims form one stack when each is within trade range of another. */
function victimsStacked(positions) {
  if (positions.length < 2) return false;
  for (const a of positions) {
    let near = false;
    for (const b of positions) {
      if (a.id === b.id) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) <= ALONE_DISTANCE) {
        near = true;
        break;
      }
    }
    if (!near) return false;
  }
  return true;
}

/** Absolute yaw difference in [0, 180]. */
function yawDelta(a, b) {
  let d = Math.abs(Number(a) - Number(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Source yaw toward a point: 0 = +X, 90 = +Y. */
function yawToward(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

/** Connected stack around seed (trade-range edges). */
function groupAround(seed, mates) {
  if (!seed) return [];
  const ids = new Set([seed.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of mates) {
      if (ids.has(m.id)) continue;
      for (const id of ids) {
        const a = mates.find((x) => x.id === id);
        if (a && Math.hypot(a.x - m.x, a.y - m.y) <= ALONE_DISTANCE) {
          ids.add(m.id);
          grew = true;
          break;
        }
      }
    }
  }
  return mates.filter((m) => ids.has(m.id));
}

/**
 * @param {object} args
 * @param {object} args.meta      round meta (events, stats, players, sides…)
 * @param {(tick: number) => Array} args.sampleAt  per-slot tick states
 * @param {object} [args.network] zone network (map control term when ready + baselined)
 * @param {{ sampleAll: Function }} [args.track]   full tick track for presence build
 * @param {(tick: number) => Array} [args.duelsAt]  open fights, for the graph's
 *   duel-aware line. Deliberately kept off `ct`/`t`: every rule below measures
 *   what a death cost by reading the win chance either side of it, and a
 *   probability that has already priced the death in would report that every
 *   death cost nothing. The lookahead is a better account of the round and a
 *   useless one to coach against, so it rides alongside as `ctDuel`.
 * @returns {{series: Array, flags: Array, gate: object}}
 */
export function analyseRound({
  meta,
  sampleAt,
  network = null,
  track = null,
  duelsAt = null
}) {
  const tickRate = meta.tickRate || 64;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const sideOfTeam = (team) => teamSides[team];
  const byId = new Map(players.map((p) => [p.id, p]));
  const sideOf = (id) => sideOfTeam(byId.get(id)?.team);

  const from = meta.freezeEndTick ?? meta.startTick ?? 0;
  const to = Math.max(from, meta.endTick ?? from);
  const endTick = meta.endTick ?? to;
  // Both are per round and are walked hundreds of times below, so they are
  // built once rather than per sample. The reload tracker only reads the shot
  // log; phaseBounds sorts the kill log.
  const reloadTracker = createReloadTracker({ meta });
  const phaseBoundsCache = phaseBounds(meta);
  const controlOn = mapControlAdvantageEnabled(meta.map, network);
  if (controlOn && network && meta.map) {
    prepareControlField(network, meta.map, null);
  }
  const presence =
    controlOn && track && hasControlField(network)
      ? buildZonePresence({ meta, track, network, mapCode: meta.map })
      : null;
  // Coachable window: 1s after freezetime ends → 1s before the winner is decided.
  const coachFrom = from + tickRate;
  const coachUntil = endTick - tickRate;
  const inCoachWindow = (tick) => tick >= coachFrom && tick <= coachUntil;
  const grenades = meta.events?.grenades || [];
  // Kill log for alive counts starts at freeze end (not earlier freezetime knives).
  // Flagging itself is further gated by inCoachWindow below.
  const kills = [...(meta.events?.kills || [])]
    .filter((k) => k.victim && (k.tick || 0) >= from)
    .sort((a, b) => (a.tick || 0) - (b.tick || 0));

  const winnerSide = meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const bomb = meta.events?.bomb || [];

  // ---- pass one: baseline cadence + kill / death / assist ticks -----------

  const sampleStride = coachSampleStride(tickRate);
  const sampleTicks = winSeriesSampleTicks(from, to, sampleStride, kills);
  const series = [];
  for (const tick of sampleTicks) {
    const sampled = sampleAt(tick) || [];
    // Copy out of the sampler scratch buffer — it is reused every step.
    const states = sampled.map((s) => (s ? { ...s } : null));
    const deadIds = deadPlayersAt(kills, tick);
    const eq = liveEquipment({
      players,
      stats: meta.stats,
      states,
      grenades,
      tick,
      teamSides,
      deadIds
    });
    const decided = decidedSideAt({
      tick,
      endTick,
      winnerSide,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      bomb
    });
    const plant = plantSituationAt({
      meta,
      states,
      tick,
      deadIds,
      teamSides,
      players
    });
    let mapControlCt;
    let mapControlT;
    if (presence) {
      const shares = possessionSharesAt({
        meta,
        states,
        network,
        presence,
        tick
      });
      if (shares) {
        mapControlCt = shares.ct;
        mapControlT = shares.t;
      }
    }
    let sitePp;
    let site;
    let siteCt;
    let siteT;
    if (network && hasBombSites(network) && !plant.planted) {
      const bySide = alivePositionsBySide({
        players,
        states,
        deadIds,
        teamSides
      });
      const siteAdv = sitePresenceAdvantage({
        network,
        tAlive: bySide.T,
        ctAlive: bySide.CT,
        planted: false
      });
      if (siteAdv) {
        sitePp = siteAdv.pp;
        site = siteAdv.site;
        siteCt = siteAdv.ct;
        siteT = siteAdv.t;
      }
    }
    const state = {
      map: meta.map,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      ctEff: eq.ctEff,
      tEff: eq.tEff,
      ctEquip: eq.CT,
      tEquip: eq.T,
      decided,
      mapControlCt,
      mapControlT,
      sitePp,
      site,
      siteCt,
      siteT,
      ...plant
    };
    // The drawn line comes from the trained round model. It reads the same
    // states plus the map geometry the coach already prepared, and it accounts
    // for open gunfights itself through its duel term, so the separate
    // lookahead below is only kept for the `ctDuel` overlay the coach rules
    // deliberately never read.
    const wp = roundWinAtTick({
      meta,
      states,
      tick,
      network,
      presence,
      track,
      reloadTracker,
      bounds: phaseBoundsCache
    }) || winProbability(state);
    const duels = duelsAt ? duelsAt(tick) : null;
    const ahead = duels?.length
      ? winProbabilityWithDuels({
          state,
          duels,
          bySlot: eq.bySlot,
          ctSum: eq.ctSum,
          tSum: eq.tSum
        })
      : null;
    series.push({
      tick,
      second: (tick - from) / tickRate,
      ct: wp.ct,
      t: wp.t,
      // Same moment with the open fights resolved forward, or null when nobody
      // is fighting / no duel model is available. Drawn, never coached against.
      ctDuel: ahead ? ahead.ct : null,
      tDuel: ahead ? ahead.t : null,
      ctAlive: eq.ctAlive,
      tAlive: eq.tAlive,
      ctEff: eq.ctEff,
      tEff: eq.tEff,
      ctEquip: eq.CT,
      tEquip: eq.T,
      parts: wp.parts,
      duelParts: ahead ? ahead.parts : null,
      deadIds,
      states
    });
  }
  smoothWinSeries(series);

  // The buy alone, before a shot is fired, decides whether the coach speaks.
  const opening = series[0];
  const gate = {
    CT: opening ? opening.ct > HOPELESS : true,
    T: opening ? opening.t > HOPELESS : true,
    dominant: {
      CT: opening ? opening.ct >= DOMINANT : false,
      T: opening ? opening.t >= DOMINANT : false
    },
    winnerSide
  };

  // ---- pass two: the deaths -----------------------------------------------

  const flags = [];
  const trade = TRADE_SECONDS * tickRate;
  const fragGrace = FRAG_GRACE_SECONDS * tickRate;
  const hold = HOLD_SECONDS * tickRate;

  /** Living count per side at a tick, from the kill log. */
  const aliveAt = (tick) => {
    const out = { CT: 5, T: 5 };
    for (const k of kills) {
      if (k.tick > tick) break;
      const s = sideOf(k.victim);
      if (s) out[s]--;
    }
    return out;
  };

  const sampleNear = (tick) => {
    let best = series[0];
    for (const s of series) {
      if (s.tick <= tick) best = s;
      else break;
    }
    return best;
  };

  /**
   * Tick states off the series grid, copied and cached.
   *
   * The shot and utility rules ask about exact event ticks rather than sample
   * ticks, and often about two of them at once (a shot, and the yaw a fifth of
   * a second before it). The sampler hands back one reused scratch buffer, so
   * holding two answers from it at the same time would silently compare a tick
   * against itself. Copying is the fix; the cache keeps it affordable.
   */
  const stateCache = new Map();
  const STATE_CACHE_MAX = 4096;
  const statesAt = (tick) => {
    const key = Math.round(tick);
    const hit = stateCache.get(key);
    if (hit) return hit;
    const sampled = sampleAt(key) || [];
    const copy = sampled.map((s) => (s ? { ...s } : null));
    if (stateCache.size >= STATE_CACHE_MAX) stateCache.clear();
    stateCache.set(key, copy);
    return copy;
  };
  const stateAt = (slot, tick) => statesAt(tick)[slot] || null;
  const flashAt = (slot, tick) => stateAt(slot, tick)?.flash || 0;

  /** Everyone alive on a side at a sample, as core-detection input. */
  const positionsOf = (sample, side) => {
    const out = [];
    const dead = sample?.deadIds;
    for (const p of players) {
      if (sideOfTeam(p.team) !== side) continue;
      if (dead?.has(p.id)) continue;
      const st = sample?.states?.[p.slot];
      if (!st?.alive) continue;
      out.push({ id: p.id, x: st.x, y: st.y, z: st.z, yaw: st.yaw });
    }
    return out;
  };

  // First death inside the coachable window (not freezetime / post-round).
  const firstDeathTick = kills.find((k) => inCoachWindow(k.tick))?.tick ?? null;
  // Extra hard stops once the round is factually over (may precede endTick).
  const defusedTick =
    (meta.events?.bomb || []).find((b) => b.type === 'defused')?.tick ?? null;

  /** A frag in the prior FRAG_GRACE_SECONDS means the death was part of a fight, not a free mistake. */
  const recentlyFragged = (playerId, atTick) =>
    kills.some(
      (k) => k.attacker === playerId && k.tick < atTick && atTick - k.tick <= fragGrace
    );

  for (const death of kills) {
    const victim = death.victim;
    const side = sideOf(victim);
    if (!side || !gate[side]) continue;
    if (!inCoachWindow(death.tick)) continue;
    if (defusedTick != null && death.tick >= defusedTick) continue;
    // Just got a kill? Dying in that window is not coached as a mistake.
    if (recentlyFragged(victim, death.tick)) continue;
    const before = aliveAt(death.tick - 1);
    const opp = side === 'CT' ? 'T' : 'CT';
    // Enemy team already wiped: nothing left to throw away.
    if (before[opp] <= 0) continue;
    // Last alive: a 1vX is not a "solo peek" — there is nobody left to stack with.
    if (before[side] <= 1) continue;

    // Answered inside the window? Then nothing was lost and nothing is said.
    const answered = kills.some(
      (k) => k.tick > death.tick && k.tick - death.tick <= trade && sideOf(k.attacker) === side
    );

    const sample = sampleNear(death.tick);
    const mates = positionsOf(sample, side);
    const me = mates.find((m) => m.id === victim);
    const { core, lurkers } = findCore(mates);
    const isLurker = lurkers.includes(victim);

    const wpBefore = sampleNear(death.tick)?.[side === 'CT' ? 'ct' : 't'];
    const wpAfter = sampleNear(death.tick + tickRate)?.[side === 'CT' ? 'ct' : 't'];
    const drop =
      Number.isFinite(wpBefore) && Number.isFinite(wpAfter) && wpAfter < wpBefore
        ? ` Round win chance fell from ${pct(wpBefore)} to ${pct(wpAfter)}.`
        : '';

    // 1. An advantage held for a while, then handed back for nothing.
    if (!answered && before[side] > before[opp]) {
      const then = aliveAt(death.tick - hold);
      if (then[side] > then[opp]) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'advantage-lost',
          text:
            coachText('advantage-lost', death.tick, {
              n: before[side],
              m: before[opp]
            }) + drop
        });
        continue;
      }
    }

    // 2. Even numbers, and the lurker died before the core ever took a fight.
    if (!answered && before[side] === before[opp] && core.length && isLurker) {
      const coreFought = kills.some(
        (k) => k.tick < death.tick && (core.includes(k.attacker) || core.includes(k.victim))
      );
      if (!coreFought) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'lurk-first',
          text: coachText('lurk-first', death.tick) + drop
        });
        continue;
      }
    }

    // 3. The round's first death, with the map otherwise silent around it.
    if (death.tick === firstDeathTick) {
      const isolated = !kills.some(
        (k) => k !== death && Math.abs(k.tick - death.tick) <= trade
      );
      if (isolated) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'free-opening',
          text: coachText('free-opening', death.tick) + drop
        });
        continue;
      }
    }

    // Alone only if teammates still exist and none are in trade range.
    // With nobody left alive, nearestTeammate is Infinity — that is a clutch,
    // not a spacing mistake.
    const alone =
      Boolean(me) &&
      mates.length >= 2 &&
      nearestTeammate(me, mates) > ALONE_DISTANCE;
    const liveWp = Number.isFinite(wpBefore)
      ? wpBefore
      : sample?.[side === 'CT' ? 'ct' : 't'];

    // 4. Duelling alone while the round is *still* heavily won at this moment.
    //    Gate on the live win chance at the fight — not freezetime economy.
    //    A buy that opened at 94% can be 33% by the time the duel happens.
    if (alone && Number.isFinite(liveWp) && liveWp >= DOMINANT) {
      flags.push({
        tick: death.tick,
        playerId: victim,
        rule: 'negative-ev',
        text: coachText('negative-ev', death.tick, { win: pct(liveWp) }) + drop
      });
      continue;
    }

    // 4b. Even bodies, but the round was already won on health and equipment.
    //     "Advantage first": above WON_ROUND this is carelessness rather than
    //     the spacing note below, and it is the only rule that prices the lost
    //     rifle into the next round as well.
    if (
      !answered &&
      before[side] === before[opp] &&
      Number.isFinite(liveWp) &&
      liveWp >= WON_ROUND
    ) {
      const held = sampleNear(death.tick - hold)?.[side === 'CT' ? 'ct' : 't'];
      if (Number.isFinite(held) && held >= WON_ROUND) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'untraded-won-round',
          text: coachText('untraded-won-round', death.tick, { win: pct(liveWp) }) + drop
        });
        continue;
      }
    }

    // 5. Solo death in a true 3v3 or 4v4. The even headcount must have held
    //    for at least HOLD_SECONDS — a fleeting 3v3 that just formed does not
    //    count. HP can drag live win% into the 20s and still be a spacing
    //    mistake; eco sides stay quiet via gate[side].
    const evenN = before[side];
    if (
      !answered &&
      alone &&
      evenN === before[opp] &&
      (evenN === 3 || evenN === 4)
    ) {
      const held = aliveAt(death.tick - hold);
      if (held[side] === evenN && held[opp] === evenN) {
        flags.push({
          tick: death.tick,
          playerId: victim,
          rule: 'solo-even',
          text: coachText('solo-even', death.tick, { n: evenN }) + drop
        });
      }
    }

  }

  // 7. Aim-unawareness deaths. Unchecked-position (stack of 3+, nobody on
  //    the angle) wins over unaware-openness (victim alone ≥30° off).
  const aimFlagged = new Set();
  for (const death of kills) {
    const victim = death.victim;
    const side = sideOf(victim);
    const opp = side === 'CT' ? 'T' : 'CT';
    if (!side || !gate[side]) continue;
    if (!inCoachWindow(death.tick)) continue;
    if (defusedTick != null && death.tick >= defusedTick) continue;
    if (recentlyFragged(victim, death.tick)) continue;
    if (aliveAt(death.tick - 1)[side] <= 1) continue;
    if (!death.attacker || sideOf(death.attacker) !== opp) continue;

    const pre = sampleNear(death.tick - 1);
    const groupMates = positionsOf(pre, side);
    const victimPos = groupMates.find((m) => m.id === victim);
    const group = groupAround(victimPos, groupMates);
    if (group.length < UNCHECKED_GROUP) continue;
    if (!group.every((m) => Number.isFinite(m.yaw))) continue;

    const killerPos = positionsOf(pre, opp).find((m) => m.id === death.attacker);
    if (!killerPos) continue;
    if (
      !group.every((m) => yawDelta(m.yaw, yawToward(m, killerPos)) > AIM_DEGREES)
    ) {
      continue;
    }

    const killerName = byId.get(death.attacker)?.name || death.attacker;
    const wpBefore = pre?.[side === 'CT' ? 'ct' : 't'];
    const wpAfter = sampleNear(death.tick + tickRate)?.[side === 'CT' ? 'ct' : 't'];
    const drop =
      Number.isFinite(wpBefore) && Number.isFinite(wpAfter) && wpAfter < wpBefore
        ? ` Round win chance fell from ${pct(wpBefore)} to ${pct(wpAfter)}.`
        : '';
    flags.push({
      tick: death.tick,
      playerId: victim,
      rule: 'unchecked-position',
      text:
        coachText('unchecked-position', death.tick, {
          enemy: killerName,
          n: group.length
        }) + drop
    });
    aimFlagged.add(`${victim}@${death.tick}`);
  }

  // 7b. Victim not facing the killer (≥30°), core or solo. Skips deaths
  //     already covered by unchecked-position.
  for (const death of kills) {
    const victim = death.victim;
    const side = sideOf(victim);
    const opp = side === 'CT' ? 'T' : 'CT';
    if (!side || !gate[side]) continue;
    if (!inCoachWindow(death.tick)) continue;
    if (defusedTick != null && death.tick >= defusedTick) continue;
    if (recentlyFragged(victim, death.tick)) continue;
    if (!death.attacker || sideOf(death.attacker) !== opp) continue;
    if (aimFlagged.has(`${victim}@${death.tick}`)) continue;

    const pre = sampleNear(death.tick - 1);
    const me = positionsOf(pre, side).find((m) => m.id === victim);
    const killerPos = positionsOf(pre, opp).find((m) => m.id === death.attacker);
    if (!me || !killerPos || !Number.isFinite(me.yaw)) continue;
    const off = yawDelta(me.yaw, yawToward(me, killerPos));
    if (off < UNAWARE_DEGREES) continue;

    const killerName = byId.get(death.attacker)?.name || death.attacker;
    const wpBefore = pre?.[side === 'CT' ? 'ct' : 't'];
    const wpAfter = sampleNear(death.tick + tickRate)?.[side === 'CT' ? 'ct' : 't'];
    const drop =
      Number.isFinite(wpBefore) && Number.isFinite(wpAfter) && wpAfter < wpBefore
        ? ` Round win chance fell from ${pct(wpBefore)} to ${pct(wpAfter)}.`
        : '';
    flags.push({
      tick: death.tick,
      playerId: victim,
      rule: 'unaware-openness',
      text:
        coachText('unaware-openness', death.tick, {
          enemy: killerName,
          deg: Math.round(off)
        }) + drop
    });
  }

  // 8. Died to an enemy standing in/near your own molotov after it had time
  //    to land — utility unawareness.
  const mollyGrace = MOLLY_AWARE_SECONDS * tickRate;
  const mollyLife = MOLLY_LIFE_SECONDS * tickRate;
  const mollies = grenades.filter(
    (g) =>
      (g.type === 'molotov' || g.type === 'incgrenade') &&
      g.player &&
      g.at &&
      Number.isFinite(g.detonateTick)
  );
  if (mollies.length) {
    for (const death of kills) {
      const victim = death.victim;
      const side = sideOf(victim);
      const opp = side === 'CT' ? 'T' : 'CT';
      if (!side || !gate[side]) continue;
      if (!inCoachWindow(death.tick)) continue;
      if (defusedTick != null && death.tick >= defusedTick) continue;
      if (!death.attacker || sideOf(death.attacker) !== opp) continue;

      const mine = mollies.filter(
        (g) =>
          g.player === victim &&
          death.tick >= g.detonateTick + mollyGrace &&
          death.tick <= g.detonateTick + mollyLife
      );
      if (!mine.length) continue;

      const pre = sampleNear(death.tick - 1);
      const killerPos = positionsOf(pre, opp).find((m) => m.id === death.attacker);
      if (!killerPos) continue;

      const onFire = mine.find((g) => {
        const dx = killerPos.x - g.at.x;
        const dy = killerPos.y - g.at.y;
        if (Math.hypot(dx, dy) > MOLLY_NEAR_UNITS) return false;
        if (Number.isFinite(g.at.z) && Number.isFinite(killerPos.z)) {
          if (Math.abs(killerPos.z - g.at.z) > MOLLY_SAME_Z) return false;
        }
        return true;
      });
      if (!onFire) continue;

      const killerName = byId.get(death.attacker)?.name || death.attacker;
      flags.push({
        tick: death.tick,
        playerId: victim,
        rule: 'utility-unawareness',
        text: coachText('utility-unawareness', death.tick, { enemy: killerName })
      });
    }
  }

  // 6. Group wiped by one lone enemy who was the sole damager in the window.
  //    Needs events.damage from a re-parse; older packs skip quietly.
  const damages = meta.events?.damage || [];
  if (damages.length) {
    const pad = DAMAGE_PAD_SECONDS * tickRate;
    const gap = MULTIKILL_GAP_SECONDS * tickRate;
    const loadoutsOf = (side) =>
      players
        .filter((p) => sideOfTeam(p.team) === side)
        .map((p) => meta.stats?.[p.id]?.loadout || []);
    const pistolsVsPistols =
      sideOnPistols(loadoutsOf('CT')) && sideOnPistols(loadoutsOf('T'));

    // Maximal streaks: same attacker, same victim side, consecutive kills ≤ gap.
    const streaks = [];
    let cur = null;
    for (const k of kills) {
      if (!k.attacker || !k.victim) continue;
      if (!inCoachWindow(k.tick)) continue;
      if (defusedTick != null && k.tick >= defusedTick) continue;
      const vSide = sideOf(k.victim);
      const aSide = sideOf(k.attacker);
      if (!vSide || aSide !== (vSide === 'CT' ? 'T' : 'CT')) continue;
      if (
        cur &&
        cur.attacker === k.attacker &&
        cur.side === vSide &&
        k.tick - cur.lastTick <= gap
      ) {
        cur.kills.push(k);
        cur.lastTick = k.tick;
        continue;
      }
      if (cur && cur.kills.length >= 2) streaks.push(cur);
      cur = {
        attacker: k.attacker,
        side: vSide,
        kills: [k],
        lastTick: k.tick
      };
    }
    if (cur && cur.kills.length >= 2) streaks.push(cur);

    for (const streak of streaks) {
      if (!gate[streak.side]) continue;
      const victims = streak.kills.map((k) => k.victim);
      if (new Set(victims).size < 2) continue;

      const avgEquip =
        victims.reduce((s, id) => s + (meta.stats?.[id]?.equipValue || 0), 0) /
        victims.length;
      if (!pistolsVsPistols && avgEquip < MULTIKILL_EQUIP_PER) continue;

      const firstTick = streak.kills[0].tick;
      const lastTick = streak.kills[streak.kills.length - 1].tick;
      const windowFrom = firstTick - pad;
      const windowTo = lastTick + pad;
      const victimSet = new Set(victims);

      // Only enemy damage on the wiped group counts; teammate FF is ignored.
      const attackers = new Set();
      for (const d of damages) {
        if (!victimSet.has(d.victim)) continue;
        if (d.tick < windowFrom || d.tick > windowTo) continue;
        if (sideOf(d.attacker) !== sideOf(streak.attacker)) continue;
        if (!(d.hp > 0)) continue;
        attackers.add(d.attacker);
      }
      if (attackers.size !== 1 || !attackers.has(streak.attacker)) continue;

      // Positions just before the spray starts.
      const sample = sampleNear(firstTick - 1);
      const victimPos = [];
      for (const id of victims) {
        const death = streak.kills.find((k) => k.victim === id);
        const s = sampleNear((death?.tick || firstTick) - 1);
        const pos = positionsOf(s, streak.side).find((p) => p.id === id);
        if (pos) victimPos.push(pos);
      }
      if (victimPos.length < 2 || !victimsStacked(victimPos)) continue;

      const killerMates = positionsOf(sample, sideOf(streak.attacker));
      const killer = killerMates.find((m) => m.id === streak.attacker);
      // Killer must be alone — a stacked entry fragging a pack is different.
      if (
        !killer ||
        (killerMates.length >= 2 &&
          nearestTeammate(killer, killerMates) <= ALONE_DISTANCE)
      ) {
        continue;
      }

      const killerName = byId.get(streak.attacker)?.name || streak.attacker;
      // One note on the first death (team filter uses that player's side).
      flags.push({
        tick: firstTick,
        playerId: victims[0],
        rule: 'multikill-refrag',
        text: coachText('multikill-refrag', firstTick, {
          enemy: killerName,
          n: victims.length
        })
      });
    }
  }

  // Solo duels the winner survived leave no death behind, so they are picked
  // up from the kill side of the log rather than the death side.
  if (opening) {
    for (const side of ['CT', 'T']) {
      if (!gate[side]) continue;
      const opp = side === 'CT' ? 'T' : 'CT';
      const key = side === 'CT' ? 'ct' : 't';
      for (const k of kills) {
        if (sideOf(k.attacker) !== side) continue;
        if (!inCoachWindow(k.tick)) continue;
        if (defusedTick != null && k.tick >= defusedTick) continue;
        if (aliveAt(k.tick - 1)[opp] <= 0) continue;
        // Last alive cannot take a "solo duel" — clutch fights are not coached.
        if (aliveAt(k.tick - 1)[side] <= 1) continue;
        const sample = sampleNear(k.tick);
        // Live chance at the duel — freezetime dominance is not enough.
        const liveWp = sample?.[key];
        if (!Number.isFinite(liveWp) || liveWp < DOMINANT) continue;
        const mates = positionsOf(sample, side);
        const me = mates.find((m) => m.id === k.attacker);
        if (!me || mates.length < 2 || nearestTeammate(me, mates) <= ALONE_DISTANCE) continue;
        if (flags.some((f) => f.playerId === k.attacker && Math.abs(f.tick - k.tick) <= trade)) continue;
        flags.push({
          tick: k.tick,
          playerId: k.attacker,
          rule: 'negative-ev',
          text: coachText('negative-ev-won', k.tick, { win: pct(liveWp) })
        });
      }
    }
  }

  // Mid/late: T core held at a bombsite for 3s → coach CT stack vs defaults.
  for (const f of findSiteExecuteFlags({
    meta,
    network,
    series,
    positionsOf,
    inCoachWindow,
    defusedTick,
    gate
  })) {
    flags.push(f);
  }

  // ---- pass three: the shot log and the grenade log -----------------------
  //
  // Neither of these is a death rule. A spray that stopped landing, or a flash
  // that blinded its own side, is the same mistake whichever way the fight then
  // went, so the trade window and the frag grace deliberately do not reach
  // them. The buy gate and the coach window still do.

  const passThree = { meta, tickRate, byId, sideOf, gate, inCoachWindow, defusedTick, kills };
  try {
    for (const f of findUtilityFlags({ ...passThree, flashAt })) flags.push(f);
  } catch {
    /* one missing event list must not cost the round its other notes */
  }
  try {
    for (const f of findShotFlags({ ...passThree, stateAt })) flags.push(f);
  } catch {
    /* same */
  }
  // Priced against the duel model, so these need the map. They stay quiet when
  // it is not loaded rather than guessing at line of sight.
  try {
    for (const f of findDuelFlags({ ...passThree, network, track })) flags.push(f);
  } catch {
    /* same */
  }

  // Round-decided is not a mistake and was the only flag pinned to a side
  // rather than to a player, so it is no longer written as a note. The moment
  // itself still rides along for anything that wants to draw it.
  const decidedMoment = findRoundDecided(meta);

  flags.sort((a, b) => a.tick - b.tick);
  // Category is a property of the rule, so it is stamped once here rather than
  // repeated at every push site.
  for (const f of flags) f.category = coachCategory(f.rule);
  // The states are only needed while the rules run; the graph wants numbers.
  for (const s of series) delete s.states;
  return { series, flags, gate, decided: decidedMoment || null };
}

/** Turn a flag into the note shape the round file stores. */
export function flagToNote(flag) {
  return {
    id: `c${flag.tick}${flag.rule.slice(0, 3)}`.slice(0, 32),
    tick: flag.tick,
    text: flag.text,
    kind: 'coach',
    mark: '',
    playerId: flag.playerId || '',
    rule: flag.rule || '',
    updatedAt: Date.now()
  };
}
