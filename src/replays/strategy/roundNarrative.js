// ---------------------------------------------------------------------------
// replays/strategy/roundNarrative.js
// What each body actually did, as the one line that goes in its stratbook
// column.
//
// A strategy note is a sequence, not a description: the reader is a player who
// wants to know what he does next, so the output is the round's events for one
// person in the order they happened, comma separated.
//
// Movement is read at two different layers on purpose, because the two
// questions a strat asks about ground are not the same question:
//
//   Go Mid on flash from ropz        arriving is a ZONE. After the opening
//                                    ten seconds a stay also names the last
//                                    POSITION he left: "Go Underground to
//                                    Lower Mid". In the first ten seconds a
//                                    nade in the air is just "Go T A".
//   Stay Chair until 1:21            holding is a POSITION. The whole value of
//                                    the line is which exact spot he is on.
//
// What counts as an event, and nothing else does:
//
//   throws            every grenade, named and timed, wrapped in the link tags
//                     that make it clickable
//   go                arriving in a new zone. Behind a teammate's grenade
//                     after 10s: "Go A Site on smoke from ropz". In the first
//                     10s the nade is omitted. A stay after 10s also writes
//                     the last position before that zone: "Go Underground
//                     to Lower Mid"
//   stay              five seconds or more on one position with a GUN in hand.
//                     Two of those in a row collapse: the second is "then
//                     search", not another until-clock
//                     Five seconds holding a smoke is not holding an angle, it
//                     is lining up a throw, which is the next line instead
//   line up           standing somewhere with utility out and throwing it
//                     later: where he sets up, and when it leaves his hand
//   fights            the first shots he traded with the other side, named by
//                     the ground both men were on: "Fight Jungle from Top Con".
//                     That is where he took contact; the trades after it are
//                     the round going on, not the call, and are left out
//   spam              ten or more bullets into one of the other side's clouds
//   drops / pickups   utility handed between players, and to or from whom:
//                     "Drop smoke to ropz", "Get smoke from ropz"
//   smoke             walking through one of his own side's clouds. A man
//                     the other side smoked off is not doing anything
//   lurk              solo on the far site while a core of three or more
//                     walks into a key zone (T)
//   play              a body nothing above placed still gets where he spent
//                     the call: "Play B Apps". An empty column reads as a
//                     player with no job
//   search            T walking an a1–a4 / b1–b4 piece that the plant then
//                     follows. Contact if nobody threw in the last five
//                     seconds; Rush out if the next five cover 1000 PSDT
//   hold              CT in a key bombsite zone for 5s, aiming at one named
//                     spot for 4 of them: "Go short, hold B ramp". A later
//                     angle is "At 1:29, hold CT from short"
//   boost             two teammates within 25 units, then one rises 60 Z and
//                     stays there: "Get boosted Window by ropz"
//   runboost          the same hug, then 300+ u/s within a second of leaving
//                     it: "Get runboosted Mid by ropz"
//   fake              two or more nades from a 40% minority while a core
//                     of three exists (T)
//   2x / synced       two pops of the same flash from one man, or a flash
//                     and HE leaving two teammates together
//
// Two things are not moments in the round and so do not sit in the sequence at
// all: what a player bought, and whether he took the bomb out of spawn. Both
// open the line, in that order, ahead of the first thing he does.
//
// Every note opens with the name of the player it was read off, so a coach
// reading the A Lurk column knows whose round he is about to watch.
//
// Times are the clock, never a duration. A player reads "until 1:21" against
// the clock on his own screen; "for 14s" he would have to do arithmetic during
// a round to use.
//
// Where four or more grenades land from two or more players inside five
// seconds after the 1:35 mark, that is an execute, and the actions inside it
// are gathered under one "On exec, do ..." clause rather than listed loose.
//
// Attacking words are for attackers. A CT throwing his opening molotov from
// spawn is not faking, the first CT to walk onto his own site is not entering
// it, and the B anchor is not lurking: fake, lurk, first in and the execute
// clause are written for T columns only.
//
// The FIRST zone a body stands in never produces any movement event. That is
// where the round spawns, and "Stay T Spawn until 1:40" is not a strategy, it
// is the buy. Grenades thrown from spawn still count: what a player throws is
// always worth writing, where he starts never is.
//
// Utility that changes hands is written once per hand it passes through, and
// round trips are not written at all. A smoke going 1 → 2 → 1 is a player
// picking up his own smoke again; writing "drop smoke" under one column and
// "pick up smoke, drop smoke" under another describes a shuffle nobody
// performed on purpose. A smoke going 1 → 2 → 3 is a real relay and every leg
// of it is written.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { ROUND_SECONDS, timingFor } from '../viewer/roundClock.js';
import { findCore } from '../coach/cores.js';
import { pulledStringDistance } from '../roles/roleMetrics.js';
import { createNamer } from './regionNames.js';
import { normalizeNadeType, TYPE_WORDS } from './utilityImport.js';
import { isGun, normalizeLoadout } from '../viewer/equipmentIcons.js';
import { SMOKE_RADIUS_UNITS } from '../viewer/utilityMarkers.js';
import { bombSitePieces, hasBombSites, pieceCenter } from '../zones/bombSites.js';
import { hasKeyZones, keyZonesFor } from '../zones/keyZones.js';
import { pointInPiece, ringSignedArea } from '../zones/zoneGeom.js';
import { mapHasStackedFloors, regionLevelForZ } from '../zones/zoneLevel.js';

/** Position samples per second. Five seconds is the shortest thing measured. */
const SAMPLE_HZ = 2;
/** Ground occupied for less than this is transit, not a position. */
const MIN_RUN_SECONDS = 1.5;
/** How far a receiver may stand from the teammate who dropped him utility. */
const HANDOVER_UNITS = 260;
/** "Remains in the same position for 5+ seconds". */
const HOLD_SECONDS = 5;
/** Opening seconds: no "on smoke from", and no "Go pos to zone" on a stay. */
const EARLY_SECONDS = 10;
/** …and it only counts as holding if the gun was out for that whole time. */
const GUN_HOLD_SECONDS = 5;
/** A grenade thrown this soon after leaving a spot was lined up on it. */
const LINEUP_TAIL_SECONDS = 2.5;
/**
 * Utility has to sit in the hand this long before the throw to be a "line up".
 *
 * Pulling a molotov and throwing it a second later is a throw, and writing
 * "Line up Con molo from Top mid, throw at 1:47" for it is four times the words
 * of "Molo Con 1:47" for none of the meaning. A line-up is a man who took the
 * spot early and held the nade waiting.
 */
const LINEUP_MIN_SETUP_SECONDS = 3;
/** Grenades leaving hands this close together are one burst, timed once. */
const BURST_SECONDS = 2;
/** Shots traded with the same opponent inside this window are one fight. */
const FIGHT_MERGE_SECONDS = 4;
/** Bullets into one cloud before it counts as spamming it. */
const SPAM_SHOTS = 10;
/** How far down a barrel a smoke still counts as the thing being shot at. */
const SPAM_RANGE_UNITS = 2200;
/** Shots fired from inside the cloud are not shots at it. */
const SPAM_MIN_STANDOFF = SMOKE_RADIUS_UNITS + 40;
/** Utility leaving the hand this early is thrown off spawn: "insta", not a clock. */
const INSTA_CLOCKS = new Set(['1:55', '1:54']);
/** The bomb belongs to whoever carried it through most of this opening window. */
const BOMB_WINDOW_SECONDS = 10;
/** Touching it for less than this is not carrying it. */
const BOMB_MIN_HOLD_SECONDS = 2;

/**
 * Where the strategy stops.
 *
 * A stratbook row is a call, and a call ends when the round turns into a fight
 * nobody scripted. These are the moments that happens: bodies in the plant
 * zone, the bomb down, or enough men dead that everyone is improvising.
 */
const CUTOFF_ENTRIES = 2;
/** Grace after the second body arrives, so the line covers the entry itself. */
const CUTOFF_ENTRY_GRACE_SECONDS = 2;
/**
 * Utility thrown this soon after the site entry ended the call is still the
 * hit: the smoke a man puts up as he lands on the site (robo's temple smoke
 * on the Nemiga Anubis pistol left his hand a fraction past the grace and was
 * missing from his line).
 */
const ENTRY_UTILITY_SECONDS = 5;
/**
 * A side down to this many is improvising. One early trade is not: teams play
 * the call on four or three a side. Stopping at 4v4 or at three alive (the old
 * rule) ended the line 13 to 16 seconds in on an opening pick and trade, and
 * left whole columns blank: 15 of 600 in 60 library rounds, 22 Oct.
 */
const CUTOFF_ALIVE = 2;
/** Men entering the site inside this window are one group. */
const ENTRY_GROUP_SECONDS = 8;
/** A group this size has a first man worth naming. */
const ENTRY_GROUP_MIN = 3;
/** How far back from his entry the action that took him in may sit. */
const FIRST_IN_LOOKBACK_SECONDS = 6;
/** Approach key zone → plant on that letter, for Search / Contact / Rush out. */
const SEARCH_PLANT_SECONDS = 20;
/** No teammate throw inside this window turns Search into Contact. */
const CONTACT_UTIL_SECONDS = 5;
/** PSDT over this window at the Search threshold is a Rush out. */
const RUSH_SECONDS = 5;
const RUSH_PSDT = 1000;
/** Fake: core this size, thrower in a group this share of the living side or less. */
const FAKE_CORE = 3;
const FAKE_MINORITY = 0.4;
const FAKE_NADES = 2;
/** Same flash, same man: origins this close, landings this close → "2x". */
const DOUBLE_FLASH_ORIGIN = 50;
const DOUBLE_FLASH_LANDING = 100;
/** Flash / HE pair: landings, throwers, and throw clocks this close → synced. */
const SYNC_LANDING = 500;
const SYNC_THROWERS = 500;
const SYNC_SECONDS = 0.5;
/** HE detonating inside a smoke, or this far past its edge. */
const NADE_IN_SMOKE_PAD = 25;
/** CT Hold: 4 of the last 5 seconds must look at the same named spot. */
const HOLD_AIM_SECONDS = 4;
/** Teammates this close are stacked for a boost or a runboost. */
const BOOST_NEAR = 25;
/** Z gain that turns a stack into a boost, and how long it must stick. */
const BOOST_LIFT = 60;
const BOOST_STAY_SECONDS = 1.5;
/** Horizontal speed after leaving the stack that counts as a runboost. */
const RUNBOOST_SPEED = 300;
const RUNBOOST_MAX = 600;
const RUNBOOST_AFTER_SECONDS = 1;
const RUNBOOST_DEST_SECONDS = 2;
/** Look-trace for "holding" a named spot. */
const AIM_STEP = 32;
const AIM_RANGE = 3600;

/**
 * An execute: this many grenades, from this many players, inside this window,
 * and not before the clock reads 1:35.
 */
const EXEC_NADES = 4;
const EXEC_PLAYERS = 2;
const EXEC_WINDOW_SECONDS = 5;
const EXEC_AFTER_CLOCK = '1:35';
/** How long after the last grenade of an execute an action still belongs to it. */
const EXEC_TAIL_SECONDS = 6;
/** A smoke is up this long after it pops. */
const SMOKE_SECONDS = 18;
/** Shortest time inside a smoke worth writing. */
const MIN_SMOKE_SECONDS = 1.5;
/** A throw and its item_remove land on the same moment, give or take. */
const THROW_MATCH_SECONDS = 0.75;
/** How long a dropped grenade may lie on the floor and still count as handed over. */
const HANDOVER_SECONDS = 15;
/** Everything a dying player was carrying hits the floor; that is not a drop. */
const DEATH_DROP_SECONDS = 1;
/** Grace either side of a grenade's flight, for "entered while it was in the air". */
const FLIGHT_LEAD_SECONDS = 0.5;
const FLIGHT_TAIL_SECONDS = 1.5;

