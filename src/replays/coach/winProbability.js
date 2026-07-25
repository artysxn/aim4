// ---------------------------------------------------------------------------
// replays/coach/winProbability.js
// Live round win probability: map, economy, and bodies.
//
// Everything composes in LOG-ODDS, not percentage points. Adding percentages
// runs off the end of the scale (a 55% map base plus a 5v2 advantage is not
// 143%), while log-odds add cleanly and can never leave 0-1. Each input below
// is therefore quoted as the win rate it produces on its own from an even
// start, and converted to a log-odds delta before anything is combined.
// ---------------------------------------------------------------------------

/**
 * CT win rate at equal equipment and 5v5, per map. Anubis is the only one of
 * the seven that is T sided (50.7% T).
 */
export const MAP_BASE_CT = {
  ANC: 52.6,
  ANU: 49.3,
  CCH: 52.9,
  DD2: 52.2,
  INF: 52.3,
  MIR: 55.3,
  NUK: 55.8
};

const DEFAULT_BASE_CT = 52.5;

/**
 * Percentage points of win chance per dollar of equipment difference.
 *
 * Least-squares fit through the origin over the four reference buys:
 *
 *   $13,600 -> +22pp    $15,800 -> +46pp
 *   $18,100 -> +24pp    $2,600  -> -1pp
 *
 *   k = Σ(xy) / Σ(x²) = 1,457,800 / 768,970,000 = 0.0018958
 *
 * One point per ~$528. The four cases do not agree under any single
 * coefficient — the +46pp case had a losing side with no armour and no
 * utility, which a dollar figure understates — so this is a compromise, and it
 * is applied through a logistic below so a lopsided buy saturates rather than
 * running past certainty.
 */
export const PP_PER_DOLLAR = 0.0018958;

/**
 * Man advantage, as the win rate it produces from an even start. +1 body is
 * worth 22.5 points, and each further body is worth less than the last.
 */
const ADVANTAGE_WINRATE = [50, 72.5, 87, 96, 99];

/**
 * Equal numbers still favour T as the count drops: fewer bodies means fewer
 * angles the defence can hold at once. Percentage points, added to T.
 */
const EVEN_T_BONUS = { 5: 0, 4: 2, 3: 5, 2: 7, 1: 11 };

/** Never show a decided round as decided until it actually is. */
const FLOOR = 1;
const CEIL = 99;

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** A win rate in percent -> its log-odds distance from even. */
const edge = (winPercent) => logit(clampP(winPercent) / 100);

function clampP(p) {
  return Math.min(99.9, Math.max(0.1, p));
}

/**
 * Live round win probability for the CT side.
 *
 * @param {object} state
 * @param {string} state.map            map code
 * @param {number} state.ctAlive
 * @param {number} state.tAlive
 * @param {number} state.ctEquip        dollars still on the field, CT
 * @param {number} state.tEquip         dollars still on the field, T
 * @param {'CT'|'T'|null} [state.decided] set once the round is actually over
 * @returns {{ct: number, t: number, parts: object}} percentages
 */
export function winProbability(state) {
  const ctAlive = Math.max(0, state.ctAlive | 0);
  const tAlive = Math.max(0, state.tAlive | 0);

  // A finished round is not a prediction.
  if (state.decided === 'CT' || (tAlive === 0 && ctAlive > 0)) return decided('CT');
  if (state.decided === 'T' || (ctAlive === 0 && tAlive > 0)) return decided('T');
  if (!ctAlive && !tAlive) return decided(null);

  const baseCt = MAP_BASE_CT[state.map] ?? DEFAULT_BASE_CT;

  // 1. Map base, plus the T lean that comes with playing fewer bodies.
  const even = Math.min(ctAlive, tAlive);
  const tBonus = ctAlive === tAlive ? EVEN_T_BONUS[even] ?? 0 : 0;
  const mapEdge = edge(baseCt - tBonus);

  // 2. Equipment still alive on the field.
  const dollars = (state.ctEquip || 0) - (state.tEquip || 0);
  const econEdge = edge(50 + PP_PER_DOLLAR * dollars);

  // 3. Bodies. The ladder is symmetric, so a 5v3 and a 3v5 are mirror images.
  const gap = Math.min(Math.abs(ctAlive - tAlive), ADVANTAGE_WINRATE.length - 1);
  const manEdge = edge(ADVANTAGE_WINRATE[gap]) * Math.sign(ctAlive - tAlive);

  const ct = sigmoid(mapEdge + econEdge + manEdge) * 100;
  const clamped = Math.min(CEIL, Math.max(FLOOR, ct));
  return {
    ct: clamped,
    t: 100 - clamped,
    parts: { mapEdge, econEdge, manEdge, dollars, tBonus }
  };
}

function decided(side) {
  const ct = side === 'CT' ? 100 : side === 'T' ? 0 : 50;
  return { ct, t: 100 - ct, parts: { decided: side } };
}

// ---------------------------------------------------------------------------
// Live equipment
// ---------------------------------------------------------------------------

/** What a grenade costs, so a thrown one can be taken back off the board. */
const NADE_COST = {
  smokegrenade: 300,
  flashbang: 200,
  hegrenade: 300,
  molotov: 400,
  incgrenade: 600,
  decoy: 50
};

/**
 * Dollars each side still has on the field at a tick.
 *
 * Per-tick inventory is deliberately not stored — it is the single most
 * expensive thing a parse can keep — so this starts from what each player
 * bought at freezetime and subtracts what has left their hands since: their
 * whole kit when they die, and the price of every grenade they have thrown.
 *
 * @param {object} args
 * @param {Array} args.players      roster ({id, team})
 * @param {object} args.stats       per-player freezetime stats ({equipValue})
 * @param {Array} args.states       per-slot tick states ({alive})
 * @param {Array} args.grenades     round grenade events ({player, throwTick, type})
 * @param {number} args.tick
 * @param {{1: 'T'|'CT', 2: 'T'|'CT'}} args.teamSides
 */
export function liveEquipment({ players, stats, states, grenades, tick, teamSides }) {
  const out = { CT: 0, T: 0, ctAlive: 0, tAlive: 0 };
  const thrown = new Map();
  for (const g of grenades || []) {
    if (!g.player || Number(g.throwTick) > tick) continue;
    thrown.set(g.player, (thrown.get(g.player) || 0) + (NADE_COST[g.type] || 0));
  }

  for (const p of players || []) {
    const side = teamSides?.[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    const s = states?.[p.slot];
    if (!s?.alive) continue;
    if (side === 'CT') out.ctAlive++;
    else out.tAlive++;
    const bought = stats?.[p.id]?.equipValue || 0;
    out[side] += Math.max(0, bought - (thrown.get(p.id) || 0));
  }
  return out;
}
