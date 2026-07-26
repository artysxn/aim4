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

/**
 * Live round win probability for the CT side.
 *
 * @param {object} state
 * @param {string} state.map            map code
 * @param {number} state.ctAlive        living headcount (wipe / even-man)
 * @param {number} state.tAlive
 * @param {number} [state.ctEff]        HP-weighted bodies (defaults to ctAlive)
 * @param {number} [state.tEff]         HP-weighted bodies (defaults to tAlive)
 * @param {number} state.ctEquip        dollars still on the field, CT
 * @param {number} state.tEquip         dollars still on the field, T
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

  // 2. Equipment still alive on the field.
  const dollars = (state.ctEquip || 0) - (state.tEquip || 0);
  const econEdge = edge(50 + PP_PER_DOLLAR * dollars);

  // 3. Bodies — HP-weighted. 5v5 with one CT on 20 HP is ~4.2v5; five players
  //    on 1 HP still count as 2.5 bodies thanks to HP_BODY_FLOOR.
  const gap = Math.abs(ctEff - tEff);
  const manEdge =
    gap < 1e-6 ? 0 : edge(advantageWinrate(gap)) * Math.sign(ctEff - tEff);

  const ct = sigmoid(mapEdge + econEdge + manEdge) * 100;
  const clamped = Math.min(CEIL, Math.max(FLOOR, ct));
  return {
    ct: clamped,
    t: 100 - clamped,
    parts: { mapEdge, econEdge, manEdge, dollars, tBonus, ctEff, tEff }
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
      `Equip  CT $${ctEq.toLocaleString()}  ·  T $${tEq.toLocaleString()}  (${
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
 * @param {Set<string>} [args.deadIds]  kill-log deaths at this tick
 */
export function liveEquipment({ players, stats, states, grenades, tick, teamSides, deadIds }) {
  const out = { CT: 0, T: 0, ctAlive: 0, tAlive: 0, ctEff: 0, tEff: 0 };
  const thrown = new Map();
  for (const g of grenades || []) {
    if (!g.player || Number(g.throwTick) > tick) continue;
    thrown.set(g.player, (thrown.get(g.player) || 0) + (NADE_COST[g.type] || 0));
  }

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
    out[side] += Math.max(0, bought - (thrown.get(p.id) || 0));
  }
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
