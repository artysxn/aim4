// ---------------------------------------------------------------------------
// shared/sim/conservation.js
// Reading the buy: three conservation laws (SIM-PLAN 19.7).
//
// Every read a good player makes about enemy intent is downstream of something
// being conserved. Naming the three turns a pile of heuristics into one idea,
// and this module is the surface all three are read through.
//
//   1. BODIES. Five minus the kill feed. Already ENFORCED, in knowledge.js:
//      `killed()` deletes the slot from every layout and `aliveCount()` reports
//      the remainder, so nothing here re-implements it. `bodiesRead` delegates,
//      because a second body count that could disagree with the belief is worse
//      than no body count at all.
//   2. UTILITY. The enemy's inventory is bounded by what their buy could
//      contain and decremented by every detonation we saw and every throw we
//      heard. Two reads drop out with no new rule: the late round becomes a
//      COUNT rather than a guess, and a fake must be affordable, so P(fake)
//      falls as believed utility falls. A side that cannot pay for both sites
//      cannot buy a convincing lie.
//   3. MONEY. 5.3's econ tracker upgraded from "a class" to a distribution over
//      loadouts with a spend history, using the inputs it ignores today: the
//      loss ladder is public, drops are observable, saved weapons carry
//      forward, and absence of evidence is evidence. A side that shows nothing
//      for forty seconds is saving, stacking, or deliberately hiding, which is
//      three hypotheses rather than a default.
//
// Then the one behavioural payload, and the discipline that governs it:
// ECONOMY CONDITIONS PRIORS, NEVER RULES. `enemyRiskPosture` runs 6.7's second
// consequence (a side priced out of a fair fight correctly seeks variance) on
// the OPPONENT's inferred economy and returns what the belief should EXPECT:
// further forward, more stacked, off their default angles. It returns
// multipliers and biases a prior can consume; it never says what anybody does.
// This is the first place the design turns its own decision theory around to
// predict the opponent, and because the theory is already written it costs
// nothing.
//
// Law 3 feeds law 2: the loadout posterior prices how many dollars of grenades
// the buy could have contained, which is the utility tracker's ceiling. Law 1
// feeds law 2 as well, through `bodiesLost`: a player who dies takes his
// unthrown utility out of the round with him.
//
// Everything here is pure and deterministic. No clock, no rng, no I/O: the same
// percepts always produce the same read, because a belief that drifts between
// two runs of the same round is not a belief, it is a bug with a story.
//
// Numbers that no demo has been mined for yet carry `[calibrate]`. They are
// shaped so the QUALITATIVE claims (monotone in the evidence, three hypotheses
// rather than one, never negative) hold for any plausible value of them.
// ---------------------------------------------------------------------------

import { NADE } from './grenades.js';
import { HEAVY, LIGHT, utilityLedger } from './ledgers.js';
import { DEFAULT_KILL_AWARD, MONEY_CAP, START_MONEY, killAward, settleRound } from './economy.js';
import { NADE_COST } from '../../src/replays/coach/winProbability.js';
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';
import { ECONOMIES, ECON_FULL_AWP } from '../../src/replays/shared/roundId.js';

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const clampSigned = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(-1, x)) : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Law 1: bodies
// ---------------------------------------------------------------------------

/**
 * The body count, read straight off the joint belief.
 *
 * Delegation, not duplication: `belief.aliveCount()` is the enforcement point
 * and this is a window onto it. With a zone predicate it also answers the
 * question 6.21 asks of a fake: four bodies committed to A is not a fake, and
 * `elsewhere` is how many are left to be the real thing.
 *
 * @param {import('./knowledge.js').JointBelief} belief
 * @param {(anchor: string, level: string) => boolean} [inZone]
 */
export function bodiesRead(belief, inZone = null) {
  const alive = belief.aliveCount();
  const read = {
    alive,
    dead: 5 - alive,
    deadSlots: [...belief.dead].sort((a, b) => a - b)
  };
  if (!inZone) return read;
  const countDist = belief.countDist(inZone);
  let committed = 0;
  for (let i = 0; i < countDist.length; i += 1) committed += i * countDist[i];
  return { ...read, countDist, committed, elsewhere: Math.max(0, alive - committed), pEmpty: countDist[0] };
}

// ---------------------------------------------------------------------------
// Law 2: utility
// ---------------------------------------------------------------------------

