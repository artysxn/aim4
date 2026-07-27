// ---------------------------------------------------------------------------
// Per-phase combat counters from round events (early / mid / late windows).
// Same PLAYER_SLOTS layout as the whole-round stats index row.
// ---------------------------------------------------------------------------

import { P, PLAYER_SLOTS } from '../shared/statsMath.js';
import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';
import { eligibleAwpShotTicks } from '../shared/awpAccuracy.js';

const PHASES = /** @type {const} */ (['early', 'mid', 'late']);

const NOT_A_GUN =
  /grenade|molotov|incgrenade|firebomb|inferno|decoy|flash|knife|bayonet|karambit|c4|world|taser|zeus/i;

const isGun = (weapon) => {
  const w = String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
  return Boolean(w) && !NOT_A_GUN.test(w);
};

const TRADE_SECONDS = 5;

function emptyLine() {
  return new Array(PLAYER_SLOTS).fill(0);
}

function emptyPhaseBag() {
  return {
    early: { p: emptyLine() },
    mid: { p: emptyLine() },
    late: { p: emptyLine() }
  };
}

/**
 * Combat stats per player per phase from tick-stamped events.
 * When `tickBuffer` is provided, AWP shots/hits are filtered to holds within
 * 10° of an enemy with a clear (no smoke) path.
 * @param {object} meta
 * @param {string[]} playerIds
 * @param {ArrayBuffer|Buffer|DataView|null} [tickBuffer]
 * @returns {Record<string, { early: object, mid: object, late: object }>}
 */
