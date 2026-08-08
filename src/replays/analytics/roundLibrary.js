// ---------------------------------------------------------------------------
// The round library: named round types, per map, per side.
//
// A round type is a call a coach can say out loud ("A Fake", "Lobby crunch")
// written as a test over the facts of one round (roundFacts.js). One round can
// carry several tags — "A Split" is deliberately the family label over the
// three smoke walls — so a matcher returns a mark sheet rather than a boolean,
// and `group` is what makes a family mutually exclusive: within one group the
// first definition to match wins, which is why the list is written strictest
// first.
//
// Every definition here is the map's own vocabulary. Region names resolve
// against the painted hierarchy by name (position, zone or area alike, see
// createRegionIndex), and utility names resolve against the stored utility
// spots. A map with nothing painted classifies every round as Default, which
// is the honest answer rather than a wrong one.
//
// Clocks count down from 1:55; every number below is seconds since the round
// went live.
// ---------------------------------------------------------------------------

import { SAMPLE_SECONDS, SMOKE_SECONDS, burstWindow, longestRun, secondsAtClock } from './roundFacts.js';

/** "In quick succession": within this many seconds of the other actions. */
export const QUICK_SECONDS = 6;

/**
 * @typedef {object} RoundTypeDef
 * @property {string} key
 * @property {string} label
 * @property {string} desc      the definition, in the coach's own wording
 * @property {string} [group]   family; only the first match in one wins
 * @property {string[]} [excludes]  keys that suppress this one when they matched
 * @property {(f: object) => ({ marks?: Record<string, number> })|null} match
 */

// ---------------------------------------------------------------------------
// Nuke vocabulary
// ---------------------------------------------------------------------------

// Both spellings of the lobby are accepted: the definitions call it "Lobby" in
// one line and "T Lobby" in the next, and it is one piece of ground.
const LOBBY = ['Lobby', 'T Lobby'];
const A_ZONES = ['A Anchor', 'A Door'];
const A_MAIN = ['A Main'];
const RAMP = ['Ramp'];
const RADIO = ['Radio'];
const TROPHY = ['Trophy'];
const OUTSIDE = ['Yard', 'CT Yard'];
const OUTSIDE_ALL = ['Yard', 'CT Yard', 'T Yard'];
const T_YARD = ['T Yard'];
const SILO = ['Silo'];
const SECRET = ['Secret'];
const VENTS = ['Vents'];
const T_START = [...LOBBY, 'T Yard'];
const AWP_PEEK = ['Main wall', 'm0NESY'];
const T_DOORS = ['Door', 'Lobby', 'T Lobby', 'Exit'];
/**
 * The CT spawn box, which the map paints as a member of the CT Yard zone.
 * Every CT is standing in it at freeze end, so any rule that means "they went
 * outside" has to take it back out or it is true in every round.
 */
const CT_SPAWN = ['CT Spawn'];
/**
 * How long 3 CTs must hold the yard before it is a call and not a walk.
 *
 * The only threshold here that no definition states. Nuke paints CT spawn into
 * the CT Yard zone and the walk out of it crosses the yard, so the bare form is
 * true in 100% of rounds at ~2s; at five seconds it is 17%.
 */
const OUTSIDE_HOLD_SECONDS = 5;

const NAVI_WALL = ['navi1', '2nd'];
const SECRET_WALL = ['secret1', '2nd'];
const FURIA_WALL = ['secret1', 'navi1', '2nd'];
const HEROIC_WALL = ['hell', 'main'];
const SECRET_RUSH_WALL = ['start', 'secret1', '2nd'];

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * When a named smoke wall is fully up: every name has to have landed, and the
 * wall exists from the last of them. Returns null when one is missing, which
 * is also what happens when the map has no stored spot under that name.
 */
function smokeWall(f, names, without = []) {
  // A wall is the smokes that ARE up and the smokes that are NOT. The three
  // Nuke walls share members (secret1 + 2nd is a subset of the FURIA wall), so
  // "which wall was that" is only answerable by ruling the others out — and a
  // FURIA round must never also read as a Secret wall or a Navi one.
  for (const name of without) {
    if (f.nadesNamed(name).length) return null;
  }
  const times = [];
  for (const name of names) {
    const hit = f.nadesNamed(name)[0];
    if (!hit) return null;
    times.push(hit.at);
  }
  return { at: Math.max(...times), first: Math.min(...times) };
}

/**
 * How many bodies have committed one way at a moment.
 *
 * `lower` is the "or down on the B layer" clause, and it is not on every rule:
 * a Navi smoke commit is measured on Yard / CT Yard alone, a Secret one counts
 * the players who have already dropped downstairs. Counting ids rather than
 * adding two numbers matters because ground can be painted on the lower floor,
 * and the same player would otherwise be counted twice.
 */
function spread(f, sec, { names = OUTSIDE, lower = false } = {}) {
  const ids = f.playersIn(names, sec);
  if (lower) {
    for (const id of f.playersLower(sec)) ids.add(id);
  }
  return ids.size;
}

/** First second in the window with `min`+ bodies committed that way. */
function spreadAt(f, from, to, min, opts) {
  for (const s of f.series) {
    if (s.sec < from || s.sec > to) continue;
    if (spread(f, s.sec, opts) >= min) return s.sec;
  }
  return null;
}

/**
 * A fake is the absence of the commit, held for the whole late window, with
 * nobody loitering in the staging positions either — a side still sitting in
 * T Yard or Silo has not faked anything, it just has not left yet.
 */
function stayedHome(f, from, to, min, opts) {
  let sawWindow = false;
  for (const s of f.series) {
    if (s.sec < from || s.sec > to) continue;
    sawWindow = true;
    if (spread(f, s.sec, opts) >= min) return false;
    if (f.countIn([...T_YARD, ...SILO], s.sec) > 0) return false;
  }
  return sawWindow;
}

/**
 * A group stages together, leaves, and arrives somewhere else intact.
 *
 * `min` players share the staging ground at one moment; the group is whoever
 * that is. "Leaving" is the first moment none of them is still on it, and the
 * push counts when every one of them is on the target within `span` after.
 */
function stagedPush(f, staging, target, span, min) {
  for (const s of f.series) {
    const group = f.playersIn(staging, s.sec);
    if (group.size < min) continue;
    const ids = [...group];
    let leftAt = null;
    for (const t of f.series) {
      if (t.sec <= s.sec) continue;
      const still = f.playersIn(staging, t.sec);
      if (!ids.some((id) => still.has(id))) {
        leftAt = t.sec;
        break;
      }
    }
    if (leftAt === null) continue;
    for (const t of f.series) {
      if (t.sec < leftAt || t.sec > leftAt + span) continue;
      const there = f.playersIn(target, t.sec);
      if (ids.every((id) => there.has(id))) {
        return { stagedAt: s.sec, leftAt, arrivedAt: t.sec, group };
      }
    }
  }
  return null;
}

/** The A-side utility burst, with per-definition counts. */
function aBurst(f, { molotovs, flashes, flashRegions = A_ZONES }) {
  const molos = f.nadesIn('molotov', A_ZONES);
  const smokes = f.nadesIn('smokegrenade', A_MAIN);
  const flash = f.nadesIn('flashbang', flashRegions);
  return burstWindow(
    [
      { need: molotovs, times: molos.map((n) => n.at) },
      { need: 1, times: smokes.map((n) => n.at) },
      { need: flashes, times: flash.map((n) => n.at) }
    ],
    QUICK_SECONDS
  );
}

