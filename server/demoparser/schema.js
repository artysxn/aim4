// ---------------------------------------------------------------------------
// demoparser/schema.js
// The normalized demo shape. This file is the contract between whichever
// parser is plugged in and the rest of the site: nothing outside this folder
// may import a parser package directly, and nothing outside this folder knows
// what "@laihoe/demoparser2" is. Swapping parsers means writing one new
// adapter that returns this shape (see README.md).
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/**
 * @typedef {object} NormalizedPlayer
 * @property {string} id        3-char short id used in round names
 * @property {string} name      display name at parse time
 * @property {string} steamId   steamid64, or '' when the demo has none
 * @property {1|2}    team      which side of the round name they belong to
 * @property {number} slot      0-9, the record slot in the tick buffer
 */

/**
 * @typedef {object} NormalizedRound
 * @property {number} round             1-99, order in the match
 * @property {1|2} winner
 * @property {'T'|'CT'} winnerSide      side that won (from round_end + team_num)
 * @property {'T'|'CT'} team1Side       side roster team 1 played this round
 * @property {'T'|'CT'} team2Side       side roster team 2 played this round
 * @property {number} econ1             0-5 economy bucket, team 1
 * @property {number} econ2             0-5 economy bucket, team 2
 * @property {number} startTick         first tick of freezetime
 * @property {number} freezeEndTick     tick the round goes live
 * @property {number|null} plantTick    tick the bomb was planted
 * @property {number} endTick           tick the winner was decided
 * @property {number} officialEndTick   tick the next freezetime begins
 * @property {NormalizedPlayer[]} players  exactly 10, ordered by slot
 * @property {string[]} weapons         dictionary; tick records store indices
 * @property {ArrayBuffer} ticks        tickFormat buffer, stride 1
 * @property {RoundEvents} events
 * @property {Record<string, PlayerRoundStats>} stats  keyed by player id
 */

/**
 * @typedef {object} RoundEvents
 * @property {KillEvent[]} kills
 * @property {ShotEvent[]} shots        every shot fired, by every player
 * @property {GrenadeEvent[]} grenades  throw + detonation, with trajectory
 * @property {BombEvent[]} bomb
 * @property {DamageEvent[]} [damage]   player_hurt hits (coach / attribution)
 */

/**
 * @typedef {object} DamageEvent
 * @property {number} tick
 * @property {string} attacker  player id ('' for world / self omitted at parse)
 * @property {string} victim    player id
 * @property {number} hp        health damage dealt
 * @property {string} [weapon]
 */

/**
 * @typedef {object} KillEvent
 * @property {number} tick
 * @property {string} attacker   player id ('' for world)
 * @property {string} victim     player id
 * @property {string} assister   player id or ''
 * @property {string} weapon
 * @property {boolean} headshot
 * @property {boolean} noscope
 * @property {boolean} throughSmoke
 * @property {boolean} penetrated
 * @property {boolean} attackerBlind
 */

/**
 * @typedef {object} ShotEvent
 * @property {number} tick
 * @property {string} player
 * @property {string} weapon
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} yaw
 * @property {number} pitch
 */

/**
 * @typedef {object} GrenadeEvent
 * @property {string} type       flashbang | smokegrenade | hegrenade | molotov | incgrenade | decoy
 * @property {string} player     thrower
 * @property {number} throwTick
 * @property {number|null} detonateTick
 * @property {{x:number,y:number,z:number}|null} from   throw origin
 * @property {{x:number,y:number,z:number}|null} at     landing / detonation point
 * @property {Array<{tick:number,x:number,y:number,z:number}>} path  flight trajectory
 */

/**
 * @typedef {object} BombEvent
 * @property {'planted'|'defused'|'exploded'|'dropped'|'pickup'} type
 * @property {number} tick
 * @property {string} player
 * @property {string} site       'A' | 'B' | ''
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z]
 */

/**
 * @typedef {object} PlayerRoundStats
 * @property {number} kills
 * @property {number} deaths
 * @property {number} assists
 * @property {number} damage
 * @property {number} shots
 * @property {number} money       cash at freezetime end
 * @property {number} equipValue  value of the loadout at freezetime end
 * @property {string[]} loadout   full inventory at freezetime end
 */

/**
 * @typedef {object} NormalizedDemo
 * @property {number} schemaVersion
 * @property {{name: string, version: string}} parser
 * @property {string} map        map code (ANC, DD2, ...)
 * @property {string} mapRaw     name as the demo spelled it
 * @property {number} tickRate
 * @property {{id: string, name: string}} team1
 * @property {{id: string, name: string}} team2
 * @property {NormalizedRound[]} rounds
 * @property {object} [source]   free-form provenance from the adapter
 */

/** Grenade types the viewer knows how to draw. */
export const GRENADE_TYPES = [
  'flashbang',
  'smokegrenade',
  'hegrenade',
  'molotov',
  'incgrenade',
  'decoy'
];

/**
 * Validate an adapter's output before it reaches storage. A parser swap that
 * quietly drops rounds or ticks should fail loudly here rather than produce a
 * library full of empty replays.
 *
 * @param {NormalizedDemo} demo
 * @returns {string[]} problems, empty when the demo is usable
 */
export function validateDemo(demo) {
  const errs = [];
  if (!demo || typeof demo !== 'object') return ['demo is not an object'];
  if (demo.schemaVersion !== SCHEMA_VERSION) {
    errs.push(`schemaVersion ${demo.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (!demo.map) errs.push('missing map code');
  if (!(demo.tickRate > 0)) errs.push('missing tickRate');
  if (!Array.isArray(demo.rounds) || demo.rounds.length === 0) {
    errs.push('no rounds parsed');
    return errs;
  }
  demo.rounds.forEach((r, i) => {
    const where = `round[${i}]`;
    if (!(r.round >= 1 && r.round <= 99)) errs.push(`${where}: round number out of range`);
    if (r.winner !== 1 && r.winner !== 2) errs.push(`${where}: winner must be 1 or 2`);
    if (!Array.isArray(r.players) || r.players.length !== 10) {
      errs.push(`${where}: expected 10 players, got ${r.players?.length ?? 0}`);
    }
    if (!(r.ticks instanceof ArrayBuffer) || r.ticks.byteLength === 0) {
      errs.push(`${where}: missing tick buffer`);
    }
    if (!r.events) errs.push(`${where}: missing events`);
  });
  return errs;
}