/** Four grenades is the carry limit, two of them flashes (economy.js canBuy). */
export const PER_PLAYER_NADE_CAP = 4;
export const FLASH_SLOTS_PER_PLAYER = 2;

/**
 * Cheapest grenade a real side actually buys, used to turn dollars into a count
 * bound. The decoy is priced at $50 and would make the bound useless, because
 * nobody spends a buy on decoys. `[calibrate]`
 */
export const BOUND_PRICE_FLOOR = NADE_COST[NADE.FLASH];

/** Fire is the same grenade at two prices: molotov for T, incendiary for CT. */
export function fireType(side) {
  return side === 'CT' ? NADE.INCENDIARY : NADE.MOLOTOV;
}

/** The types a side can hold at all. Prices come from winProbability's table. */
export function nadeTypes(side) {
  return [NADE.SMOKE, fireType(side), NADE.HE, NADE.FLASH, NADE.DECOY];
}

export function nadePrice(type) {
  return NADE_COST[type] ?? BOUND_PRICE_FLOOR;
}

/**
 * What their buy COULD contain: the ceiling every later decrement works down
 * from. Two constraints, both hard: carry slots, and dollars.
 *
 * `byType` entries are independent upper bounds rather than a partition. They
 * cannot all be true at once, which is what `total` is for, and saying so is
 * more honest than inventing a split we have no evidence for.
 *
 * @param {{side?: 'T'|'CT', alive?: number, utilityBudget?: number}} args
 *        utilityBudget is TEAM dollars believed available for grenades
 */
export function utilityBound({ side = 'T', alive = 5, utilityBudget = Infinity } = {}) {
  const bodies = Math.max(0, Math.round(alive));
  const budget = Number.isFinite(utilityBudget) ? Math.max(0, utilityBudget) : Infinity;
  const byType = {};
  for (const type of nadeTypes(side)) {
    const slots = bodies * (type === NADE.FLASH ? FLASH_SLOTS_PER_PLAYER : 1);
    const affordable = Number.isFinite(budget) ? Math.floor(budget / nadePrice(type)) : slots;
    byType[type] = Math.max(0, Math.min(slots, affordable));
  }
  const slotTotal = bodies * PER_PLAYER_NADE_CAP;
  const moneyTotal = Number.isFinite(budget) ? Math.floor(budget / BOUND_PRICE_FLOOR) : slotTotal;
  return { byType, total: Math.max(0, Math.min(slotTotal, moneyTotal)) };
}

/**
 * The enemy's grenade inventory, bounded above and only ever falling.
 *
 * A throw we heard and a detonation we watched are the same grenade, so the
 * tracker reconciles them rather than counting both. Over-counting is the one
 * failure mode that matters here: it quietly deflates the reserve and produces
 * a bot that walks onto a site believing they are out of smokes.
 */
export class EnemyUtilityTracker {
  constructor({ side = 'T', alive = 5, utilityBudget = Infinity, bound = null } = {}) {
    this.side = side;
    this.alive0 = Math.max(1, Math.round(alive));
    this.bound = bound
      ? { byType: { ...bound.byType }, total: bound.total }
      : utilityBound({ side, alive, utilityBudget });
    this.bound0 = { byType: { ...this.bound.byType }, total: this.bound.total };
    /** Detonations seen, per type. */
    this.spent = new Map();
    /** Throws heard whose detonation we have not watched yet. */
    this.pending = new Map();
    /** Throws heard that we could not name. They spend the total, not a type. */
    this.unknown = 0;
    /** The spend history, in percept order. Readable, and it is the audit. */
    this.log = [];
    /** True once the bound came from something better than an inference. */
    this.boundKnown = false;
  }

  /** Bounds only ever tighten: conservation runs one way. */
  tighten(bound, { known = false } = {}) {
    for (const [type, n] of Object.entries(bound.byType || {})) {
      const cur = this.bound.byType[type];
      this.bound.byType[type] = cur == null ? n : Math.min(cur, n);
    }
    if (Number.isFinite(bound.total)) this.bound.total = Math.min(this.bound.total, bound.total);
    if (known) this.boundKnown = true;
    return this;
  }

  /**
   * A body that dies takes its unthrown utility with it: law 1 acting on law 2.
   * The ceiling falls with the roster, which is why a 5v2 is also a utility
   * read and not only a body one.
   */
  bodiesLost(aliveNow) {
    const share = clamp01(aliveNow / this.alive0);
    const byType = {};
    for (const [type, n] of Object.entries(this.bound0.byType)) byType[type] = Math.ceil(n * share);
    return this.tighten({ byType, total: Math.ceil(this.bound0.total * share) });
  }