// ---------------------------------------------------------------------------
// T side, Nuke
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const NUK_T = [
  {
    key: 'a-fake',
    label: 'A Fake',
    group: 'a-hit',
    desc: '2+ molotovs into A Anchor / A Door, a smoke in A Main and 2 flashes into A Anchor / A Door within 6s, with at most 1 player entering A and 3 others elsewhere.',
    match(f) {
      const w = aBurst(f, { molotovs: 2, flashes: 2 });
      if (!w) return null;
      if (f.playersDuring(A_ZONES, 0, f.lastSec).size > 1) return null;
      if (f.aliveCount(w.end) - f.countIn(A_ZONES, w.end) < 3) return null;
      return { marks: { 'Utility starts': w.start, 'Utility ends': w.end } };
    }
  },
  {
    key: 'a-pop',
    label: 'A Pop',
    group: 'a-hit',
    desc: '1+ molotov into A Anchor / A Door, a smoke in A Main and 3+ flashes into A Anchor / A Door / A Main within 6s, with 3 different players entering A.',
    match(f) {
      const w = aBurst(f, { molotovs: 1, flashes: 3, flashRegions: [...A_ZONES, ...A_MAIN] });
      if (!w) return null;
      if (f.playersDuring(A_ZONES, 0, f.lastSec).size < 3) return null;
      const entry = f.firstSecWith(A_ZONES, 1, w.start, f.lastSec);
      return {
        marks: { 'Utility starts': w.start, ...(entry === null ? {} : { 'First entry': entry }) }
      };
    }
  },
  {
    key: 'a-execute',
    label: 'A Execute',
    group: 'a-hit',
    desc: '2+ molotovs into A Anchor / A Door, a smoke in A Main and 2+ flashes into A Anchor / A Door within 6s, with 2+ different players entering A.',
    match(f) {
      const w = aBurst(f, { molotovs: 2, flashes: 2 });
      if (!w) return null;
      if (f.playersDuring(A_ZONES, 0, f.lastSec).size < 2) return null;
      const entry = f.firstSecWith(A_ZONES, 1, w.start, f.lastSec);
      return {
        marks: { 'Utility starts': w.start, ...(entry === null ? {} : { 'First entry': entry }) }
      };
    }
  },
  {
    key: 'vent-dive',
    label: 'Vent dive',
    desc: 'The lurk smoke is thrown, and a player is down in Vents by 1:35.',
    match(f) {
      const smoke = f.nadesNamed('lurk')[0];
      if (!smoke) return null;
      const at = f.firstSecWith(VENTS, 1, 0, secondsAtClock('1:35'));
      if (at === null) return null;
      return { marks: { 'Lurk smoke': smoke.at, 'In vents': at } };
    }
  },
  {
    key: 'ramp-rush',
    label: 'Ramp rush',
    group: 'ramp',
    desc: '4+ players in Ramp by 1:35.',
    match(f) {
      const at = f.firstSecWith(RAMP, 4, 0, secondsAtClock('1:35'));
      if (at === null) return null;
      return { marks: { 'Ramp full': at } };
    }
  },
  {
    key: 'ramp-pop',
    label: 'Ramp pop',
    group: 'ramp',
    desc: '3+ players stage in Radio / Trophy and are all in Ramp within 6s of leaving, with a flash thrown into Ramp or Lobby by one of them.',
    match(f) {
      const push = stagedPush(f, [...RADIO, ...TROPHY], RAMP, QUICK_SECONDS, 3);
      if (!push) return null;
      const flash = f
        .nadesIn('flashbang', [...RAMP, ...LOBBY])
        .find((n) => push.group.has(n.player) && n.thrown <= push.arrivedAt);
      if (!flash) return null;
      return {
        marks: { Staged: push.stagedAt, 'In ramp': push.arrivedAt, Flash: flash.at }
      };
    }
  },
  {
    key: 'ramp-contact',
    label: 'Ramp contact',
    group: 'ramp',
    desc: '3+ players stage in Radio / Lobby / Trophy and are all in Ramp within 8s of leaving.',
    match(f) {
      const push = stagedPush(f, [...RADIO, ...LOBBY, ...TROPHY], RAMP, 8, 3);
      if (!push) return null;
      return { marks: { Staged: push.stagedAt, 'In ramp': push.arrivedAt } };
    }
  },
  {
    key: 'furia',
    label: 'FURIA',
    group: 'wall',
    desc: 'secret1 + navi1 + 2nd land, and 3+ players are in Yard / CT Yard or downstairs 4-24s after.',
    match(f) {
      const wall = smokeWall(f, FURIA_WALL);
      if (!wall) return null;
      const at = spreadAt(f, wall.at + 4, wall.at + 24, 3, { names: OUTSIDE, lower: true });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, Committed: at } };
    }
  },
  {
    key: 'furia-fake',
    label: 'FURIA fake',
    group: 'wall',
    desc: 'secret1 + navi1 + 2nd land, but 12-24s after there are 2 or fewer players out or downstairs and none left in T Yard or Silo.',
    match(f) {
      const wall = smokeWall(f, FURIA_WALL);
      if (!wall) return null;
      if (!stayedHome(f, wall.at + 12, wall.at + 24, 3, { names: OUTSIDE, lower: true })) return null;
      return { marks: { 'Smokes land': wall.at } };
    }
  },
  {
    key: 'navi-smokes',
    label: 'Navi smokes',
    group: 'wall',
    desc: 'navi1 + 2nd land, and 3+ players are in Yard / CT Yard 4-24s after.',
    match(f) {
      const wall = smokeWall(f, NAVI_WALL, ['secret1']);
      if (!wall) return null;
      const at = spreadAt(f, wall.at + 4, wall.at + 24, 3, { names: OUTSIDE });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, Outside: at } };
    }
  },
  {
    key: 'navi-fake',
    label: 'Navi fake',
    group: 'wall',
    desc: 'navi1 + 2nd land, but 12-24s after there are 2 or fewer players in Yard / CT Yard and none left in T Yard or Silo.',
    match(f) {
      const wall = smokeWall(f, NAVI_WALL, ['secret1']);
      if (!wall) return null;
      if (!stayedHome(f, wall.at + 12, wall.at + 24, 3, { names: OUTSIDE })) return null;
      return { marks: { 'Smokes land': wall.at } };
    }
  },
  {
    key: 'secret-wall',
    label: 'Secret wall',
    group: 'wall',
    desc: 'secret1 + 2nd land, and 3+ players are in Yard / CT Yard or downstairs 4-24s after.',
    match(f) {
      const wall = smokeWall(f, SECRET_WALL, ['navi1']);
      if (!wall) return null;
      const at = spreadAt(f, wall.at + 4, wall.at + 24, 3, { names: OUTSIDE, lower: true });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, Committed: at } };
    }
  },
  {
    key: 'secret-wall-fake',
    label: 'Secret wall fake',
    group: 'wall',
    desc: 'secret1 + 2nd land, but 12-24s after there are 2 or fewer players out or downstairs and none left in T Yard or Silo.',
    match(f) {
      const wall = smokeWall(f, SECRET_WALL, ['navi1']);
      if (!wall) return null;
      if (!stayedHome(f, wall.at + 12, wall.at + 24, 3, { names: OUTSIDE, lower: true })) return null;
      return { marks: { 'Smokes land': wall.at } };
    }
  },
  {
    key: 'secret-rush',
    label: 'Secret rush',
    desc: 'start + secret1 + 2nd land, and 3 players are in Secret or downstairs within 15s.',
    match(f) {
      const wall = smokeWall(f, SECRET_RUSH_WALL);
      if (!wall) return null;
      const at = spreadAt(f, wall.at, wall.at + 15, 3, { names: SECRET, lower: true });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, 'In secret': at } };
    }
  },
  {
    key: 'a-split',
    label: 'A Split',
    desc: 'Any of the smoke walls goes up: secret1 + 2nd, navi1 + 2nd, or secret1 + navi1 + 2nd.',
    match(f) {
      const wall =
        smokeWall(f, FURIA_WALL) || smokeWall(f, SECRET_WALL) || smokeWall(f, NAVI_WALL);
      if (!wall) return null;
      return { marks: { 'Smokes land': wall.at } };
    }
  },
  {
    key: 'heroic-a',
    label: 'Heroic A',
    desc: 'hell + main land, and 3+ players go toward Yard / CT Yard / A Main within 24s.',
    match(f) {
      const wall = smokeWall(f, HEROIC_WALL);
      if (!wall) return null;
      const at = spreadAt(f, wall.at, wall.at + 24, 3, { names: [...OUTSIDE, ...A_MAIN] });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, Committed: at } };
    }
  },
  {
    key: 'heroic-b',
    label: 'Heroic B',
    desc: 'hell + main land, and 3+ players go toward Secret or downstairs within 24s.',
    match(f) {
      const wall = smokeWall(f, HEROIC_WALL);
      if (!wall) return null;
      const at = spreadAt(f, wall.at, wall.at + 24, 3, { names: SECRET, lower: true });
      if (at === null) return null;
      return { marks: { 'Smokes land': wall.at, Committed: at } };
    }
  },
  {
    key: 'passive-start',
    label: 'Passive start',
    desc: '4 of 5 players stay in T Lobby / T Yard until at least 1:20, utility aside.',
    match(f) {
      const until = secondsAtClock('1:20');
      let saw = false;
      for (const s of f.series) {
        if (s.sec > until) break;
        saw = true;
        if (f.countIn(T_START, s.sec) < 4) return null;
      }
      if (!saw) return null;
      return { marks: { 'Held until': until } };
    }
  }
];