/** Stratbook roleNotes are capped by the server; leave the trim to us. */
const NOTE_MAX = 800;

/**
 * The buy as the coach's stratbook writes it (tools/eye/gold/stratbook-notes.json):
 * K for kevlar, then one letter per grenade, repeated for a second one (SFF is
 * a smoke and two flashes, which the old one-letter-per-kind line wrote as SF),
 * dualies as D among them, and the rest joined on with a plus: SF+P250, DF+HE.
 */
const BUY_LETTERS = [
  ['smokegrenade', 'S'],
  ['molotov', 'M'],
  ['incgrenade', 'M'],
  ['elite', 'D'],
  ['flashbang', 'F']
];
const BUY_EXTRAS = [
  ['hegrenade', 'HE'],
  ['p250', 'P250'],
  ['tec9', 'Tec9']
];

/** Economies whose notes open with what the player bought. */
const BUY_ECONOMIES = new Set(['Pistol', 'Eco', 'Force']);

/** "1:49" for a second offset into the live round. */
export function clockAt(seconds) {
  const left = Math.max(0, Math.min(ROUND_SECONDS, Math.round(ROUND_SECONDS - seconds)));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** "1:35" back to the 20 seconds into the round that it means. */
export function secondsAtClock(clock) {
  const m = /^(\d+):(\d{1,2})$/.exec(String(clock || '').trim());
  if (!m) return 0;
  return ROUND_SECONDS - (Number(m[1]) * 60 + Number(m[2]));
}

/**
 * The window an execute happened in, or null.
 *
 * Four grenades from two players inside five seconds is a co-ordinated hit
 * rather than one man using utility; before the 1:35 mark the same burst is
 * the opening default every team throws, which is not an execute either.
 *
 * @param {Array<{ player: string, sec: number }>} throws  our side's, in order
 */
export function execWindow(throws) {
  const after = secondsAtClock(EXEC_AFTER_CLOCK);
  const live = throws.filter((t) => t.sec >= after);
  for (let i = 0; i < live.length; i++) {
    const burst = live.filter(
      (t) => t.sec >= live[i].sec && t.sec <= live[i].sec + EXEC_WINDOW_SECONDS
    );
    if (burst.length < EXEC_NADES) continue;
    if (new Set(burst.map((t) => t.player)).size < EXEC_PLAYERS) continue;
    return { from: burst[0].sec, to: burst[burst.length - 1].sec + EXEC_TAIL_SECONDS };
  }
  return null;
}

const lower = (word) => String(word || '').toLowerCase();

const dist2d = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/** Flash / HE as they appear inside a "synced with …" clause. */
function syncWord(type) {
  const t = normalizeNadeType(type);
  if (t === 'hegrenade') return 'HE';
  if (t === 'flashbang') return 'flash';
  return '';
}

/** Two flashes from one man that should read as one "2x" line. */
function sameFlash(a, b) {
  if (!a?.nade || !b?.nade) return false;
  if (a.nade.type !== 'flashbang' || b.nade.type !== 'flashbang') return false;
  if (![a.nade.ox, a.nade.oy, b.nade.ox, b.nade.oy, a.nade.lx, a.nade.ly, b.nade.lx, b.nade.ly].every(Number.isFinite)) {
    return a.nade.head === b.nade.head && a.nade.id === b.nade.id;
  }
  return (
    dist2d(a.nade.ox, a.nade.oy, b.nade.ox, b.nade.oy) <= DOUBLE_FLASH_ORIGIN &&
    dist2d(a.nade.lx, a.nade.ly, b.nade.lx, b.nade.ly) <= DOUBLE_FLASH_LANDING
  );
}

/**
 * First painted position along the look direction that is not `skip`.
 * That is the angle a CT is holding: where he stands is already known.
 */
export function lookTarget(namer, x, y, z, yaw, skip = '') {
  const rad = (Number(yaw) * Math.PI) / 180;
  if (!namer || !Number.isFinite(rad) || !Number.isFinite(x) || !Number.isFinite(y)) return '';
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const skipName = skip || '';
  const zz = z || 0;
  for (let t = AIM_STEP; t <= AIM_RANGE; t += AIM_STEP) {
    const pos = namer.namesAt(x + dx * t, y + dy * t, zz).position;
    if (pos && pos !== skipName) return pos;
  }
  return '';
}

/**
 * Does the shot at (ox, oy) facing `yaw` run into the cloud at (cx, cy)?
 *
 * Flat ray against a circle, the same test the duel sight lines use for smoke.
 * Walls are not consulted: a player unloading into a cloud he cannot see
 * through is exactly the case being counted, and asking whether the bullets
 * arrived would throw away every wall-bang and every spam through the corner.
 */
function shotIntoCloud(ox, oy, yaw, cx, cy, radius, range) {
  const dx = Math.cos((yaw * Math.PI) / 180);
  const dy = Math.sin((yaw * Math.PI) / 180);
  const px = cx - ox;
  const py = cy - oy;
  const proj = px * dx + py * dy;
  if (proj <= 0 || proj > range) return false;
  const perp2 = px * px + py * py - proj * proj;
  return perp2 <= radius * radius;
}

/**
 * The moment a line reads as. Lines that print a clock are placed by THAT
 * clock, so a note counts down without ever stepping backwards; lines that
 * print no clock fall where they happened.
 */
const eventClock = (e) => (Number.isFinite(e.at) ? e.at : e.sec);

/**
 * Render the grenade lines, folding a burst into one clause.
 *
 * Utility thrown in succession is one action. Four grenades two seconds apart
 * do not need four clocks and four "from" clauses — the first says when, and
 * if they all left the same spot, one trailing "from Top mid" says where.
 * A grenade on its own keeps the fuller wording, including the "Line up …"
 * form when the player genuinely set it up early.
 *
 * @param {Array<object>} events  in reading order; grenade ones carry `.nade`
 */
function collapseNades(events) {
  const out = [];
  const render = (b, when, count) => {
    const bits = count > 1 ? [b.nade.head, '2x', when] : [b.nade.head, when];
    const label = bits.filter(Boolean).join(' ');
    const tagged = b.nade.id ? `<${label}><!${b.nade.id}>` : label;
    return b.nade.synced ? `${tagged} (${b.nade.synced})` : tagged;
  };
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.nade) {
      out.push(e);
      continue;
    }
    // How far the burst runs: each grenade within BURST_SECONDS of the last.
    let end = i;
    while (
      end + 1 < events.length &&
      events[end + 1].nade &&
      eventClock(events[end + 1]) - eventClock(events[end]) <= BURST_SECONDS
    ) {
      end += 1;
    }
    if (end === i) {
      out.push({ ...e, text: e.nade.lineup || render(e, e.nade.when, 1) });
      i = end;
      continue;
    }
    const burst = events.slice(i, end + 1);
    const spots = new Set(burst.map((b) => b.nade.from).filter(Boolean));
    const shared = spots.size === 1 && burst.every((b) => b.nade.from) ? [...spots][0] : '';
    // Two pops of the same flash from one step: "Flash over B 2x 1:49".
    const parts = [];
    for (let n = 0; n < burst.length; n++) {
      const b = burst[n];
      let same = 1;
      while (n + same < burst.length && sameFlash(b, burst[n + same])) same += 1;
      parts.push(render(b, n === 0 ? b.nade.when : '', same));
      n += same - 1;
    }
    out.push({
      ...e,
      text: shared ? `${parts.join(', ')} from ${shared}` : parts.join(', ')
    });
    i = end;
  }
  return out;
}

/**
 * One note out of one player's events, with the execute gathered up.
 *
 * Everything inside the execute window becomes a single "On exec, do ..."
 * clause in place of the loose list, because that is how the call is made: the
 * four things a player does during a hit are one instruction, not four.
 *
 * @param {Array<{ sec: number, text: string }>} events  already in time order
 * @param {{ from: number, to: number }|null} exec
 */
function joinEvents(events, exec) {
  if (!exec) return events.map((e) => e.text).join(', ');
  const before = [];
  const during = [];
  const after = [];
  for (const e of events) {
    const at = eventClock(e);
    if (at < exec.from) before.push(e.text);
    else if (at <= exec.to) during.push(e.text);
    else after.push(e.text);
  }
  if (!during.length) return events.map((e) => e.text).join(', ');
  // The clause closes with a full stop. Without it "On exec, do A, B, C, D"
  // gives the reader no way to see where the execute stopped and the rest of
  // the round started again.
  const head = before.length ? `${before.join(', ')}, ` : '';
  const tail = after.length ? ` ${after.join(', ')}` : '';
  return `${head}On exec, do ${during.join(', ')}.${tail}`;
}

/**
 * Collapse a per-sample name series into runs, dropping transit.
 *
 * `pick` selects which layer of the sample to run on: the same sample list
 * produces the zone runs that answer "where did he go" and the position runs
 * that answer "what was he sitting on".
 *
 * @param {Array<object>} samples
 * @param {number} step  seconds between samples
 * @param {(s: object) => string} pick
 */
function runsFrom(samples, step, pick) {
  const raw = [];
  for (const s of samples) {
    const name = pick(s);
    const last = raw[raw.length - 1];
    if (last && last.name === name) {
      last.to = s.sec + step;
      last.samples.push(s);
    } else raw.push({ name, from: s.sec, to: s.sec + step, samples: [s] });
  }
  // Drop flickers, then re-collapse so ground re-entered around one is one run.
  const kept = raw.filter((r) => r.name && r.to - r.from >= MIN_RUN_SECONDS);
  const runs = [];
  for (const r of kept) {
    const last = runs[runs.length - 1];
    if (last && last.name === r.name) {
      last.to = r.to;
      last.samples.push(...r.samples);
    } else runs.push({ ...r, samples: [...r.samples] });
  }
  return runs;
}

/** Shortest time somewhere before it counts as where a player played. */
const PLAY_MIN_SECONDS = 3;

/**
 * Where a player spent the call, for a column the event rules left with
 * nothing that places him: the zone he was in longest. Never the spawn, by the
 * same rule as everywhere else: a man who never left it gets no line.
 *
 * @param {Array<{ sec: number, zone: string }>} samples
 * @param {number} step  seconds between samples
 * @param {string} [spawnZone]
 * @returns {{ name: string, sec: number } | null}
 */
export function presenceOf(samples, step, spawnZone = '') {
  const time = new Map();
  const first = new Map();
  for (const s of samples) {
    if (!s.zone || s.zone === spawnZone) continue;
    time.set(s.zone, (time.get(s.zone) || 0) + step);
    if (!first.has(s.zone)) first.set(s.zone, s.sec);
  }
  let best = '';
  let most = 0;
  for (const [name, t] of time) {
    if (t > most) {
      best = name;
      most = t;
    }
  }
  return most >= PLAY_MIN_SECONDS ? { name: best, sec: first.get(best) } : null;
}

/**
 * Grenades that changed hands, with the round trips already removed.
 *
 * A CS2 demo does not say who dropped anything. `item_remove` is not emitted at
 * all in practice, and even where it is it fires for a throw as much as for a
 * drop — so the drop has to be inferred from the pickup at the other end.
 *
 * The inference is an inventory model: everyone starts with the freezetime
 * loadout, throwing spends one, and a pickup is credited to the teammate who
 * (a) still held one of that type, (b) was alive, and (c) was standing closest
 * to the pickup. Utility taken off a corpse or off the floor from nobody finds
 * no donor and is not written — a player who picks up a dead enemy's molotov
 * did not receive it from anyone.
 *
 * `item_remove` is still honoured when a parse does produce it, because a real
 * drop event beats an inferred one.
 *
 * @returns {Array<{ item: string, from: string, to: string, sec: number }>}
 */