  /** A throw we heard. The grenade has left their hands, named or not. */
  heardThrow({ type = null, tick = null } = {}) {
    this.log.push({ kind: 'heard', type, tick });
    if (!type) {
      this.unknown += 1;
      return this;
    }
    this.pending.set(type, (this.pending.get(type) || 0) + 1);
    return this;
  }

  /**
   * A detonation we saw. If a throw of that type is outstanding it is THIS
   * grenade arriving rather than a second one; failing that, an unnamed throw
   * is the next best explanation, and only then is it new spend.
   */
  sawDetonation({ type, tick = null } = {}) {
    this.log.push({ kind: 'detonated', type, tick });
    const outstanding = this.pending.get(type) || 0;
    if (outstanding > 0) this.pending.set(type, outstanding - 1);
    else if (this.unknown > 0) this.unknown -= 1;
    this.spent.set(type, (this.spent.get(type) || 0) + 1);
    return this;
  }

  /** Grenades of a type that have left the buy, thrown or in the air. */
  spentOf(type) {
    return (this.spent.get(type) || 0) + (this.pending.get(type) || 0);
  }

  /**
   * Counted off the percepts rather than off the bound, so a grenade the buy
   * was not believed to contain still shows as spent.
   */
  totalSpent() {
    let sum = this.unknown;
    for (const n of this.spent.values()) sum += n;
    for (const n of this.pending.values()) sum += n;
    return sum;
  }

  /** Never negative: a side cannot un-throw a grenade. */
  remaining(type) {
    return Math.max(0, (this.bound.byType[type] ?? 0) - this.spentOf(type));
  }

  remainingTotal() {
    let sum = 0;
    for (const type of Object.keys(this.bound.byType)) sum += this.remaining(type);
    return Math.max(0, Math.min(sum, this.bound.total - this.totalSpent()));
  }

  /**
   * The late round is a COUNT, not a guess (6.22 rung 7).
   *
   * A CT side that stopped a 1:40 rush with three molotovs has bought the early
   * round with the late one, and the T side can KNOW this: when `exact` is
   * true, "they have nothing left" is arithmetic. `resolved` is how much of the
   * buy the percepts have accounted for in the meantime.
   */
  projectedReserve() {
    const byType = {};
    let heavy = 0;
    let light = 0;
    for (const type of Object.keys(this.bound.byType)) {
      const n = this.remaining(type);
      byType[type] = n;
      if (HEAVY.has(type)) heavy += n;
      if (LIGHT.has(type)) light += n;
    }
    const total = this.remainingTotal();
    const spent = this.totalSpent();
    return {
      byType,
      heavy: Math.min(heavy, total),
      light: Math.min(light, total),
      total,
      spent,
      exact: total === 0 || this.boundKnown,
      resolved: this.bound.total > 0 ? clamp01(spent / this.bound.total) : 1
    };
  }

  /**
   * The believed inventory as a flat list, which is exactly what
   * `utilityLedger({ ours, theirs })` consumes. Heavy first, because when the
   * total cap bites, assuming they kept the resource that decides late rounds
   * is the read that costs us least when it is wrong.
   */
  believedInventory() {
    const cap = this.remainingTotal();
    const out = [];
    for (const type of nadeTypes(this.side)) {
      for (let i = 0; i < this.remaining(type) && out.length < cap; i += 1) out.push(type);
    }
    return out;
  }

  /** Feeds the existing ledger rather than reimplementing it (ledgers.js). */
  ledger({ ours = [], spentByUs = 0 } = {}) {
    return utilityLedger({
      ours,
      theirs: this.believedInventory(),
      spentByUs,
      spentByThem: this.totalSpent()
    });
  }

  /** P(this show is a fake), priced off what is left to pay for the real one. */
  pFake(args = {}) {
    return pFake({ reserveHeavy: this.projectedReserve().heavy, ...args });
  }
}

/** Base rate of a fake among shows, before affordability. `[calibrate]` */
export const P_FAKE_PRIOR = 0.35;
/** Heavy utility a site take needs: a smoke and a molotov. `[calibrate]` */
export const EXECUTE_HEAVY_NEED = 2;
/** Heavy utility a full buy carries across five players. `[calibrate]` */
export const FULL_BUY_HEAVY = 5;
/** Bodies a real execute needs behind it. `[calibrate]` */
export const EXECUTE_BODIES = 3;

