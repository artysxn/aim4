// ---------------------------------------------------------------------------
// replays/coach/utilityMistakes.js
// The mistakes that live in the grenade log rather than the kill log.
//
// Everything here reads `events.grenades`, `events.damage` and the per-tick
// flash byte, so it runs anywhere the round file is readable: no map geometry,
// no duel model, no reparse. That is why it is first in the plan's build order.
//
// None of these rules use the trade window or the frag grace. Both of those are
// arguments about whether a DEATH was avoidable, and a flash that blinded your
// own team is the same mistake whether or not anyone died for it. The buy gate
// still applies: utility discipline on a lost-on-the-buy round is not worth
// saying out loud.
// ---------------------------------------------------------------------------

import { coachText } from './coachMessages.js';
import { flashBlindRise, isFireWeapon, isHeWeapon } from '../shared/utilityMetrics.js';

/** Own-team flash has to hold someone this long before it is worth a note. */
const ATE_FLASH_SECONDS = 1;
/** Friendly utility damage in a round, above which the victim hears about it. */
const TEAM_DAMAGE_HP = 20;
/** One enemy HE across the group: total damage, per-player floor, group size. */
const NADE_STACK_HP = 40;
const NADE_STACK_PER_PLAYER_HP = 10;
const NADE_STACK_PLAYERS = 2;
/** Grenades still in the bag at death, at or above which it is a wasted buy. */
const HELD_UTIL_COUNT = 3;
/** How far back a flash counts as "the one you were supposed to use". */
const OFF_FLASH_SECONDS = 3;
/** Death this soon after eating a friendly flash is called out as the cost. */
const FLASH_DEATH_SECONDS = 2;

const GRENADE_ITEMS = new Set([
  'flashbang',
  'smokegrenade',
  'hegrenade',
  'molotov',
  'incgrenade',
  'decoy'
]);

const bare = (w) =>
  String(w || '')
    .toLowerCase()
    .replace(/^weapon_/, '');

const round1 = (n) => (Math.round(n * 10) / 10).toString();

/**
 * @param {object} args
 * @param {object} args.meta
 * @param {number} args.tickRate
 * @param {Map<string, object>} args.byId          player id -> player
 * @param {(id: string) => ('CT'|'T'|undefined)} args.sideOf
 * @param {{CT: boolean, T: boolean}} args.gate
 * @param {(tick: number) => boolean} args.inCoachWindow
 * @param {number|null} args.defusedTick
 * @param {Array} args.kills
 * @param {(slot: number, tick: number) => number} args.flashAt  blind seconds
 * @returns {Array<{tick: number, playerId: string, rule: string, text: string}>}
 */
