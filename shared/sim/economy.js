// ---------------------------------------------------------------------------
// shared/sim/economy.js
// The cash machine: what a kill pays, what a round pays, and what you may buy.
//
// Pure, unit-tested, and paranoid, because reward signals flow through it and a
// wrong economy poisons training invisibly. A $250 error compounds over 24
// rounds into a team that has learned the wrong afterplant, and nothing about
// that failure looks like a bug: the bots simply play slightly badly forever.
//
// The load-bearing subtlety is explode versus eliminate. Ending a round by
// killing the last CT after a plant pays the team $3,250 plus the kill award;
// letting the bomb finish pays $3,500 and no award. Those are different numbers
// and they point in different directions depending on who is holding what, so
// the afterplant hold-or-hunt decision is a real money decision rather than a
// preference. SIM-PLAN 4.9 says so; this file is what makes it true.
//
// This module prices and enforces legality. It never decides. What to buy is a
// learned decision (7.4) and lives in the policy.
// ---------------------------------------------------------------------------

import { WEAPON_SPEED } from './constants.js';

export const START_MONEY = 800;
export const OT_START_MONEY = 10000;
export const MONEY_CAP = 16000;

/** Loss bonus ladder. A win decrements the streak by one; it does not reset it. */
export const LOSS_LADDER = Object.freeze([1400, 1900, 2400, 2900, 3400]);

export const WIN_ELIM = 3250;
export const WIN_BOMB = 3500;
export const WIN_DEFUSE = 3500;
export const WIN_TIME = 3250;
/** Consolation for a T side that planted and still lost. */
export const T_PLANT_LOSS_BONUS = 800;
export const PLANT_BONUS = 300;
export const DEFUSE_BONUS = 300;
export const TEAM_KILL_PENALTY = -300;

export const GEAR_PRICES = Object.freeze({
  kevlar: 650,
  kevlarHelmet: 1000, // 650 + 350
  helmetUpgrade: 350,
  defuser: 400,
  taser: 200
});

/**
 * Kill award by weapon, in the four buckets CS actually uses. Keyed by
 * `bareWeapon()` stem so it lines up with weaponTable.js. `[verify all]`
 */
export const KILL_AWARD = Object.freeze({
  // $100: the guns that already paid for themselves
  awp: 100,
  cz75a: 100,

  // $900: shotguns
  nova: 900,
  xm1014: 900,
  mag7: 900,
  sawedoff: 900,

  // $600: SMGs, except the P90
  mac10: 600,
  mp9: 600,
  mp7: 600,
  mp5sd: 600,
  ump45: 600,
  bizon: 600,

  // extras
  knife: 1500,
  taser: 0
});

/** Everything not named above pays the standard award. */
export const DEFAULT_KILL_AWARD = 300;

/**
 * @param {string} weapon  bareWeapon stem
 * @param {boolean} [teamKill]
 */
export function killAward(weapon, teamKill = false) {
  if (teamKill) return TEAM_KILL_PENALTY;
  return KILL_AWARD[weapon] ?? DEFAULT_KILL_AWARD;
}

/** Loss bonus for a streak of consecutive losses (1-based, clamped). */
export function lossBonus(streak) {
  const i = Math.max(1, Math.min(LOSS_LADDER.length, Math.round(streak))) - 1;
  return LOSS_LADDER[i];
}

/**
 * A win does not reset the loss streak in CS2, it decrements it by one. Getting
 * this wrong makes a team that wins one round out of a long losing run richer
 * than it should be for the rest of the half, which quietly changes every buy
 * decision downstream of it.
 */
export function nextLossStreak(streak, won) {
  return won ? Math.max(0, streak - 1) : Math.min(LOSS_LADDER.length, streak + 1);
}

/**
 * How a round ended, in the only vocabulary the payout cares about.
 * @typedef {object} RoundOutcome
 * @property {'T'|'CT'} winner
 * @property {'elimination'|'bomb'|'defuse'|'time'} reason
 * @property {boolean} planted        was the bomb down when the round ended
 * @property {number|null} planterSlot
 * @property {number|null} defuserSlot
 */

/**
 * Team win payment for an outcome.
 *
 * The `elimination after a plant` row is the one worth reading twice: the Ts
 * win by eliminating rather than by explosion, so they are paid the elimination
 * figure and not the bomb figure, and the difference is the $250 the hold-or-
 * hunt decision turns on.
 */
export function winPayout(outcome) {
  if (outcome.winner === 'T') {
    if (outcome.reason === 'bomb') return WIN_BOMB;
    return WIN_ELIM;
  }
  if (outcome.reason === 'defuse') return WIN_DEFUSE;
  if (outcome.reason === 'time') return WIN_TIME;
  return WIN_ELIM;
}

