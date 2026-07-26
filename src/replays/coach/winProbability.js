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
 * Percentage points of win chance per dollar of *average* equipment difference
 * (alive players only, each side capped at AVG_EQUIP_CAP).
 *
 * Scaled from the old team-total fit (~$528/pp) so a typical full-buy vs eco
 * average gap (~$3k) still reads strongly before the extreme bend.
 */
export const PP_PER_DOLLAR = 0.0075;

/** Cap on average equipment value per alive player (AWP ≈ rifle). */
export const AVG_EQUIP_CAP = 5500;

/** Side is eco'd when its average live equipment is below this. */
export const ECON_POOR_MAX = 2000;
/** Side is fully stacked when its average live equipment is above this. */
export const ECON_STACKED_MIN = 5000;
/** Dollar gap that should land near a 95/5 economy split (full buy vs eco). */
const ECON_EXTREME_GAP = ECON_STACKED_MIN - ECON_POOR_MAX;
/** Max |pp| the economy term alone may contribute (50 ± this → 5% / 95%). */
const ECON_SAT_PP = 45;
/** Boost stays off until gaps pass this, so mid buys keep the linear fit. */
const ECON_BOOST_FROM = 1200;

/**
 * Man advantage, as the win rate it produces from an even start. +1 body is
 * worth 22.5 points, and each further body is worth less than the last.
 * Indexed by whole-body gap; fractional gaps interpolate between rungs.
 */
const ADVANTAGE_WINRATE = [50, 72.5, 87, 96, 99];

/**
 * Equal numbers still favour T as the count drops: fewer bodies means fewer
 * angles the defence can hold at once. Percentage points, added to T.
 */
const EVEN_T_BONUS = { 5: 0, 4: 2, 3: 5, 2: 7, 1: 11 };

/**
 * An alive player counts as `hp/100` of a body, but never less than this.
 * Stops a 5×1HP side from collapsing to ~0.05 bodies against one full-HP
 * player (they still threaten as 2.5v1). At 30 HP the floor already binds.
 */
export const HP_BODY_FLOOR = 0.5;

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
 * Fraction of a body one living player is worth from remaining HP.
 * @param {number} hp
 * @returns {number} in [HP_BODY_FLOOR, 1]
 */
export function hpBodyWeight(hp) {
  const frac = Math.min(1, Math.max(0, (Number(hp) || 0) / 100));
  return Math.max(HP_BODY_FLOOR, frac);
}

