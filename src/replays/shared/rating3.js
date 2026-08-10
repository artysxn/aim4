// ---------------------------------------------------------------------------
// replays/shared/rating3.js
// Rating 3.0: the eco-adjusted rating, reverse engineered against HLTV's
// published numbers and fitted by scripts/rating3-train.mjs.
//
//   rating = 1 + sign(core - 1) * |core - 1| ^ pw
//   core   = c0 + wKills*Kills + wDmg*Damage + wSurv*Survival
//               + wKast*KAST + wMk*MultiKills + swing term + round-share term
//
// Every input is read off the stats index rows that already exist: `kt` gives
// each kill's attacker, victim and second, `ev` gives each player's inventory
// value that round, `e1`/`e2` the two team economies, `ok`/`od` the opening
// duel, `w` the winner and `sw` the swing. Nothing here reparses a demo.
//
// Kills, damage and deaths are weighted by how hard the duel was, through the
// published duel win-rate table: a kill on a player who was favoured is worth
// more than one on a player holding a pistol, and dying to someone you were
// favoured against costs more.
// ---------------------------------------------------------------------------

/**
 * Fitted parameters. Mean absolute error 0.043 against 90 HLTV player-map
 * ratings across 9 maps, worst row 0.090.
 *
 * The trainer runs candidates through the functions below over rows shaped
 * like the stats index, so these constants are calibrated against exactly what
 * the site feeds in. Change an input and they have to be refitted:
 *   node scripts/rating3-train.mjs --generations 70 --write
 * Check the current ones without changing them:
 *   node scripts/rating3-train.mjs --generations 0
 */
export const RATING3_PARAMS = {
  ecoA: 1.380202429717,
  ecoB: 0.11066922801524129,
  decoA: 0.7779722140602835,
  decoB: -0.08998802955196789,
  okBonus: 0.06945233984704956,
  denialBonus: 0.3057807609442562,
  tradeKillBonus: -0.3462242865151236,
  assistPts: 0.03148928600355023,
  assistedShare: 0.22488469526832194,
  odCost: -0.3057221363700997,
  ftCost: -0.2585009084303437,
  tdCost: 0.022620624181735667,
  saveCost: -0.018283159435832422,
  mk2w: 0.0519757419019565,
  mk3w: 0.38123923752308103,
  mk4w: 0.27601383659400497,
  mk5w: 1.9493795949657475,
  cw1: 0.09276615136227039,
  cwPer: 0.3903892430635157,
  clLostCost: -0.2883782808264285,
  mkEco: -0.4004710445577646,
  kastEco: -0.6069517037138922,
  killLostMult: 1.0086744653169208,
  deathWonMult: 0.6178825543036541,
  pistolKillMult: 1.042110378427679,
  etaOpp: 0.29749373794713946,
  wKills: 0.8396726067873025,
  wDmg: 0.3633375071948659,
  wSurv: 1.454306089941159,
  wKast: 0.6129788916485664,
  wMk: 0.8401818418353655,
  wSwPos: 0.039348289374662324,
  wSwNeg: 0.0215263850547059,
  c0: 0.3395913437177341,
  wOppShare: 0.23601575551144743,
  pw: 0.996966696924154
};

/**
 * Duel win rate for the T side, by [T equipment tier][CT equipment tier].
 * Tiers: 0 sniper, 1 primary rifle, 2 secondary rifle, 3 SMG or shotgun,
 * 4 upgraded pistol, 5 starter pistol. The CT side is the complement of the
 * transpose, which is why only one table is stored.
 */
export const T_WIN = [
  [49.8, 55.5, 57.8, 60.9, 66.3, 74.0],
  [39.6, 48.0, 51.1, 56.2, 61.3, 74.8],
  [34.9, 43.8, 48.4, 53.9, 59.0, 76.1],
  [33.3, 38.8, 41.9, 48.2, 55.7, 74.0],
  [30.3, 35.1, 38.4, 41.2, 48.0, 65.0],
  [22.4, 20.5, 21.7, 20.0, 26.6, 48.6]
];

/** Chance the actor wins a duel at these tiers, 0-1. */
export function duelWin(own, opp, sideT) {
  const a = own >= 0 && own <= 5 ? own : 5;
  const b = opp >= 0 && opp <= 5 ? opp : 5;
  return sideT ? T_WIN[a][b] / 100 : 1 - T_WIN[b][a] / 100;
}