// ---------------------------------------------------------------------------
// CT side, Nuke
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const NUK_CT = [
  {
    key: 'three-outside',
    label: '3 Outside fight',
    desc: '3 CTs out in Yard / CT Yard / T Yard together for 5s+, spawn not counted.',
    match(f) {
      // Two corrections against the painted map, both measured: CT spawn is a
      // member of the CT Yard zone, and the walk out of it crosses the yard.
      // Without the hold this is true in 100% of rounds at ~2s; with it, 17%.
      const run = longestRun(f.series, 0, f.lastSec, (sec) => {
        const ids = f.playersIn(OUTSIDE_ALL, sec);
        for (const id of f.playersIn(CT_SPAWN, sec)) ids.delete(id);
        return ids.size >= 3;
      });
      if (run.seconds < OUTSIDE_HOLD_SECONDS) return null;
      return { marks: { 'Three outside': run.start } };
    }
  },
  {
    key: 'awp-peek',
    label: 'm0NESY peek',
    desc: 'Before 1:37, a gla1ve smoke is thrown, the AWPer sits on Main wall / m0NESY, and takes a fight with a player in T Yard.',
    match(f) {
      const limit = secondsAtClock('1:37');
      const awp = f.awper(limit);
      if (!awp) return null;
      const smoke = f.nadesNamed('gla1ve').find((n) => n.at <= limit);
      if (!smoke) return null;
      let held = null;
      for (const s of f.series) {
        if (s.sec > limit) break;
        if (f.playersIn(AWP_PEEK, s.sec).has(awp)) {
          held = s.sec;
          break;
        }
      }
      if (held === null) return null;
      // Vision is not painted on this map, so "sees them" is read as the fight
      // it turns into: damage or a kill, either direction.
      const fight = f.fights({ from: 0, to: limit, enemyIn: T_YARD }).find((x) => x.ours === awp);
      if (!fight) return null;
      return { marks: { 'gla1ve smoke': smoke.at, 'On the peek': held, Contact: fight.sec } };
    }
  },
  {
    key: 'lobby-crunch',
    label: 'Lobby crunch',
    desc: 'All 5 CTs in A Door / A Anchor / Ramp, then 2+ of them inside Lobby within the next 12s.',
    match(f) {
      for (const s of f.series) {
        if (f.countIn([...A_ZONES, ...RAMP], s.sec) < 5) continue;
        const at = f.firstSecWith(LOBBY, 2, s.sec + 1, s.sec + 12);
        if (at === null) continue;
        return { marks: { Stacked: s.sec, 'In lobby': at } };
      }
      return null;
    }
  },
  {
    key: 'two-ramp',
    label: '2 Ramp',
    desc: '2 CTs hold Ramp for more than 8s inside the first 25s.',
    match(f) {
      const run = longestRun(f.series, 0, 25, (sec) => f.countIn(RAMP, sec) >= 2);
      if (run.seconds <= 8) return null;
      return { marks: { 'Both on ramp': run.start } };
    }
  },
  {
    key: 'door-peek',
    label: 'Door peek',
    desc: 'Inside the first 20s, a CT takes a fight with a T in Door / Lobby / Exit.',
    match(f) {
      const fight = f.fights({ from: 0, to: 20, enemyIn: T_DOORS })[0];
      if (!fight) return null;
      return { marks: { Contact: fight.sec } };
    }
  },
  {
    key: 'mid-lobby-crunch',
    label: 'Midround lobby crunch',
    desc: 'From a 1 A Anchor / 1 A Door / 1 Ramp / 1 outside setup, 2+ CTs are inside Lobby after 1:20.',
    match(f) {
      const snap = secondsAtClock('1:42');
      const setup =
        f.countIn(['A Anchor'], snap) >= 1 &&
        f.countIn(['A Door'], snap) >= 1 &&
        f.countIn(RAMP, snap) >= 1 &&
        f.countIn(OUTSIDE_ALL, snap) >= 1;
      if (!setup) return null;
      const at = f.firstSecWith(LOBBY, 2, secondsAtClock('1:20'), f.lastSec);
      if (at === null) return null;
      return { marks: { 'In lobby': at } };
    }
  },
  {
    key: 'mid-outside-fight',
    label: 'Midround outside fight',
    desc: 'After 1:30 an A Door / A Anchor player moves into Yard / CT Yard, with 3 CTs and 2 Ts trading duels inside 10s.',
    match(f) {
      const snap = secondsAtClock('1:42');
      const from = secondsAtClock('1:30');
      const started = f.playersIn(A_ZONES, snap);
      if (!started.size) return null;
      let moved = null;
      for (const s of f.series) {
        if (s.sec < from) continue;
        const out = f.playersIn(OUTSIDE, s.sec);
        if ([...started].some((id) => out.has(id))) {
          moved = s.sec;
          break;
        }
      }
      if (moved === null) return null;
      const fights = f.fights({ from, to: f.lastSec });
      for (const seed of fights) {
        const ours = new Set();
        const theirs = new Set();
        for (const g of fights) {
          if (g.sec < seed.sec || g.sec > seed.sec + 10) continue;
          ours.add(g.ours);
          theirs.add(g.enemy);
        }
        if (ours.size >= 3 && theirs.size >= 2) {
          return { marks: { 'Rotated out': moved, Duels: seed.sec } };
        }
      }
      return null;
    }
  }
];

// ---------------------------------------------------------------------------
// Inferno vocabulary
// ---------------------------------------------------------------------------

const T_A_AREA = ['T_A'];
const T_B_AREA = ['T_B'];
const APS_STAGE = ['Exit', 'Aps'];
const A_EXEC_STAGE = ['Exit', 'Aps', 'Top mid', 'Short', 'Boiler'];
/** Where a CT stands when the A side is being hit. */
const A_HOLDERS = ['Pit', 'Ropz', 'A', 'Device', 'Brollan', 'A HS', 'A site', 'Moto'];
const LONG = ['Long'];
const ARCH = ['Arch'];
const LIBRARY = ['Library'];
const B_CT = ['B CT'];
const B_SMOKE_GROUND = ['B boost', ...B_CT];
const B_COFFINS = ['B coffins'];
const B_MOLLY_GROUND = ['B 1st', 'B 2nd', 'B triple', 'B pillar', 'B dark'];
const B_FLASH_GROUND = ['B Site', 'B Hobbit', 'B'];
const B_SITE = ['B Site'];
const B_BANANA = ['B Banana'];
const FALLEN = ['FalleN'];
const B_POS = ['B'];
const B_RUINS = ['B Ruins'];
const TOP_MID = ['Top mid'];
const BOTTOM_MID = ['Bottom mid'];
const SECOND_MID = ['2nd mid'];
const T_BOILER = ['T boiler', 'Boiler'];
const BOILER = ['Boiler'];
const SHORT = ['Short'];
const MID_FLASH_GROUND = ['Mid + A', 'CT + Long'];
const BOILER_FLASH_GROUND = ['Mid', 'Top mid', 'Short', 'Boiler'];
const BANANA = ['Banana'];
const BANANA_TOP = ['Banana top'];
const BANANA_BOTTOM = ['Banana bottom', 'Ramp'];
const BANANA_LATE = ['Banana top', 'Car', 'Halfwall'];
const BANANA_QUIET = ['Logs', 'Post', 'Banana'];
const BANANA_HOLDERS = ['Banana top', 'Sandbags', 'Pasha', 'Halfwall', 'Car', 'Banana'];
const HALFWALL = ['Halfwall'];
const CAR_TOP = ['Car', 'Banana top'];
const BEDROOM = ['Bedroom'];
const APS_ANCHOR = ['Aps', 'Boiler', 'Bedroom'];
const A_ROAMS = ['Short', 'Hut', 'Top mid', 'Long cubby', 'Aps'];
const MID_ANCHOR = ['Boiler', 'Hut', 'Short', 'Top mid'];

/** Distinct players of ours who took one of these fights. */
const fighters = (list) => new Set(list.map((x) => x.ours));

/** The earliest second by which `min` distinct players had taken a fight. */
function nthFightSecond(list, min) {
  const seen = new Set();
  for (const f of [...list].sort((a, b) => a.sec - b.sec)) {
    seen.add(f.ours);
    if (seen.size >= min) return f.sec;
  }
  return null;
}

/** Earliest window of `span` holding `min` distinct players' arrivals. */
function arrivalsWithin(list, min, span) {
  const times = list.map((x) => x.arrivedAt).sort((a, b) => a - b);
  for (let i = 0; i + min - 1 < times.length; i++) {
    if (times[i + min - 1] - times[i] <= span) return { start: times[i], end: times[i + min - 1] };
  }
  return null;
}

