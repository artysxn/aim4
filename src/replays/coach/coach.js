// ---------------------------------------------------------------------------
// replays/coach/coach.js
// Reads one round and says what went wrong.
//
// Two passes. The first walks the round a second at a time, recording the win
// probability and who was standing where — that series feeds the graph and is
// also what every rule below reasons against. The second walks the deaths and
// asks, of each, whether it cost something it did not have to.
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
import {
  alivePositionsBySide,
  sitePresenceAdvantage
} from './sitePresenceAdvantage.js';
import { hasBombSites } from '../zones/bombSites.js';

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

  // ---- pass one: the round, one second at a time --------------------------

  const series = [];
  for (let tick = from; tick <= to; tick += tickRate) {
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
    const wp = winProbability(state);
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
      second: Math.round((tick - from) / tickRate),
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
    const name = byId.get(victim)?.name || victim;

    // Answered inside the window? Then nothing was lost and nothing is said.
    const answered = kills.some(
      (k) => k.tick > death.tick && k.tick - death.tick <= trade && sideOf(k.attacker) === side
    );

    const sample = sampleNear(death.tick);
    const mates = positionsOf(sample, side);
    const me = mates.find((m) => m.id === victim);
    const { core, lurkers } = findCore(mates);
    const inCore = core.includes(victim);
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
          text: inCore
            ? `${name} died in a ${before[side]}v${before[opp]} with no trade. In a man advantage the refrags and the spacing have to be tighter than this.${drop}`
            : `${name} died alone in a ${before[side]}v${before[opp]} with no trade. A solo player should not be the one dying when the team is already up.${drop}`
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
          text: `${name} died out on their own before the group had taken a fight. In an even round it is generally better to let the core play first and open the map from there.${drop}`
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
          text: `${name} opened the round by dying with nothing else happening anywhere on the map. Nothing was traded and nothing was gained, so this is a potentially unnecessary opening death.${drop}`
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
        text: `${name} took a solo duel with the round already ${pct(
          liveWp
        )} won. With that much of an edge a fight nobody can trade is negative EV whether it is won or lost.${drop}`
      });
      continue;
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
          text: `${name} died alone in a ${evenN}v${evenN} with no trade. In an even situation the team needs to play together — a solo death here is still a mistake even when the HP looks bad.${drop}`
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

    const name = byId.get(victim)?.name || victim;
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
      text: `${name} died to ${killerName} from an angle nobody in the group was holding. With ${group.length} players stacked, that position needed a check — dying to an unchecked angle is a team mistake.${drop}`
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
    if (yawDelta(me.yaw, yawToward(me, killerPos)) < UNAWARE_DEGREES) continue;

    const name = byId.get(victim)?.name || victim;
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
      text: `${name} died to ${killerName} while not aiming anywhere near them. Getting opened while that unaware is a positioning / info mistake — you have to be ready for the fight you take.${drop}`
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

      const name = byId.get(victim)?.name || victim;
      const killerName = byId.get(death.attacker)?.name || death.attacker;
      flags.push({
        tick: death.tick,
        playerId: victim,
        rule: 'utility-unawareness',
        text: `${name} died to ${killerName} standing in their own molotov. Once fire lands you have to track who is playing it — dying to someone in your util is utility unawareness.`
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
      const victimNames = victims
        .map((id) => byId.get(id)?.name || id)
        .join(', ');
      const n = victims.length;
      // One note on the first death (team filter uses that player's side).
      flags.push({
        tick: firstTick,
        playerId: victims[0],
        rule: 'multikill-refrag',
        text: `${victimNames} died to ${killerName} alone (${n}v1). Although enemy luck is a possibility, usually this has to be a refrag.`
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
        const name = byId.get(k.attacker)?.name || k.attacker;
        flags.push({
          tick: k.tick,
          playerId: k.attacker,
          rule: 'negative-ev',
          text: `${name} won a solo duel, but took it with no teammate in support and the round already ${pct(
            liveWp
          )} won. That fight was negative EV even though it came off.`
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

  // Equal-buy rounds: mark the exact tick win% hit 88% and never came back.
  const decidedMoment = findRoundDecided(meta);
  if (decidedMoment) {
    const onSide = players.find((p) => sideOf(p.id) === decidedMoment.side);
    if (onSide) {
      const phaseLabel =
        decidedMoment.phase === 'early'
          ? 'early round'
          : decidedMoment.phase === 'late'
            ? 'late round'
            : 'mid round';
      flags.push({
        tick: decidedMoment.tick,
        playerId: onSide.id,
        rule: 'round-decided',
        text: `Round decided in the ${phaseLabel}: ${decidedMoment.side} crossed 88% win chance and never dropped below it (equal buy).`
      });
    }
  }

  flags.sort((a, b) => a.tick - b.tick);
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
    updatedAt: Date.now()
  };
}