/**
 * A fake must be affordable.
 *
 * `P(fake | two smokes on B)` falls as their believed utility falls, because a
 * side that cannot pay for both sites cannot buy a convincing lie. No new rule
 * is needed: the show has already been decremented by the tracker, so what is
 * passed in is what is left to pay for the real execute. The body term is law 1
 * arriving at the same answer from the other side, since a fake with four
 * bodies committed to it is not a fake.
 *
 * @param {object} args
 * @param {number} args.reserveHeavy  believed heavy utility left AFTER the show
 * @param {number} [args.alive]       enemies still alive
 * @param {number} [args.committed]   expected bodies in the shown zone
 * @param {number} [args.prior]
 * @returns {{p: number, affordability: number, bodies: number, prior: number}}
 */
export function pFake({ reserveHeavy = 0, alive = 5, committed = 0, prior = P_FAKE_PRIOR } = {}) {
  const share = (x) => x / (x + EXECUTE_HEAVY_NEED);
  const r = Math.max(0, reserveHeavy);
  // Strictly increasing in what is left, so the read moves on every grenade,
  // and normalized so a full buy can fake at the base rate and nothing above it.
  const affordability = clamp01(share(r) / share(FULL_BUY_HEAVY));
  const bodies = clamp01((Math.max(0, alive) - Math.max(0, committed)) / EXECUTE_BODIES);
  return { p: clamp01(prior * affordability * bodies), affordability, bodies, prior };
}

// ---------------------------------------------------------------------------
// Law 3: money
// ---------------------------------------------------------------------------

const loadoutKey = (digit) => (digit === ECON_FULL_AWP ? 'fullAwp' : ECONOMIES[digit].key);
const loadoutLabel = (digit) => (digit === ECON_FULL_AWP ? 'Full buy + AWP' : ECONOMIES[digit].label);

/**
 * The six econ digits the site already stores (roundId.js `ECONOMIES` plus the
 * legacy digit 5), given the fields a read needs. Per player, team-averaged:
 * we cannot see how their money is distributed, so five identical wallets is
 * the model, and `AFFORD_SLACK` below is what covers the case where it is not.
 *
 * `money` is the bank at which this buy is the natural choice, `cost` what it
 * takes out of that bank, `equipValue` what it puts on the player (higher than
 * cost on an eco, because saved weapons carry forward). `[calibrate all]`
 */
export const LOADOUTS = Object.freeze(
  [
    { digit: 0, money: 800, cost: 700, gunPrice: 500, nadeBudget: 300, equipValue: 900, dropFriendly: 0.2, pistolRoundOnly: true },
    { digit: 1, money: 1000, cost: 0, gunPrice: 400, nadeBudget: 100, equipValue: 800, dropFriendly: 0.15 },
    { digit: 2, money: 2600, cost: 2100, gunPrice: 1500, nadeBudget: 500, equipValue: 2600, dropFriendly: 0.35 },
    { digit: 3, money: 3400, cost: 1900, gunPrice: 900, nadeBudget: 600, equipValue: 2400, dropFriendly: 0.25 },
    { digit: 4, money: 5200, cost: 4200, gunPrice: 2900, nadeBudget: 900, equipValue: 4700, dropFriendly: 1 },
    { digit: 5, money: 6600, cost: 4600, gunPrice: 4750, nadeBudget: 900, equipValue: 5600, dropFriendly: 1 }
  ].map((l) => Object.freeze({ ...l, key: loadoutKey(l.digit), label: loadoutLabel(l.digit) }))
);

/** Width of the money kernel, in dollars per player. `[calibrate]` */
export const MONEY_KERNEL = 1600;
/** A buy can come in under price when somebody is dropped for. `[calibrate]` */
export const AFFORD_SLACK = 0.15;
/** How far over a loadout's gun budget a seen weapon can still sit. `[calibrate]` */
export const GUN_SLACK = 0.15;

