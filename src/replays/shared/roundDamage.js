// ---------------------------------------------------------------------------
// replays/shared/roundDamage.js
// Damage actually taken off enemy health, per round.
//
// The parser reports the damage a weapon *would* have done, so an AWP headshot
// on a full-health player is logged at 440 rather than the 100 it removed.
// Summing that raw figure inflated ADR by roughly a fifth. Every consumer of a
// damage total should walk the events through here instead: each hit is capped
// at what the victim had left, and only damage onto an opponent is credited.
//
// Health is decremented for friendly fire and self damage too, even though
// neither is credited to anyone: a teammate's molotov really does reduce what
// an enemy can still take off that player.
//
// Reads `meta.events.damage`, which is written at parse time, so correcting a
// stored total is an index rebuild and never a reparse. Older packs predate the
// event stream; `null` comes back for those and the caller falls back to the
// parser's own per-round total.
// ---------------------------------------------------------------------------

/** Health every player starts a round with. */
export const FULL_HP = 100;

/**
 * @typedef {object} CappedDamage
 * @property {Array<object>} events  the round's damage events in tick order,
 *   each with a `dealt` field: health actually removed from an opponent, 0 for
 *   friendly fire and self damage
 * @property {Map<string, number>} byPlayer  attacker id -> health removed
 */

/**
 * @param {object} meta  round meta
 * @param {Map<string, number>|null} [teamById]  player id -> team. Without it
 *   nothing can be told apart as friendly, so every hit is credited.
 * @returns {CappedDamage|null} null when the round carries no damage events
 */
export function cappedDamageFromMeta(meta, teamById = null) {
  const raw = meta?.events?.damage;
  if (!Array.isArray(raw) || !raw.length) return null;

  const ordered = [...raw].sort((a, b) => (a.tick || 0) - (b.tick || 0));
  /** @type {Map<string, number>} */
  const health = new Map();
  /** @type {Map<string, number>} */
  const byPlayer = new Map();
  const events = [];

  for (const ev of ordered) {
    const amount = Number(ev.hp ?? ev.damage) || 0;
    let removed = 0;
    if (ev.victim && amount > 0) {
      const left = health.has(ev.victim) ? health.get(ev.victim) : FULL_HP;
      removed = Math.max(0, Math.min(amount, left));
      health.set(ev.victim, left - removed);
    }

    const at = teamById?.get?.(ev.attacker);
    const vt = teamById?.get?.(ev.victim);
    const friendly = Boolean(ev.attacker) && (ev.attacker === ev.victim || (at && vt && at === vt));
    const dealt = friendly ? 0 : removed;
    if (ev.attacker && dealt > 0) {
      byPlayer.set(ev.attacker, (byPlayer.get(ev.attacker) || 0) + dealt);
    }
    events.push({ ...ev, dealt });
  }

  return { events, byPlayer };
}

/**
 * One player's damage for a round, falling back to the parser total when the
 * round has no damage events to walk.
 *
 * @param {CappedDamage|null} capped  from cappedDamageFromMeta
 * @param {string} id
 * @param {number} fallback  the parser's own `stats[id].damage`
 */
export function playerRoundDamage(capped, id, fallback) {
  if (!capped) return Math.round(Number(fallback) || 0);
  return Math.round(capped.byPlayer.get(id) || 0);
}