export function utilityHandovers({
  items,
  grenades,
  loadouts,
  deadAt,
  positionAt,
  secOf,
  tickRate,
  sideIds,
  fromTick,
  toTick
}) {
  const throws = (grenades || [])
    .map((g) => ({ player: g.player, type: normalizeNadeType(g.type), tick: Number(g.throwTick) }))
    .filter((g) => g.type && Number.isFinite(g.tick));
  const slack = THROW_MATCH_SECONDS * tickRate;
  const wasThrow = (player, type, tick) =>
    throws.some((g) => g.player === player && g.type === type && Math.abs(g.tick - tick) <= slack);

  /** playerId → type → how many he is holding right now. */
  const held = new Map();
  for (const id of sideIds) {
    const bag = new Map();
    for (const item of normalizeLoadout(loadouts?.get?.(id) || [])) {
      const type = normalizeNadeType(item);
      if (TYPE_WORDS[type]) bag.set(type, (bag.get(type) || 0) + 1);
    }
    held.set(id, bag);
  }
  const take = (id, type) => {
    const bag = held.get(id);
    if (!bag) return;
    bag.set(type, Math.max(0, (bag.get(type) || 0) - 1));
  };
  const give = (id, type) => {
    const bag = held.get(id);
    if (!bag) return;
    bag.set(type, (bag.get(type) || 0) + 1);
  };
  const has = (id, type) => (held.get(id)?.get(type) || 0) > 0;
  const alive = (id, tick) => !(Number.isFinite(deadAt.get(id)) && deadAt.get(id) <= tick);

  // Everything that touches the model, in the order it happened. Only the live
  // round counts: the pickups every player logs as the next freezetime opens
  // are the game handing out knives, not a teammate dropping one.
  const steps = [];
  for (const g of throws) {
    if (!sideIds.has(g.player) || g.tick < fromTick || g.tick > toTick) continue;
    steps.push({ kind: 'throw', tick: g.tick, player: g.player, type: g.type });
  }
  /** @type {Array<{ tick: number, player: string, type: string }>} */
  const explicitDrops = [];
  for (const e of items || []) {
    const type = normalizeNadeType(e.item);
    if (!TYPE_WORDS[type] || !sideIds.has(e.player)) continue;
    if (e.tick < fromTick || e.tick > toTick) continue;
    if (e.op === 'pickup') steps.push({ kind: 'pickup', tick: e.tick, player: e.player, type });
    else if (e.op === 'remove' && !wasThrow(e.player, type, e.tick)) {
      const died = deadAt.get(e.player);
      if (Number.isFinite(died) && died - e.tick <= DEATH_DROP_SECONDS * tickRate) continue;
      explicitDrops.push({ tick: e.tick, player: e.player, type });
      steps.push({ kind: 'drop', tick: e.tick, player: e.player, type });
    }
  }
  steps.sort((a, b) => a.tick - b.tick);

  const chain = [];
  const usedDrop = new Set();
  for (const step of steps) {
    if (step.kind === 'throw' || step.kind === 'drop') {
      take(step.player, step.type);
      continue;
    }
    // A pickup. Prefer a drop this parse actually reported.
    const window = HANDOVER_SECONDS * tickRate;
    let donor = '';
    const reported = explicitDrops.find(
      (d) =>
        !usedDrop.has(d) &&
        d.type === step.type &&
        d.player !== step.player &&
        d.tick <= step.tick &&
        step.tick - d.tick <= window
    );
    if (reported) {
      usedDrop.add(reported);
      donor = reported.player;
    } else {
      const me = positionAt(step.player, step.tick);
      let bestD = Infinity;
      for (const id of sideIds) {
        if (id === step.player || !has(id, step.type) || !alive(id, step.tick)) continue;
        const them = positionAt(id, step.tick);
        const d = me && them ? (me.x - them.x) ** 2 + (me.y - them.y) ** 2 : Infinity;
        if (d < bestD) {
          bestD = d;
          donor = id;
        }
      }
      if (bestD > HANDOVER_UNITS * HANDOVER_UNITS) donor = '';
    }
    give(step.player, step.type);
    if (!donor) continue;
    take(donor, step.type);
    chain.push({ item: step.type, from: donor, to: step.player, sec: secOf(step.tick) });
  }

  chain.sort((a, b) => a.sec - b.sec);

  // A → B followed by B → A on the same item is a round trip, not a relay.
  // Removing a pair can expose another, so the sweep repeats until it is quiet.
  let dirty = true;
  let live = chain;
  while (dirty) {
    dirty = false;
    const next = [];
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      const b = live[i + 1];
      if (b && a.item === b.item && a.from === b.to && a.to === b.from) {
        i += 1;
        dirty = true;
        continue;
      }
      next.push(a);
    }
    live = next;
  }
  return live;
}

/** What CS2 charges, to work out a pistol round's freezetime drops from what each man spent. */
const PRICES = {
  smokegrenade: 300,
  flashbang: 200,
  hegrenade: 300,
  molotov: 400,
  incgrenade: 500,
  decoy: 50,
  p250: 300,
  elite: 300,
  tec9: 500,
  fiveseven: 500,
  cz75a: 500,
  deagle: 700,
  revolver: 600
};
/** The pistol everyone spawns with, worth 200 in a demo's equipment value. */
const DEFAULT_PISTOLS = new Set(['glock', 'usp_silencer', 'hkp2000']);
const PISTOL_MONEY = 800;
/** How a dropped item is named in a note. */
const ITEM_WORDS = {
  p250: 'p250',
  elite: 'dualies',
  tec9: 'tec9',
  fiveseven: 'five-seven',
  cz75a: 'cz',
  deagle: 'deagle',
  revolver: 'revolver',
  smokegrenade: 'smoke',
  flashbang: 'flash',
  hegrenade: 'nade',
  molotov: 'molo',
  incgrenade: 'molo',
  decoy: 'decoy'
};

/**
 * Who dropped what to whom in a pistol round's freezetime.
 *
 * The demo has no event for it: the buy menu and the drop both happen before
 * the round goes live. The money does say it. Everyone starts on 800, so a man
 * who spent 800 and holds 500 of gear bought 300 he gave away, and a man who
 * spent 650 and holds 950 was given 300 of it. A P250 in the second man's hands
 * that nobody else lacks is the one the first bought ("SF+P250, drop p250").
 * Only exact matches are written: a guess about who paid is worse than none.
 *
 * @param {string[]} ids   the side
 * @param {object} stats   meta.stats: money left, equipValue and loadout at freeze end
 * @returns {Array<{ from: string, to: string, item: string }>}
 */
export function pistolDrops(ids, stats) {
  const left = new Map();
  for (const id of ids) {
    const st = stats?.[id];
    if (!st || !Number.isFinite(st.money) || !Number.isFinite(st.equipValue)) continue;
    const items = normalizeLoadout(st.loadout || []);
    const bought = st.equipValue - (items.some((i) => DEFAULT_PISTOLS.has(i)) ? 200 : 0);
    left.set(id, { spare: PISTOL_MONEY - st.money - bought, items });
  }
  const drops = [];
  for (const [to, r] of left) {
    if (r.spare >= 0) continue;
    const item = r.items.find((i) => PRICES[i] === -r.spare);
    const from = item && [...left].find(([id, d]) => id !== to && d.spare === -r.spare)?.[0];
    if (!from) continue;
    left.get(from).spare = 0;
    r.spare = 0;
    drops.push({ from, to, item });
  }
  return drops;
}

/**
 * The buy line for a pistol, eco or force round: what the player owned when
 * freezetime ended.
 */
export function buyString(loadout, state) {
  const items = normalizeLoadout(loadout);
  const count = (id) => items.filter((item) => item === id).length;
  let letters = (state?.armor ?? 0) > 0 ? 'K' : '';
  for (const [item, letter] of BUY_LETTERS) letters += letter.repeat(count(item));
  const extras = BUY_EXTRAS.filter(([item]) => count(item)).map(([, word]) => word);
  return [letters, ...extras].filter(Boolean).join('+');
}

/**
 * One note per player on the side.
 *
 * @param {object} args
 * @param {object} args.meta       round meta (players, events, timing, stats)
 * @param {object} args.track      tick track for the round
 * @param {object|null} args.network
 * @param {string} args.mapCode
 * @param {'T'|'CT'} args.side
 * @param {string[]} args.playerIds  the five on that side
 * @param {Array} args.links       from foldRoundUtility — throw ids to link
 * @param {string} args.economy    the economy chosen in the Add strategy form
 * @param {number} [args.windowFrom]  seconds after freeze, inclusive
 * @param {number} [args.windowTo]    seconds after freeze, inclusive
 * @returns {Map<string, string>} playerId → note
 */
export function buildRoundNotes(args) {
  return readRoundNotes(args).notes;
}

/** A hold in the facts: this long on one position, gun out for most of it. */
const FACT_HOLD_SECONDS = 4;
/** Route steps kept per player; a man pacing between two zones is not a route. */
const FACT_ROUTE_STEPS = 14;
/** A route step this short, between two steps in one zone, is a corner clipped. */
const FACT_FLICKER_SECONDS = 3;
/**
 * Moving at this speed is walking (shift): CS2 runs at 215-250 u/s with a
 * pistol or knife and walks at about half that. Measured on the Nemiga Anubis
 * pistol: the slow shift along water to con read 100-120.
 */
const WALK_MIN = 80;
const WALK_MAX = 160;
const WALK_SECONDS = 3;

/** The value of `key` the samples spent the most time on. */
function mostSeen(samples, key) {
  const n = new Map();
  for (const s of samples) if (s[key]) n.set(s[key], (n.get(s[key]) || 0) + 1);
  let best = '';
  let most = 0;
  for (const [v, c] of n) {
    if (c > most) {
      best = v;
      most = c;
    }
  }
  return best;
}

/** A pause this long ends the leg that took him into a route step. */
const LEG_PAUSE_SECONDS = 1.5;

/**
 * When he started walking in this step: the first leg (movement between two
 * pauses) with more time at walking speed than running and at least
 * WALK_SECONDS of it, or null. Counted second by second per leg, not averaged
 * over the step: a man who ran to krimz, held it and later edged along water
 * averaged out at walking speed and was told to walk to krimz, while khaN's
 * slow shift towards con came only after his hold on m0NESY.
 *
 * @returns {number|null} seconds into the round
 */
function walked(samples, step) {
  let walking = 0;
  let running = 0;
  let still = 0;
  let legFrom = null;
  const done = () => (walking >= WALK_SECONDS && walking > running ? legFrom : null);
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].sec - samples[i - 1].sec;
    if (dt <= 0 || dt > step * 1.5) continue;
    const speed = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) / dt;
    if (speed < WALK_MIN) {
      still += dt;
      if (still >= LEG_PAUSE_SECONDS && legFrom != null) {
        const from = done();
        if (from != null) return from;
        walking = 0;
        running = 0;
        legFrom = null;
      }
      continue;
    }
    still = 0;
    if (legFrom == null) legFrom = samples[i - 1].sec;
    if (speed > WALK_MAX) running += dt;
    else walking += dt;
  }
  return legFrom == null ? null : done();
}