/** Equipment tier from the inventory value the index already stores. */
export function ecoTier(equipValue) {
  const v = Number(equipValue);
  if (!Number.isFinite(v)) return 5;
  if (v >= 4700) return 0;
  if (v >= 3550) return 1;
  if (v >= 2700) return 2;
  if (v >= 1700) return 3;
  if (v >= 1000) return 4;
  return 5;
}

/** A death counts as traded when the killer dies inside this window. */
const TRADE_SECONDS = 5;

/** Running totals for one player over any set of rounds. */
export function emptyRating3() {
  return {
    rounds: 0,
    killPts: 0,
    dmgPts: 0,
    survPts: 0,
    kastPts: 0,
    mkPts: 0,
    wonRounds: 0,
    swingSum: 0,
    swingRounds: 0,
    // kept for the hover breakdown, not used by the formula itself
    kast: 0,
    assists: 0,
    denials: 0,
    failedTrades: 0,
    saves: 0,
    tradedDeaths: 0,
    clutchWins: 0
  };
}

/**
 * Everything about one round that does not depend on whose rating it is.
 *
 * `kt` is the kill timeline (`{t, a, v}` per kill, already in round order), so
 * trades, clutches and who died first all come from it rather than from a
 * second pass over the demo. Resolved once per round and shared by all ten
 * players, because the trade scan is quadratic in the kill count.
 *
 * @param {object} row  one stats-index round row
 * @param {Map<string, number>} teamById  player id -> team, for this demo
 */
export function rating3RoundContext(row, teamById) {
  const kills = Array.isArray(row.kt) ? row.kt : [];
  const ev = row.ev || {};

  // Enemy kills only, in round order.
  const duels = [];
  for (const k of kills) {
    if (!k.a || !k.v) continue;
    const at = teamById.get(k.a);
    const vt = teamById.get(k.v);
    if (!at || !vt || at === vt) continue;
    duels.push(k);
  }

  const traded = new Set();
  const tradeKill = new Set();
  const failedTrade = new Set();
  const denials = new Map();
  for (let i = 0; i < duels.length; i++) {
    const k = duels[i];
    for (let j = i + 1; j < duels.length; j++) {
      const o = duels[j];
      const dt = (o.t || 0) - (k.t || 0);
      if (dt > TRADE_SECONDS) break;
      if (o.v === k.a && teamById.get(o.a) === teamById.get(k.v)) {
        traded.add(k.v);
        tradeKill.add(j);
      }
      // Both dead inside the window: the one who died second is the failed trade.
      if (o.v === k.a) failedTrade.add(k.a);
      if (o.a === k.a && teamById.get(o.v) === teamById.get(k.v)) {
        denials.set(k.a, (denials.get(k.a) || 0) + 1);
      }
    }
  }

  // Walk the deaths once and note, per team, who was left alone and against
  // how many. A team can only enter one clutch per round.
  const alive = new Map();
  for (const [pid, t] of teamById) {
    if (!alive.has(t)) alive.set(t, new Set());
    alive.get(t).add(pid);
  }
  /** @type {Map<number, {id: string, vs: number}>} */
  const clutchByTeam = new Map();
  for (const k of duels) {
    const vt = teamById.get(k.v);
    const set = alive.get(vt);
    if (!set || !set.has(k.v)) continue;
    set.delete(k.v);
    for (const [t, mine] of alive) {
      if (clutchByTeam.has(t) || mine.size !== 1) continue;
      let foes = 0;
      for (const [t2, other] of alive) if (t2 !== t) foes += other.size;
      if (foes >= 1) clutchByTeam.set(t, { id: [...mine][0], vs: foes });
    }
  }

  // Each side's average inventory value, for the eco scaling.
  const evSum = new Map();
  const evN = new Map();
  for (const [pid, t] of teamById) {
    const v = Number(ev[pid]);
    if (!Number.isFinite(v)) continue;
    evSum.set(t, (evSum.get(t) || 0) + v);
    evN.set(t, (evN.get(t) || 0) + 1);
  }

  const victims = new Set(duels.map((k) => k.v));

  return {
    row,
    teamById,
    duels,
    traded,
    tradeKill,
    failedTrade,
    denials,
    clutchByTeam,
    victims,
    evSum,
    evN,
    tierOf: (pid) => ecoTier(ev[pid]),
    // Pistol rounds: both sides on the opening buy.
    pistol: row.n === 1 || (row.e1 === 0 && row.e2 === 0)
  };
}