/**
 * The econ read as a DISTRIBUTION over loadouts rather than a class (5.3).
 *
 * Three channels, all of them observables a real player uses:
 *
 *   money      the loss ladder is public, so the bank is inferable and each
 *              loadout has a bank it belongs to
 *   weapons    seeing an expensive gun is strong evidence and seeing a cheap
 *              one is weak, which is the honest asymmetry: a full buy can be
 *              holding a pistol, an eco cannot be holding an AWP
 *   saves      unless it saved one. `savedGuns` is the carried-forward channel,
 *              and it is what stops a saved AWP from falsifying an eco
 *
 * @param {object} args
 * @param {number} args.money          believed bank per player at buy time
 * @param {number} [args.alive]
 * @param {boolean} [args.isPistolRound]
 * @param {string[]} [args.seenWeapons]
 * @param {number} [args.drops]        drops observed this round
 * @param {number} [args.savedGuns]    guns believed carried in from last round
 * @returns {Array<object>} one row per loadout with `p`, in digit order
 */
export function loadoutPosterior({
  money = START_MONEY,
  alive = 5,
  isPistolRound = false,
  seenWeapons = [],
  drops = 0,
  savedGuns = 0
} = {}) {
  const bank = Number.isFinite(money) ? Math.max(0, money) : START_MONEY;
  const savedShare = clamp01(savedGuns / Math.max(1, alive));

  const legal = LOADOUTS.map(
    (l) => !(l.pistolRoundOnly && !isPistolRound) && bank >= l.cost * (1 - AFFORD_SLACK)
  );
  const byBank = LOADOUTS.map((l, i) => {
    if (!legal[i]) return 0;
    const d = (bank - l.money) / MONEY_KERNEL;
    return Math.exp(-d * d);
  });
  const weights = LOADOUTS.map((l, i) => {
    let w = byBank[i];
    if (w === 0) return 0;
    for (const weapon of seenWeapons) w *= weaponLikelihood(l, weapon, savedShare);
    if (drops > 0) w *= l.dropFriendly ** drops;
    return w;
  });

  // A side priced out of every loadout is a side whose bank we have wrong, not
  // a side with no buy: fall back to the money channel, then to the legal set.
  const pick = sum(weights) > 0 ? weights : sum(byBank) > 0 ? byBank : legal.map((ok) => (ok ? 1 : 0));
  const total = sum(pick) || 1;
  return LOADOUTS.map((l, i) => ({ ...l, p: pick[i] / total }));
}

/**
 * How well one seen weapon sits inside a loadout's gun budget. Over budget the
 * fit falls off quadratically, floored by the share of their side that could be
 * carrying a gun it did not pay for this round.
 */
function weaponLikelihood(loadout, weapon, savedShare) {
  const price = weaponInfo(weapon).price;
  const budget = Math.max(1, loadout.gunPrice) * (1 + GUN_SLACK);
  if (price <= budget) return 1;
  const fit = (budget / price) ** 2;
  return Math.max(fit, savedShare);
}

/** Posterior mass on a set of loadout keys or digits. */
export function massOf(posterior, keys) {
  const want = new Set(Array.isArray(keys) ? keys : [keys]);
  let mass = 0;
  for (const l of posterior || []) if (want.has(l.key) || want.has(l.digit)) mass += l.p;
  return mass;
}

/** Expected per-player equipment value under the posterior. */
export function expectedEquipValue(posterior) {
  let v = 0;
  for (const l of posterior || []) v += l.p * l.equipValue;
  return v;
}

/** Expected TEAM dollars of grenades in the buy: the utility tracker's ceiling. */
export function expectedNadeBudget(posterior, alive = 5) {
  let v = 0;
  for (const l of posterior || []) v += l.p * l.nadeBudget;
  return v * Math.max(0, alive);
}

/**
 * The enemy wallet, inferred rather than read (5.3: bots must not read the
 * enemy wallet). The bank is carried round to round through economy.js's own
 * settlement, because the ladder, the win payouts, and the cap are public and
 * re-deriving them here is how two economies quietly disagree.
 *
 * The spend history is the point: each round records the bank the buy was made
 * against, the posterior over what it bought, and what that costs in
 * expectation, so the next round starts from a number with a lineage.
 */
export class EnemyEconomy {
  constructor({ side = 'T', players = 5, teamMoney = null, lossStreak = 0, savedGuns = 0 } = {}) {
    this.side = side;
    this.players = players;
    this.bank = Number.isFinite(teamMoney) ? teamMoney : START_MONEY * players;
    this.lossStreak = lossStreak;
    this.savedGuns = savedGuns;
    this.bankAtBuy = this.bank;
    /** A side sitting on exactly the starting bank is on a pistol round. */
    this.isPistolRound = this.bank <= START_MONEY * players;
    this.seenWeapons = [];
    this.drops = 0;
    /** @type {Array<object>} one row per round, oldest first. */
    this.history = [];
  }