/** Interpolate the man-advantage ladder for a fractional body gap. */
function advantageWinrate(gap) {
  const g = Math.min(Math.max(0, gap), ADVANTAGE_WINRATE.length - 1);
  const i0 = Math.floor(g);
  const i1 = Math.min(i0 + 1, ADVANTAGE_WINRATE.length - 1);
  const f = g - i0;
  return ADVANTAGE_WINRATE[i0] * (1 - f) + ADVANTAGE_WINRATE[i1] * f;
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Equipment edge as a CT win% from an even start.
 * Near-even buys follow `PP_PER_DOLLAR`; from ~$4k upward an extra bend fills
 * out to ±45pp by a $12k gap so eco vs full-buy sits near 5/95.
 *
 * @param {number} dollarDiff  CT equipment − T equipment
 * @returns {number} CT win percent from economy alone
 */
export function economyWinPercent(dollarDiff) {
  const d = Number(dollarDiff) || 0;
  const abs = Math.abs(d);
  const linear = PP_PER_DOLLAR * d;
  const linearAtExtreme = PP_PER_DOLLAR * ECON_EXTREME_GAP;
  const boostRoom = ECON_SAT_PP - linearAtExtreme;
  const t = smoothstep(ECON_BOOST_FROM, ECON_EXTREME_GAP, abs);
  const boost = d === 0 ? 0 : Math.sign(d) * boostRoom * t;
  const pp = Math.max(-ECON_SAT_PP, Math.min(ECON_SAT_PP, linear + boost));
  return 50 + pp;
}

/**
 * When one side is eco (<$2k) and the other is stacked (>$14k), never give the
 * poor side more than 5% — map/man edges must not override that read.
 */
function clampEcoMismatch(ctPercent, ctEquip, tEquip) {
  const ctEq = Number(ctEquip) || 0;
  const tEq = Number(tEquip) || 0;
  if (ctEq < ECON_POOR_MAX && tEq > ECON_STACKED_MIN) return Math.min(ctPercent, 5);
  if (tEq < ECON_POOR_MAX && ctEq > ECON_STACKED_MIN) return Math.max(ctPercent, 95);
  return ctPercent;
}

/**
 * Live round win probability for the CT side.
 *
 * @param {object} state
 * @param {string} state.map            map code
 * @param {number} state.ctAlive        living headcount (wipe / even-man)
 * @param {number} state.tAlive
 * @param {number} [state.ctEff]        HP-weighted bodies (defaults to ctAlive)
 * @param {number} [state.tEff]         HP-weighted bodies (defaults to tAlive)
 * @param {number} state.ctEquip        avg $ per alive CT (capped)
 * @param {number} state.tEquip         avg $ per alive T (capped)
 * @param {'CT'|'T'|null} [state.decided] set once the round is actually over
 * @returns {{ct: number, t: number, parts: object}} percentages
 */
export function winProbability(state) {
  const ctAlive = Math.max(0, state.ctAlive | 0);
  const tAlive = Math.max(0, state.tAlive | 0);
  const ctEff = Math.max(0, Number.isFinite(state.ctEff) ? state.ctEff : ctAlive);
  const tEff = Math.max(0, Number.isFinite(state.tEff) ? state.tEff : tAlive);

  // A finished round is not a prediction. Wipe uses headcount, not HP weight.
  if (state.decided === 'CT' || (tAlive === 0 && ctAlive > 0)) return decided('CT');
  if (state.decided === 'T' || (ctAlive === 0 && tAlive > 0)) return decided('T');
  if (!ctAlive && !tAlive) return decided(null);

  const baseCt = MAP_BASE_CT[state.map] ?? DEFAULT_BASE_CT;

  // 1. Map base, plus the T lean when the same number of players are standing.
  //    (Angles to hold scale with headcount; HP is handled in the man term.)
  const even = Math.min(ctAlive, tAlive);
  const tBonus = ctAlive === tAlive ? EVEN_T_BONUS[even] ?? 0 : 0;
  const mapEdge = edge(baseCt - tBonus);

  // 2. Average equipment still alive (per player), not team totals.
  const dollars = (state.ctEquip || 0) - (state.tEquip || 0);
  const econPct = economyWinPercent(dollars);
  const econEdge = edge(econPct);

  // 3. Bodies — HP-weighted. 5v5 with one CT on 20 HP is ~4.2v5; five players
  //    on 1 HP still count as 2.5 bodies thanks to HP_BODY_FLOOR.
  const gap = Math.abs(ctEff - tEff);
  const manEdge =
    gap < 1e-6 ? 0 : edge(advantageWinrate(gap)) * Math.sign(ctEff - tEff);

  let ct = sigmoid(mapEdge + econEdge + manEdge) * 100;
  ct = clampEcoMismatch(ct, state.ctEquip, state.tEquip);
  const clamped = Math.min(CEIL, Math.max(FLOOR, ct));
  return {
    ct: clamped,
    t: 100 - clamped,
    parts: { mapEdge, econEdge, manEdge, dollars, econPct, tBonus, ctEff, tEff }
  };
}

function decided(side) {
  const ct = side === 'CT' ? 100 : side === 'T' ? 0 : 50;
  return { ct, t: 100 - ct, parts: { decided: side } };
}

/**
 * Human-readable tip lines for a series sample (hover on the win graph).
 * @param {object} sample  series point ({ ct, t, ctAlive, tAlive, ctEquip, tEquip, parts })
 * @param {string} [map]   map code
 * @returns {{ summary: string, detail: string[] }}
 */
export function explainProbability(sample, map = '') {
  if (!sample) return { summary: '', detail: [] };
  const summary = `T ${Math.round(sample.t)}%  ·  CT ${Math.round(sample.ct)}%`;
  const detail = [];
  if (sample.parts?.decided) {
    detail.push(`Round decided (${sample.parts.decided})`);
    return { summary, detail };
  }
  const ctEff = sample.ctEff ?? sample.parts?.ctEff;
  const tEff = sample.tEff ?? sample.parts?.tEff;
  const fmtEff = (n) => (Number.isFinite(n) ? n.toFixed(1) : '?');
  detail.push(
    `Alive  ${sample.ctAlive ?? '?'} CT (${fmtEff(ctEff)})  /  ${sample.tAlive ?? '?'} T (${fmtEff(tEff)})`
  );
  const ctEq = Number.isFinite(sample.ctEquip) ? Math.round(sample.ctEquip) : null;
  const tEq = Number.isFinite(sample.tEquip) ? Math.round(sample.tEquip) : null;
  if (ctEq != null && tEq != null) {
    const delta = ctEq - tEq;
    detail.push(
      `Equip avg  CT $${ctEq.toLocaleString()}  ·  T $${tEq.toLocaleString()}  (${
        delta >= 0 ? '+' : ''
      }$${delta.toLocaleString()} CT)`
    );
  }
  const base = MAP_BASE_CT[map] ?? DEFAULT_BASE_CT;
  detail.push(`Map base  ${base}% CT`);
  const tBonus = sample.parts?.tBonus || 0;
  if (tBonus) detail.push(`Even-man T lean  +${tBonus}pp`);
  if (Number.isFinite(ctEff) && Number.isFinite(tEff)) {
    const gap = Math.abs(ctEff - tEff);
    if (gap >= 0.05) {
      const wr = advantageWinrate(gap);
      detail.push(
        `Man advantage  ${ctEff > tEff ? 'CT' : 'T'} (${gap.toFixed(1)}) → ~${wr.toFixed(1)}% from even`
      );
    }
  }
  return { summary, detail };
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
 * Players whose kill has already happened at `tick`. Tick `alive` flags in
 * demos sometimes flip back on after death; the kill log is the source of truth
 * (same workaround the radar uses).
 * @param {Array<{victim?: string, tick?: number}>} kills
 * @param {number} tick
 * @returns {Set<string>}
 */
export function deadPlayersAt(kills, tick) {
  const dead = new Set();
  for (const k of kills || []) {
    if (!k?.victim || (k.tick || 0) > tick) continue;
    dead.add(k.victim);
  }
  return dead;
}

/**
 * When the round is factually over at `tick`, which side won — else null.
 * Wipe, bomb outcome, or past round end with a known winner.
 */
export function decidedSideAt({ tick, endTick, winnerSide, ctAlive, tAlive, bomb }) {
  if (tAlive === 0 && ctAlive > 0) return 'CT';
  if (ctAlive === 0 && tAlive > 0) return 'T';
  for (const b of bomb || []) {
    if ((b.tick || 0) > tick) continue;
    if (b.type === 'defused') return 'CT';
    if (b.type === 'exploded') return 'T';
  }
  if (endTick != null && tick >= endTick && (winnerSide === 'CT' || winnerSide === 'T')) {
    return winnerSide;
  }
  return null;
}

/**
 * Average equipment value per alive player on each side at a tick.
 *
 * Per-tick inventory is deliberately not stored — it is the single most
 * expensive thing a parse can keep — so this starts from what each player
 * bought at freezetime and subtracts what has left their hands since: their
 * whole kit when they die, and the price of every grenade they have thrown.
 *
 * Returns capped averages (not team totals) so a 4v3 from one death does not
 * look like a multi-thousand economy swing, and AWP kits match rifles at the cap.
 *
 * @param {object} args
 * @param {Array} args.players      roster ({id, team})
 * @param {object} args.stats       per-player freezetime stats ({equipValue})
 * @param {Array} args.states       per-slot tick states ({alive})
 * @param {Array} args.grenades     round grenade events ({player, throwTick, type})
 * @param {number} args.tick
 * @param {{1: 'T'|'CT', 2: 'T'|'CT'}} args.teamSides
 * @param {Set<string>} [args.deadIds]  kill-log deaths at this tick
 */
export function liveEquipment({ players, stats, states, grenades, tick, teamSides, deadIds }) {
  const out = { CT: 0, T: 0, ctAlive: 0, tAlive: 0, ctEff: 0, tEff: 0 };
  const thrown = new Map();
  for (const g of grenades || []) {
    if (!g.player || Number(g.throwTick) > tick) continue;
    thrown.set(g.player, (thrown.get(g.player) || 0) + (NADE_COST[g.type] || 0));
  }

  let ctSum = 0;
  let tSum = 0;
  for (const p of players || []) {
    const side = teamSides?.[p.team];
    if (side !== 'T' && side !== 'CT') continue;
    if (deadIds?.has(p.id)) continue;
    const s = states?.[p.slot];
    if (!s?.alive) continue;
    const weight = hpBodyWeight(s.health);
    if (side === 'CT') {
      out.ctAlive++;
      out.ctEff += weight;
    } else {
      out.tAlive++;
      out.tEff += weight;
    }
    const bought = stats?.[p.id]?.equipValue || 0;
    const value = Math.max(0, bought - (thrown.get(p.id) || 0));
    if (side === 'CT') ctSum += value;
    else tSum += value;
  }
  out.CT =
    out.ctAlive > 0 ? Math.min(AVG_EQUIP_CAP, ctSum / out.ctAlive) : 0;
  out.T = out.tAlive > 0 ? Math.min(AVG_EQUIP_CAP, tSum / out.tAlive) : 0;
  return out;
}

/**
 * Live win probability for one tick (badges / playhead). Same inputs the
 * series pass uses, so playback tracks bodies and utility every frame.
 */
export function winProbabilityAtTick({ meta, states, tick }) {
  if (!meta) return null;
  const players = meta.players || [];
  const teamSides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
  const winnerSide =
    meta.winnerSide || (meta.winner === 1 ? teamSides[1] : teamSides[2]);
  const endTick = meta.endTick ?? meta.freezeEndTick ?? 0;
  const deadIds = deadPlayersAt(meta.events?.kills, tick);
  const eq = liveEquipment({
    players,
    stats: meta.stats,
    states,
    grenades: meta.events?.grenades || [],
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
    bomb: meta.events?.bomb
  });
  const wp = winProbability({
    map: meta.map,
    ctAlive: eq.ctAlive,
    tAlive: eq.tAlive,
    ctEff: eq.ctEff,
    tEff: eq.tEff,
    ctEquip: eq.CT,
    tEquip: eq.T,
    decided
  });
  return {
    tick,
    ct: wp.ct,
    t: wp.t,
    ctAlive: eq.ctAlive,
    tAlive: eq.tAlive,
    ctEff: eq.ctEff,
    tEff: eq.tEff,
    ctEquip: eq.CT,
    tEquip: eq.T,
    parts: wp.parts
  };
}