/**
 * One player's slice of a round context.
 * @param {object} ctx   from rating3RoundContext()
 * @param {string} id    the subject's player id
 * @param {number} team  1 or 2
 */
export function rating3RoundFacts(ctx, id, team) {
  const { row, duels, tradeKill, tierOf } = ctx;
  const line = row.p?.[id] || [];
  const side = team === 1 ? row.s1 : row.s2;
  const sideT = side === 'T';
  const won = row.w === team;

  const myTier = tierOf(id);
  const myKills = [];
  for (let i = 0; i < duels.length; i++) {
    const k = duels[i];
    if (k.a !== id) continue;
    myKills.push({
      own: myTier,
      opp: tierOf(k.v),
      sideT,
      opening: row.ok === id && row.od === k.v,
      trade: tradeKill.has(i)
    });
  }

  let deathDuel = null;
  for (const k of duels) {
    if (k.v !== id) continue;
    deathDuel = { own: myTier, opp: tierOf(k.a), sideT };
    break;
  }

  let oppSum = 0;
  let oppN = 0;
  for (const [t, sum] of ctx.evSum) {
    if (t === team) continue;
    oppSum += sum;
    oppN += ctx.evN.get(t) || 0;
  }
  const oppEvAvg = oppN ? oppSum / oppN : 2750;

  const clutch = ctx.clutchByTeam.get(team);
  const clutchVs = clutch && clutch.id === id ? clutch.vs : 0;
  const died = ctx.victims.has(id);

  return {
    won,
    died,
    survived: !died,
    kills: myKills,
    deathDuel,
    assists: Number(line[2]) || 0,
    damage: Number(line[3]) || 0,
    tradedDeath: ctx.traded.has(id),
    failedTrade: ctx.failedTrade.has(id),
    denials: ctx.denials.get(id) || 0,
    openingDeath: row.od === id,
    clutchVs,
    clutchWon: clutchVs > 0 && won,
    oppEvAvg,
    pistol: ctx.pistol,
    swing: Number.isFinite(row.sw?.[id]) ? row.sw[id] : null
  };
}

/**
 * Fold one round into a player's running totals.
 * @param {object} acc  from emptyRating3()
 * @param {object} f    from rating3RoundFacts()
 */
export function addRating3Round(acc, f, v = RATING3_PARAMS) {
  acc.rounds++;
  if (f.won) acc.wonRounds++;

  for (const k of f.kills) {
    const w = duelWin(k.own, k.opp, k.sideT);
    let pts = v.ecoA * (1 - w) + v.ecoB;
    if (k.opening) pts += v.okBonus;
    if (k.trade) pts += v.tradeKillBonus;
    if (!f.won) pts *= v.killLostMult;
    if (f.pistol) pts *= v.pistolKillMult;
    acc.killPts += pts;
  }
  acc.killPts += f.denials * v.denialBonus;
  acc.killPts += f.assists * v.assistPts;
  acc.assists += f.assists;
  acc.denials += f.denials;

  // Damage is weighted by the tier it was dealt into, approximated by the
  // opposing side's average inventory that round.
  const dmgTier = ecoTier(f.oppEvAvg);
  acc.dmgPts += (f.damage / 100) * (v.ecoA * (1 - duelWin(1, dmgTier, true)) + v.ecoB);

  if (f.deathDuel) {
    const w = duelWin(f.deathDuel.own, f.deathDuel.opp, f.deathDuel.sideT);
    let cost = -(v.decoA * w + v.decoB);
    if (f.openingDeath) cost += v.odCost;
    if (f.tradedDeath) cost += v.tdCost;
    if (f.won) cost *= v.deathWonMult;
    acc.survPts += cost;
  }
  if (f.failedTrade) {
    acc.survPts += v.ftCost;
    acc.failedTrades++;
  }
  if (f.survived && !f.won) {
    acc.survPts += v.saveCost;
    acc.saves++;
  }
  if (f.tradedDeath) acc.tradedDeaths++;

  const ecoScale = f.oppEvAvg / 5000 - 0.55;
  const kast3 = f.kills.length > 0 || f.assists > 0 || (f.survived && f.won) || f.tradedDeath;
  if (kast3) {
    acc.kastPts += 1 + v.kastEco * ecoScale;
    acc.kast++;
  }

  const n = f.kills.length;
  let mk = 0;
  if (n === 2) mk = v.mk2w;
  else if (n === 3) mk = v.mk3w;
  else if (n === 4) mk = v.mk4w;
  else if (n >= 5) mk = v.mk5w;
  if (f.clutchWon) {
    mk += v.cw1 + (f.clutchVs - 1) * v.cwPer;
    acc.clutchWins++;
  } else if (f.clutchVs > 0) {
    mk += v.clLostCost;
  }
  acc.mkPts += mk * (1 + v.mkEco * ecoScale);

  if (f.swing !== null) {
    acc.swingSum += f.swing;
    acc.swingRounds++;
  }
}