/** No player of ours stays inside `names` for longer than `limit` seconds. */
function neverLingers(f, names, from, to, limit) {
  /** @type {Map<string, number>} id -> seconds inside so far */
  const run = new Map();
  for (const s of f.series) {
    if (s.sec < from || s.sec > to) continue;
    const inside = f.playersIn(names, s.sec);
    for (const id of f.ids) {
      const next = inside.has(id) ? (run.get(id) || 0) + SAMPLE_SECONDS : 0;
      if (next > limit) return false;
      run.set(id, next);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// T side, Inferno
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const INF_T = [
  {
    key: 'aps-pop',
    label: 'Aps pop',
    desc: '3+ players in Exit / Aps, a flash into T_A, and within 4s those players are fighting CTs on the A holds.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(APS_STAGE, s.sec);
        if (group.size < 3) continue;
        for (const flash of f.nadesIn('flashbang', T_A_AREA)) {
          if (flash.at < s.sec) continue;
          const hits = f.fights({
            from: flash.at,
            to: flash.at + 4,
            ours: group,
            enemyIn: A_HOLDERS
          });
          if (!hits.length) continue;
          return { marks: { Staged: s.sec, Flash: flash.at, Contact: hits[0].sec } };
        }
      }
      return null;
    }
  },
  {
    key: 'inf-a-execute',
    label: 'A execute',
    desc: '4+ players across Exit / Aps / Top mid / Short / Boiler, a moto smoke, 2+ flashes into T_A, and 2 players fighting the A holds inside 8s.',
    match(f) {
      const staged = f.firstSecWith(A_EXEC_STAGE, 4);
      if (staged === null) return null;
      const smoke = f.nadesNamed('moto').find((n) => n.type === 'smokegrenade');
      if (!smoke) return null;
      if (f.nadesIn('flashbang', T_A_AREA).filter((n) => n.at >= staged).length < 2) return null;
      const at = nthFightSecond(
        f.fights({ from: smoke.at, to: smoke.at + 8, enemyIn: A_HOLDERS }),
        2
      );
      if (at === null) return null;
      return { marks: { Staged: staged, 'Moto smoke': smoke.at, 'Second man in': at } };
    }
  },
  {
    key: 'long-wrap',
    label: 'Long wrap smokes',
    desc: 'arch and library land in Arch and Library within 6s of each other.',
    match(f) {
      const arch = f.nadesNamed('arch').find((n) => f.regions.inside(ARCH, n.x, n.y, n.z));
      const lib = f.nadesNamed('library').find((n) => f.regions.inside(LIBRARY, n.x, n.y, n.z));
      if (!arch || !lib) return null;
      if (Math.abs(arch.at - lib.at) > QUICK_SECONDS) return null;
      return { marks: { Arch: arch.at, Library: lib.at } };
    }
  },
  {
    key: 'long-to-ct',
    label: 'Long to CT',
    desc: 'A bsplit smoke, a flash into Long, and a player crossing Long into Arch within 15s of the smoke.',
    match(f) {
      const smoke = f.nadesNamed('bsplit')[0];
      if (!smoke) return null;
      if (!f.nadesIn('flashbang', LONG).length) return null;
      const moved = f.transitions(LONG, ARCH, { from: smoke.at - QUICK_SECONDS, to: smoke.at + 15 })[0];
      if (!moved) return null;
      return { marks: { 'bsplit smoke': smoke.at, 'Into arch': moved.arrivedAt } };
    }
  },
  {
    key: 'inf-b-execute',
    label: 'B execute',
    desc: 'Smokes on B boost / B ct and on B coffins, a molotov into the B ground, and a flash onto B before the first death.',
    match(f) {
      const wall = bSmokes(f);
      if (!wall) return null;
      const molly = f.nadesIn('molotov', B_MOLLY_GROUND)[0];
      if (!molly) return null;
      // "Before any new players die on this execute": the first death from the
      // moment the smokes are up, so a duel lost ten seconds earlier elsewhere
      // does not disqualify the execute.
      const firstDeath = [...f.deaths, ...f.enemy.deaths]
        .filter((sec) => sec >= wall.at)
        .sort((a, b) => a - b)[0];
      const flash = f
        .nadesIn('flashbang', B_FLASH_GROUND)
        .find((n) => firstDeath === undefined || n.at <= firstDeath);
      if (!flash) return null;
      return { marks: { 'Smokes land': wall.at, Molotov: molly.at, Flash: flash.at } };
    }
  },
  {
    key: 'inf-b-pop',
    label: 'B pop',
    excludes: ['inf-b-execute'],
    desc: 'A CT bblock smoke is up, and 3+ players cross FalleN into B inside 5s of each other.',
    match(f) {
      for (const smoke of f.enemy.nadesNamed('bblock')) {
        const moved = f.transitions(FALLEN, B_POS, {
          from: smoke.at,
          to: smoke.at + SMOKE_SECONDS
        });
        const window = arrivalsWithin(moved, 3, 5);
        if (!window) continue;
        return { marks: { 'bblock smoke': smoke.at, 'Third man in': window.end } };
      }
      return null;
    }
  },
  {
    key: 'inf-b-contact',
    label: 'B contact',
    desc: 'No bblock smoke and no B CT / B Ruins smoke: a 3-man group under 500 units takes a gunfight with a CT on Banana or B, and 2+ cross FalleN into B within 20s.',
    match(f) {
      if (f.enemy.nadesNamed('bblock').length) return null;
      if (f.nadesIn('smokegrenade', [...B_CT, ...B_RUINS]).length) return null;
      for (const s of f.series) {
        const group = f.cluster(3, 500, s.sec);
        if (!group) continue;
        const hit = f.fights({
          from: s.sec,
          ours: group,
          gunOnly: true,
          enemyIn: [...B_BANANA, ...B_SITE]
        })[0];
        if (!hit) continue;
        const moved = f.transitions(FALLEN, B_POS, { from: hit.sec, to: hit.sec + 20 });
        if (moved.length < 2) continue;
        return { marks: { Grouped: s.sec, Contact: hit.sec, 'Into B': moved[1].arrivedAt } };
      }
      return null;
    }
  },
  {
    key: 'inf-b-fake',
    label: 'B fake',
    desc: 'The B execute smokes and a flash go down, but at most 2 players reach Banana or B while 4+ are still alive.',
    match(f) {
      const wall = bSmokes(f);
      if (!wall) return null;
      const flash = f.nadesIn('flashbang', B_FLASH_GROUND)[0] || f.nades.find((n) => n.type === 'flashbang');
      if (!flash) return null;
      let held = null;
      for (const s of f.series) {
        if (s.sec < wall.at) continue;
        if (f.aliveCount(s.sec) < 4) continue;
        if (f.countIn([...B_BANANA, ...B_SITE], s.sec) > 2) return null;
        if (held === null) held = s.sec;
      }
      if (held === null) return null;
      return { marks: { 'Smokes land': wall.at, Flash: flash.at } };
    }
  },
  {
    key: 'mid-rush',
    label: 'Mid rush',
    desc: '3+ players in Top mid by 1:35.',
    match(f) {
      const at = f.firstSecWith(TOP_MID, 3, 0, secondsAtClock('1:35'));
      if (at === null) return null;
      return { marks: { 'Top mid': at } };
    }
  },
  {
    key: 'mid-pop',
    label: 'Mid pop',
    desc: '3+ in Bottom mid by 1:35 with Top mid still empty, then 2+ into Top mid before 1:20 and before anyone enters T boiler, with 2+ flashes into Mid / A / CT / Long inside 5s.',
    match(f) {
      const by135 = secondsAtClock('1:35');
      let staged = null;
      for (const s of f.series) {
        if (s.sec > by135) break;
        if (f.countIn(BOTTOM_MID, s.sec) >= 3 && f.countIn(TOP_MID, s.sec) === 0) {
          staged = s.sec;
          break;
        }
      }
      if (staged === null) return null;
      const by120 = secondsAtClock('1:20');
      const entered = f.firstSecWith(TOP_MID, 2, staged, by120);
      if (entered === null) return null;
      const boiler = f.firstSecWith(T_BOILER, 1, staged, by120);
      if (boiler !== null && boiler <= entered) return null;
      const flashes = f
        .nadesIn('flashbang', MID_FLASH_GROUND)
        .filter((n) => Math.abs(n.at - entered) <= 5);
      if (flashes.length < 2) return null;
      return { marks: { 'Bottom mid': staged, 'Into top mid': entered } };
    }
  },
  {
    key: 'boiler-pop',
    label: 'Boiler pop',
    desc: '2+ players in Boiler, a flash into Mid / Top mid / Short / Boiler, and both out in Short within 3s.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(BOILER, s.sec);
        if (group.size < 2) continue;
        for (const flash of f.nadesIn('flashbang', BOILER_FLASH_GROUND)) {
          if (flash.at < s.sec) continue;
          for (const t of f.series) {
            if (t.sec < flash.at || t.sec > flash.at + 3) continue;
            const out = f.playersIn(SHORT, t.sec);
            if ([...group].every((id) => out.has(id))) {
              return { marks: { 'In boiler': s.sec, Flash: flash.at, 'In short': t.sec } };
            }
          }
        }
      }
      return null;
    }
  },
  {
    key: 'mid-take',
    label: 'Mid take',
    desc: 'A long smoke, then within 6s a molotov on short and a player into Top mid or Short.',
    match(f) {
      for (const smoke of f.nadesNamed('long')) {
        if (smoke.type !== 'smokegrenade') continue;
        const molly = f
          .nadesNamed('short')
          .find((n) => n.type === 'molotov' && n.at >= smoke.at && n.at <= smoke.at + QUICK_SECONDS);
        if (!molly) continue;
        const at = f.firstSecWith([...TOP_MID, ...SHORT], 1, smoke.at, smoke.at + QUICK_SECONDS);
        if (at === null) continue;
        return { marks: { 'Long smoke': smoke.at, Molotov: molly.at, 'In mid': at } };
      }
      return null;
    }
  },
  {
    key: 'b-rush',
    label: 'B rush',
    desc: '4+ in the Banana zone and 2 in Banana by 1:35, one in Banana top and a B CT / B boost smoke by 1:30.',
    match(f) {
      const by135 = secondsAtClock('1:35');
      const by130 = secondsAtClock('1:30');
      const zone = f.firstSecWith(B_BANANA, 4, 0, by135);
      if (zone === null) return null;
      if (f.firstSecWith(BANANA, 2, 0, by135) === null) return null;
      const top = f.firstSecWith(BANANA_TOP, 1, 0, by130);
      if (top === null) return null;
      const smoke = f.nadesIn('smokegrenade', B_SMOKE_GROUND).find((n) => n.at <= by130);
      if (!smoke) return null;
      return { marks: { 'Banana full': zone, 'Banana top': top, Smoke: smoke.at } };
    }
  },
  {
    key: 'fast-banana',
    label: 'Fast banana take',
    desc: '3+ in the Banana zone and one in Banana by 1:35, with one in Banana top / Car / Halfwall by 1:30.',
    match(f) {
      const by135 = secondsAtClock('1:35');
      const zone = f.firstSecWith(B_BANANA, 3, 0, by135);
      if (zone === null) return null;
      if (f.firstSecWith(BANANA, 1, 0, by135) === null) return null;
      const deep = f.firstSecWith(BANANA_LATE, 1, 0, secondsAtClock('1:30'));
      if (deep === null) return null;
      return { marks: { 'Banana filled': zone, Deep: deep } };
    }
  },
  {
    key: 'banana-pop',
    label: 'Banana pop',
    desc: '3+ in Banana bottom / Ramp by 1:35 with Logs, Post and Banana empty, then a flash outside T_A and 2 of them fighting into B within 10s.',
    match(f) {
      const by135 = secondsAtClock('1:35');
      let staged = null;
      let group = null;
      for (const s of f.series) {
        if (s.sec > by135) break;
        const bottom = f.playersIn(BANANA_BOTTOM, s.sec);
        if (bottom.size < 3 || f.countIn(BANANA_QUIET, s.sec) > 0) continue;
        staged = s.sec;
        group = bottom;
        break;
      }
      if (staged === null) return null;
      for (const flash of f.nadesNotIn('flashbang', T_A_AREA)) {
        if (flash.at < staged) continue;
        const pushed = new Set([
          ...fighters(
            f.fights({ from: flash.at, to: flash.at + 10, ours: group, enemyIn: T_B_AREA })
          ),
          ...f.transitions(BANANA_BOTTOM, BANANA, { from: flash.at, to: flash.at + 10 })
            .map((x) => x.id)
            .filter((id) => group.has(id))
        ]);
        if (pushed.size < 2) continue;
        return { marks: { Staged: staged, Flash: flash.at } };
      }
      return null;
    }
  }
];

