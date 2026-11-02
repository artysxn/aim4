// ---------------------------------------------------------------------------
// replays/gif/gifSetpos.js
// "Automatically append setpos": every grenade thrown in a GIF's part of the
// round, as a line for its description with the thrower's setpos in < >, so
// Bookmarks and the share page show each one as a copy link.
//
// The position is read the tick before the grenade leaves the hand. A
// grenade event's throwTick is the first tick its projectile exists, so one
// tick earlier the thrower is still standing (or crouching, or in the air) on
// the lineup with the aim that threw it.
//
// Two decimals because that is all the tick data holds: positions are stored
// in quarter units and angles in hundredths of a degree (shared/tickFormat.js).
//
// DOM-free.
// ---------------------------------------------------------------------------

import { clockAt } from '../viewer/roundClock.js';
import { normalizeNadeType } from '../strategy/utilityImport.js';

/** How each grenade reads in a line. Incendiaries and molotovs are both "Molotov". */
const WORDS = {
  smokegrenade: 'Smoke',
  flashbang: 'Flash',
  hegrenade: 'HE',
  molotov: 'Molotov',
  decoy: 'Decoy'
};

const fmt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

/** Grenades in a few words, in the order given: "Smoke, Flash, Flash". */
export const grenadeWords = (grenades) => (grenades || []).map((g) => WORDS[normalizeNadeType(g.type)] || 'Grenade').join(', ');

/** The console line that stands a player where a sample says: setpos x y z; setang pitch yaw 0 */
export function setposText(s) {
  return `setpos ${fmt(s.x)} ${fmt(s.y)} ${fmt(s.z)}; setang ${fmt(s.pitch)} ${fmt(s.yaw)} 0`;
}

/**
 * One line per grenade thrown between two ticks, in throw order:
 * "1:32 s1mple Smoke <setpos ...; setang ... 0>".
 *
 * @param {object} meta   the round's meta (events.grenades, players)
 * @param {{ sample: (slot: number, tick: number, out?: object) => object }} track
 *   the round's full tick track (every tick, not the coarse one)
 * @param {{ fromTick: number, toTick: number, timing: object, player?: string|string[] }} opts
 *   `player`: only this player's grenades, or these players'
 * @returns {string[]}
 */
export function utilitySetposLines(meta, track, { fromTick, toTick, timing, player = '' }) {
  if (!meta || !track) return [];
  const players = new Map((meta.players || []).map((p) => [String(p.id), p]));
  const lines = [];
  const only = new Set((Array.isArray(player) ? player : player ? [player] : []).map(String));
  const grenades = (meta.events?.grenades || [])
    .filter((g) => {
      const t = Number(g.throwTick);
      return Number.isFinite(t) && t >= fromTick && t <= toTick && (!only.size || only.has(String(g.player)));
    })
    .sort((a, b) => Number(a.throwTick) - Number(b.throwTick));
  for (const g of grenades) {
    const p = players.get(String(g.player));
    if (!p || !Number.isInteger(p.slot) || p.slot < 0) continue;
    const s = track.sample(p.slot, Number(g.throwTick) - 1, {});
    if (!s?.alive || !Number.isFinite(s.x) || !Number.isFinite(s.yaw)) continue;
    const type = normalizeNadeType(g.type);
    const word = WORDS[type] || 'Grenade';
    const clock = timing ? clockAt(timing, Number(g.throwTick)).label : '';
    lines.push(`${[clock, p.name, word].filter(Boolean).join(' ')} <${setposText(s)}>`);
  }
  return lines;
}

/**
 * The description with the lines under it, as many as fit in `max`. A line
 * is never cut in half: a setpos missing its last number teleports somewhere
 * else.
 *
 * @returns {{ text: string, added: number, left: number }}
 */
export function appendSetposLines(description, lines, max) {
  let text = String(description || '').trimEnd();
  let added = 0;
  for (const line of lines) {
    const next = text ? `${text}${added ? '\n' : '\n\n'}${line}` : line;
    if (next.length > max) break;
    text = next;
    added++;
  }
  return { text, added, left: lines.length - added };
}