/**
 * The notes, and the facts they were read from.
 *
 * A writer that words the notes itself (aim4 eye, eye/eyeStrategyNotes.js) needs
 * what the rules saw, not only what they printed: the whole walk, every hold
 * and what it watched, each grenade with its archive id, where the call ended.
 * Seconds are seconds after the round went live, like everything else here.
 *
 * @param {object} args  as buildRoundNotes
 * @returns {{ notes: Map<string, string>, facts: null | {
 *   side: 'T'|'CT',
 *   window: { from: number, to: number },
 *   cutoff: null | { sec: number, why: string },
 *   exec: null | { from: number, to: number },
 *   plant: null | { sec: number, site: string, player: string },
 *   firstIn: null | { id: string, sec: number, zone: string },
 *   players: Map<string, {
 *     name: string, note: string, buy: string, handed: string[], died: number|null, bomb: boolean,
 *     route: Array<{ zone: string, from: number, to: number, position: string, walkFrom: number|null }>,
 *     holds: Array<{ position: string, from: number, to: number, aim: string }>,
 *     nades: Array<{ grenade: object, sec: number, word: string, spot: string, from: string,
 *                    throwId: string, insta: boolean, lineup: string, synced: string }>
 *   }>
 * } }}
 */
export function readRoundNotes({
  meta,
  track,
  network,
  mapCode,
  side,
  playerIds,
  links = [],
  economy = '',
  windowFrom = 0,
  windowTo = ROUND_SECONDS
}) {
  const notes = new Map();
  const ids = (playerIds || []).filter(Boolean);
  if (!meta || !track || !ids.length) return { notes, facts: null };

  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const live0 = timing.freezeEndTick;
  const rawFrom = Number(windowFrom);
  const rawTo = Number(windowTo);
  const winFrom = Math.max(0, Math.min(ROUND_SECONDS, Number.isFinite(rawFrom) ? rawFrom : 0));
  const winTo = Math.max(
    winFrom,
    Math.min(ROUND_SECONDS, Number.isFinite(rawTo) ? rawTo : ROUND_SECONDS)
  );
  const windowed = winFrom > 0.05 || winTo < ROUND_SECONDS - 0.05;
  const t0 = live0 + winFrom * rate;
  const endTick = Math.min(timing.endTick, live0 + winTo * rate);
  const secOf = (tick) => (tick - live0) / rate;
  const namer = createNamer(network, mapCode);
  const slotOf = new Map((meta.players || []).map((p) => [p.id, p.slot]));

  // Two different questions, and they are not the same set. `ids` is who gets a
  // note; `sideIds` is whose grenades and whose dropped utility count as ours.
  // A column left empty (four bodies on the side, or a seat nobody filled) must
  // not stop a teammate's flash from being the cover an entry happened behind.
  const side1 = meta.team1Side === 'CT' ? 'CT' : 'T';
  const side2 = meta.team2Side === 'CT' || meta.team2Side === 'T' ? meta.team2Side : side1 === 'CT' ? 'T' : 'CT';
  const sideIds = new Set(ids);
  for (const p of meta.players || []) {
    const theirs = p.team === 1 ? side1 : p.team === 2 ? side2 : '';
    if (theirs === side) sideIds.add(p.id);
  }

  const deadAt = new Map();
  for (const k of meta.events?.kills || []) {
    if (k.victim && !deadAt.has(k.victim)) deadAt.set(k.victim, k.tick || 0);
  }

  const allGrenades = meta.events?.grenades || [];
  const ourGrenades = allGrenades.filter((g) => {
    if (!sideIds.has(g.player)) return false;
    const tick = Number(g.throwTick);
    return Number.isFinite(tick) && tick >= t0 && tick <= endTick;
  });
  const linkOf = new Map(links.map((l) => [l.grenade, l]));
  const weaponNames = (meta.weapons || []).map((w) => String(w || ''));
  const nameOf = new Map((meta.players || []).map((p) => [p.id, p.name || '']));

  // One execute for the whole side: it is the same hit under every column, so
  // every player's note breaks at the same moment. Attackers only: four CT
  // grenades inside five seconds is a defence answering a hit, not a call.
  const exec =
    side !== 'T'
      ? null
      : execWindow(
          ourGrenades
            .filter((g) => TYPE_WORDS[normalizeNadeType(g.type)])
            .map((g) => ({ player: g.player, sec: secOf(Number(g.throwTick)) }))
            .filter((t) => Number.isFinite(t.sec))
            .sort((a, b) => a.sec - b.sec)
        );

  /**
   * Smokes that were up, for "standing in one" and for "spamming one".
   *
   * Both sides' clouds, marked by whose they are. A player walks through his
   * own side's cover on purpose; he is caught in the other side's. And the
   * smoke a player empties a magazine into is the other team's: shots out past
   * his own cloud are aimed at whoever is behind it, not at the smoke.
   */
  const smokes = allGrenades
    .filter((g) => normalizeNadeType(g.type) === 'smokegrenade')
    .map((g) => ({
      x: Number(g.at?.x),
      y: Number(g.at?.y),
      ours: sideIds.has(g.player),
      spot: namer.positionName(Number(g.at?.x), Number(g.at?.y), Number(g.at?.z) || 0),
      from: Number(g.detonateTick ?? g.throwTick),
      to: Number(g.detonateTick ?? g.throwTick) + SMOKE_SECONDS * rate
    }))
    .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.from));

  /**
   * Bullets each player put into each cloud.
   *
   * A shot is aimed at a cloud when the cloud is up, the barrel points at it,
   * and the shooter is standing outside it. Ten of those is a player holding
   * the trigger down on a smoke rather than one stray round crossing it.
   */
  const spamCounts = new Map();
  for (const shot of meta.events?.shots || []) {
    if (!sideIds.has(shot.player)) continue;
    if (shot.tick < t0 || shot.tick > endTick) continue;
    if (!isGun(shot.weapon)) continue;
    const ox = Number(shot.x);
    const oy = Number(shot.y);
    const yaw = Number(shot.yaw);
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(yaw)) continue;
    for (let i = 0; i < smokes.length; i++) {
      const sm = smokes[i];
      if (sm.ours || shot.tick < sm.from || shot.tick > sm.to) continue;
      const away = Math.hypot(sm.x - ox, sm.y - oy);
      if (away < SPAM_MIN_STANDOFF) continue;
      if (!shotIntoCloud(ox, oy, yaw, sm.x, sm.y, SMOKE_RADIUS_UNITS, SPAM_RANGE_UNITS)) continue;
      const key = `${shot.player}|${i}`;
      const hit = spamCounts.get(key);
      if (hit) hit.n += 1;
      else spamCounts.set(key, { n: 1, player: shot.player, spot: sm.spot, tick: shot.tick });
      break;
    }
  }

  /**
   * Who carried the bomb out of spawn.
   *
   * NOT the tick buffer: these demos never set FLAG_HAS_BOMB, so a note built
   * off it would silently say nobody ever had the bomb. The freezetime loadout
   * does carry "C4 Explosive", and the bomb event chain (dropped / pickup /
   * planted) says where it went from there, so the two together give a holder
   * at every moment. A bomb dropped in freezetime and picked up after the round
   * goes live never appears in any loadout at all, which is why the chain has
   * to be replayed from the start of the round rather than from `t0`.
   */
  const bombCarrier = (() => {
    let holder = '';
    for (const who of sideIds) {
      if (normalizeLoadout(meta.stats?.[who]?.loadout || []).includes('c4')) holder = who;
    }
    const chain = [...(meta.events?.bomb || [])]
      .filter((b) => b.type === 'dropped' || b.type === 'pickup' || b.type === 'planted')
      .sort((a, b) => (a.tick || 0) - (b.tick || 0));

    const until = Math.min(endTick, t0 + BOMB_WINDOW_SECONDS * rate);
    const held = new Map();
    let since = t0;
    for (const b of chain) {
      const tick = b.tick || 0;
      if (tick <= t0) {
        holder = b.type === 'pickup' ? b.player : '';
        continue;
      }
      if (tick > until) break;
      if (holder) held.set(holder, (held.get(holder) || 0) + (tick - since));
      since = tick;
      holder = b.type === 'pickup' ? b.player : '';
    }
    if (holder && since < until) held.set(holder, (held.get(holder) || 0) + (until - since));

    let best = '';
    let bestTicks = BOMB_MIN_HOLD_SECONDS * rate;
    for (const [who, ticks] of held) {
      if (sideIds.has(who) && ticks > bestTicks) {
        bestTicks = ticks;
        best = who;
      }
    }
    return best;
  })();

  /**
   * Where each side's bodies stood when shots were traded.
   *
   * A duel throws off a dozen player_hurt rows, so the exchanges are collapsed
   * per opponent: one fight, named by the ground both men were standing on when
   * it started. Positions rather than zones, because "Fight Jungle from Top
   * Con" is the useful sentence and "Fight A Site from Mid" is not.
   */
  const spotScratch = {};
  const spotOf = (who, tick) => {
    const slot = slotOf.get(who);
    if (slot == null || slot < 0) return '';
    const st = track.sample(slot, tick, spotScratch);
    if (!st || !Number.isFinite(st.x)) return '';
    const where = namer.namesAt(st.x, st.y, st.z);
    return where.position || where.zone || '';
  };

  const contacts = [];
  const addContact = (tick, attacker, victim) => {
    if (!attacker || !victim) return;
    const ours = sideIds.has(attacker) ? attacker : sideIds.has(victim) ? victim : '';
    const theirs = ours === attacker ? victim : attacker;
    if (!ours || sideIds.has(theirs)) return;
    if (tick < t0 || tick > endTick) return;
    contacts.push({ tick, ours, theirs });
  };
  for (const k of meta.events?.kills || []) addContact(k.tick || 0, k.attacker, k.victim);
  for (const d of meta.events?.damage || []) addContact(d.tick || 0, d.attacker, d.victim);
  contacts.sort((a, b) => a.tick - b.tick);

  /** One entry per exchange this player was in, in time order. */
  function fightsFor(id) {
    const out = [];
    /** opponent → tick of the last exchange already written. */
    const open = new Map();
    for (const c of contacts) {
      if (c.ours !== id) continue;
      const last = open.get(c.theirs);
      if (last != null && c.tick - last <= FIGHT_MERGE_SECONDS * rate) {
        open.set(c.theirs, c.tick);
        continue;
      }
      open.set(c.theirs, c.tick);
      const at = spotOf(c.theirs, c.tick);
      if (!at) continue;
      out.push({ sec: secOf(c.tick), at, from: spotOf(id, c.tick) });
    }
    return out;
  }

  /**
   * When the call is over.
   *
   * Whichever of these comes first: two T bodies inside the A or B key zone
   * itself (plus a two second grace, so the line covers the entry itself), the bomb
   * down, either side cut to three, or the round levelled at four apiece. Past
   * that moment the round is a fight, and a stratbook row that kept narrating
   * it would be describing an outcome rather than a plan.
   *
   * The T-entry test is about Ts whichever side this note is for: a CT column
   * stops at the same moment, because that is when its setup stopped mattering
   * too.
   */
  const tIds = new Set(
    (meta.players || [])
      .filter((p) => (p.team === 1 ? side1 : p.team === 2 ? side2 : '') === 'T')
      .map((p) => p.id)
  );

  /**
   * The A and B plant zones.
   *
   * KEY zones, not the painted zone layer and not the bombsite rectangle. Key
   * zones are the regions drawn per bombsite letter in the Sites editor, and
   * they are what "two men are on the site" means. The bombsite rectangle is
   * the fallback for a map nobody has drawn key zones for yet, so the rule
   * still fires there rather than silently never ending the call.
   *
   * Only the BIGGEST piece per letter counts. A site is drawn as up to four
   * pieces - a1, a2, a3, a4 - and those smaller ones are sub-regions of the
   * approach, not the site: one of Mirage's reaches back into T spawn, so
   * treating any of them as "on A" ended the call four seconds into the round.
   * The largest piece is the site itself, which is the zone being asked about.
   *
   * Piece lists are resolved once per floor: `keyZonesFor` re-sanitizes the
   * whole structure on every call, and this is asked ten times a second for
   * ten bodies.
   */
  const plantZones = (() => {
    const useKey = hasKeyZones(network);
    if (!useKey && !hasBombSites(network)) return { painted: false, at: () => '', keyAt: () => null };
    const stacked = mapHasStackedFloors(mapCode);
    const areaOf = (p) =>
      p?.type === 'poly' ? Math.abs(ringSignedArea(p.ring)) : Math.abs((p?.w || 0) * (p?.h || 0));
    const biggest = (list) => {
      let best = null;
      for (const piece of list || []) {
        if (!best || areaOf(piece) > areaOf(best)) best = piece;
      }
      return best ? [best] : [];
    };
    /**
     * The site's own zone, checked against the site it claims to be.
     *
     * Most maps in this library paint their key zones as the APPROACHES to a
     * site (Mirage's A is T Outside A / CT Spawn / T Palace / Jungle) with no
     * piece covering the plant at all. Taking the biggest of those as "A" puts
     * the cutoff in Jungle. So the bombsite is used as the ground truth: if
     * the letter's biggest key zone does not contain its own bombsite, that
     * paint is not a plant zone and the bombsite rectangle stands in.
     */
    const zoneFor = (site, opts, list) => {
      const bomb = bombSitePieces(network, site, opts);
      if (!useKey) return bomb;
      const big = biggest(list);
      if (!big.length) return bomb;
      const center = bomb[0] ? pieceCenter(bomb[0]) : null;
      if (!center) return big;
      return pointInPiece(center.x, center.y, big[0]) ? big : bomb;
    };
    const listsFor = (level) => {
      const opts = level ? { level, mapCode } : {};
      const listA = useKey ? keyZonesFor(network, 'a', opts) : [];
      const listB = useKey ? keyZonesFor(network, 'b', opts) : [];
      const a = zoneFor('a', opts, listA);
      const b = zoneFor('b', opts, listB);
      const keys = [];
      if (useKey) {
        for (const [site, list, plant] of [
          ['A', listA, a[0]],
          ['B', listB, b[0]]
        ]) {
          const plantIsKey = plant && list.includes(plant);
          list.forEach((piece, i) => {
            keys.push({
              site,
              index: i + 1,
              piece,
              plant: Boolean(plantIsKey && piece === plant)
            });
          });
        }
      }
      return { a, b, keys };
    };
    const byLevel = stacked
      ? { default: listsFor('default'), lower: listsFor('lower') }
      : { '': listsFor(null) };
    const packAt = (x, y, z) => byLevel[stacked ? regionLevelForZ(mapCode, z) : ''] || byLevel[''];
    return {
      painted: true,
      at(x, y, z) {
        const lists = packAt(x, y, z);
        if (!lists) return '';
        for (const piece of lists.a) if (pointInPiece(x, y, piece)) return 'A';
        for (const piece of lists.b) if (pointInPiece(x, y, piece)) return 'B';
        return '';
      },
      keyAt(x, y, z) {
        const lists = packAt(x, y, z);
        if (!lists?.keys?.length) return null;
        let hit = null;
        for (const item of lists.keys) {
          if (!pointInPiece(x, y, item.piece)) continue;
          if (item.plant) return item;
          if (!hit) hit = item;
        }
        return hit;
      }
    };
  })();

  /** First tick each of ours stood inside a bombsite, for the entry group. */
  const enteredSiteAt = new Map();
  /** First time each of ours walked an a1–a4 / b1–b4 piece that is not the plant. */
  const approachEntry = [];
  const seenApproach = new Set();

  /** What ended the call: 'plant', 'site' or 'deaths', or '' when nothing did. */
  let cutoffWhy = '';
  const cutoffSec = (() => {
    const marks = [];

    const plant = (meta.events?.bomb || []).find((b) => b.type === 'planted');
    if (plant?.tick > t0) marks.push({ sec: secOf(plant.tick), why: 'plant' });

    // Deaths, in order, against the count each side started with.
    const teamOf = new Map((meta.players || []).map((p) => [p.id, p.team === 1 ? side1 : side2]));
    const alive = { T: 0, CT: 0 };
    for (const p of meta.players || []) {
      const s = teamOf.get(p.id);
      if (s === 'T' || s === 'CT') alive[s] += 1;
    }
    const deaths = (meta.events?.kills || [])
      .filter((k) => k.victim && (k.tick || 0) >= t0)
      .sort((a, b) => (a.tick || 0) - (b.tick || 0));
    for (const k of deaths) {
      const s = teamOf.get(k.victim);
      if (s !== 'T' && s !== 'CT') continue;
      alive[s] -= 1;
      if (alive.T <= CUTOFF_ALIVE || alive.CT <= CUTOFF_ALIVE) {
        marks.push({ sec: secOf(k.tick || 0), why: 'deaths' });
        break;
      }
    }

    // Bodies on the site. Walked here rather than off the per-player samples
    // below, because the answer is about the side as a whole and every column
    // has to stop at the same second.
    if (plantZones.painted) {
      const siteScratch = {};
      const inSite = new Set();
      let twoIn = 0;
      const stride = Math.max(1, Math.round(rate / 2));
      // The whole round, not just up to the cutoff: the entry GROUP is still
      // forming after the second man is in, and the third arriving late is
      // what makes the first man worth naming.
      for (let tick = t0; tick <= endTick; tick += stride) {
        for (const p of meta.players || []) {
          if (p.slot == null || p.slot < 0) continue;
          const isT = tIds.has(p.id);
          if (!isT && !sideIds.has(p.id)) continue;
          const st = track.sample(p.slot, tick, siteScratch);
          if (!st?.alive || !Number.isFinite(st.x)) continue;
          const plantLetter = plantZones.at(st.x, st.y, st.z);
          if (tIds.has(p.id)) {
            const key = plantZones.keyAt(st.x, st.y, st.z);
            if (key && !key.plant) {
              const sig = `${p.id}|${key.site}|${key.index}`;
              if (!seenApproach.has(sig)) {
                seenApproach.add(sig);
                const where = namer.namesAt(st.x, st.y, st.z);
                approachEntry.push({
                  id: p.id,
                  tick,
                  sec: secOf(tick),
                  site: key.site,
                  index: key.index,
                  position: where.position || '',
                  zone: where.zone || ''
                });
              }
            }
          }
          if (!plantLetter) continue;
          if (sideIds.has(p.id) && !enteredSiteAt.has(p.id)) {
            enteredSiteAt.set(p.id, { tick, site: plantLetter });
          }
          if (isT) inSite.add(p.id);
        }
        if (!twoIn && inSite.size >= CUTOFF_ENTRIES) twoIn = tick;
      }
      // Plus a moment, so the line still covers the entry that ended it.
      if (twoIn) marks.push({ sec: secOf(twoIn) + CUTOFF_ENTRY_GRACE_SECONDS, why: 'site' });
    }

    if (!marks.length) return Infinity;
    const first = marks.reduce((a, b) => (b.sec < a.sec ? b : a));
    cutoffWhy = first.why;
    return first.sec;
  })();

  /**
   * The man who went in first, when a group went in together.
   *
   * Measured on the same plant zones the cutoff uses, so the mark can always
   * land on a line the cutoff kept. Only when it IS a group: one player
   * wandering into the site ahead of nobody is not leading an entry, he is
   * lurking.
   */
  /** Where a grenade stops counting: a little later than the rest when the site entry ended the call. */
  const nadeCutoff = cutoffWhy === 'site' ? cutoffSec + ENTRY_UTILITY_SECONDS : cutoffSec;

  const firstIn = (() => {
    // Defenders walk onto their own site at the start: that is the setup, not an entry.
    if (side !== 'T') return '';
    const entries = [...enteredSiteAt.entries()].sort((a, b) => a[1].tick - b[1].tick);
    if (entries.length < ENTRY_GROUP_MIN) return '';
    const [lead, leadInfo] = entries[0];
    const together = entries.filter(([, info]) => info.tick - leadInfo.tick <= ENTRY_GROUP_SECONDS * rate);
    return together.length >= ENTRY_GROUP_MIN ? lead : '';
  })();
  const firstInSec = firstIn ? secOf(enteredSiteAt.get(firstIn).tick) : 0;
  /** Where he went in, for the case where no line exists to hang the mark on. */
  const firstInZone = (() => {
    if (!firstIn) return '';
    const slot = slotOf.get(firstIn);
    if (slot == null || slot < 0) return '';
    const st = track.sample(slot, enteredSiteAt.get(firstIn).tick, {});
    if (!st || !Number.isFinite(st.x)) return '';
    return namer.namesAt(st.x, st.y, st.z).zone || '';
  })();

  /** Our own utility in the air, for "went in behind it". */
  const flights = ourGrenades
    .map((g) => {
      const from = Number(g.throwTick);
      const to = Number(g.detonateTick ?? g.throwTick + 2 * rate);
      if (!Number.isFinite(from)) return null;
      return {
        player: g.player,
        word: TYPE_WORDS[normalizeNadeType(g.type)] || '',
        from: from - FLIGHT_LEAD_SECONDS * rate,
        to: (Number.isFinite(to) ? to : from) + FLIGHT_TAIL_SECONDS * rate
      };
    })
    .filter((f) => f && f.word);

  const handoverScratch = {};
  const positionAt = (id, tick) => {
    const slot = slotOf.get(id);
    if (slot == null || slot < 0) return null;
    const s = track.sample(slot, tick, handoverScratch);
    return s && Number.isFinite(s.x) ? { x: s.x, y: s.y, z: s.z || 0 } : null;
  };

  const coreScratch = {};
  function livingSide(tick) {
    const alive = [];
    for (const p of meta.players || []) {
      if (!sideIds.has(p.id)) continue;
      if ((deadAt.get(p.id) || Infinity) <= tick) continue;
      if (p.slot == null || p.slot < 0) continue;
      const st = track.sample(p.slot, tick, coreScratch);
      if (!st?.alive || !Number.isFinite(st.x)) continue;
      alive.push({ id: p.id, x: st.x, y: st.y, z: st.z || 0 });
    }
    return alive;
  }

  /** First man into an a1–a4 / b1–b4 piece when a teammate is with him. */
  const goFirstApproach = new Set();
  {
    const byPiece = new Map();
    for (const e of approachEntry) {
      const k = `${e.site}|${e.index}`;
      const list = byPiece.get(k) || [];
      list.push(e);
      byPiece.set(k, list);
    }
    for (const group of byPiece.values()) {
      group.sort((a, b) => a.tick - b.tick);
      const lead = group[0];
      const together = group.filter((e) => e.tick - lead.tick <= ENTRY_GROUP_SECONDS * rate);
      if (together.length >= 2) goFirstApproach.add(`${lead.id}|${lead.site}|${lead.index}`);
    }
  }

  const firstPlantTick = { A: Infinity, B: Infinity };
  for (const info of enteredSiteAt.values()) {
    if (info.tick < firstPlantTick[info.site]) firstPlantTick[info.site] = info.tick;
  }

  /**
   * Solo on the far site: the first time a core of three walks into a key
   * zone, everyone outside that core is lurking there.
   */
  const lurkAt = new Map();
  // The B anchor while three CTs hold A is the setup, not a lurk.
  if (side === 'T') {
    const keyHits = [
      ...approachEntry.map((e) => ({ id: e.id, tick: e.tick, site: e.site })),
      ...[...enteredSiteAt.entries()].map(([id, info]) => ({ id, tick: info.tick, site: info.site }))
    ].sort((a, b) => a.tick - b.tick);
    for (const hit of keyHits) {
      const core = findCore(livingSide(hit.tick));
      if (core.size < FAKE_CORE || !core.core.includes(hit.id)) continue;
      for (const lid of core.lurkers) {
        const st = positionAt(lid, hit.tick);
        if (!st) continue;
        const key = plantZones.keyAt(st.x, st.y, st.z);
        const plant = plantZones.at(st.x, st.y, st.z);
        const place = key?.site || plant || namer.namesAt(st.x, st.y, st.z).zone || '';
        if (place) lurkAt.set(lid, place);
      }
      break;
    }
  }

  /**
   * Boost: stacked within 25, then one man rises 60 Z and stays up.
   * Runboost: the same stack, then 300+ u/s within a second of leaving it.
   */
  const boostById = new Map();
  {
    const boostEndTick = Math.min(
      endTick,
      Number.isFinite(cutoffSec) ? live0 + cutoffSec * rate : endTick
    );
    const bodies = [];
    for (const p of meta.players || []) {
      if (!sideIds.has(p.id) || p.slot == null || p.slot < 0) continue;
      bodies.push({ id: p.id, slot: p.slot });
    }
    const scratchBoost = {};
    const prevPos = new Map();
    const prevClose = new Map();
    const pairBase = new Map();
    const liftPending = new Map();
    const leftClose = new Map();
    const boostLock = new Map();
    const runLock = new Map();
    const pushEv = (id, sec, text) => {
      const list = boostById.get(id) || [];
      list.push({ sec, at: sec, text });
      boostById.set(id, list);
    };
    const destAfter = (id, fromTick, origin) => {
      let dest = '';
      const until = Math.min(boostEndTick, fromTick + RUNBOOST_DEST_SECONDS * rate);
      const stride = Math.max(1, Math.round(rate / SAMPLE_HZ));
      for (let t = fromTick; t <= until; t += stride) {
        const st = positionAt(id, t);
        if (!st) continue;
        const n = namer.namesAt(st.x, st.y, st.z).position;
        if (n && n !== origin) dest = n;
      }
      return dest;
    };

    for (let tick = t0; tick <= boostEndTick; tick += 1) {
      const now = new Map();
      for (const b of bodies) {
        if ((deadAt.get(b.id) || Infinity) <= tick) continue;
        const st = track.sample(b.slot, tick, scratchBoost);
        if (!st?.alive || !Number.isFinite(st.x) || !Number.isFinite(st.y)) continue;
        now.set(b.id, { x: st.x, y: st.y, z: Number(st.z) || 0 });
      }
      const close = new Map();
      const idsNow = [...now.keys()];
      for (let i = 0; i < idsNow.length; i++) {
        for (let j = i + 1; j < idsNow.length; j++) {
          const ia = idsNow[i];
          const ib = idsNow[j];
          const a = now.get(ia);
          const b = now.get(ib);
          const d = dist2d(a.x, a.y, b.x, b.y);
          if (d > BOOST_NEAR) continue;
          const keep = (id, other, dist) => {
            const cur = close.get(id);
            if (!cur || dist < cur.d) close.set(id, { id: other, d: dist });
          };
          keep(ia, ib, d);
          keep(ib, ia, d);
        }
      }

      for (const id of idsNow) {
        const p = now.get(id);
        const partner = close.get(id)?.id;
        if (partner) {
          if (!pairBase.has(id)) pairBase.set(id, { z: p.z, partner });
        } else {
          pairBase.delete(id);
        }

        const wasPartner = prevClose.get(id);
        if (wasPartner && !partner) leftClose.set(id, { partner: wasPartner, tick });

        const base = pairBase.get(id);
        if (base && !liftPending.has(id) && !(boostLock.get(id) > tick)) {
          const other = now.get(base.partner) || prevPos.get(base.partner);
          const otherLow = !other || other.z <= base.z + 25;
          if (otherLow && p.z >= base.z + BOOST_LIFT) {
            liftPending.set(id, { fromZ: base.z, partner: base.partner, fromTick: tick });
          }
        }

        const lift = liftPending.get(id);
        if (lift) {
          if (p.z >= lift.fromZ + BOOST_LIFT - 10) {
            if (tick - lift.fromTick >= BOOST_STAY_SECONDS * rate) {
              const who = nameOf.get(lift.partner) || '';
              const named = namer.namesAt(p.x, p.y, p.z);
              const where = named.position || named.zone;
              pushEv(
                id,
                secOf(lift.fromTick),
                where ? `Get boosted ${where}${who ? ` by ${who}` : ''}` : who ? `Get boosted by ${who}` : 'Get boosted'
              );
              liftPending.delete(id);
              boostLock.set(id, tick + 2 * rate);
            }
          } else {
            liftPending.delete(id);
          }
        }

        const pr = prevPos.get(id);
        const left = leftClose.get(id);
        if (
          pr &&
          left &&
          !(runLock.get(id) > tick) &&
          !(boostLock.get(id) > tick) &&
          tick - left.tick <= RUNBOOST_AFTER_SECONDS * rate
        ) {
          const speed = Math.hypot(p.x - pr.x, p.y - pr.y) * rate;
          if (speed >= RUNBOOST_SPEED && speed < RUNBOOST_MAX) {
            const origin = namer.namesAt(pr.x, pr.y, pr.z).position;
            const dest = destAfter(id, tick, origin);
            const who = nameOf.get(left.partner) || '';
            pushEv(
              id,
              secOf(tick),
              dest ? `Get runboosted ${dest}${who ? ` by ${who}` : ''}` : who ? `Get runboosted by ${who}` : 'Get runboosted'
            );
            leftClose.delete(id);
            runLock.set(id, tick + 2 * rate);
          }
        }
      }

      prevPos.clear();
      for (const [id, p] of now) prevPos.set(id, p);
      prevClose.clear();
      for (const [id, v] of close) prevClose.set(id, v.id);
    }
  }

  const syncedFor = new Map();
  {
    const syncables = ourGrenades.filter((g) => syncWord(g.type));
    for (let i = 0; i < syncables.length; i++) {
      for (let j = i + 1; j < syncables.length; j++) {
        const a = syncables[i];
        const b = syncables[j];
        if (a.player === b.player) continue;
        if (Math.abs(Number(a.throwTick) - Number(b.throwTick)) > SYNC_SECONDS * rate) continue;
        const oa = positionAt(a.player, Number(a.throwTick));
        const ob = positionAt(b.player, Number(b.throwTick));
        if (!oa || !ob || dist2d(oa.x, oa.y, ob.x, ob.y) > SYNC_THROWERS) continue;
        const lx = Number(a.at?.x);
        const ly = Number(a.at?.y);
        const rx = Number(b.at?.x);
        const ry = Number(b.at?.y);
        if (![lx, ly, rx, ry].every(Number.isFinite) || dist2d(lx, ly, rx, ry) > SYNC_LANDING) continue;
        const aName = nameOf.get(a.player) || '';
        const bName = nameOf.get(b.player) || '';
        if (!syncedFor.has(a) && bName) syncedFor.set(a, `synced with ${syncWord(b.type)} from ${bName}`);
        if (!syncedFor.has(b) && aName) syncedFor.set(b, `synced with ${syncWord(a.type)} from ${aName}`);
      }
    }
  }

  function nadeFields(g, head, when, extra = {}) {
    const origin = positionAt(g.player, Number(g.throwTick));
    const type = normalizeNadeType(g.type);
    let outHead = head;
    if (type === 'hegrenade') {
      const lx = Number(g.at?.x);
      const ly = Number(g.at?.y);
      const det = Number(g.detonateTick ?? g.throwTick);
      const r = SMOKE_RADIUS_UNITS + NADE_IN_SMOKE_PAD;
      if (Number.isFinite(lx) && Number.isFinite(ly) && Number.isFinite(det)) {
        for (const sm of smokes) {
          if (det < sm.from || det > sm.to) continue;
          if ((sm.x - lx) ** 2 + (sm.y - ly) ** 2 > r * r) continue;
          const spot = sm.spot || extra.spot || '';
          if (spot) outHead = `Nade the ${spot} smoke`;
          break;
        }
      }
    }
    return {
      head: outHead,
      when,
      id: extra.id || '',
      from: extra.from || spotOf(g.player, Number(g.throwTick)),
      type,
      ox: origin?.x,
      oy: origin?.y,
      lx: Number(g.at?.x),
      ly: Number(g.at?.y),
      synced: syncedFor.get(g) || '',
      lineup: extra.lineup
    };
  }
  const handovers = utilityHandovers({
    items: meta.events?.items || [],
    grenades: allGrenades,
    loadouts: new Map([...sideIds].map((id) => [id, meta.stats?.[id]?.loadout || []])),
    deadAt,
    positionAt,
    secOf,
    tickRate: rate,
    sideIds,
    fromTick: t0,
    toTick: endTick
  });

  const step = 1 / SAMPLE_HZ;
  const stepTicks = Math.max(1, Math.round(rate * step));
  const scratch = {};
  const showBuy = BUY_ECONOMIES.has(String(economy || ''));

  const freezeDrops = economy === 'Pistol' && !windowed ? pistolDrops([...sideIds], meta.stats) : [];
  const planted = (meta.events?.bomb || []).find((b) => b.type === 'planted' && b.tick >= t0 && b.tick <= endTick);
  const facts = {
    side,
    window: { from: winFrom, to: winTo },
    cutoff: Number.isFinite(cutoffSec) ? { sec: cutoffSec, why: cutoffWhy } : null,
    exec,
    plant: planted ? { sec: secOf(planted.tick), site: String(planted.site || '').toUpperCase(), player: planted.player || '' } : null,
    firstIn: firstIn ? { id: firstIn, sec: firstInSec, zone: firstInZone } : null,
    players: new Map()
  };

  for (const id of ids) {
    const slot = slotOf.get(id);
    if (slot == null || slot < 0) {
      notes.set(id, '');
      facts.players.set(id, { name: nameOf.get(id) || '', note: '', buy: '', handed: [], died: null, bomb: false, route: [], holds: [], nades: [] });
      continue;
    }
    const died = deadAt.has(id) ? deadAt.get(id) : Infinity;
    const lastTick = Math.min(endTick, died);

    // ---- where he was, second by second ---------------------------------
    //
    // One walk, both layers, plus what was in his hands: whether five seconds
    // on a spot is a hold or a line-up is a question about the weapon, not the
    // ground.
    const samples = [];
    for (let tick = t0; tick <= lastTick; tick += stepTicks) {
      const s = track.sample(slot, tick, scratch);
      if (!s.alive || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      const where = namer.namesAt(s.x, s.y, s.z);
      const inHand = weaponNames[s.weapon] || '';
      const yaw = Number(s.yaw);
      samples.push({
        sec: secOf(tick),
        tick,
        zone: where.zone,
        position: where.position,
        gun: isGun(inHand),
        nade: normalizeNadeType(inHand),
        x: s.x,
        y: s.y,
        z: s.z || 0,
        key: Boolean(plantZones.keyAt(s.x, s.y, s.z)),
        aim: lookTarget(namer, s.x, s.y, s.z || 0, yaw, where.position)
      });
    }
    const zoneRuns = runsFrom(samples, step, (s) => s.zone);
    // The first zone is the spawn. It never produces a movement event.
    // A mid-round window has no spawn: the first box is just where he was.
    const spawnEndsAt = windowed ? -1 : zoneRuns.length ? zoneRuns[0].to : 0;
    // Holding is measured off the spawn SPOT, not the spawn zone. Anubis paints
    // one zone over "T Spawn + B Main", and a lurker who sat outside B Main for
    // twenty seconds read as never having left spawn: his column was empty.
    const positionRuns = runsFrom(samples, step, (s) => s.position);
    const spawnSpotEndsAt = windowed ? -1 : positionRuns.length ? positionRuns[0].to : 0;

    /** @type {Array<{ sec: number, text: string, exec?: boolean }>} */
    const events = [];
    /** Grenades already spoken for by a "Line up" line, so they are not repeated. */
    const linedUp = new Set();
    /** `stay|type` pairs already looked at, so the search below terminates. */
    const linedUpTypes = new Set();

    // ---- staying somewhere, and lining up from it ------------------------
    //
    // Positions, not zones: the value of this line is the exact spot. A repeat
    // of the last spot written extends that stay rather than adding another,
    // so a body peeking in and out of one does not read as two holds.
    const stays = [];
    let lastStay = null;
    for (const run of positionRuns) {
      if (run.from < spawnSpotEndsAt) continue;
      if (run.to - run.from < HOLD_SECONDS) continue;
      if (lastStay && lastStay.name === run.name) {
        lastStay.to = run.to;
        lastStay.samples.push(...run.samples);
        continue;
      }
      lastStay = { name: run.name, from: run.from, to: run.to, samples: [...run.samples] };
      stays.push(lastStay);
    }

    const spawnZone = windowed ? '' : zoneRuns[0]?.name || '';

    for (const stay of stays) {
      // Five seconds on a spot is only a hold if the gun was out for them. Time
      // spent with a smoke in hand is not holding an angle.
      const gunSecs = stay.samples.filter((s) => s.gun).length * step;
      if (gunSecs >= GUN_HOLD_SECONDS) {
        const stayZone = stay.samples[0]?.zone || '';
        const zr = zoneRuns.find(
          (r) => r.name === stayZone && r.from <= stay.from && stay.from <= r.to
        );
        const zoneFrom = zr?.from ?? stay.from;
        let fromPos = '';
        let fromZone = '';
        for (const s of samples) {
          if (s.sec >= zoneFrom - 1e-9) break;
          if (s.position) {
            fromPos = s.position;
            fromZone = s.zone || '';
          }
        }
        events.push({
          sec: stay.from,
          at: stay.to,
          stay: true,
          stayName: stay.name,
          stayZone,
          zoneFrom,
          fromPos,
          fromZone,
          text: `Stay ${stay.name} until ${clockAt(stay.to)}`
        });
      }

      // Utility out on this spot, and thrown from it: a line-up. Independent of
      // the hold above, because a player does both from one spot — he sits on
      // Chair watching mid and puts the Window smoke up from the same step.
      for (;;) {
        const first = stay.samples.find(
          (s) => TYPE_WORDS[s.nade] && !linedUpTypes.has(`${stay.from}|${s.nade}`)
        );
        if (!first) break;
        linedUpTypes.add(`${stay.from}|${first.nade}`);
        const g = ourGrenades.find(
          (t) =>
            t.player === id &&
            !linedUp.has(t) &&
            normalizeNadeType(t.type) === first.nade &&
            secOf(Number(t.throwTick)) >= first.sec + LINEUP_MIN_SETUP_SECONDS &&
            secOf(Number(t.throwTick)) <= stay.to + LINEUP_TAIL_SECONDS
        );
        // Not a line-up: the plain throw line below says it in four words.
        if (!g) continue;
        linedUp.add(g);
        const link = linkOf.get(g);
        const word = lower(link?.word || TYPE_WORDS[normalizeNadeType(g.type)] || '');
        const what = [link?.spot || '', word].filter(Boolean).join(' ');
        const tag = link?.throwId ? `<${what}><!${link.throwId}>` : what;
        const thrownAt = secOf(Number(g.throwTick));
        events.push({
          sec: first.sec,
          at: thrownAt,
          grenade: g,
          nade: nadeFields(g, what, clockAt(thrownAt), {
            id: link?.throwId || '',
            from: stay.name,
            spot: link?.spot || '',
            lineup: `Line up ${tag} from ${stay.name}, throw at ${clockAt(thrownAt)}`
          })
        });
      }
    }

    // ---- throws ----------------------------------------------------------
    for (const g of ourGrenades) {
      if (g.player !== id || linedUp.has(g)) continue;
      const link = linkOf.get(g);
      const word = link?.word || TYPE_WORDS[normalizeNadeType(g.type)] || '';
      if (!word) continue;
      const sec = secOf(Number(g.throwTick));
      // A smoke leaving the hand on the first tick of the round is called an
      // insta, not "at 1:55" — the whole point is that it needs no timing.
      const insta =
        normalizeNadeType(g.type) === 'smokegrenade' && INSTA_CLOCKS.has(clockAt(sec));
      events.push({
        sec,
        at: sec,
        grenade: g,
        nade: nadeFields(g, [word, link?.spot || ''].filter(Boolean).join(' '), insta ? 'insta' : clockAt(sec), {
          id: link?.throwId || '',
          from: spotOf(id, Number(g.throwTick)),
          spot: link?.spot || ''
        })
      });
    }

    // ---- going somewhere, behind someone's utility -----------------------
    //
    // Never back into the spawn zone. A body drifting over that boundary is
    // the same "first zone" the rules already ignore, and "Go T Spawn on flash"
    // is not an instruction anyone would give.
    let lastGo = '';
    for (const run of zoneRuns.slice(1)) {
      if (run.name === spawnZone) continue;
      // The most recent grenade still in the air, so the line names the piece
      // of utility he actually walked in behind, and who threw it.
      const cover = flights
        .filter((f) => f.player !== id && secOf(f.from) <= run.from && secOf(f.to) >= run.from)
        .sort((a, b) => b.from - a.from)[0];
      if (!cover || run.name === lastGo) continue;
      lastGo = run.name;
      const who = nameOf.get(cover.player) || '';
      const early = run.from < EARLY_SECONDS;
      events.push({
        sec: run.from,
        go: true,
        goZone: run.name,
        text: early
          ? `Go ${run.name}`
          : `Go ${run.name} on ${lower(cover.word)}${who ? ` from ${who}` : ''}`
      });
    }

    // ---- a1–a4 / b1–b4: Search, Contact, Rush out, or Go 1st (T only) ------
    const keySeen = new Set();
    for (const e of approachEntry) {
      if (e.id !== id || !tIds.has(id)) continue;
      if (keySeen.has(e.site)) continue;
      keySeen.add(e.site);
      const plantTick = firstPlantTick[e.site];
      const follows =
        Number.isFinite(plantTick) &&
        plantTick >= e.tick &&
        plantTick - e.tick <= SEARCH_PLANT_SECONDS * rate;
      if (follows) {
        const window = samples.filter((s) => s.sec >= e.sec && s.sec <= e.sec + RUSH_SECONDS);
        const psdt = pulledStringDistance(window);
        const util = ourGrenades.some((g) => {
          const s = secOf(Number(g.throwTick));
          return s < e.sec && s >= e.sec - CONTACT_UTIL_SECONDS;
        });
        const pos = e.position || e.zone;
        let text = 'Rush out';
        if (psdt < RUSH_PSDT) {
          const verb = util ? 'Search' : 'Contact';
          text = pos ? `${verb} ${pos}` : verb;
        }
        events.push({ sec: e.sec, keyMove: true, text });
      } else if (goFirstApproach.has(`${e.id}|${e.site}|${e.index}`)) {
        events.push({ sec: e.sec, keyMove: true, text: `Go 1st out ${e.site}` });
      }
    }

    // ---- CT Hold: 5s in a key bombsite zone, 4s looking at one spot --------
    if (!tIds.has(id)) {
      const winN = Math.max(1, Math.round(HOLD_SECONDS / step));
      const need = Math.max(1, Math.round(HOLD_AIM_SECONDS / step));
      const after = samples.filter((s) => s.sec >= spawnEndsAt);
      const runs = [];
      let cur = [];
      const flushRun = () => {
        if (cur.length * step >= HOLD_SECONDS) runs.push(cur);
        cur = [];
      };
      for (const s of after) {
        if (s.key) cur.push(s);
        else flushRun();
      }
      flushRun();
      for (const run of runs) {
        let last = { stand: '', aim: '' };
        let first = true;
        for (let i = 0; i + winN <= run.length; i++) {
          const win = run.slice(i, i + winN);
          const aimCount = new Map();
          const standCount = new Map();
          for (const s of win) {
            if (s.gun && s.aim) aimCount.set(s.aim, (aimCount.get(s.aim) || 0) + 1);
            if (s.position) standCount.set(s.position, (standCount.get(s.position) || 0) + 1);
          }
          let aim = '';
          let ac = 0;
          for (const [k, v] of aimCount) if (v > ac) { aim = k; ac = v; }
          let stand = '';
          let sc = 0;
          for (const [k, v] of standCount) if (v > sc) { stand = k; sc = v; }
          if (ac < need || !stand || !aim || stand === aim) continue;
          if (stand === last.stand && aim === last.aim) continue;
          const hit = win.find((s) => s.aim === aim && s.position === stand) || win[0];
          const sec = first ? run[0].sec : hit.sec;
          events.push({
            sec,
            at: first ? undefined : sec,
            keyMove: true,
            hold: true,
            fromPos: stand,
            text: first
              ? `Go ${stand}, hold ${aim}`
              : `At ${clockAt(sec)}, hold ${aim} from ${stand}`
          });
          last = { stand, aim };
          first = false;
        }
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      if (!events[i].go || events[i].keyMove) continue;
      if (events.some((e) => e.keyMove && Math.abs(e.sec - events[i].sec) <= 1)) events.splice(i, 1);
    }

    const pathTold = new Set();
    for (const e of events) {
      if (!e.stay || e.zoneFrom < EARLY_SECONDS) continue;
      if (!e.fromPos || !e.stayZone) continue;
      if (spawnZone && e.fromZone === spawnZone) continue;
      if (e.fromPos === e.stayName || e.fromPos === e.stayZone) continue;
      const key = `${e.stayZone}@${e.zoneFrom}`;
      if (pathTold.has(key)) continue;
      if (
        events.some(
          (g) => g.go && g.goZone === e.stayZone && Math.abs(g.sec - e.zoneFrom) <= 2.5
        )
      ) {
        continue;
      }
      pathTold.add(key);
      e.pathGo = true;
      e.text = `Go ${e.fromPos} to ${e.stayZone}. ${e.text}`;
    }

    // ---- walking through our own smoke -----------------------------------
    //
    // Once per cloud: stepping out of the edge and back in is the same crossing.
    let smokeFrom = -1;
    let smokeAt = '';
    let smokeCloud = -1;
    const smokeTold = new Set();
    const closeSmoke = (endSec) => {
      if (smokeFrom < 0) return;
      if (endSec - smokeFrom >= MIN_SMOKE_SECONDS && smokeFrom >= spawnEndsAt && !smokeTold.has(smokeCloud)) {
        smokeTold.add(smokeCloud);
        events.push({
          sec: smokeFrom,
          text: smokeAt ? `In smoke at ${smokeAt}` : 'In smoke'
        });
      }
      smokeFrom = -1;
      smokeAt = '';
      smokeCloud = -1;
    };
    for (const s of samples) {
      const cloud = smokes.findIndex(
        (sm) =>
          sm.ours &&
          s.tick >= sm.from &&
          s.tick <= sm.to &&
          (sm.x - s.x) ** 2 + (sm.y - s.y) ** 2 <= SMOKE_RADIUS_UNITS * SMOKE_RADIUS_UNITS
      );
      if (cloud >= 0) {
        if (smokeFrom < 0) {
          smokeFrom = s.sec;
          smokeAt = s.position || s.zone;
          smokeCloud = cloud;
        }
      } else {
        closeSmoke(s.sec);
      }
    }
    closeSmoke(samples[samples.length - 1]?.sec ?? 0);

    // ---- utility handed over ---------------------------------------------
    //
    // With the other end named: "Drop smoke" leaves the reader asking to whom,
    // and that is the instruction.
    for (const h of handovers) {
      const word = lower(TYPE_WORDS[h.item] || h.item);
      if (h.from === id) {
        const to = nameOf.get(h.to) || '';
        events.push({ sec: h.sec, hand: true, text: to ? `Drop ${word} to ${to}` : `Drop ${word}` });
      } else if (h.to === id) {
        const from = nameOf.get(h.from) || '';
        events.push({ sec: h.sec, hand: true, text: from ? `Get ${word} from ${from}` : `Pick up ${word}` });
      }
    }

    // ---- emptying a magazine into a cloud ---------------------------------
    for (const hit of spamCounts.values()) {
      if (hit.player !== id || hit.n < SPAM_SHOTS || !hit.spot) continue;
      events.push({ sec: secOf(hit.tick), text: `Spam the ${hit.spot} smoke` });
    }

    // ---- taking a fight ---------------------------------------------------
    //
    // The first one only. Where he took contact belongs to the call; the trades
    // after it are the round going on, and a column that read "Fight Long from
    // Long Corner" three times over said nothing a coach would write.
    for (const f of fightsFor(id).slice(0, 1)) {
      events.push({
        sec: f.sec,
        fight: true,
        // Both men on the same painted spot is one place, not two: "Fight CT
        // Spawn from CT Spawn" says nothing the first half did not.
        text: f.from && f.from !== f.at ? `Fight ${f.at} from ${f.from}` : `Fight in ${f.at}`
      });
    }

    for (const b of boostById.get(id) || []) events.push({ sec: b.sec, at: b.at, boost: true, text: b.text });

    // Ordered by the clock each line SHOWS, not by when its situation began.
    // "Stay Top mid until 1:38" is ordered by 1:38; putting it where the stay
    // started would print 1:38 ahead of a throw at 1:45 and read backwards.
    events.sort((a, b) => eventClock(a) - eventClock(b) || a.sec - b.sec);

    // Past the cutoff the round stopped being a call, so the line stops too.
    // Measured on the clock each line shows, which is the order they are in:
    // a hold running past the cutoff is a hold the call no longer covers.
    const live = events.filter((e) => eventClock(e) <= (e.nade ? nadeCutoff : cutoffSec));
    events.length = 0;
    events.push(...live);

    for (let i = events.length - 1; i >= 0; i--) {
      if (!events[i].stay) continue;
      if (events.some((e) => e.hold && e.fromPos === events[i].stayName)) events.splice(i, 1);
    }

    // The man who went in first is told so, on the action that took him in.
    if (id === firstIn && !events.some((e) => String(e.text || '').startsWith('Go 1st'))) {
      let lead = null;
      for (const e of events) {
        if (!e.go || e.sec > firstInSec) continue;
        if (firstInSec - e.sec <= FIRST_IN_LOOKBACK_SECONDS) lead = e;
      }
      if (lead) lead.text = `Go 1st. ${lead.text}`;
      else {
        // No line to hang it on: he walked in on his own utility, or on none.
        // Name the site so the mark still says where he went first.
        events.push({
          sec: firstInSec,
          at: firstInSec,
          text: firstInZone ? `Go 1st into ${firstInZone}` : 'Go 1st'
        });
        events.sort((a, b) => eventClock(a) - eventClock(b) || a.sec - b.sec);
      }
    }

    // Trading with two men on the same angle, or re-peeking the same one, is
    // one line. The reader gains nothing from "Fight A from A Balc" three times
    // over. Two flashes from the same teammate are one "Get flash from" too.
    for (let i = events.length - 1; i > 0; i--) {
      if ((events[i].fight || events[i].hand) && events[i].text === events[i - 1].text) events.splice(i, 1);
    }

    // A hold is only worth writing when the note goes on to say what happens
    // when it ends. "Stay Mid until 1:40" as the last thing on the line leaves
    // the reader asking "then what?" and the clock is really just where the
    // round ran out or where he died, which is not an instruction.
    while (events.length && events[events.length - 1].stay) events.pop();

    // Two idle sits back to back are one hold, then a search. A stay that
    // already named a new zone ("Go Ramp to B Banana. Stay …") is an arrival,
    // not a second sit, and starts the next run.
    for (let i = 0; i < events.length - 1; ) {
      if (!events[i].stay) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < events.length && events[j].stay && !events[j].pathGo) j += 1;
      if (j === i + 1) {
        i += 1;
        continue;
      }
      events[i].text = `${events[i].text}, then search`;
      events.splice(i + 1, j - i - 1);
      i += 1;
    }

    const searched = events.some((e) => e.keyMove && /^(Search |Contact |Rush out)/.test(e.text));
    if (!searched && lurkAt.has(id)) {
      events.push({
        sec: Number.isFinite(cutoffSec) ? cutoffSec : 1e9,
        lurk: true,
        text: `Lurk ${lurkAt.get(id)}`
      });
    }

    // Nothing above put him anywhere: he kept moving, or nobody's utility
    // covered his walk, or the call ended early. Where he spent it still says
    // what his job was.
    const placed = events.some((e) => e.go || e.stay || e.keyMove || e.hold || e.lurk || e.boost || /^Go 1st/.test(e.text || ''));
    if (!placed) {
      const play = presenceOf(samples.filter((s) => s.sec <= cutoffSec), step, spawnZone);
      // Grenades thrown from that zone already say where he stood ("… from Top Mid").
      const threwFrom = new Set(
        events
          .filter((e) => e.nade)
          .map((e) => samples.find((s) => s.sec >= eventClock(e) - step)?.zone)
          .filter(Boolean)
      );
      if (play && !threwFrom.has(play.name)) {
        events.push({ sec: play.sec, play: true, text: `Play ${play.name}` });
        events.sort((a, b) => eventClock(a) - eventClock(b) || a.sec - b.sec);
      }
    }

    const collapsed = collapseNades(events);
    const nadeCount = events.filter((e) => e.nade).length;
    if (side === 'T' && nadeCount >= FAKE_NADES) {
      const first = events.find((e) => e.nade);
      const tick = t0 + first.sec * rate;
      const alive = livingSide(tick);
      const core = findCore(alive);
      if (core.size >= FAKE_CORE && !core.core.includes(id)) {
        const share = (alive.length - core.size) / Math.max(1, alive.length);
        if (share <= FAKE_MINORITY + 1e-9) {
          const st = positionAt(id, tick);
          const zone = st ? namer.namesAt(st.x, st.y, st.z).zone : '';
          const hit = collapsed.find((e) => e.nade);
          if (zone && hit) hit.text = `Fake ${zone}. ${hit.text}`;
        }
      }
    }
    let note = joinEvents(collapsed, exec);
    // Carrying the bomb is not something he does at a moment, it is the job he
    // leaves spawn with, so it opens the line rather than sitting in sequence.
    if (!windowed && id === bombCarrier) note = note ? `Take bomb. ${note}` : 'Take bomb.';
    // A pistol drop is part of the buy: he bought what he gave away, and what
    // he was given is not his buy ("SF+P250. Drop p250 to khaN." / "K. Take p250 from robo.").
    const gave = freezeDrops.filter((d) => d.from === id);
    const got = freezeDrops.filter((d) => d.to === id);
    const owned = normalizeLoadout(meta.stats?.[id]?.loadout || []);
    for (const d of got) owned.splice(owned.indexOf(d.item), 1);
    const buy = showBuy && !windowed ? buyString([...owned, ...gave.map((d) => d.item)], track.sample(slot, t0, scratch)) : '';
    const handed = [
      ...gave.map((d) => `Drop ${ITEM_WORDS[d.item] || d.item} to ${nameOf.get(d.to) || 'a teammate'}.`),
      ...got.map((d) => `Take ${ITEM_WORDS[d.item] || d.item} from ${nameOf.get(d.from) || 'a teammate'}.`)
    ];
    if (buy || handed.length) note = [buy ? `${buy}.` : '', ...handed, note].filter(Boolean).join(' ');

    // Whose round this was read off. A coach opening the A Lurk column wants to
    // know he is watching ropz before he reads a word of what ropz did.
    const who = nameOf.get(id) || '';
    const room = NOTE_MAX - (who ? who.length + 2 : 0);
    if (note.length > room) note = `${note.slice(0, room - 1).trimEnd()}…`;
    notes.set(id, who ? (note ? `${who}: ${note}` : who) : note);

    // ---- the facts behind the line ---------------------------------------
    //
    // Everything up to where his part ended: the call's end, or his death.
    const diedSec = Number.isFinite(died) && died >= t0 && died <= endTick ? secOf(died) : null;
    const liveTo = Math.min(cutoffSec, diedSec ?? Infinity);
    // Every zone he passed through, with the spot he spent it on and whether he
    // walked it. A step shorter than FACT_FLICKER_SECONDS between two steps in
    // one zone is a corner clipped, not a move: the walk from water to con on
    // Anubis brushes "Bridge" (painted in T Mid) for two seconds, and the
    // flicker came out as "push mid to con".
    let route = zoneRuns
      .filter((r) => r.from <= liveTo)
      .map((r) => ({ zone: r.name, from: r.from, to: Math.min(r.to, liveTo), samples: r.samples.filter((s) => s.sec <= liveTo) }));
    route = route.filter(
      (r, i) => !(i > 0 && i < route.length - 1 && r.to - r.from < FACT_FLICKER_SECONDS && route[i - 1].zone === route[i + 1].zone)
    );
    // Pacing between two zones is not a route: the shortest steps go first.
    while (route.length > FACT_ROUTE_STEPS) {
      let shortest = 1;
      for (let i = 1; i < route.length; i++) {
        if (route[i].to - route[i].from < route[shortest].to - route[shortest].from) shortest = i;
      }
      route.splice(shortest, 1);
    }
    route = route
      .reduce((out, r) => {
        const last = out[out.length - 1];
        if (last && last.zone === r.zone) {
          last.to = r.to;
          last.samples.push(...r.samples);
        } else out.push({ ...r, samples: [...r.samples] });
        return out;
      }, [])
      .map((r) => ({ zone: r.zone, from: r.from, to: r.to, position: mostSeen(r.samples, 'position'), walkFrom: walked(r.samples, step) }));
    const holds = [];
    for (const run of runsFrom(samples.filter((s) => s.sec <= liveTo), step, (s) => s.position)) {
      if (run.from < spawnSpotEndsAt || run.to - run.from < FACT_HOLD_SECONDS) continue;
      const guns = run.samples.filter((s) => s.gun);
      if (guns.length < run.samples.length / 2) continue;
      const looks = new Map();
      for (const s of guns) if (s.aim) looks.set(s.aim, (looks.get(s.aim) || 0) + 1);
      let aim = '';
      let seen = 0;
      for (const [spot, n] of looks) {
        if (n > seen) {
          aim = spot;
          seen = n;
        }
      }
      holds.push({ position: run.name, from: run.from, to: Math.min(run.to, liveTo), aim: seen >= guns.length / 2 ? aim : '' });
    }
    const nades = [];
    for (const g of ourGrenades) {
      if (g.player !== id) continue;
      const sec = secOf(Number(g.throwTick));
      const type = normalizeNadeType(g.type);
      const link = linkOf.get(g);
      const word = link?.word || TYPE_WORDS[type] || '';
      if (!word || sec > nadeCutoff) continue;
      const ev = events.find((e) => e.grenade === g);
      nades.push({
        grenade: g,
        sec,
        word,
        spot: link?.spot || namer.positionName(Number(g.at?.x), Number(g.at?.y), Number(g.at?.z) || 0) || '',
        from: spotOf(id, Number(g.throwTick)),
        throwId: link?.throwId || '',
        insta: type === 'smokegrenade' && INSTA_CLOCKS.has(clockAt(sec)),
        lineup: ev?.nade?.lineup ? ev.nade.from || '' : '',
        synced: syncedFor.get(g) || ''
      });
    }
    facts.players.set(id, { name: who, note, buy, handed, died: diedSec, bomb: !windowed && id === bombCarrier, route, holds, nades });
  }

  return { notes, facts };
}