export function findUtilityFlags({
  meta,
  tickRate,
  byId,
  sideOf,
  gate,
  inCoachWindow,
  defusedTick,
  kills,
  flashAt
}) {
  const flags = [];
  const players = meta?.players || [];
  if (!players.length) return flags;

  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const nameOf = (id) => byId.get(id)?.name || id;
  const grenades = meta.events?.grenades || [];
  const damages = meta.events?.damage || [];

  const coachable = (id, tick) => {
    const side = sideOf(id);
    if (!side || !gate[side]) return false;
    if (!inCoachWindow(tick)) return false;
    if (defusedTick != null && tick >= defusedTick) return false;
    return true;
  };

  /** The player's death tick, or null when they survived the round. */
  const deathTick = new Map();
  for (const k of kills) {
    if (k.victim && !deathTick.has(k.victim)) deathTick.set(k.victim, k.tick);
  }
  const killerOf = new Map();
  for (const k of kills) {
    if (k.victim && !killerOf.has(k.victim)) killerOf.set(k.victim, k.attacker || '');
  }

  // ---- flashbangs: who did this actually blind ----------------------------

  for (const g of grenades) {
    if (String(g.type || '').toLowerCase() !== 'flashbang') continue;
    if (!g.player || !Number.isFinite(g.detonateTick)) continue;
    const throwerTeam = teamOf.get(g.player);
    if (!throwerTeam) continue;

    // Crossed before your own flash popped, so it blinded nobody in the fight.
    // Checked before the blind measurement rather than after it: a flash that
    // reached nobody is exactly the case this note is about.
    const throwerDied = deathTick.get(g.player);
    if (
      Number.isFinite(throwerDied) &&
      Number.isFinite(g.throwTick) &&
      throwerDied > g.throwTick &&
      throwerDied < g.detonateTick &&
      coachable(g.player, throwerDied)
    ) {
      flags.push({
        tick: throwerDied,
        playerId: g.player,
        rule: 'early-off-flash',
        text: coachText('early-off-flash', throwerDied, {
          enemy: nameOf(killerOf.get(g.player) || '') || 'They'
        })
      });
    }

    const rise = flashBlindRise({
      players,
      detonateTick: g.detonateTick,
      tickRate,
      flashAt
    });
    if (!rise.size) continue;

    let worstMate = '';
    let worstMateSeconds = 0;
    let bestEnemySeconds = 0;
    for (const [id, seconds] of rise) {
      if (id === g.player) continue;
      if (teamOf.get(id) === throwerTeam) {
        if (seconds > worstMateSeconds) {
          worstMateSeconds = seconds;
          worstMate = id;
        }
      } else if (seconds > bestEnemySeconds) {
        bestEnemySeconds = seconds;
      }
    }

    // A flash that held a teammate longer than anyone it was thrown at.
    // An enemy blinded for zero seconds counts, so a lineup that catches only
    // your own side fires here rather than being written off as a dud.
    if (worstMate && worstMateSeconds > bestEnemySeconds && coachable(g.player, g.detonateTick)) {
      flags.push({
        tick: g.detonateTick,
        playerId: g.player,
        rule: 'missed-flash',
        text: coachText('missed-flash', g.detonateTick, {
          teammate: nameOf(worstMate),
          seconds: round1(worstMateSeconds)
        })
      });
    }

    // The other half of the same throw. Separate note because the fix is
    // different: the thrower needs a lineup, the victim needs to turn.
    for (const [id, seconds] of rise) {
      if (id === g.player) continue;
      if (teamOf.get(id) !== throwerTeam) continue;
      if (seconds <= ATE_FLASH_SECONDS) continue;
      if (!coachable(id, g.detonateTick)) continue;
      const died = deathTick.get(id);
      const costTheRound =
        Number.isFinite(died) &&
        died >= g.detonateTick &&
        died - g.detonateTick <= FLASH_DEATH_SECONDS * tickRate;
      flags.push({
        tick: g.detonateTick,
        playerId: id,
        rule: 'ate-team-flash',
        text:
          coachText('ate-team-flash', g.detonateTick, { seconds: round1(seconds) }) +
          (costTheRound ? ' You died before it wore off.' : '')
      });
    }
  }

  // ---- died to an enemy your team had already flashed ---------------------

  const teamFlashes = grenades.filter(
    (g) =>
      String(g.type || '').toLowerCase() === 'flashbang' &&
      g.player &&
      Number.isFinite(g.detonateTick)
  );
  if (teamFlashes.length) {
    const lookback = OFF_FLASH_SECONDS * tickRate;
    for (const death of kills) {
      const victim = death.victim;
      const killer = death.attacker;
      if (!victim || !killer) continue;
      const side = sideOf(victim);
      if (!side || sideOf(killer) === side) continue;
      if (!coachable(victim, death.tick)) continue;

      const killerSlot = byId.get(killer)?.slot;
      if (killerSlot == null) continue;
      // The flash has to have been ours. An enemy who walked through their own
      // teammate's flash is not a timing we paid for.
      const ours = teamFlashes.some(
        (g) =>
          sideOf(g.player) === side &&
          g.detonateTick >= death.tick - lookback &&
          g.detonateTick <= death.tick
      );
      if (!ours) continue;
      // Blind at some point in the window, seeing again by the time we fired.
      if (flashAt(killerSlot, death.tick) > 0) continue;
      // The blind byte has 20ths-of-a-second resolution, so a coarse scan finds
      // the same recovery tick as a per-tick one for a fraction of the samples.
      const step = Math.max(1, Math.round(tickRate / 32));
      let endedAt = null;
      for (let t = death.tick - lookback; t < death.tick; t += step) {
        if (flashAt(killerSlot, t) > 0) endedAt = t;
      }
      if (endedAt == null) continue;

      flags.push({
        tick: death.tick,
        playerId: victim,
        rule: 'late-off-flash',
        text: coachText('late-off-flash', death.tick, {
          enemy: nameOf(killer),
          seconds: round1((death.tick - endedAt) / tickRate)
        })
      });
    }
  }

  // ---- utility damage that came from your own side ------------------------

  if (damages.length) {
    /** victim id -> { hp, tick, from: Map<attacker, hp> } */
    const friendly = new Map();
    /** attacker|tick bucket -> { attacker, tick, victims: Map<id, hp> } */
    const heGroups = new Map();
    const bucket = Math.max(1, Math.round(0.25 * tickRate));

    for (const d of damages) {
      const hp = Number(d.hp) || 0;
      if (hp <= 0 || !d.attacker || !d.victim) continue;
      if (!isHeWeapon(d.weapon) && !isFireWeapon(d.weapon)) continue;
      const at = teamOf.get(d.attacker);
      const vt = teamOf.get(d.victim);
      if (!at || !vt) continue;

      if (at === vt) {
        if (d.attacker === d.victim) continue; // your own molly under your feet
        const bag = friendly.get(d.victim) || { hp: 0, tick: d.tick, from: new Map() };
        bag.hp += hp;
        bag.tick = Math.min(bag.tick, d.tick);
        bag.from.set(d.attacker, (bag.from.get(d.attacker) || 0) + hp);
        friendly.set(d.victim, bag);
        continue;
      }

      if (!isHeWeapon(d.weapon)) continue;
      const key = `${d.attacker}@${Math.floor(d.tick / bucket)}`;
      const group = heGroups.get(key) || { attacker: d.attacker, tick: d.tick, victims: new Map() };
      group.tick = Math.min(group.tick, d.tick);
      group.victims.set(d.victim, (group.victims.get(d.victim) || 0) + hp);
      heGroups.set(key, group);
    }

    for (const [victim, bag] of friendly) {
      if (bag.hp <= TEAM_DAMAGE_HP) continue;
      if (!coachable(victim, bag.tick)) continue;
      flags.push({
        tick: bag.tick,
        playerId: victim,
        rule: 'team-util-damage',
        text: coachText('team-util-damage', bag.tick, { hp: Math.round(bag.hp) })
      });
    }

    for (const group of heGroups.values()) {
      const hit = [...group.victims.entries()].filter(
        ([, hp]) => hp >= NADE_STACK_PER_PLAYER_HP
      );
      if (hit.length < NADE_STACK_PLAYERS) continue;
      const total = hit.reduce((n, [, hp]) => n + hp, 0);
      if (total < NADE_STACK_HP) continue;
      // One note for the group, pinned to a victim so the team filter works.
      const pin = hit[0][0];
      if (!coachable(pin, group.tick)) continue;
      flags.push({
        tick: group.tick,
        playerId: pin,
        rule: 'nade-stack',
        text: coachText('nade-stack', group.tick, {
          hp: Math.round(total),
          n: hit.length
        })
      });
    }
  }

  // ---- utility that was bought and never thrown ---------------------------

  const thrownBefore = (playerId, tick) =>
    grenades.filter(
      (g) => g.player === playerId && Number.isFinite(g.throwTick) && g.throwTick <= tick
    ).length;

  for (const [victim, tick] of deathTick) {
    if (!coachable(victim, tick)) continue;
    const loadout = meta.stats?.[victim]?.loadout || [];
    const bought = loadout.filter((w) => GRENADE_ITEMS.has(bare(w))).length;
    const left = bought - thrownBefore(victim, tick);
    if (left < HELD_UTIL_COUNT) continue;
    flags.push({
      tick,
      playerId: victim,
      rule: 'died-holding-util',
      text: coachText('died-holding-util', tick, { n: left })
    });
  }

  return flags;
}