/**
 * Final rating plus the per-term breakdown behind it.
 *
 * `swing` overrides the accumulated average when a caller already has the
 * number it wants to use; otherwise the rounds' own swing is used.
 */
export function rating3Breakdown(acc, { swing = null } = {}, v = RATING3_PARAMS) {
  if (!acc || !acc.rounds) {
    return { value: 0, rounds: 0, terms: [], core: 0, swing: 0 };
  }
  const n = acc.rounds;
  const sw = Number.isFinite(swing)
    ? swing
    : acc.swingRounds
      ? acc.swingSum / acc.swingRounds
      : 0;
  const oppShare = 1 - acc.wonRounds / n;
  const oppFactor = 1 + v.etaOpp * (oppShare - 0.5);

  const mKills = (acc.killPts / n) * oppFactor;
  const mDmg = acc.dmgPts / n;
  const mSurv = acc.survPts / n;
  const mKast = acc.kastPts / n;
  const mMk = acc.mkPts / n;
  const swContrib = (sw > 0 ? v.wSwPos : v.wSwNeg) * sw;
  const shareContrib = v.wOppShare * (oppShare - 0.5);

  const terms = [
    { key: 'kills', label: 'Kills', input: mKills, contrib: v.wKills * mKills },
    { key: 'damage', label: 'Damage', input: mDmg, contrib: v.wDmg * mDmg },
    { key: 'survival', label: 'Survival', input: mSurv, contrib: v.wSurv * mSurv },
    { key: 'kast', label: 'KAST', input: mKast, contrib: v.wKast * mKast },
    { key: 'multikill', label: 'Multi-kills', input: mMk, contrib: v.wMk * mMk },
    { key: 'swing', label: 'Swing', input: sw, contrib: swContrib },
    { key: 'share', label: 'Rounds lost', input: oppShare * 100, contrib: shareContrib }
  ];

  const core = v.c0 + terms.reduce((a, t) => a + t.contrib, 0);
  const d = core - 1;
  const value = 1 + Math.sign(d) * Math.pow(Math.abs(d), v.pw);
  return { value, rounds: n, terms, core, offset: v.c0, swing: sw };
}

/** Rating 3.0 for an accumulator. */
export function rating3(acc, opts) {
  return rating3Breakdown(acc, opts).value;
}

/**
 * Neutral-economy rating from plain per-round counters, for the few callers
 * that aggregate windows rather than whole rounds and so have no duel context.
 * Every duel is treated as an even rifle matchup.
 */
export function rating3FromCounters({ rounds, kills, deaths, assists, damage, kast, swing = 0 }) {
  if (!rounds) return 0;
  const acc = emptyRating3();
  acc.rounds = rounds;
  acc.wonRounds = rounds / 2;
  const v = RATING3_PARAMS;
  const evenKill = v.ecoA * (1 - duelWin(1, 1, true)) + v.ecoB;
  const evenDeath = -(v.decoA * duelWin(1, 1, true) + v.decoB);
  acc.killPts = kills * evenKill + assists * v.assistPts;
  acc.dmgPts = (damage / 100) * evenKill;
  acc.survPts = deaths * evenDeath;
  acc.kastPts = kast;
  acc.mkPts = 0;
  return rating3Breakdown(acc, { swing }).value;
}