/** The pair of smokes that opens a B execute or a B fake. */
function bSmokes(f) {
  const ground = f.nadesIn('smokegrenade', B_SMOKE_GROUND)[0];
  const coffins = f.nadesIn('smokegrenade', B_COFFINS)[0];
  if (!ground || !coffins) return null;
  return { at: Math.max(ground.at, coffins.at), first: Math.min(ground.at, coffins.at) };
}

// ---------------------------------------------------------------------------
// CT side, Inferno
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const INF_CT = [
  {
    key: 'deep-banana',
    label: 'Deep banana take',
    desc: 'A deepbanana smoke, and 2 flashes thrown by CTs standing in the B Site / B Banana zones or B CT.',
    match(f) {
      const smoke = f.nadesNamed('deepbanana')[0];
      if (!smoke) return null;
      const flashes = f.nadesFrom('flashbang', [...B_SITE, ...B_BANANA, 'B ct']);
      if (flashes.length < 2) return null;
      return { marks: { 'deepbanana smoke': smoke.at, 'Second flash': flashes[1].at } };
    }
  },
  {
    key: 'fake-banana',
    label: 'Fake banana take',
    desc: 'A deepbanana smoke, and 3 flashes / molotovs / HEs into the Banana or B areas by 1:43.',
    match(f) {
      const smoke = f.nadesNamed('deepbanana')[0];
      if (!smoke) return null;
      const by143 = secondsAtClock('1:43');
      const support = f
        .nadesIn('', [...B_BANANA, ...B_SITE])
        .filter((n) => n.type !== 'smokegrenade' && n.at <= by143);
      if (support.length < 3) return null;
      return { marks: { 'deepbanana smoke': smoke.at, 'Third piece': support[2].at } };
    }
  },
  {
    key: 'french-default',
    label: 'French default',
    desc: 'A french smoke is thrown by the CTs.',
    match(f) {
      const smoke = f.nadesNamed('french')[0];
      return smoke ? { marks: { 'french smoke': smoke.at } } : null;
    }
  },
  {
    key: 'niko-default',
    label: 'Niko default',
    desc: 'A niko smoke is thrown by the CTs.',
    match(f) {
      const smoke = f.nadesNamed('niko')[0];
      return smoke ? { marks: { 'niko smoke': smoke.at } } : null;
    }
  },
  {
    key: 'banana-retake',
    label: 'Banana retake',
    desc: 'After 1:35, with banana given up, a smoke onto Halfwall plus a molotov on Car / Banana top or a flash out of the B Site zone.',
    match(f) {
      const from = secondsAtClock('1:35');
      for (const smoke of f.nadesIn('smokegrenade', HALFWALL)) {
        if (smoke.at < from) continue;
        // "Given up" is read at the moment the smoke goes down: nobody of ours
        // is still holding any of the banana ground.
        if (f.countIn(BANANA_HOLDERS, smoke.at) > 0) continue;
        const molly = f.nadesIn('molotov', CAR_TOP).find((n) => n.at >= smoke.at - QUICK_SECONDS);
        const flash = f.nadesFrom('flashbang', B_SITE).find((n) => n.at >= smoke.at - QUICK_SECONDS);
        if (!molly && !flash) continue;
        return {
          marks: {
            'Halfwall smoke': smoke.at,
            ...(molly ? { Molotov: molly.at } : {}),
            ...(flash ? { Flash: flash.at } : {})
          }
        };
      }
      return null;
    }
  },
  {
    key: 'passive-b',
    label: 'Passive B setup',
    desc: '2 CTs hold inside the B Site zone for 10s+ after 1:15, with 4 alive.',
    match(f) {
      const from = secondsAtClock('1:15');
      const run = longestRun(
        f.series,
        from,
        f.lastSec,
        (sec) => f.aliveCount(sec) >= 4 && f.countIn(B_SITE, sec) >= 2
      );
      if (run.seconds < 10) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'second-mid-push',
    label: '2nd mid push',
    desc: 'A G2 smoke lands before 1:45, with 2 CTs in Bottom mid / 2nd mid / Bedroom by 1:42.',
    match(f) {
      const smoke = f.nadesNamed('g2').find((n) => n.at <= secondsAtClock('1:45'));
      if (!smoke) return null;
      const at = f.firstSecWith(
        [...BOTTOM_MID, ...SECOND_MID, ...BEDROOM],
        2,
        0,
        secondsAtClock('1:42')
      );
      if (at === null) return null;
      return { marks: { 'G2 smoke': smoke.at, 'Mid filled': at } };
    }
  },
  {
    key: 'aps-setup',
    label: 'Aps setup',
    desc: 'After 1:35, 2+ CTs in Aps / Boiler / Bedroom for 10s+, or long enough to trade a kill there.',
    match(f) {
      const from = secondsAtClock('1:35');
      const run = longestRun(f.series, from, f.lastSec, (sec) => f.countIn(APS_ANCHOR, sec) >= 2);
      if (run.start === null) return null;
      if (run.seconds >= 10) return { marks: { 'Set from': run.start } };
      // Short of ten seconds it still counts when the pair traded a fight,
      // because a setup broken by a kill was still the setup that round.
      const traded = f.fights({ from: run.start, to: run.start + run.seconds })[0];
      if (!traded) return null;
      return { marks: { 'Set from': run.start, Contact: traded.sec } };
    }
  },
  {
    key: 'passive-a',
    label: 'Passive A setup',
    desc: 'From 1:30, 3 CTs on the A site and its key zones for 15s+, none of them stepping into Short / Hut / Top mid / Long cubby / Aps for more than 2s at a time.',
    match(f) {
      const from = secondsAtClock('1:30');
      for (const s of f.series) {
        if (s.sec < from || s.sec + 15 > f.lastSec) continue;
        let held = true;
        for (const t of f.series) {
          if (t.sec < s.sec || t.sec > s.sec + 15) continue;
          if (f.playersInSite('a', t.sec).size < 3) {
            held = false;
            break;
          }
        }
        if (!held) continue;
        if (!neverLingers(f, A_ROAMS, s.sec, s.sec + 15, 2)) continue;
        return { marks: { 'Set from': s.sec } };
      }
      return null;
    }
  },
  {
    key: 'mid-setup',
    label: 'Mid setup',
    desc: '2 CTs across Boiler / Hut / Short / Top mid for 10s+, with a third alongside them or holding Long.',
    match(f) {
      const run = longestRun(
        f.series,
        0,
        f.lastSec,
        (sec) => f.countIn(MID_ANCHOR, sec) >= 2 && f.countIn([...MID_ANCHOR, ...LONG], sec) >= 3
      );
      if (run.seconds < 10) return null;
      return { marks: { 'Set from': run.start } };
    }
  }
];

// ---------------------------------------------------------------------------
// Dust2 vocabulary
// ---------------------------------------------------------------------------

const DD2_T_B = ['T_B'];
const DD2_B_SITE = ['B Site'];
const B_TUNNELS = ['B Tunnels'];
const CT_MID = ['CT Mid'];
const A_SHORT = ['A Short'];
const A_SITE = ['A Site'];
const A_CT = ['A CT'];
const A_LONG = ['A Long'];
const T_LONG_AREA = ['T_LONG'];
const LONG_BOX = ['Long box'];
const OUTSIDE_LONG = ['Outside Long'];
const LONG_OUT = ['Outside Long', 'Blue'];
const LONG_CORNER = ['Long Corner'];
const SHORT_POS = ['Short', 'm0NESY'];
const LONG_POS = ['Outside Long', 'Blue', 'Shogu', 'Long Corner', 'Pit', 'Balcony'];
const A_HOLD = ['A Site', 'A CT', 'Long', 'Car'];
const SHORT_EXEC_MOLLY = ['Ramp', 'Goose', 'A Site', 'HS', 'Spanish'];
const MID_PUSH = ['Mid', 'Palms / TM'];
const LOWER = ['Lower'];
const M0NESY = ['m0NESY'];
const SHORT_ONLY = ['Short'];
/** Short setup holds for this long, and Mid fight default for this long. */
const SHORT_SETUP_SECONDS = 5;
const MID_DEFAULT_SECONDS = 20;

/** Distinct players of ours who took a fight, from a `fights` list. */
const uniqueFighters = (list) => new Set(list.map((x) => x.ours)).size;

/**
 * The B contact shape, shared by B Contact and B AWP Pop.
 *
 * Order is the whole definition: the group is together, the duel comes FIRST,
 * and the flashes and the door smoke come after. A flash landing on B before
 * the duel makes it an execute, not a contact.
 */
function bContact(f, { awpFirst = false } = {}) {
  const from = secondsAtClock('1:35');
  for (const s of f.series) {
    if (s.sec < from) continue;
    const group = f.playersIn([...B_TUNNELS, ...DD2_B_SITE], s.sec);
    if (group.size < 3) continue;
    const duel = f.fights({ from: s.sec, ours: group, enemyIn: DD2_B_SITE })[0];
    if (!duel) continue;
    if (awpFirst && !f.heldAwp(duel.ours, duel.sec)) continue;
    // Nothing on B may have been lit before the contact.
    if (f.nadesIn('flashbang', [...B_TUNNELS, ...DD2_B_SITE]).some((n) => n.at < duel.sec)) {
      continue;
    }
    const smoke = f.nadesNamed('bdoor').find((n) => n.at > duel.sec);
    if (!smoke) continue;
    return { marks: { Grouped: s.sec, Duel: duel.sec, 'Door smoke': smoke.at } };
  }
  return null;
}

/** Flashes that were released in, or landed in, the long approach. */
function longFlashes(f) {
  const seen = new Set();
  const out = [];
  for (const n of [...f.nadesIn('flashbang', T_LONG_AREA), ...f.nadesFrom('flashbang', T_LONG_AREA)]) {
    const key = `${n.player}@${n.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The lowest headcount inside `names` across every sample of the window. */
function minCountOver(f, names, from, to) {
  let min = Infinity;
  for (const s of f.series) {
    if (s.sec < from || s.sec > to) continue;
    min = Math.min(min, f.countIn(names, s.sec));
  }
  return min === Infinity ? 0 : min;
}

/**
 * The AWPer holds `names` from the round start until `until`, unless they die
 * or take a kill first — either of which ends the hold on its own terms.
 */
function awpHolds(f, names, until) {
  const awp = f.awper();
  if (!awp) return null;
  if (!f.playersIn(names, 0).has(awp)) return null;
  const died = f.deathSec(awp);
  const killed = f.fights({ killsOnly: true }).find((x) => x.ours === awp && x.killedThem);
  const release = Math.min(until, died ?? Infinity, killed?.sec ?? Infinity);
  for (const s of f.series) {
    if (s.sec <= 0 || s.sec > release) continue;
    if (!f.playersIn(names, s.sec).has(awp)) return null;
  }
  return { held: release, died, killed: killed?.sec ?? null };
}

// ---------------------------------------------------------------------------
// T side, Dust2
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const DD2_T = [
  {
    key: 'dd2-b-rush',
    label: 'B Rush',
    desc: 'A B Door smoke lands by 1:40 and 4+ players are in T_B or the B Site zone by 1:35.',
    match(f) {
      const smoke = f.nadesNamed('bdoor').find((n) => n.at <= secondsAtClock('1:40'));
      if (!smoke) return null;
      const at = f.firstSecWith([...DD2_T_B, ...DD2_B_SITE], 4, 0, secondsAtClock('1:35'));
      if (at === null) return null;
      return { marks: { 'Door smoke': smoke.at, 'Four on B': at } };
    }
  },
  {
    key: 'dd2-b-execute',
    label: 'B Execute',
    desc: 'After 1:35: a B Door smoke, 3+ flashes or 2 flashes and a molotov onto B, and 3+ players on B with 2 of them duelling.',
    match(f) {
      const from = secondsAtClock('1:35');
      const smoke = f.nadesNamed('bdoor').find((n) => n.at >= from);
      if (!smoke) return null;
      const flashes = f.nadesIn('flashbang', DD2_B_SITE).filter((n) => n.at >= from);
      const mollies = f.nadesIn('molotov', DD2_B_SITE).filter((n) => n.at >= from);
      if (flashes.length < 3 && !(flashes.length >= 2 && mollies.length >= 1)) return null;
      for (const s of f.series) {
        if (s.sec < from) continue;
        const group = f.playersIn([...B_TUNNELS, ...DD2_B_SITE], s.sec);
        if (group.size < 3) continue;
        const duels = f.fights({ from: s.sec, ours: group });
        if (uniqueFighters(duels) < 2) continue;
        return { marks: { 'Door smoke': smoke.at, Grouped: s.sec, Duels: duels[0].sec } };
      }
      return null;
    }
  },
  {
    key: 'dd2-b-awp-pop',
    label: 'B AWP Pop',
    desc: 'A B contact where the first player to trade damage had the AWP out.',
    match(f) {
      return bContact(f, { awpFirst: true });
    }
  },
  {
    key: 'dd2-b-contact',
    label: 'B Contact',
    excludes: ['dd2-b-awp-pop'],
    desc: 'After 1:35, 3+ players on B take the duel FIRST, with no flash on B before it, and the B Door smoke coming after.',
    match(f) {
      return bContact(f);
    }
  },
  {
    key: 'dd2-b-split',
    label: 'B Split',
    desc: 'A midtob smoke, a player in CT Mid and a player in B Tunnels, and a fight taken on a CT in CT Mid or on B.',
    match(f) {
      const smoke = f.nadesNamed('midtob')[0];
      if (!smoke) return null;
      let split = null;
      for (const s of f.series) {
        if (f.countIn(CT_MID, s.sec) >= 1 && f.countIn(B_TUNNELS, s.sec) >= 1) {
          split = s.sec;
          break;
        }
      }
      if (split === null) return null;
      const fight = f.fights({ enemyIn: [...CT_MID, ...DD2_B_SITE] })[0];
      if (!fight) return null;
      return { marks: { 'midtob smoke': smoke.at, Split: split, Contact: fight.sec } };
    }
  },
  {
    key: 'dd2-b-fake',
    label: 'B Fake',
    desc: 'A B Door smoke and a flash onto B Tunnels or B, but never more than 2 players in B Tunnels.',
    match(f) {
      const smoke = f.nadesNamed('bdoor')[0];
      if (!smoke) return null;
      const flash = f.nadesIn('flashbang', [...B_TUNNELS, ...DD2_B_SITE])[0];
      if (!flash) return null;
      for (const s of f.series) {
        if (s.sec < smoke.at) continue;
        if (f.countIn(B_TUNNELS, s.sec) > 2) return null;
      }
      return { marks: { 'Door smoke': smoke.at, Flash: flash.at } };
    }
  },
  {
    key: 'dd2-short-to-b',
    label: 'Short to B split',
    desc: 'short1st and short2nd go up with at most 2 players in A Short, then within 10s 2+ enter CT Mid with someone in B Tunnels.',
    match(f) {
      const wall = smokeWall(f, ['short1st', 'short2nd']);
      if (!wall) return null;
      if (f.countIn(A_SHORT, wall.at) > 2) return null;
      for (const s of f.series) {
        if (s.sec < wall.at || s.sec > wall.at + 10) continue;
        if (f.countIn(CT_MID, s.sec) >= 2 && f.countIn(B_TUNNELS, s.sec) >= 1) {
          return { marks: { 'Smokes land': wall.at, Split: s.sec } };
        }
      }
      return null;
    }
  },
  {
    key: 'dd2-short-execute',
    label: 'Short execute',
    desc: 'short1st and short2nd with 3+ players in A Short, a molotov onto the A ground within 8s, and 2 flashes thrown out of A Short, all inside 13s.',
    match(f) {
      const wall = smokeWall(f, ['short1st', 'short2nd']);
      if (!wall) return null;
      const staged = f.firstSecWith(A_SHORT, 3, wall.first - QUICK_SECONDS, wall.at + 13);
      if (staged === null) return null;
      const molly = f
        .nadesIn('molotov', SHORT_EXEC_MOLLY)
        .find((n) => n.at >= wall.at && n.at <= wall.at + 8);
      if (!molly) return null;
      const flashes = f
        .nadesFrom('flashbang', A_SHORT)
        .filter((n) => n.thrown >= wall.first && n.thrown <= wall.first + 13);
      if (flashes.length < 2) return null;
      return { marks: { 'Smokes land': wall.at, Staged: staged, Molotov: molly.at } };
    }
  },
  {
    key: 'dd2-short-pop',
    label: 'Short pop',
    desc: '3+ players in A Short take a fight, either on 2+ CTs holding A Short itself or on a CT in A CT / A Site / A Long.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(A_SHORT, s.sec);
        if (group.size < 3) continue;
        const onA = f.fights({ from: s.sec, ours: group, enemyIn: [...A_CT, ...A_SITE, ...A_LONG] })[0];
        // Fighting into short itself only counts as the call when the CTs are
        // actually contesting it in numbers, not one man caught out.
        const inShort = f
          .fights({ from: s.sec, ours: group, enemyIn: A_SHORT })
          .find((x) => f.enemy.countIn(A_SHORT, x.sec) >= 2);
        const hit = [onA, inShort].filter(Boolean).sort((a, b) => a.sec - b.sec)[0];
        if (!hit) continue;
        return { marks: { Staged: s.sec, Contact: hit.sec } };
      }
      return null;
    }
  },
  {
    key: 'dd2-fake-long',
    label: 'Fake long',
    desc: '2+ flashes thrown from or into T_LONG, and nobody enters Outside Long within 6s of them popping.',
    match(f) {
      const flashes = longFlashes(f);
      if (flashes.length < 2) return null;
      const second = flashes[1].at;
      if (f.firstSecWith(OUTSIDE_LONG, 1, second, second + QUICK_SECONDS) !== null) return null;
      return { marks: { 'Second flash': second } };
    }
  },
  {
    key: 'dd2-long-take',
    label: 'Long take',
    desc: 'A player crosses Long box into Outside Long or Blue by 1:43, with 2+ flashes from or into T_LONG.',
    match(f) {
      if (longFlashes(f).length < 2) return null;
      const by143 = secondsAtClock('1:43');
      const moved = f.transitions(LONG_BOX, LONG_OUT, { from: 0, to: by143 })[0];
      if (!moved) return null;
      return { marks: { 'Out of long box': moved.arrivedAt } };
    }
  },
  {
    key: 'dd2-long-pop',
    label: 'Long pop',
    desc: '2+ players cross Long box into Outside Long or Blue between 1:43 and 1:00, with 2+ flashes from or into T_LONG.',
    match(f) {
      if (longFlashes(f).length < 2) return null;
      const moved = f
        .transitions(LONG_BOX, LONG_OUT, { from: 0, to: secondsAtClock('1:00') })
        .filter((x) => x.arrivedAt >= secondsAtClock('1:43'));
      if (moved.length < 2) return null;
      return { marks: { 'Second man out': moved[1].arrivedAt } };
    }
  },
  {
    key: 'dd2-a-split',
    label: 'A Split',
    desc: 'A player alone in Short / m0NESY and another alone out long, 3v3 or better alive, with 2 of the CTs sitting on A.',
    match(f) {
      for (const s of f.series) {
        if (f.aliveCount(s.sec) < 3 || f.enemy.aliveCount(s.sec) < 3) continue;
        if (!f.countIn(SHORT_POS, s.sec) || f.enemy.countIn(SHORT_POS, s.sec)) continue;
        if (!f.countIn(LONG_POS, s.sec) || f.enemy.countIn(LONG_POS, s.sec)) continue;
        if (f.enemy.countIn(A_HOLD, s.sec) < 2) continue;
        return { marks: { Split: s.sec } };
      }
      return null;
    }
  }
];

// ---------------------------------------------------------------------------
// CT side, Dust2
// ---------------------------------------------------------------------------

/** The A headcount window: 1:51 to 1:39. */
const A_COUNT_FROM = secondsAtClock('1:51');
const A_COUNT_TO = secondsAtClock('1:39');
const A_COUNT_ZONES = ['A CT', 'A Long', 'A Site'];

/** @type {RoundTypeDef[]} */
const DD2_CT = [
  {
    key: 'dd2-four-long',
    label: '4 Long fight',
    group: 'a-count',
    desc: 'At 1:40, only 1 CT across CT Mid and B Site, in a 5v5.',
    match(f) {
      const at = secondsAtClock('1:40');
      if (f.aliveCount(at) < 5 || f.enemy.aliveCount(at) < 5) return null;
      if (f.countIn([...CT_MID, ...DD2_B_SITE], at) !== 1) return null;
      return { marks: { Measured: at } };
    }
  },
  {
    key: 'dd2-three-long',
    label: '3 Long fight',
    group: 'a-count',
    desc: '3 CTs across A CT / A Long / A Site for the whole 1:51 to 1:39 window.',
    match(f) {
      if (minCountOver(f, A_COUNT_ZONES, A_COUNT_FROM, A_COUNT_TO) < 3) return null;
      return { marks: { Measured: A_COUNT_FROM } };
    }
  },
  {
    key: 'dd2-two-long',
    label: '2 Long fight',
    group: 'a-count',
    desc: '2 CTs across A CT / A Long / A Site for the whole 1:51 to 1:39 window.',
    match(f) {
      if (minCountOver(f, A_COUNT_ZONES, A_COUNT_FROM, A_COUNT_TO) < 2) return null;
      return { marks: { Measured: A_COUNT_FROM } };
    }
  },
  {
    key: 'dd2-solo-long',
    label: 'Solo long take',
    group: 'a-count',
    desc: '1 CT across A CT / A Long / A Site for the whole 1:51 to 1:39 window.',
    match(f) {
      if (minCountOver(f, A_COUNT_ZONES, A_COUNT_FROM, A_COUNT_TO) < 1) return null;
      return { marks: { Measured: A_COUNT_FROM } };
    }
  },
  {
    key: 'dd2-long-molotovs',
    label: 'Long molotovs take',
    desc: 'A CT smoke lands in Long box.',
    match(f) {
      const smoke = f.nadesIn('smokegrenade', LONG_BOX)[0];
      if (!smoke) return null;
      return { marks: { Smoke: smoke.at } };
    }
  },
  {
    key: 'dd2-long-smokes',
    label: 'Long smokes take',
    desc: 'A CT molotov lands in Long box before any smoke does, or with no smoke at all.',
    match(f) {
      const molly = f.nadesIn('molotov', LONG_BOX)[0];
      if (!molly) return null;
      const smoke = f.nadesIn('smokegrenade', LONG_BOX)[0];
      if (smoke && smoke.at <= molly.at) return null;
      return { marks: { Molotov: molly.at } };
    }
  },
  {
    key: 'dd2-awp-long-late',
    label: 'AWP Long lateround',
    desc: 'The AWPer sits on Long Corner after 1:39.',
    match(f) {
      const awp = f.awper();
      if (!awp) return null;
      const from = secondsAtClock('1:39');
      for (const s of f.series) {
        if (s.sec < from) continue;
        if (f.playersIn(LONG_CORNER, s.sec).has(awp)) return { marks: { 'On the corner': s.sec } };
      }
      return null;
    }
  },
  {
    key: 'dd2-awp-mid-start',
    label: 'AWP Mid start',
    desc: 'The AWPer starts in CT Mid and holds it to 1:30, unless they die or take a kill first.',
    match(f) {
      const hold = awpHolds(f, CT_MID, secondsAtClock('1:30'));
      if (!hold) return null;
      return { marks: { 'Held to': hold.held } };
    }
  },
  {
    key: 'dd2-awp-short-start',
    label: 'AWP Short start',
    desc: 'The AWPer starts in A Short and holds it to 1:30, unless they die or take a kill first.',
    match(f) {
      const hold = awpHolds(f, A_SHORT, secondsAtClock('1:30'));
      if (!hold) return null;
      return { marks: { 'Held to': hold.held } };
    }
  },
  {
    key: 'dd2-mid-push',
    label: 'Mid push',
    desc: 'A CT is in Mid or Palms / TM by 1:40.',
    match(f) {
      const at = f.firstSecWith(MID_PUSH, 1, 0, secondsAtClock('1:40'));
      if (at === null) return null;
      return { marks: { 'In mid': at } };
    }
  },
  {
    key: 'dd2-ug-setup',
    label: 'UG setup',
    desc: '2+ CTs in Lower by 1:39.',
    match(f) {
      const at = f.firstSecWith(LOWER, 2, 0, secondsAtClock('1:39'));
      if (at === null) return null;
      return { marks: { 'In lower': at } };
    }
  },
  {
    key: 'dd2-short-setup',
    label: 'Short setup',
    desc: '2+ CTs together on m0NESY, or together on Short, for 5s+.',
    match(f) {
      for (const names of [M0NESY, SHORT_ONLY]) {
        const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(names, sec) >= 2);
        if (run.seconds >= SHORT_SETUP_SECONDS) return { marks: { 'Set from': run.start } };
      }
      return null;
    }
  },
  {
    key: 'dd2-mid-fight-default',
    label: 'Mid fight default',
    desc: 'A CT on m0NESY or A Short, a CT in CT Mid, and a third on either, held 20s+ from 1:39.',
    match(f) {
      // Measured from 1:39 rather than the round start, which is also what
      // keeps spawn out of it: the map paints "Bridge" into A Short and "CT"
      // into CT Mid, so at freeze end the shape is true in every round.
      const run = longestRun(
        f.series,
        secondsAtClock('1:39'),
        f.lastSec,
        (sec) =>
          f.countIn([...M0NESY, ...A_SHORT], sec) >= 1 &&
          f.countIn(CT_MID, sec) >= 1 &&
          f.countIn([...A_SHORT, ...M0NESY, ...CT_MID], sec) >= 3
      );
      if (run.seconds < MID_DEFAULT_SECONDS) return null;
      return { marks: { Set: run.start } };
    }
  }
];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/** Tag every round that matched nothing else. Never a `match` of its own. */
export const DEFAULT_TYPE = { key: 'default', label: 'Default / Other' };

/** @type {Record<string, { T: RoundTypeDef[], CT: RoundTypeDef[] }>} */
export const ROUND_LIBRARY = {
  NUK: { T: NUK_T, CT: NUK_CT },
  INF: { T: INF_T, CT: INF_CT },
  DD2: { T: DD2_T, CT: DD2_CT }
};

export function hasRoundLibrary(mapCode) {
  return Boolean(ROUND_LIBRARY[String(mapCode || '').toUpperCase()]);
}

/** Definitions for one map and side, strictest first. Never null. */
export function roundTypesFor(mapCode, side) {
  const bag = ROUND_LIBRARY[String(mapCode || '').toUpperCase()];
  const list = bag?.[side === 'CT' ? 'CT' : 'T'];
  return Array.isArray(list) ? list : [];
}

/** Every type of a map and side, Default last, for report and panel rows. */
export function roundTypeRows(mapCode, side) {
  const list = roundTypesFor(mapCode, side);
  if (!list.length) return [];
  return [
    ...list.map((d) => ({ key: d.key, label: d.label, desc: d.desc })),
    { ...DEFAULT_TYPE, desc: 'Any round that matched none of the above.' }
  ];
}

/**
 * Tag one side's round.
 *
 * @param {object} facts  the side facts from buildRoundFacts
 * @param {string} mapCode
 * @param {'T'|'CT'} side
 * @returns {Array<{ key: string, marks: Record<string, number> }>}
 */
export function classifyRoundTypes(facts, mapCode, side) {
  const defs = roundTypesFor(mapCode, side);
  if (!defs.length || !facts) return [];
  const out = [];
  const takenGroups = new Set();
  const taken = new Set();
  for (const def of defs) {
    // A round carries as many tags as it earns — a Navi fake early and an A
    // Execute late are one round and two calls. Suppression is only where a
    // definition says so: a family (`group`), or a named `excludes`.
    if (def.group && takenGroups.has(def.group)) continue;
    if (def.excludes?.some((key) => taken.has(key))) continue;
    let hit = null;
    try {
      hit = def.match(facts);
    } catch {
      hit = null;
    }
    if (!hit) continue;
    if (def.group) takenGroups.add(def.group);
    taken.add(def.key);
    const marks = {};
    for (const [name, sec] of Object.entries(hit.marks || {})) {
      if (Number.isFinite(sec)) marks[name] = Math.round(sec * 10) / 10;
    }
    out.push({ key: def.key, marks });
  }
  if (!out.length) out.push({ key: DEFAULT_TYPE.key, marks: {} });
  return out;
}

/**
 * The vocabulary each map's definitions lean on. A missing name is not an
 * error, it just means every definition built on it stays at zero rounds — so
 * the reports show this list and which of it the map actually has painted or
 * stored, rather than reporting the zeroes as findings.
 */
const READINESS = {
  NUK: {
    utility: [
      ...NAVI_WALL,
      ...SECRET_WALL,
      ...FURIA_WALL,
      ...HEROIC_WALL,
      ...SECRET_RUSH_WALL,
      'lurk',
      'gla1ve'
    ],
    regions: [
      ...A_ZONES.map((n) => [n]),
      A_MAIN,
      RAMP,
      LOBBY,
      RADIO,
      TROPHY,
      ...OUTSIDE_ALL.map((n) => [n]),
      SILO,
      SECRET,
      VENTS,
      AWP_PEEK,
      ['Door'],
      ['Exit'],
      LOBBY
    ]
  },
  INF: {
    utility: [
      'moto',
      'arch',
      'library',
      'bsplit',
      'bblock',
      'long',
      'short',
      'deepbanana',
      'french',
      'niko',
      'g2'
    ],
    regions: [
      T_A_AREA,
      T_B_AREA,
      ...A_EXEC_STAGE.map((n) => [n]),
      ...A_HOLDERS.map((n) => [n]),
      LONG,
      ARCH,
      LIBRARY,
      ...B_SMOKE_GROUND.map((n) => [n]),
      B_COFFINS,
      ...B_MOLLY_GROUND.map((n) => [n]),
      ...B_FLASH_GROUND.map((n) => [n]),
      B_BANANA,
      B_RUINS,
      FALLEN,
      BOTTOM_MID,
      SECOND_MID,
      T_BOILER,
      ...MID_FLASH_GROUND.map((n) => [n]),
      BANANA,
      ...BANANA_BOTTOM.map((n) => [n]),
      ...BANANA_HOLDERS.map((n) => [n]),
      BEDROOM,
      ...A_ROAMS.map((n) => [n])
    ]
  },
  DD2: {
    utility: ['bdoor', 'midtob', 'short1st', 'short2nd'],
    regions: [
      DD2_T_B,
      DD2_B_SITE,
      B_TUNNELS,
      CT_MID,
      A_SHORT,
      A_SITE,
      A_CT,
      A_LONG,
      T_LONG_AREA,
      LONG_BOX,
      OUTSIDE_LONG,
      LONG_CORNER,
      ...LONG_POS.map((n) => [n]),
      ...SHORT_POS.map((n) => [n]),
      ...A_HOLD.map((n) => [n]),
      ...SHORT_EXEC_MOLLY.map((n) => [n]),
      ...MID_PUSH.map((n) => [n]),
      LOWER
    ]
  }
};

/** Utility spot names the library needs on this map. */
export function requiredUtilityNames(mapCode) {
  const code = String(mapCode || '').toUpperCase();
  return [...new Set(READINESS[code]?.utility || [])].sort();
}

/**
 * Ground the library reads on this map, as groups of alternate spellings.
 *
 * A group is satisfied when any ONE of its names is painted, because that is
 * how the constants behave at match time: `['Lobby', 'T Lobby']` is one piece
 * of ground under whichever name the map happens to use. Reporting each name
 * separately would flag the spelling nobody chose as a missing region.
 *
 * @returns {string[][]}
 */
export function requiredRegionGroups(mapCode) {
  const code = String(mapCode || '').toUpperCase();
  const groups = READINESS[code]?.regions || [];
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const key = group.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(group);
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

/** The same groups as display strings, for tests and copy. */
export function requiredRegionNames(mapCode) {
  return requiredRegionGroups(mapCode).map((g) => g.join(' / '));
}