export function phaseCombatFromMeta(meta, playerIds, tickBuffer = null) {
  /** @type {Record<string, ReturnType<typeof emptyPhaseBag>>} */
  const out = {};
  for (const id of playerIds) out[id] = emptyPhaseBag();
  if (!meta || !playerIds.length) return out;

  const bounds = phaseBounds(meta);
  const tickRate = meta.tickRate || 64;
  const tradeWindow = TRADE_SECONDS * tickRate;

  const kills = [...(meta.events?.kills || [])].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  const damage = meta.events?.damage || [];
  const shots = meta.events?.shots || [];
  const eligibleAwp = tickBuffer ? eligibleAwpShotTicks(meta, tickBuffer) : null;

  /** @type {Map<string, Set<string>>} phase → player ids with a kill */
  const killedIn = { early: new Set(), mid: new Set(), late: new Set() };
  /** @type {Map<string, Set<string>>} phase → player ids with an assist */
  const assistedIn = { early: new Set(), mid: new Set(), late: new Set() };
  /** @type {Map<string, Set<string>>} phase → player ids who died */
  const diedIn = { early: new Set(), mid: new Set(), late: new Set() };
  /** @type {Map<string, Set<string>>} phase → traded victims */
  const tradedIn = { early: new Set(), mid: new Set(), late: new Set() };

  for (const k of kills) {
    const tick = k.tick || 0;
    const phase = phaseAtTick(tick, bounds);
    const bag = out[k.attacker];
    if (bag && k.attacker) {
      bag[phase].p[P.KILLS] += 1;
      killedIn[phase].add(k.attacker);
      if (k.headshot) bag[phase].p[P.HEADSHOTS] += 1;
    }
    if (k.victim && out[k.victim]) {
      out[k.victim][phase].p[P.DEATHS] += 1;
      diedIn[phase].add(k.victim);
    }
    if (k.assister && out[k.assister]) {
      out[k.assister][phase].p[P.ASSISTS] += 1;
      assistedIn[phase].add(k.assister);
    }
  }

  // Trades: killer dies soon after — credit the original victim's phase.
  for (const k of kills) {
    if (!k.attacker || !k.victim) continue;
    const avenged = kills.some(
      (other) =>
        other.victim === k.attacker &&
        other.tick > k.tick &&
        other.tick - k.tick <= tradeWindow
    );
    if (!avenged) continue;
    const phase = phaseAtTick(k.tick || 0, bounds);
    tradedIn[phase].add(k.victim);
  }

  for (const d of damage) {
    if (!d.attacker || !out[d.attacker]) continue;
    const phase = phaseAtTick(d.tick || 0, bounds);
    const hp = Number(d.hp ?? d.damage) || 0;
    if (hp > 0) out[d.attacker][phase].p[P.DAMAGE] += Math.round(hp);
    out[d.attacker][phase].p[P.HITS] += 1;
  }

  for (const s of shots) {
    if (!s.player || !out[s.player] || !isGun(s.weapon)) continue;
    const phase = phaseAtTick(s.tick || 0, bounds);
    out[s.player][phase].p[P.SHOTS] += 1;
    const w = String(s.weapon || '')
      .toLowerCase()
      .replace(/^weapon_/, '');
    if (w === 'awp') {
      if (eligibleAwp && !eligibleAwp.get(s.player)?.has(s.tick)) continue;
      out[s.player][phase].p[P.AWP_SHOTS] += 1;
    }
  }

  // AWP hits: damage events with awp weapon when present.
  for (const d of damage) {
    if (!d.attacker || !out[d.attacker]) continue;
    const w = String(d.weapon || '')
      .toLowerCase()
      .replace(/^weapon_/, '');
    if (w !== 'awp') continue;
    if (eligibleAwp && !eligibleAwp.get(d.attacker)?.has(d.tick)) continue;
    const phase = phaseAtTick(d.tick || 0, bounds);
    out[d.attacker][phase].p[P.AWP_HITS] += 1;
  }

  /** First death tick per player (if any). */
  const deathTickOf = new Map();
  for (const k of kills) {
    if (!k.victim || deathTickOf.has(k.victim)) continue;
    deathTickOf.set(k.victim, k.tick || 0);
  }

  const phaseStartOf = {
    early: bounds.freezeEndTick,
    mid: bounds.midStartTick,
    late: bounds.lateStartTick
  };

  /**
   * Split a round total across phases by combat weight.
   * @param {ReturnType<typeof emptyPhaseBag>} bag
   * @param {Record<string, number>} weights
   * @param {number} weightSum
   * @param {number} total
   * @param {number} slot  P.* index
   */
  const distribute = (bag, weights, weightSum, total, slot) => {
    const n = Math.round(Number(total) || 0);
    if (n <= 0) return;
    if (weightSum <= 0) {
      bag.early.p[slot] = (bag.early.p[slot] || 0) + n;
      return;
    }
    let left = n;
    for (let i = 0; i < PHASES.length; i++) {
      const phase = PHASES[i];
      const share =
        i === PHASES.length - 1 ? left : Math.round((n * weights[phase]) / weightSum);
      bag[phase].p[slot] = (bag[phase].p[slot] || 0) + Math.max(0, share);
      left -= share;
    }
  };

  // Older packs often lack events.damage — pull damage / hits from round stats
  // and split across phases by activity (kills / assists / alive in window).
  for (const id of playerIds) {
    const bag = out[id];
    if (!bag) continue;

    let eventDmg = 0;
    let eventHits = 0;
    for (const phase of PHASES) {
      eventDmg += bag[phase].p[P.DAMAGE] || 0;
      eventHits += bag[phase].p[P.HITS] || 0;
    }

    const st = meta.stats?.[id] || {};
    const deathTick = deathTickOf.get(id);
    const weights = {};
    let weightSum = 0;
    for (const phase of PHASES) {
      const start = phaseStartOf[phase];
      const aliveAtStart = deathTick == null || deathTick >= start;
      const w =
        (bag[phase].p[P.KILLS] || 0) * 3 +
        (bag[phase].p[P.ASSISTS] || 0) * 2 +
        (aliveAtStart && !diedIn[phase].has(id) ? 1 : 0);
      weights[phase] = w;
      weightSum += w;
    }

    if (eventDmg <= 0) {
      distribute(bag, weights, weightSum, st.damage, P.DAMAGE);
    }
    if (eventHits <= 0) {
      // Prefer parser hit counts; otherwise every kill / HS is still a hit.
      const killHits = PHASES.reduce((n, phase) => n + (bag[phase].p[P.KILLS] || 0), 0);
      const hsHits = PHASES.reduce((n, phase) => n + (bag[phase].p[P.HEADSHOTS] || 0), 0);
      const fallbackHits = Math.max(Number(st.hits) || 0, killHits, hsHits);
      distribute(bag, weights, weightSum, fallbackHits, P.HITS);

      // Kill-loop already stamped HEADSHOTS; only fill from stats when none.
      if (hsHits <= 0 && (st.headshots || 0) > 0) {
        distribute(bag, weights, weightSum, st.headshots, P.HEADSHOTS);
      }
      if (!eligibleAwp && (st.awpHits || 0) > 0) {
        let awpEventHits = 0;
        for (const phase of PHASES) awpEventHits += bag[phase].p[P.AWP_HITS] || 0;
        if (awpEventHits <= 0) distribute(bag, weights, weightSum, st.awpHits, P.AWP_HITS);
      }
    }

    // Consistency: a headshot or kill always counts as a hit in that window.
    for (const phase of PHASES) {
      const line = bag[phase].p;
      const minHits = Math.max(line[P.KILLS] || 0, line[P.HEADSHOTS] || 0);
      if ((line[P.HITS] || 0) < minHits) line[P.HITS] = minHits;
    }
  }

  for (const phase of PHASES) {
    const start = phaseStartOf[phase];
    for (const id of playerIds) {
      const line = out[id][phase].p;
      const deathTick = deathTickOf.get(id);
      const aliveAtStart = deathTick == null || deathTick >= start;
      const survivedWindow = aliveAtStart && !diedIn[phase].has(id);
      const kast =
        killedIn[phase].has(id) ||
        assistedIn[phase].has(id) ||
        tradedIn[phase].has(id) ||
        survivedWindow;
      line[P.KAST] = kast ? 1 : 0;
    }
  }

  return out;
}

/**
 * Attach dominant location ids onto an existing phase combat bag.
 * @param {Record<string, any>} combat
 * @param {Record<string, { early?: object, mid?: object, late?: object }>} locs
 */
export function mergePhaseLocations(combat, locs) {
  if (!combat) return combat;
  for (const [id, phases] of Object.entries(locs || {})) {
    if (!combat[id]) combat[id] = emptyPhaseBag();
    for (const phase of PHASES) {
      const loc = phases?.[phase];
      if (!loc) continue;
      combat[id][phase].pos = loc.pos || '';
      combat[id][phase].zone = loc.zone || '';
      combat[id][phase].area = loc.area || '';
    }
  }
  return combat;
}

export { PHASES, emptyPhaseBag };