  perPlayerMoney() {
    return this.bank / Math.max(1, this.players);
  }

  /** Freeze the bank the buy is made against and clear the round's evidence. */
  startRound({ isPistolRound = false } = {}) {
    this.bankAtBuy = this.bank;
    this.isPistolRound = isPistolRound;
    this.seenWeapons = [];
    this.drops = 0;
    const posterior = this.posterior();
    let spend = 0;
    for (const l of posterior) spend += l.p * l.cost;
    const expectedSpend = spend * this.players;
    this.bank = Math.max(0, this.bank - expectedSpend);
    this.history.push({
      bankAtBuy: this.bankAtBuy,
      lossStreak: this.lossStreak,
      savedGuns: this.savedGuns,
      expectedSpend,
      posterior
    });
    return posterior;
  }

  /** A weapon on a contact or in the kill feed. */
  sawWeapon(weapon) {
    this.seenWeapons.push(weapon);
    return this;
  }

  /** A drop is evidence of asymmetric wealth, which is a full buy's habit. */
  sawDrop(count = 1) {
    this.drops += count;
    return this;
  }

  posterior() {
    return loadoutPosterior({
      money: this.bankAtBuy / Math.max(1, this.players),
      alive: this.players,
      isPistolRound: this.isPistolRound,
      seenWeapons: this.seenWeapons,
      drops: this.drops,
      savedGuns: this.savedGuns
    });
  }

  /** Team dollars of grenades their buy could have contained. */
  utilityBudget() {
    return expectedNadeBudget(this.posterior(), this.players);
  }

  /** A ready-made ceiling for the utility tracker: law 3 feeding law 2. */
  utilityBound({ alive = this.players } = {}) {
    return utilityBound({ side: this.side, alive, utilityBudget: this.utilityBudget() });
  }

  /**
   * Settle the round through economy.js. Five identical wallets at the mean is
   * the model, so the per-player cap applies at the mean; kill cash is spread
   * evenly for the same reason.
   *
   * @param {object} args
   * @param {boolean} args.won
   * @param {'elimination'|'bomb'|'defuse'|'time'} [args.reason]
   * @param {boolean} [args.planted]
   * @param {string[]|number} [args.kills]  weapons from the feed, or a count
   * @param {number} [args.survivors]       bodies that kept their guns
   */
  roundEnded({ won, reason = 'elimination', planted = false, kills = [], survivors = 0 } = {}) {
    const other = this.side === 'T' ? 'CT' : 'T';
    const perPlayer = this.perPlayerMoney();
    const players = Array.from({ length: this.players }, (_, slot) => ({
      slot,
      side: this.side,
      alive: slot < survivors,
      money: perPlayer
    }));
    const cash = Array.isArray(kills)
      ? kills.reduce((sum, w) => sum + killAward(w), 0)
      : Math.max(0, kills) * DEFAULT_KILL_AWARD;
    const perSlot = cash / Math.max(1, this.players);
    const killCash = Object.fromEntries(players.map((p) => [p.slot, perSlot]));

    const settled = settleRound({
      outcome: {
        winner: won ? this.side : other,
        reason,
        planted,
        planterSlot: planted && this.side === 'T' ? 0 : null,
        defuserSlot: reason === 'defuse' && this.side === 'CT' ? 0 : null
      },
      players,
      killCash,
      lossStreak: { [this.side]: this.lossStreak, [other]: 0 }
    });

    let total = 0;
    for (const p of players) total += settled.money[p.slot];
    this.bank = Math.min(MONEY_CAP * this.players, total);
    this.lossStreak = settled.lossStreak[this.side];
    // Saved weapons carry forward, but only the survivors who had one: the
    // posterior already says how likely that is.
    this.savedGuns = Math.max(0, survivors) * massOf(this.posterior(), ['half', 'force', 'full', 'fullAwp']);
    const row = this.history[this.history.length - 1];
    if (row) Object.assign(row, { won, reason, planted, survivors, bankAfter: this.bank });
    return this;
  }
}

// ---------------------------------------------------------------------------
// Absence of evidence is evidence
// ---------------------------------------------------------------------------

/** The three hypotheses silence supports. Not two, and not a default. */
export const SILENCE_HYPOTHESES = Object.freeze(['saving', 'stacking', 'hiding']);