/**
 * Per-player payout for one round, before the cap.
 *
 * @param {object} args
 * @param {RoundOutcome} args.outcome
 * @param {Array<{slot: number, side: 'T'|'CT', alive: boolean, money: number}>} args.players
 * @param {Record<number, number>} [args.killCash]  per slot, already earned in-round
 * @param {{T: number, CT: number}} args.lossStreak  streak BEFORE this round
 * @returns {{money: Record<number, number>, lossStreak: {T: number, CT: number}, detail: object}}
 */
export function settleRound({ outcome, players, killCash = {}, lossStreak }) {
  const winner = outcome.winner;
  const loser = winner === 'T' ? 'CT' : 'T';
  const win = winPayout(outcome);
  const loss = lossBonus(lossStreak[loser] + 1);

  const money = {};
  const detail = { win, loss, perPlayer: {} };

  for (const p of players) {
    const rows = [];
    let pay = p.money + (killCash[p.slot] || 0);
    if (killCash[p.slot]) rows.push(['kills', killCash[p.slot]]);

    if (p.side === winner) {
      pay += win;
      rows.push(['win', win]);
    } else {
      // Time expiry with no plant pays the losing T side nothing at all: not
      // the win, not the loss bonus. It is the one round type where a side
      // finishes with only what it started with, and it is why running down
      // the clock as T is a genuinely expensive mistake rather than a neutral
      // one. `[verify]`
      const timeExpiryT = outcome.reason === 'time' && !outcome.planted && p.side === 'T';
      if (!timeExpiryT) {
        pay += loss;
        rows.push(['loss', loss]);
      }
      // A T side that planted and lost anyway gets the consolation, on top of
      // the ladder, which is what makes planting into a lost retake still worth
      // doing.
      if (p.side === 'T' && outcome.planted) {
        pay += T_PLANT_LOSS_BONUS;
        rows.push(['plantConsolation', T_PLANT_LOSS_BONUS]);
      }
    }

    if (outcome.planterSlot === p.slot) {
      pay += PLANT_BONUS;
      rows.push(['plant', PLANT_BONUS]);
    }
    if (outcome.defuserSlot === p.slot) {
      pay += DEFUSE_BONUS;
      rows.push(['defuse', DEFUSE_BONUS]);
    }

    const capped = Math.max(0, Math.min(MONEY_CAP, pay));
    if (capped !== pay) rows.push(['cap', capped - pay]);
    money[p.slot] = capped;
    detail.perPlayer[p.slot] = rows;
  }

  return {
    money,
    lossStreak: {
      T: nextLossStreak(lossStreak.T, winner === 'T'),
      CT: nextLossStreak(lossStreak.CT, winner === 'CT')
    },
    detail
  };
}

/**
 * Can this player buy this item right now, and what does it cost?
 *
 * Legality only. The module never says whether buying is a good idea, which is
 * the policy's job and the one part of the economy that is learned.
 *
 * @param {object} args
 * @param {{money: number, side: 'T'|'CT', inBuyZone: boolean, inventory: object}} args.player
 * @param {string} args.item  weapon stem or a GEAR_PRICES key
 * @param {number} args.price
 * @param {boolean} args.inBuyTime
 * @returns {{ok: boolean, reason?: string, price: number}}
 */
export function canBuy({ player, item, price, inBuyTime }) {
  if (!inBuyTime) return { ok: false, reason: 'buy_time_over', price };
  if (!player.inBuyZone) return { ok: false, reason: 'outside_buy_zone', price };
  if (player.money < price) return { ok: false, reason: 'insufficient_funds', price };

  const inv = player.inventory || {};
  if (item === 'defuser' && player.side !== 'CT') {
    return { ok: false, reason: 'ct_only', price };
  }
  const grenades = inv.grenades || [];
  if (isGrenade(item)) {
    if (grenades.length >= 4) return { ok: false, reason: 'grenade_limit', price };
    if (item === 'flashbang' && grenades.filter((g) => g === 'flashbang').length >= 2) {
      return { ok: false, reason: 'flash_limit', price };
    }
    if (item !== 'flashbang' && grenades.includes(item)) {
      return { ok: false, reason: 'duplicate_grenade', price };
    }
  }
  return { ok: true, price };
}

const GRENADES = new Set(['hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incgrenade', 'decoy']);
export function isGrenade(item) {
  return GRENADES.has(item);
}

/**
 * Is this a weapon the sim knows how to carry? Guards the buy head against
 * emitting an item the movement model has no speed for, which would otherwise
 * surface as a bot that walks at the default rifle speed holding a shotgun.
 */
export function isKnownWeapon(item) {
  return Object.prototype.hasOwnProperty.call(WEAPON_SPEED, item);
}

/** Starting money for a half. */
export function startMoney(overtime = false) {
  return overtime ? OT_START_MONEY : START_MONEY;
}
