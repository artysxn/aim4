// ---------------------------------------------------------------------------
// Per-phase combat counters from round events (early / mid / late windows).
// Same PLAYER_SLOTS layout as the whole-round stats index row.
// ---------------------------------------------------------------------------

import { P, PLAYER_SLOTS } from '../shared/statsMath.js';
import { phaseAtTick, phaseBounds } from '../coach/roundPhases.js';

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
    early: { p: emptyLine(), pos: '', zone: '', area: '' },
    mid: { p: emptyLine(), pos: '', zone: '', area: '' },
    late: { p: emptyLine(), pos: '', zone: '', area: '' }
  };
}

/**
 * Combat stats per player per phase from tick-stamped events.
 * @param {object} meta
 * @param {string[]} playerIds
 * @returns {Record<string, { early: object, mid: object, late: object }>}
 */
export function phaseCombatFromMeta(meta, playerIds) {
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
    const hp = Number(d.hp) || 0;
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
    if (w === 'awp') out[s.player][phase].p[P.AWP_SHOTS] += 1;
  }

  // AWP hits: damage events with awp weapon when present.
  for (const d of damage) {
    if (!d.attacker || !out[d.attacker]) continue;
    const w = String(d.weapon || '')
      .toLowerCase()
      .replace(/^weapon_/, '');
    if (w !== 'awp') continue;
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