/**
 * Mean seconds before each hypothesis reveals itself, which is what makes
 * silence informative: a stack still leaks a footstep or a timing long before a
 * save does. `[calibrate]`
 */
export const SILENCE_TAU = Object.freeze({ saving: 75, stacking: 30, hiding: 55 });

/** Base rates before the econ read weighs in. `[calibrate]` */
export const SILENCE_BASE = Object.freeze({ saving: 0.2, stacking: 0.3, hiding: 0.1 });
/** Share of the non-eco mass that reads as deliberate deception. `[calibrate]` */
export const HIDING_SHARE = 0.25;
/** Eco mass assumed when no econ posterior is supplied. `[calibrate]` */
export const SILENCE_ECO_DEFAULT = 0.2;
/** Each grenade they have thrown is a point against a save. `[calibrate]` */
export const SAVING_UTIL_DECAY = 0.35;
/** Ground conceded is a stack's and a save's signature, not a hider's. `[calibrate]` */
export const CONCEDE_GAIN = 0.8;

/**
 * A side that shows nothing for forty seconds is saving, stacking, or
 * deliberately hiding. Three hypotheses, not one default.
 *
 * The likelihood is the survival function of "time until they reveal
 * themselves" under each hypothesis, so at zero seconds the posterior IS the
 * prior and every second after that is evidence. That is the whole content of
 * "absence of evidence is evidence": nothing happening is an observation with a
 * likelihood, and the three hypotheses explain it at different rates.
 *
 * @param {object} args
 * @param {number} args.seconds        silence since the last percept from them
 * @param {Array<object>} [args.loadout]  a `loadoutPosterior`, for the prior
 * @param {number} [args.utilitySpent] grenades of theirs already accounted for
 * @param {number} [args.spaceConceded] 0..1 of the contested ground they left
 * @returns {{saving: number, stacking: number, hiding: number, prior: object, seconds: number, moved: number}}
 */
export function silencePosterior({
  seconds = 0,
  loadout = null,
  utilitySpent = 0,
  spaceConceded = 0
} = {}) {
  const eco = loadout ? massOf(loadout, ['eco', 'pistol']) : SILENCE_ECO_DEFAULT;
  const rest = 1 - eco;
  const rawPrior = {
    saving: SILENCE_BASE.saving + eco,
    stacking: SILENCE_BASE.stacking + rest * (1 - HIDING_SHARE),
    hiding: SILENCE_BASE.hiding + rest * HIDING_SHARE
  };
  const prior = normalizeThree(rawPrior);

  const t = Math.max(0, seconds);
  const concede = 1 + CONCEDE_GAIN * clamp01(spaceConceded);
  const weights = {
    saving: prior.saving * Math.exp(-t / SILENCE_TAU.saving) * SAVING_UTIL_DECAY ** Math.max(0, utilitySpent) * concede,
    stacking: prior.stacking * Math.exp(-t / SILENCE_TAU.stacking) * concede,
    hiding: prior.hiding * Math.exp(-t / SILENCE_TAU.hiding)
  };
  const post = normalizeThree(weights);

  let moved = 0;
  for (const h of SILENCE_HYPOTHESES) moved += Math.abs(post[h] - prior[h]);
  return { ...post, prior, seconds: t, moved: moved / 2 };
}

function normalizeThree(weights) {
  let total = 0;
  for (const h of SILENCE_HYPOTHESES) total += weights[h];
  if (!(total > 0)) return { saving: 1 / 3, stacking: 1 / 3, hiding: 1 / 3 };
  return {
    saving: weights.saving / total,
    stacking: weights.stacking / total,
    hiding: weights.hiding / total
  };
}

// ---------------------------------------------------------------------------
// The posture the belief should expect: 6.7's logic, run on them
// ---------------------------------------------------------------------------

/** Equipment gap, in dollars per player, that reads as fully priced out. `[calibrate]` */
export const EQUIP_GAP_FULL = 2500;
/** Body gap that reads the same way: down two is already not a fair fight. `[calibrate]` */
export const BODY_GAP_FULL = 2;

/** How far each prior moves at full variance-seeking. `[calibrate all]` */
export const POSTURE_GAIN = Object.freeze({
  forward: 0.6,
  stack: 0.8,
  offAngle: 0.5,
  earlyAggression: 0.7,
  arrivalSeconds: 3
});

/**
 * The enemy's risk posture, DERIVED rather than mined.
 *
 * 6.7's second consequence says a side priced out of a fair fight correctly
 * seeks variance, because the low-variance plays all lose. Run that on the
 * OPPONENT's inferred economy and the belief should expect a disadvantaged
 * enemy further forward, more stacked, and off their default angles: gamble
 * stacks, smoke pushes, early aggression. The design already contains this
 * theory, so predicting it in the opponent costs nothing and is internally
 * consistent by construction.
 *
 * It runs both ways. A side holding the advantage plays the low-variance game,
 * so the same multipliers drop below one and the belief expects them back,
 * spread, and on their defaults.
 *
 * Returns PRIOR ADJUSTMENTS, never behaviour. Nothing here says what anybody
 * does; it says what to expect before the evidence arrives, which is the only
 * thing economy is allowed to touch (19.7: economy conditions the priors).
 *
 * @param {object} args
 * @param {number} args.theirEquip  believed per-player equipment value
 * @param {number} args.ourEquip    ours, which we know exactly
 * @param {number} [args.theirAlive]
 * @param {number} [args.ourAlive]
 */
export function enemyRiskPosture({ theirEquip = null, ourEquip = null, theirAlive = 5, ourAlive = 5 } = {}) {
  const equipGap =
    Number.isFinite(theirEquip) && Number.isFinite(ourEquip)
      ? clampSigned((ourEquip - theirEquip) / EQUIP_GAP_FULL)
      : 0;
  const bodyGap = clampSigned((ourAlive - theirAlive) / BODY_GAP_FULL);
  // Either channel alone can price them out: no gun and no body are the same
  // sentence in this currency.
  const varianceSeeking = clampSigned(equipGap + bodyGap);
  const v = varianceSeeking;
  return {
    varianceSeeking,
    equipGap,
    bodyGap,
    /** Multiplier on mass at anchors further up the map. */
    forward: 1 + POSTURE_GAIN.forward * v,
    /** Multiplier on layouts that concentrate bodies in one zone. */
    stack: 1 + POSTURE_GAIN.stack * v,
    /** Multiplier on mass off their default angles and depths. */
    offAngle: 1 + POSTURE_GAIN.offAngle * v,
    /** Multiplier on the flow prior's early-contact mass. */
    earlyAggression: 1 + POSTURE_GAIN.earlyAggression * v,
    /** Seconds EARLIER to expect them at contested ground. */
    arrivalBias: POSTURE_GAIN.arrivalSeconds * v
  };
}

/**
 * Fold a posture into a per-anchor prior, so `new JointBelief({ prior })` can
 * consume it directly.
 *
 * `tag(anchor)` is the caller's map knowledge: `forward` in 0..1 for how far up
 * the map an anchor sits, `offDefault` for anchors that are not where that side
 * normally stands. `stack` and `earlyAggression` are deliberately not applied
 * here, because a per-anchor weight cannot express a layout-level property;
 * they belong to the layout sampler and the flow prior.
 */
export function posturePrior({ prior, posture, tag }) {
  return (anchor) => {
    const t = tag(anchor) || {};
    let w = prior(anchor);
    if (t.forward) w *= posture.forward ** clamp01(t.forward);
    if (t.offDefault) w *= posture.offAngle;
    return Math.max(0, w);
  };
}

// ---------------------------------------------------------------------------

/**
 * All three laws, at one moment, through one surface. The shape mirrors
 * `readLedgers`: a block a situation key and an observation vector can both be
 * built from, where "they are out of smokes, on an eco, and quiet for forty
 * seconds" is one sentence.
 */
export function readConservation({
  belief,
  utility = null,
  economy = null,
  inZone = null,
  silenceSeconds = null,
  ourEquip = null,
  ourAlive = 5
} = {}) {
  const bodies = bodiesRead(belief, inZone);
  const reserve = utility ? utility.projectedReserve() : null;
  const loadout = economy ? economy.posterior() : null;
  const theirEquip = loadout ? expectedEquipValue(loadout) : null;
  return {
    bodies,
    reserve,
    loadout,
    theirEquip,
    pFake: reserve ? pFake({ reserveHeavy: reserve.heavy, alive: bodies.alive, committed: bodies.committed ?? 0 }) : null,
    silence:
      silenceSeconds == null
        ? null
        : silencePosterior({
            seconds: silenceSeconds,
            loadout,
            utilitySpent: reserve ? reserve.spent : 0
          }),
    posture: enemyRiskPosture({ theirEquip, ourEquip, theirAlive: bodies.alive, ourAlive })
  };
}
