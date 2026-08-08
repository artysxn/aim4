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

import {
  SAMPLE_SECONDS,
  SMOKE_SECONDS,
  burstWindow,
  longestRun,
  plainRegionName,
  secondsAtClock
} from './roundFacts.js';

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
// Anubis vocabulary
// ---------------------------------------------------------------------------

const ANU_B_STAGE = ['B Main', 'B Lobby'];
const ANU_B_MAIN = ['B Main'];
const ANU_B_IN = ['jail', 'B', 'YEKINDAR'];
const ANU_B_SITE = ['B Site'];
const ANU_CT_CON = ['CT Con'];
const ANU_B_DEFEND = ['B Site', 'CT Con'];
const ANU_CON = ['Con', 'Top Con'];
const BRIDGE = ['Bridge'];
const BLUE_CRAB = ['Blue', 'Crab'];
const BLUE_DOORS = ['Blue', 'Doors'];
const ANU_T_MID = ['T_MID'];
const ANU_MID_STAGE = ['Blue', 'Crab', 'Doors', 'Mid', 'Camera', 'NiKo'];
const ANU_MID = ['Mid'];
const CAMERA = ['Camera'];
const TEMPLE = ['Temple'];
const ANU_A_HOLD = ['A Site', 'Hell'];
const ANU_A_WATER = ['A Water'];
const ANU_A_SITE = ['A Site'];
const WATER_HOLD = ['ZywOo', 'B Water', 'Water'];
const WATER_FLASH = ['Water', 'm0NESY', 'B Water', 'Bridge', 'ZywOo'];
const WATER_SMOKE = ['m0NESY', 'Stairs'];
const ANU_A_MAIN = ['A Main'];
const ANU_A_ANCHOR = ['A Main', 'Pillar'];
const ANU_T_WATER_POS = ['Water', 'robot', 'm0NESY', 'Stairs', 'Carpets', 'B Water'];
const B_EXEC_SMOKES = ['bleft', 'palace'];

/** How long 2 CTs must sit on A before it is the 2A setup. */
const TWO_A_SECONDS = 15;

/** First landing of any of these stored smokes, or null. */
function firstNamed(f, names, type = 'smokegrenade') {
  let best = null;
  for (const name of names) {
    for (const n of f.nadesNamed(name)) {
      if (type && n.type !== type) continue;
      if (!best || n.at < best.at) best = n;
    }
  }
  return best;
}

/** Players of ours who moved out of `from` into `to` inside the window. */
const movedInto = (f, from, to, window) => f.transitions(from, to, window);

// ---------------------------------------------------------------------------
// T side, Anubis
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const ANU_T = [
  {
    key: 'anu-b-lurk',
    label: 'B Lurk moves',
    desc: 'A blurk smoke, then a player crossing B Main into jail / B / YEKINDAR within 15s.',
    match(f) {
      const smoke = f.nadesNamed('blurk')[0];
      if (!smoke) return null;
      const moved = movedInto(f, ANU_B_MAIN, ANU_B_IN, { from: smoke.at, to: smoke.at + 15 })[0];
      if (!moved) return null;
      return { marks: { 'blurk smoke': smoke.at, 'Into B': moved.arrivedAt } };
    }
  },
  {
    key: 'anu-b-fake',
    label: 'B Fake',
    desc: '2 players in B Main / B Lobby spend 2+ smokes and 2+ flashes onto CT Con or B, and at most 1 of them goes in.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(ANU_B_STAGE, s.sec);
        if (group.size < 2) continue;
        const byGroup = (type) =>
          f.nadesIn(type, ANU_B_DEFEND).filter((n) => group.has(n.player));
        const smokes = byGroup('smokegrenade');
        const flashes = byGroup('flashbang');
        if (smokes.length < 2 || flashes.length < 2) continue;
        if (f.playersDuring(ANU_B_IN, s.sec, f.lastSec).size > 1) continue;
        return { marks: { Staged: s.sec, Smokes: smokes[1].at, Flashes: flashes[1].at } };
      }
      return null;
    }
  },
  {
    key: 'anu-b-awp',
    label: 'B Contact with AWP',
    desc: 'A B Pop where the first player to trade damage had the AWP out.',
    match(f) {
      return anuBPop(f, { awpFirst: true });
    }
  },
  {
    key: 'anu-b-pop',
    label: 'B Pop',
    excludes: ['anu-b-awp'],
    desc: '4+ players in B Lobby / B Main, then inside 6s two of them are in jail / B / YEKINDAR and fighting, all before bleft or palace lands.',
    match(f) {
      return anuBPop(f);
    }
  },
  {
    key: 'anu-b-exec',
    label: 'B Exec',
    desc: '4+ players in B Lobby / B Main with a bleft or palace smoke, a flash and a molotov, all before they kill anyone holding B.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(ANU_B_STAGE, s.sec);
        if (group.size < 4) continue;
        const smoke = firstNamed(f, B_EXEC_SMOKES);
        if (!smoke) continue;
        const byGroup = (type) =>
          f.nades.filter((n) => n.type === type && group.has(n.player) && n.at >= s.sec);
        const flash = byGroup('flashbang')[0];
        const molly = byGroup('molotov')[0];
        if (!flash || !molly) continue;
        // The smoke has to be up before the first body drops on the site.
        const firstKill = f
          .fights({ from: s.sec, ours: group, killsOnly: true, enemyIn: ANU_B_DEFEND })
          .find((x) => x.killedThem);
        if (firstKill && smoke.at > firstKill.sec) continue;
        return { marks: { Staged: s.sec, Smoke: smoke.at, Flash: flash.at, Molotov: molly.at } };
      }
      return null;
    }
  },
  {
    key: 'anu-b-split',
    label: 'B Split',
    desc: 'A player in B Main / B Lobby and one in Con / Top Con, then 2 CTs holding B or CT Con in duels within 8s, 3v3 or better.',
    match(f) {
      for (const s of f.series) {
        if (f.aliveCount(s.sec) < 3 || f.enemy.aliveCount(s.sec) < 3) continue;
        if (!f.countIn(ANU_B_STAGE, s.sec) || !f.countIn(ANU_CON, s.sec)) continue;
        const duels = f.fights({ from: s.sec, to: s.sec + 8, enemyIn: ANU_B_DEFEND });
        if (new Set(duels.map((x) => x.enemy)).size < 2) continue;
        return { marks: { Split: s.sec, Duels: duels[0].sec } };
      }
      return null;
    }
  },
  {
    key: 'anu-mid-take',
    label: 'Mid take',
    desc: 'A player crosses Bridge into Blue / Crab by 1:00 with a smoke or molotov on Blue or Doors, or two players make the same move.',
    match(f) {
      const moved = movedInto(f, BRIDGE, BLUE_CRAB, { from: 0, to: secondsAtClock('1:00') });
      if (!moved.length) return null;
      if (moved.length >= 2) return { marks: { 'Second man': moved[1].arrivedAt } };
      const util = [
        ...f.nadesIn('smokegrenade', BLUE_DOORS),
        ...f.nadesIn('molotov', BLUE_DOORS)
      ].sort((a, b) => a.at - b.at)[0];
      if (!util) return null;
      return { marks: { 'Into mid': moved[0].arrivedAt, Utility: util.at } };
    }
  },
  {
    key: 'anu-mid-rush',
    label: 'Mid rush',
    desc: '2+ players cross Bridge into Crab / Blue by 1:30, with 4 in T_MID by 1:25.',
    match(f) {
      const moved = movedInto(f, BRIDGE, BLUE_CRAB, { from: 0, to: secondsAtClock('1:30') });
      if (moved.length < 2) return null;
      const filled = f.firstSecWith(ANU_T_MID, 4, 0, secondsAtClock('1:25'));
      if (filled === null) return null;
      return { marks: { 'Second man': moved[1].arrivedAt, 'Mid full': filled } };
    }
  },
  {
    key: 'anu-a-split',
    label: 'A Split',
    desc: 'A mid player crosses Mid into Camera and duels a CT on the A site or Hell.',
    match(f) {
      if (!f.playersDuring(ANU_MID_STAGE, 0, f.lastSec).size) return null;
      const moved = movedInto(f, ANU_MID, CAMERA, { from: 0, to: f.lastSec })[0];
      if (!moved) return null;
      const duel = f.fights({ from: moved.arrivedAt, enemyIn: ANU_A_HOLD })[0];
      if (!duel) return null;
      return { marks: { 'Into camera': moved.arrivedAt, Duel: duel.sec } };
    }
  },
  {
    key: 'anu-mid-temple',
    label: 'Mid to temple',
    desc: 'A mid player crosses Mid into Temple.',
    match(f) {
      if (!f.playersDuring(ANU_MID_STAGE, 0, f.lastSec).size) return null;
      const moved = movedInto(f, ANU_MID, TEMPLE, { from: 0, to: f.lastSec })[0];
      if (!moved) return null;
      return { marks: { 'Into temple': moved.arrivedAt } };
    }
  },
  {
    key: 'anu-a-rush',
    label: 'A Rush',
    desc: '4+ players in A Water or on the A site with a fight on an A holder before 1:35, and 3+ into the A site by 1:40.',
    match(f) {
      const staged = f.firstSecWith([...ANU_A_WATER, ...ANU_A_SITE], 4);
      if (staged === null) return null;
      const fight = f.fights({ to: secondsAtClock('1:35'), enemyIn: ANU_A_SITE })[0];
      if (!fight) return null;
      const entered = f.firstSecWith(ANU_A_SITE, 3, 0, secondsAtClock('1:40'));
      if (entered === null) return null;
      return { marks: { Staged: staged, Contact: fight.sec, 'Three on site': entered } };
    }
  },
  {
    key: 'anu-a-pop',
    label: 'A Pop',
    desc: '4+ players in A Water or on the A site, two of them entering and duelling two A holders inside 20s, before the heaven or camera smoke lands.',
    match(f) {
      const staged = f.firstSecWith([...ANU_A_WATER, ...ANU_A_SITE], 4);
      if (staged === null) return null;
      const smoke = firstNamed(f, ['heaven', 'camera']);
      const duels = f
        .fights({ from: staged, enemyIn: ANU_A_SITE })
        .filter((x) => smoke === null || x.sec < smoke.at);
      for (const seed of duels) {
        const window = duels.filter((x) => x.sec >= seed.sec && x.sec <= seed.sec + 20);
        if (new Set(window.map((x) => x.ours)).size < 2) continue;
        if (new Set(window.map((x) => x.enemy)).size < 2) continue;
        return { marks: { Staged: staged, Duels: seed.sec } };
      }
      return null;
    }
  }
];

/**
 * The B Pop shape, shared by B Pop and B Contact with AWP.
 *
 * Everything has to land inside six seconds of the stack forming, and all of
 * it before the execute smokes: a pop that waits for bleft is an execute.
 */
function anuBPop(f, { awpFirst = false } = {}) {
  const smoke = firstNamed(f, B_EXEC_SMOKES);
  for (const s of f.series) {
    const group = f.playersIn(ANU_B_STAGE, s.sec);
    if (group.size < 4) continue;
    const end = s.sec + QUICK_SECONDS;
    if (smoke && smoke.at <= end) continue;
    const inside = f
      .transitions(ANU_B_STAGE, ANU_B_IN, { from: s.sec, to: end })
      .filter((x) => group.has(x.id));
    if (inside.length < 2) continue;
    const fight = f.fights({ from: s.sec, to: end, ours: group })[0];
    if (!fight) continue;
    if (awpFirst && !f.heldAwp(fight.ours, fight.sec)) continue;
    return { marks: { Staged: s.sec, 'Second man in': inside[1].arrivedAt, Contact: fight.sec } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CT side, Anubis
// ---------------------------------------------------------------------------

/** The water hold shared by Water crunch and Delayed water fight. */
function waterHold(f, { from, to }) {
  for (const flash of f.nadesIn('flashbang', WATER_FLASH)) {
    if (flash.at < from || flash.at > to) continue;
    const held = f.playersIn(WATER_HOLD, flash.at);
    if (!held.size) continue;
    return { flash, held };
  }
  return null;
}

/** @type {RoundTypeDef[]} */
const ANU_CT = [
  {
    key: 'anu-water-crunch',
    label: 'Water crunch',
    desc: 'A smoke on m0NESY or Stairs by 1:44, a CT holding ZywOo / B Water / Water, and a flash onto the water ground by 1:43.',
    match(f) {
      const smoke = f
        .nadesIn('smokegrenade', WATER_SMOKE)
        .find((n) => n.at <= secondsAtClock('1:44'));
      if (!smoke) return null;
      const hold = waterHold(f, { from: 0, to: secondsAtClock('1:43') });
      if (!hold) return null;
      return { marks: { Smoke: smoke.at, Flash: hold.flash.at } };
    }
  },
  {
    key: 'anu-delayed-water',
    label: 'Delayed water fight',
    desc: 'The same water hold, but the flash lands between 1:43 and 1:15 with 8+ players still alive, and turns into a gunfight.',
    match(f) {
      const hold = waterHold(f, { from: secondsAtClock('1:43'), to: secondsAtClock('1:15') });
      if (!hold) return null;
      const at = hold.flash.at;
      if (f.aliveCount(at) + f.enemy.aliveCount(at) < 8) return null;
      const fight = f.fights({ from: at, ours: hold.held, gunOnly: true })[0];
      if (!fight) return null;
      return { marks: { Flash: at, Contact: fight.sec } };
    }
  },
  {
    key: 'anu-b-search',
    label: 'B Main search',
    desc: '2+ CTs go into B Main, or one does with a CT flash landing in B Main or B Lobby.',
    match(f) {
      const been = f.playersDuring(ANU_B_MAIN, 0, f.lastSec);
      if (!been.size) return null;
      const at = f.firstSecWith(ANU_B_MAIN, 1);
      if (been.size >= 2) return { marks: { 'In B main': at } };
      const flash = f.nadesIn('flashbang', ANU_B_STAGE)[0];
      if (!flash) return null;
      return { marks: { 'In B main': at, Flash: flash.at } };
    }
  },
  {
    key: 'anu-2a-setup',
    label: '2A setup',
    desc: '2+ CTs in A Main or Pillar for more than 15s straight.',
    match(f) {
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(ANU_A_ANCHOR, sec) >= 2);
      if (run.seconds <= TWO_A_SECONDS) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'anu-a-main-push',
    label: 'A main push',
    desc: 'A CT goes into A Main and takes a gunfight with a T on the water ground.',
    match(f) {
      const been = f.playersDuring(ANU_A_MAIN, 0, f.lastSec);
      if (!been.size) return null;
      const fight = f.fights({ ours: been, gunOnly: true, enemyIn: ANU_T_WATER_POS })[0];
      if (!fight) return null;
      return { marks: { Contact: fight.sec } };
    }
  }
];

// ---------------------------------------------------------------------------
// Ancient vocabulary
// ---------------------------------------------------------------------------

/** The staging ground: the whole ramp, zone and position alike. */
const ANC_B_RAMP = ['B Ramp'];
const ANC_B_SITE = ['B + Backsite'];
const ANC_B_CAVE = ['B Cave'];
/** Whoever is holding B: the site itself, or the cave beside it. */
const ANC_B_DEFEND = ['B + Backsite', 'B Cave'];
/**
 * "Into B": the site, or the B Ramp POSITION at the top of it.
 *
 * Qualified, because Ancient paints a B Ramp position inside a B Ramp zone and
 * they are different ground. Unqualified this would resolve to both, and the
 * clause would be true of the stack that is already standing on the ramp.
 */
const ANC_B_ENTER = ['B + Backsite', 'pos:B Ramp'];
const ANC_B_STREET = ['B Street'];
const ANC_T_SPAWN = ['T Spawn'];
const ANC_B_STAGE = ['B Ramp', 'B Street', 'T Spawn'];
const ANC_LURK_GROUND = ['B Ramp', 'B + Backsite', 'NiKo'];
const ANC_B_DOOR = ['B Door'];

const ANC_MID_1 = ['Mid 1'];
const ANC_MID_2 = ['Mid 2'];
const ANC_MID_3 = ['Mid 3'];
const ANC_ELBOW = ['Elbow'];
const ANC_LEDGE = ['Ledge'];
const ANC_RUNBOOST = ['runboost'];
const ANC_STREET = ['Street'];
const ANC_HEAVEN = ['Heaven'];
const ANC_CT_MID = ['CT Mid'];
const ANC_CT_WINDOW = ['CT Window'];
const ANC_CT_DONUT = ['CT Donut'];
const ANC_WINDOW = ['Window'];
const ANC_MID_HOLD = ['CT Mid', 'CT Window', 'CT Donut'];
const ANC_STEP_UP = ['Mid 2', 'Ledge'];

const ANC_A_MAIN = ['A Main'];
const ANC_A_POS = ['A'];
/** Where an A smoke has to land before it is part of the call. */
const ANC_A_SMOKE_GROUND = ['A Donut', 'Donut', 'A Default', 'A CT'];
const ANC_A_SITE = ['A Site'];
const ANC_CT_SPAWN = ['CT Spawn'];
const ANC_A_DEFEND = ['A Site', 'CT Donut', 'CT Spawn'];
const ANC_REDROOM = ['Redroom'];
const ANC_CT_CAVE = ['CT Cave'];

/** The street ground, and the door-smoke ground, are the same three names. */
const ANC_STREET_TAKE = ['Heaven', 'Street', 'B Ramp'];
/** And the positions a CT reaches once that take has actually gone through. */
const ANC_STREET_THROUGH = ['Street', 'Bucket', 'Under boost', 'B Street'];
const ANC_DOOR_FIGHT_GROUND = ['B Door', 'B Street', 'B Ramp'];

/** T smokes that turn a B Ramp pop into a B Execute once they are down. */
const ANC_B_EXEC_SMOKES = ['short', 'long', 'bcave'];
/** The B fake's spend: any of these smokes, or the pillar molotov. */
const ANC_B_FAKE_SMOKES = ['bcave', 'short', 'long'];
const ANC_MID_FAKE_MOLLYS = ['jungle', 'heaven', 'tmid'];
const ANC_MID_FAKE_THROW = ['T Spawn', 'T Mid', 'Elbow', 'Kabbah'];
const ANC_MID_MOLLYS = ['elbowmolo', 'deepmid', 'closemid'];

/** "Remain there": longer than this many consecutive seconds on the ground. */
const ANC_STREET_HOLD_SECONDS = 2;
/** How long three CTs have to share mid before it is a shape and not a walk. */
const ANC_MID_HOLD_SECONDS = 6;

/** First second each of ours was inside `names`, keyed by player. */
function firstEntries(f, names) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const s of f.series) {
    for (const p of f.ptsAt(s.sec)) {
      if (out.has(p.id)) continue;
      if (f.regions.inside(names, p.x, p.y, p.z)) out.set(p.id, s.sec);
    }
  }
  return out;
}

/** True when this contact's enemy was standing inside `names`. */
function enemyIn(f, fight, names) {
  const at = f.pointAt(fight.enemy, fight.sec);
  return Boolean(at) && f.regions.inside(names, at.x, at.y, at.z);
}

/** True when the player who took this contact was standing inside `names`. */
function ourFighterIn(f, fight, names) {
  const at = f.pointAt(fight.ours, fight.sec);
  return Boolean(at) && f.regions.inside(names, at.x, at.y, at.z);
}

/**
 * A kill or a death of ours on `names` inside the window.
 *
 * Both directions, because the lurk smoke asks whether anything happened on
 * that ground at all: a lurker who trades and a lurker who gets traded are the
 * same answer to "was this smoke live".
 */
function actionOn(f, names, from, to) {
  for (const x of f.fights({ from, to, killsOnly: true })) {
    if (x.killedThem ? enemyIn(f, x, names) : ourFighterIn(f, x, names)) return x;
  }
  return null;
}

/** `min`+ of ours on the street ground, held past the two-second floor. */
function ancStreetTake(f, from, to, min) {
  const run = longestRun(f.series, from, to, (sec) => f.countIn(ANC_STREET_TAKE, sec) >= min);
  return run.seconds > ANC_STREET_HOLD_SECONDS ? run : null;
}

/**
 * The B Ramp push, shared by B Pop and B Execute.
 *
 * Identical either way: three on the ramp, two of them trading with whoever
 * holds the site after 1:40, and a body inside afterwards if anyone dropped.
 * The one thing that separates the two calls is which side of the short / long
 * / bcave smokes the fight happened on, so that is the only argument.
 */
function ancBRampPush(f, { afterSmokes }) {
  const smoke = firstNamed(f, ANC_B_EXEC_SMOKES);
  if (afterSmokes && !smoke) return null;
  const opened = secondsAtClock('1:40');
  for (const s of f.series) {
    const group = f.playersIn(ANC_B_RAMP, s.sec);
    if (group.size < 3) continue;
    const duels = f
      .fights({ from: Math.max(s.sec, opened), ours: group, enemyIn: ANC_B_DEFEND })
      .filter((x) => (afterSmokes ? x.sec >= smoke.at : !smoke || x.sec < smoke.at));
    if (new Set(duels.map((x) => x.ours)).size < 2) continue;
    // Trading and then never walking in is a fake, not a push. Only asked of
    // rounds where the trade actually landed.
    const killed = duels.some((x) => x.killedThem);
    const entered = f.firstSecWith(ANC_B_ENTER, 1, s.sec, f.lastSec);
    if (killed && entered === null) continue;
    const marks = { Staged: s.sec, Contact: duels[0].sec };
    if (smoke) marks.Smoke = smoke.at;
    if (entered !== null) marks['In B'] = entered;
    return { marks };
  }
  return null;
}

/**
 * Two of an A Main stack committing: onto the site, or into the holders.
 *
 * Shared by A Rush and A Execute, which differ only in how many smokes had to
 * land and how early.
 */
function ancACommit(f, group, from) {
  const inside = [...f.playersDuring(ANC_A_POS, from, f.lastSec)].filter((id) => group.has(id));
  const duels = f.fights({ from, ours: group, enemyIn: ANC_A_DEFEND });
  if (new Set([...inside, ...duels.map((x) => x.ours)]).size < 2) return null;
  const onSite = f.firstSecWith(ANC_A_POS, 1, from);
  const times = [duels[0]?.sec, onSite].filter((x) => Number.isFinite(x));
  return times.length ? Math.min(...times) : from;
}

/** The A smokes: how many landed on the site ground, and by when they left the hand. */
function ancASmokes(f, { thrownBy = null, thrownAfter = null } = {}) {
  return f.nadesIn('smokegrenade', ANC_A_SMOKE_GROUND).filter((n) => {
    if (thrownBy !== null && n.thrown > thrownBy) return false;
    if (thrownAfter !== null && n.thrown < thrownAfter) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// T side, Ancient
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const ANC_T = [
  {
    key: 'anc-b-rush',
    label: 'B Rush',
    desc: '4+ on B Ramp with two of them trading with the B + Backsite / B Cave holders by 1:40, and 2 into B by 1:33.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(ANC_B_RAMP, s.sec);
        if (group.size < 4) continue;
        const duels = f.fights({
          from: s.sec,
          to: secondsAtClock('1:40'),
          ours: group,
          enemyIn: ANC_B_DEFEND
        });
        if (new Set(duels.map((x) => x.ours)).size < 2) continue;
        const entered = f.firstSecWith(ANC_B_ENTER, 2, 0, secondsAtClock('1:33'));
        if (entered === null) continue;
        return { marks: { Staged: s.sec, Contact: duels[0].sec, 'Two in': entered } };
      }
      return null;
    }
  },
  {
    key: 'anc-b-awp',
    label: 'B AWP search',
    desc: '2+ on B Ramp, and the first of them to trade with a B holder by 1:28 had the AWP out.',
    match(f) {
      const staged = f.firstSecWith(ANC_B_RAMP, 2);
      if (staged === null) return null;
      // The FIRST contact, not the first one an AWPer happened to take: a
      // rifler opening the round is a different call however it ends.
      const fight = f.fights({
        from: staged,
        to: secondsAtClock('1:28'),
        enemyIn: ANC_B_DEFEND
      })[0];
      if (!fight || !f.heldAwp(fight.ours, fight.sec)) return null;
      return { marks: { Staged: staged, 'AWP contact': fight.sec } };
    }
  },
  {
    key: 'anc-b-pop',
    label: 'B Pop',
    desc: '3+ on B Ramp, two of them trading with the B holders after 1:40 and before any short / long / bcave smoke lands.',
    match(f) {
      return ancBRampPush(f, { afterSmokes: false });
    }
  },
  {
    key: 'anc-b-exec',
    label: 'B Execute',
    desc: 'The same push, with the trade coming after a short / long / bcave smoke has landed.',
    match(f) {
      return ancBRampPush(f, { afterSmokes: true });
    }
  },
  {
    key: 'anc-b-split',
    label: 'B Split',
    desc: 'A player in B Cave and one on B Ramp trading with a holder, a body following into B inside 12s from cave or 8s from ramp, and a smoke on the site.',
    match(f) {
      const smoke = f.nadesIn('smokegrenade', ANC_B_SITE)[0];
      if (!smoke) return null;
      for (const s of f.series) {
        if (!f.countIn(ANC_B_CAVE, s.sec) || !f.countIn(ANC_B_RAMP, s.sec)) continue;
        const fight = f.fights({
          from: s.sec,
          enemyIn: [...ANC_B_CAVE, ...ANC_B_RAMP, ...ANC_B_SITE]
        })[0];
        if (!fight) continue;
        // Where the fight happened sets the follow-up: cave gives them longer,
        // and cave alone is allowed to be the ground they follow onto.
        const inCave = enemyIn(f, fight, ANC_B_CAVE);
        const span = inCave ? 12 : 8;
        const target = inCave ? [...ANC_B_CAVE, ...ANC_B_SITE] : ANC_B_SITE;
        const follow = f.firstSecWith(target, 1, fight.sec, fight.sec + span);
        if (follow === null) continue;
        return { marks: { Split: s.sec, Contact: fight.sec, Follow: follow, Smoke: smoke.at } };
      }
      return null;
    }
  },
  {
    key: 'anc-b-fake',
    label: 'B Fake',
    desc: '2 or fewer on B Ramp / B Street / T Spawn spending a bcave, short or long smoke, the pillar molotov, or 2 flashes onto the site, and none of them goes in.',
    match(f) {
      for (const s of f.series) {
        const group = f.playersIn(ANC_B_STAGE, s.sec);
        if (!group.size || group.size > 2) continue;
        const byGroup = (list) => list.filter((n) => group.has(n.player) && n.at >= s.sec);
        const smoke = byGroup(
          ANC_B_FAKE_SMOKES.flatMap((name) =>
            f.nadesNamed(name).filter((n) => n.type === 'smokegrenade')
          )
        ).sort((a, b) => a.at - b.at)[0];
        const pillar = byGroup(f.nadesNamed('pillar').filter((n) => n.type === 'molotov'))[0];
        const flashes = byGroup(f.nadesIn('flashbang', ANC_B_SITE));
        const spend = smoke || pillar || (flashes.length >= 2 ? flashes[1] : null);
        if (!spend) continue;
        // The fakers are the ones who must stay out; the rest of the side is
        // free to be anywhere, which is rather the point of a fake.
        const wentIn = [...f.playersDuring(ANC_B_SITE, s.sec, f.lastSec)].some((id) =>
          group.has(id)
        );
        if (wentIn) continue;
        return { marks: { Staged: s.sec, Spend: spend.at } };
      }
      return null;
    }
  },
  {
    key: 'anc-b-lurk',
    label: 'B Lurk smoke',
    group: 'anc-b-lurk',
    desc: 'A blurk smoke, and while it is up somebody enters B + Backsite, or kills or dies on B Ramp / B + Backsite / NiKo.',
    match(f) {
      const smoke = f.nadesNamed('blurk')[0];
      if (!smoke) return null;
      const end = smoke.at + SMOKE_SECONDS;
      const entered = f.firstSecWith(ANC_B_SITE, 1, smoke.at, end);
      const traded = actionOn(f, ANC_LURK_GROUND, smoke.at, end);
      if (entered === null && !traded) return null;
      const marks = { 'blurk smoke': smoke.at };
      if (entered !== null) marks['Into B'] = entered;
      if (traded) marks.Contact = traded.sec;
      return { marks };
    }
  },
  {
    key: 'anc-b-lurk-fake',
    label: 'B Lurk smoke fake',
    group: 'anc-b-lurk',
    desc: 'The same blurk smoke with none of that: nobody enters B + Backsite and nothing trades on that ground while it is up.',
    match(f) {
      const smoke = f.nadesNamed('blurk')[0];
      if (!smoke) return null;
      const end = smoke.at + SMOKE_SECONDS;
      if (f.firstSecWith(ANC_B_SITE, 1, smoke.at, end) !== null) return null;
      if (actionOn(f, ANC_LURK_GROUND, smoke.at, end)) return null;
      return { marks: { 'blurk smoke': smoke.at } };
    }
  },
  {
    key: 'anc-mid-rush',
    label: 'Mid rush',
    desc: 'A player crossing Elbow into Mid 1 by 1:46.',
    match(f) {
      const moved = f.transitions(ANC_ELBOW, ANC_MID_1, { from: 0, to: secondsAtClock('1:46') })[0];
      if (!moved) return null;
      return { marks: { 'Into mid': moved.arrivedAt } };
    }
  },
  {
    key: 'anc-mid-pop',
    label: 'Mid pop',
    desc: 'The same crossing after 1:46, made into a live CT elbow smoke.',
    match(f) {
      const moved = f.transitions(ANC_ELBOW, ANC_MID_1, {
        from: secondsAtClock('1:46'),
        to: f.lastSec
      })[0];
      if (!moved) return null;
      const smoke = f.enemy
        .nadesNamed('elbow')
        .find((n) => moved.arrivedAt >= n.at && moved.arrivedAt <= n.at + SMOKE_SECONDS);
      if (!smoke) return null;
      return { marks: { 'CT elbow smoke': smoke.at, 'Into mid': moved.arrivedAt } };
    }
  },
  {
    key: 'anc-mid-split',
    label: 'Mid split',
    desc: 'Elbow into Mid 1 after 1:42 with Street into Heaven inside 3s, then a duel into CT Mid / Heaven / Mid 2, or 2 bodies past Mid 1 by 1:30.',
    match(f) {
      const inMid = f.transitions(ANC_ELBOW, ANC_MID_1, {
        from: secondsAtClock('1:42'),
        to: f.lastSec
      });
      const toHeaven = f.transitions(ANC_STREET, ANC_HEAVEN, { from: 0, to: f.lastSec });
      // Ground inside CT Mid that is not Mid 1, counted body by body: the
      // second clause is about getting PAST the choke, not standing in it.
      const pastMid1 = (sec) =>
        f
          .ptsAt(sec)
          .filter(
            (p) =>
              f.regions.inside(ANC_CT_MID, p.x, p.y, p.z) &&
              !f.regions.inside(ANC_MID_1, p.x, p.y, p.z)
          ).length;
      for (const mid of inMid) {
        const up = toHeaven.find((x) => Math.abs(x.arrivedAt - mid.arrivedAt) <= 3);
        if (!up) continue;
        const pair = new Set([mid.id, up.id]);
        const from = Math.min(mid.arrivedAt, up.arrivedAt);
        const duel =
          f.fights({ from, ours: pair, enemyIn: [...ANC_CT_MID, ...ANC_HEAVEN] })[0] ||
          f
            .fights({ from, ours: pair, enemyIn: ANC_MID_2 })
            .find((x) => ourFighterIn(f, x, ANC_STREET));
        if (duel) {
          return { marks: { 'Into mid': mid.arrivedAt, Heaven: up.arrivedAt, Duel: duel.sec } };
        }
        for (const s of f.series) {
          if (s.sec < from || s.sec > secondsAtClock('1:30')) continue;
          if (pastMid1(s.sec) >= 2) {
            return { marks: { 'Into mid': mid.arrivedAt, Heaven: up.arrivedAt, 'Past mid': s.sec } };
          }
        }
      }
      return null;
    }
  },
  {
    key: 'anc-mid-fake',
    label: 'Mid fake',
    desc: 'A window smoke, then a jungle / heaven / tmid molotov, then 2 flashes out of T Spawn / T Mid / Elbow / Kabbah by 1:41, with nobody into Mid 1 by 1:41 or Heaven by 1:37.',
    match(f) {
      const smoke = f.nadesNamed('window').filter((n) => n.type === 'smokegrenade')[0];
      if (!smoke) return null;
      const molly = firstNamed(f, ANC_MID_FAKE_MOLLYS, 'molotov');
      if (!molly || molly.at < smoke.at) return null;
      const flashes = f
        .nadesFrom('flashbang', ANC_MID_FAKE_THROW)
        .filter((n) => n.at >= molly.at && n.at <= secondsAtClock('1:41'));
      if (flashes.length < 2) return null;
      // The whole call is the absence of the take behind the spend.
      if (f.transitions(ANC_ELBOW, ANC_MID_1, { from: 0, to: secondsAtClock('1:41') }).length) {
        return null;
      }
      if (f.playersDuring(ANC_HEAVEN, 0, secondsAtClock('1:37')).size) return null;
      return {
        marks: { 'Window smoke': smoke.at, Molotov: molly.at, 'Second flash': flashes[1].at }
      };
    }
  },
  {
    key: 'anc-a-rush',
    label: 'A Rush',
    desc: 'A smoke onto A Donut / Donut / A Default / A CT thrown by 1:39, 3+ in A Main by 1:37, and two of them onto A or into its holders.',
    match(f) {
      const smoke = ancASmokes(f, { thrownBy: secondsAtClock('1:39') })[0];
      if (!smoke) return null;
      for (const s of f.series) {
        if (s.sec > secondsAtClock('1:37')) break;
        const group = f.playersIn(ANC_A_MAIN, s.sec);
        if (group.size < 3) continue;
        const commit = ancACommit(f, group, s.sec);
        if (commit === null) continue;
        return { marks: { Smoke: smoke.at, Staged: s.sec, Commit: commit } };
      }
      return null;
    }
  },
  {
    key: 'anc-a-exec',
    label: 'A Execute',
    desc: '2+ smokes onto A Donut / Donut / A Default / A CT, 3+ in A Main, and two of them onto A or into its holders.',
    match(f) {
      const smokes = ancASmokes(f);
      if (smokes.length < 2) return null;
      for (const s of f.series) {
        const group = f.playersIn(ANC_A_MAIN, s.sec);
        if (group.size < 3) continue;
        const commit = ancACommit(f, group, s.sec);
        if (commit === null) continue;
        return { marks: { Smokes: smokes[1].at, Staged: s.sec, Commit: commit } };
      }
      return null;
    }
  },
  {
    key: 'anc-a-fake-fast',
    label: 'Fast A fake',
    desc: 'The same smoke thrown by 1:39, with at most 2 players in A Main by 1:37.',
    match(f) {
      const smoke = ancASmokes(f, { thrownBy: secondsAtClock('1:39') })[0];
      if (!smoke) return null;
      if (f.playersDuring(ANC_A_MAIN, 0, secondsAtClock('1:37')).size > 2) return null;
      return { marks: { Smoke: smoke.at } };
    }
  },
  {
    key: 'anc-a-fake-late',
    label: 'Late A fake',
    desc: 'The smoke thrown after 1:39, at most 1 player into A Main behind it, and nobody in CT Donut for its first 10 seconds.',
    match(f) {
      const smoke = ancASmokes(f, { thrownAfter: secondsAtClock('1:39') })[0];
      if (!smoke) return null;
      if (f.playersDuring(ANC_A_MAIN, smoke.thrown, f.lastSec).size > 1) return null;
      if (f.firstSecWith(ANC_CT_DONUT, 1, smoke.at, smoke.at + 10) !== null) return null;
      return { marks: { Smoke: smoke.at } };
    }
  },
  {
    key: 'anc-a-split',
    label: 'A Split',
    desc: 'A player in A Main and one in CT Donut or CT Spawn, duelling holders on that same ground or on the A site.',
    match(f) {
      for (const s of f.series) {
        if (!f.countIn(ANC_A_MAIN, s.sec)) continue;
        for (const flank of [ANC_CT_DONUT, ANC_CT_SPAWN]) {
          if (!f.countIn(flank, s.sec)) continue;
          const duel = f.fights({ from: s.sec, enemyIn: [...flank, ...ANC_A_SITE] })[0];
          if (!duel) continue;
          return { marks: { Split: s.sec, Duel: duel.sec } };
        }
      }
      return null;
    }
  },
  {
    key: 'anc-window-take',
    label: 'Window take',
    desc: 'A player into Redroom and then into CT Spawn within 15s.',
    match(f) {
      for (const [id, entered] of firstEntries(f, ANC_REDROOM)) {
        for (const s of f.series) {
          if (s.sec < entered || s.sec > entered + 15) continue;
          if (f.playersIn(ANC_CT_SPAWN, s.sec).has(id)) {
            return { marks: { Redroom: entered, 'CT Spawn': s.sec } };
          }
        }
      }
      return null;
    }
  },
  {
    key: 'anc-b-cave-take',
    label: 'Fast B cave take',
    desc: 'A player onto Street who is either fighting a CT in CT Cave or standing in it by 1:38.',
    match(f) {
      const by = secondsAtClock('1:38');
      const street = f.playersDuring(ANC_STREET, 0, by);
      if (!street.size) return null;
      const moved = f.transitions(ANC_STREET, ANC_CT_CAVE, { from: 0, to: by })[0];
      const duel = f.fights({ to: by, ours: street, enemyIn: ANC_CT_CAVE })[0];
      if (!moved && !duel) return null;
      const marks = { Street: f.firstSecWith(ANC_STREET, 1, 0, by) };
      if (moved) marks['Into cave'] = moved.arrivedAt;
      if (duel) marks.Contact = duel.sec;
      return { marks };
    }
  }
];

// ---------------------------------------------------------------------------
// CT side, Ancient
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const ANC_CT = [
  {
    key: 'anc-ct-mid-retake',
    label: 'Mid retake',
    group: 'anc-mid-count',
    desc: 'Exactly 1 CT into CT Mid in the first 20s, still alive when 2+ come back into CT Mid after 1:35.',
    match(f) {
      const early = f.playersDuring(ANC_CT_MID, 0, secondsAtClock('1:35'));
      if (early.size !== 1) return null;
      const back = f.firstSecWith(ANC_CT_MID, 2, secondsAtClock('1:35'), f.lastSec);
      if (back === null) return null;
      // The man who was there has to be alive to be retaken to. A mid that was
      // opened and then refilled over his body is a different round.
      const died = f.deathSec([...early][0]);
      if (died !== null && died <= back) return null;
      const held = f.firstSecWith(ANC_CT_MID, 1, 0, secondsAtClock('1:35'));
      return { marks: { Held: held, Retake: back } };
    }
  },
  {
    key: 'anc-ct-3-mid-pop',
    label: '3 mid pop',
    group: 'anc-mid-count',
    desc: 'No three-man mid in the first 20s, then 3 into CT Mid / CT Window / CT Donut after 1:35.',
    match(f) {
      const early = longestRun(
        f.series,
        0,
        secondsAtClock('1:35'),
        (sec) => f.countIn(ANC_MID_HOLD, sec) >= 3
      );
      if (early.seconds >= ANC_MID_HOLD_SECONDS) return null;
      const late = f.firstSecWith(ANC_MID_HOLD, 3, secondsAtClock('1:35'), f.lastSec);
      if (late === null) return null;
      return { marks: { 'Three in': late } };
    }
  },
  {
    key: 'anc-ct-3-mid',
    label: '3 mid fight',
    group: 'anc-mid-count',
    desc: '3 CTs sharing CT Mid / CT Window / CT Donut for 6s+ at once.',
    match(f) {
      const run = longestRun(
        f.series,
        0,
        f.lastSec,
        (sec) => f.countIn(ANC_MID_HOLD, sec) >= 3
      );
      if (run.seconds < ANC_MID_HOLD_SECONDS) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'anc-ct-2-mid',
    label: '2 mid fight',
    group: 'anc-mid-count',
    desc: '2 in CT Mid, or one there and one in CT Window, and one of them stepping to Mid 2 or Ledge, both by 1:35.',
    match(f) {
      const by = secondsAtClock('1:35');
      // Both halves inside the window: the shape forms, then somebody steps up
      // out of it, and neither event is allowed to be late.
      for (const s of f.series) {
        if (s.sec > by) break;
        const mid = f.countIn(ANC_CT_MID, s.sec);
        if (!(mid === 2 || (mid === 1 && f.countIn(ANC_CT_WINDOW, s.sec) === 1))) continue;
        const up = f.firstSecWith(ANC_STEP_UP, 1, s.sec, by);
        if (up === null) continue;
        return { marks: { 'Set from': s.sec, 'Step up': up } };
      }
      return null;
    }
  },
  {
    key: 'anc-ct-double-molo-mid',
    label: 'Double molotovs mid',
    desc: '2+ elbowmolo, deepmid or closemid molotovs.',
    match(f) {
      const molos = ANC_MID_MOLLYS.flatMap((name) =>
        f.nadesNamed(name).filter((n) => n.type === 'molotov')
      ).sort((a, b) => a.at - b.at);
      if (molos.length < 2) return null;
      return { marks: { First: molos[0].at, Second: molos[1].at } };
    }
  },
  {
    key: 'anc-ct-smoke-mid',
    label: 'Smoke mid',
    desc: 'An elbow smoke by 1:44.',
    match(f) {
      const smoke = f
        .nadesNamed('elbow')
        .find((n) => n.type === 'smokegrenade' && n.at <= secondsAtClock('1:44'));
      if (!smoke) return null;
      return { marks: { Smoke: smoke.at } };
    }
  },
  {
    key: 'anc-ct-double-he-lane',
    label: 'Double nades lane',
    desc: '2 street HEs by 1:44.',
    match(f) {
      const nades = f
        .nadesNamed('street')
        .filter((n) => n.type === 'hegrenade' && n.at <= secondsAtClock('1:44'));
      if (nades.length < 2) return null;
      return { marks: { First: nades[0].at, Second: nades[1].at } };
    }
  },
  {
    key: 'anc-ct-double-he-ramp',
    label: 'Double nades ramp',
    desc: '2 HEs into B Ramp by 1:44.',
    match(f) {
      const nades = f
        .nadesIn('hegrenade', ANC_B_RAMP)
        .filter((n) => n.at <= secondsAtClock('1:44'));
      if (nades.length < 2) return null;
      return { marks: { First: nades[0].at, Second: nades[1].at } };
    }
  },
  {
    key: 'anc-ct-window-break',
    label: 'Mid window break',
    desc: 'Nobody on Mid 2 or Ledge before 1:40, and an HE into Window between 1:50 and 1:30.',
    match(f) {
      if (f.playersDuring(ANC_STEP_UP, 0, secondsAtClock('1:40')).size) return null;
      const nade = f
        .nadesIn('hegrenade', ANC_WINDOW)
        .find((n) => n.at >= secondsAtClock('1:50') && n.at <= secondsAtClock('1:30'));
      if (!nade) return null;
      return { marks: { HE: nade.at } };
    }
  },
  {
    key: 'anc-ct-runboost',
    label: 'Mid runboost',
    desc: '2+ CTs on Mid 3 by 1:41, one of them up on the runboost by 1:41.',
    match(f) {
      const by = secondsAtClock('1:41');
      for (const s of f.series) {
        if (s.sec > by) break;
        const group = f.playersIn(ANC_MID_3, s.sec);
        if (group.size < 2) continue;
        for (const t of f.series) {
          if (t.sec < s.sec || t.sec > by) continue;
          const up = [...f.playersIn(ANC_RUNBOOST, t.sec)].find((id) => group.has(id));
          if (up) return { marks: { Staged: s.sec, Boost: t.sec } };
        }
      }
      return null;
    }
  },
  {
    key: 'anc-ct-street-fast',
    label: 'Fast Street take',
    group: 'anc-street',
    desc: '3+ CTs together on Heaven / Street / B Ramp for more than 2s, before 1:33.',
    match(f) {
      const run = ancStreetTake(f, 0, secondsAtClock('1:33'), 3);
      if (!run) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'anc-ct-street-late',
    label: 'Late Street take',
    group: 'anc-street',
    desc: 'The same three-man take, after 1:33.',
    match(f) {
      const run = ancStreetTake(f, secondsAtClock('1:33'), f.lastSec, 3);
      if (!run) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'anc-ct-door-fight',
    label: 'Door smoke fight B',
    group: 'anc-door',
    desc: 'A door smoke with a CT on Heaven / Street / B Ramp, then fighting on B Door / B Street / B Ramp or reaching Street / Bucket / Under boost / B Street.',
    match(f) {
      const smoke = f.nadesNamed('door')[0];
      if (!smoke) return null;
      const run = ancStreetTake(f, 0, f.lastSec, 1);
      if (!run) return null;
      const duel = f
        .fights({ from: run.start })
        .find(
          (x) =>
            enemyIn(f, x, ANC_DOOR_FIGHT_GROUND) || ourFighterIn(f, x, ANC_DOOR_FIGHT_GROUND)
        );
      const through = f.firstSecWith(ANC_STREET_THROUGH, 1, run.start, f.lastSec);
      if (!duel && through === null) return null;
      const marks = { 'door smoke': smoke.at, 'Set from': run.start };
      if (duel) marks.Contact = duel.sec;
      if (through !== null) marks.Through = through;
      return { marks };
    }
  },
  {
    key: 'anc-ct-door-fake',
    label: 'Door smoke fake',
    group: 'anc-door',
    desc: 'The door smoke with nobody holding Heaven / Street / B Ramp behind it.',
    match(f) {
      const smoke = f.nadesNamed('door')[0];
      if (!smoke) return null;
      if (ancStreetTake(f, 0, f.lastSec, 1)) return null;
      return { marks: { 'door smoke': smoke.at } };
    }
  },
  {
    key: 'anc-ct-2a-main',
    label: '2A Main',
    desc: '2 CTs in A Main or on A for more than 5s, or taking a fight there.',
    match(f) {
      const ground = [...ANC_A_MAIN, ...ANC_A_POS];
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(ground, sec) >= 2);
      if (run.seconds > 5) return { marks: { 'Set from': run.start } };
      for (const s of f.series) {
        const group = f.playersIn(ground, s.sec);
        if (group.size < 2) continue;
        const duel = f.fights({ from: s.sec, ours: group })[0];
        if (duel && ourFighterIn(f, duel, ground)) {
          return { marks: { Staged: s.sec, Contact: duel.sec } };
        }
      }
      return null;
    }
  }
];

// ---------------------------------------------------------------------------
// Mirage vocabulary
// ---------------------------------------------------------------------------

const MIR_MID = ['Mid'];
const MIR_T_MID = ['T Mid'];
/** T Mid and Mid together. The bare name covers zone and position alike. */
const MIR_MID_ALL = ['T Mid', 'Mid'];
const MIR_MID_GROUND = ['T Mid', 'Mid', 'Underground'];
/** Where a CT is allowed to be standing when they fight for mid. */
const MIR_CT_MID_FROM = ['T Mid', 'Mid', 'Underground', 'Window', 'Con', 'B Short', 'Ladder'];

const MIR_T_APS = ['T Aps'];
const MIR_B_APS = ['B Aps'];
const MIR_B_STAGE = ['T Aps', 'Underground', 'Short', 'Ladder'];
const MIR_APS_THROW = ['T Aps', 'B Aps'];
const MIR_B_SITE = ['B Site'];
const MIR_B_DEFEND = ['T Aps', 'B Aps', 'B Short', 'B Site', 'B Kitchen'];
const MIR_B_LAND = ['B Site', 'B Aps', 'B Short', 'B Kitchen'];
const MIR_B_SPLIT_LANE = ['Short', 'Catwalk'];
const MIR_B_SPLIT_DEFEND = ['B Aps', 'Short', 'Catwalk', 'B Site', 'B Kitchen'];

const MIR_T_A = ['T A'];
const MIR_A_RAMP = ['A Ramp'];
const MIR_A_IN = ['Tetris', 'apEX'];
const MIR_A_DEFEND = ['A Ramp', 'Tetris', 'apEX', 'CT Spawn', 'A Jungle', 'A Site'];
const MIR_A_SITE = ['A Site'];
const MIR_A_JUNGLE = ['A Jungle'];
const MIR_A_SPLIT_DEFEND = ['T A', 'A Jungle', 'A Site', 'CT Spawn'];
/** Where the palace duel is allowed to be taken from. */
const MIR_PALACE_FROM = ['A Palace', 'A Balc'];
const MIR_PALACE = ['A Palace'];
const MIR_BALC = ['A Balc'];
const MIR_PALACE_DEFEND = ['A Palace', 'CT Spawn', 'A Jungle', 'A Site'];
/** Ground the utility has to land on to have set the palace duel up. */
const MIR_A_LAND = ['A Site', 'CT Spawn'];

const MIR_WINDOW = ['Window'];
const MIR_T_OUTSIDE = ['T Outside A'];
const MIR_AWP_START = ['B Car', 'B Balc', 'B Aps'];
const MIR_BOOST = ['Boost'];
/** Underground and the two positions that hang off it. */
const MIR_UNDER_BLOCK = ['Underground', 'Ladder', 'Short'];
const MIR_UNDER = ['Underground'];

const MIR_A_EXEC_SMOKES = ['topcon', 'deepjungle', 'jungle', 'stairs', 'ct'];

/** "More than 4 consecutive seconds" of a four-man mid. */
const MIR_MID_RUN_SECONDS = 4;
/** How long a body has to follow a split duel onto the site. */
const MIR_SPLIT_FOLLOW = 15;
/** And how long an execute's smokes stay a reason for the entry. */
const MIR_EXEC_WINDOW = 15;
/** A fake's spend buys this long of nobody walking in behind it. */
const MIR_FAKE_WINDOW = 20;
/** How close to the palace duel the utility has to land to have set it up. */
const MIR_PALACE_UTIL = 4;
/** Which side of the kitchen smoke the B contact fell on. */
const MIR_KITCHEN_EDGE = 3;
const MIR_RAMP_SEARCH_SECONDS = 20;
const MIR_APS_SEARCH_SECONDS = 15;
const MIR_BOOST_SECONDS = 3;
const MIR_UNDER_SECONDS = 3;
/**
 * "Recently" for the two definitions that use the word: the window boost's
 * second man, and the under push's rotation between its three pieces.
 */
const MIR_UNDER_RECENT = 6;

/**
 * The Mirage push: a stack that came through one position, reached the next,
 * and traded with whoever was holding.
 *
 * Shared by both B and A. `needBoth` is the difference between B Rush, which
 * asks for the entry AND the fight, and B Pop, which takes either.
 */
function mirPush(f, { stage, into, defend, from, to, min, needBoth = false }) {
  const staged = f.playersDuring(stage, from, to);
  if (staged.size < min) return null;
  const inside = [...f.playersDuring(into, from, to)].filter((id) => staged.has(id));
  const fight = f.fights({ from, to, ours: staged, enemyIn: defend })[0];
  if (needBoth ? !inside.length || !fight : !inside.length && !fight) return null;
  return {
    staged: f.firstSecWith(stage, min, from, to),
    entered: inside.length ? f.firstSecWith(into, 1, from, to) : null,
    fight
  };
}

/**
 * A split: two lanes held at once, a duel out of one of them, and a body onto
 * the site behind it. All four Mirage splits are this shape; they differ only
 * in the ground, and in whether the first duel that qualifies was early.
 */
function mirSplit(f, { lanes, defend, site }) {
  for (const s of f.series) {
    if (!lanes.every((names) => f.countIn(names, s.sec))) continue;
    const ours = new Set(lanes.flatMap((names) => [...f.playersIn(names, s.sec)]));
    for (const duel of f.fights({ from: s.sec, ours, enemyIn: defend })) {
      const onSite = f.firstSecWith(site, 1, duel.sec, duel.sec + MIR_SPLIT_FOLLOW);
      if (onSite === null) continue;
      return { split: s.sec, duel, onSite };
    }
  }
  return null;
}

/** The palace shape, either side of the question "was it set up with utility". */
function mirPalaceRead(f, { withUtil }) {
  const been = f.playersDuring(MIR_PALACE, 0, f.lastSec);
  if (been.size < 2) return null;
  const setUp = (sec) =>
    f.nadesIn(null, MIR_A_LAND).some((n) => n.at >= sec - MIR_PALACE_UTIL && n.at <= sec);

  const duel = f
    .fights({ ours: been, enemyIn: MIR_PALACE_DEFEND })
    .find((x) => ourFighterIn(f, x, MIR_PALACE_FROM) && f.aliveCount(x.sec) >= 3);
  if (duel) {
    if (setUp(duel.sec) !== withUtil) return null;
    return { marks: { Palace: f.firstSecWith(MIR_PALACE, 2) ?? duel.sec, Duel: duel.sec } };
  }
  // No duel at all is still a contact, so long as both of them walked onto
  // balcony. A pop has to be a pop at something, so it has no such branch.
  if (withUtil) return null;
  const balc = [...f.playersDuring(MIR_BALC, 0, f.lastSec)].filter((id) => been.has(id));
  if (balc.length < 2) return null;
  const at = f.firstSecWith(MIR_BALC, 2, 0, f.lastSec);
  if (at === null || f.aliveCount(at) < 3 || setUp(at)) return null;
  return { marks: { Palace: f.firstSecWith(MIR_PALACE, 2) ?? at, Balcony: at } };
}

/** The two A smokes an execute or a fake is built on, in landing order. */
function mirAExecSmokes(f) {
  const smokes = MIR_A_EXEC_SMOKES.flatMap((name) =>
    f.nadesNamed(name).filter((n) => n.type === 'smokegrenade')
  ).sort((a, b) => a.at - b.at);
  return smokes.length >= 2 ? smokes : null;
}

// ---------------------------------------------------------------------------
// T side, Mirage
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const MIR_T = [
  {
    key: 'mir-mid-rush',
    label: 'Mid rush',
    desc: '2+ into Mid by 1:35, and if it is only two, a third still in T Mid behind them.',
    match(f) {
      const by = secondsAtClock('1:35');
      for (const s of f.series) {
        if (s.sec > by) break;
        const inMid = f.countIn(MIR_MID, s.sec);
        if (inMid < 2) continue;
        if (inMid === 2 && f.countIn(MIR_T_MID, s.sec) < 1) continue;
        return { marks: { 'Into mid': s.sec } };
      }
      return null;
    }
  },
  {
    key: 'mir-4mid',
    label: '4Mid Default',
    group: 'mir-mid-count',
    desc: '4+ in T Mid / Mid for more than 4 consecutive seconds, by 1:30.',
    match(f) {
      const run = longestRun(f.series, 0, secondsAtClock('1:30'), (sec) =>
        f.countIn(MIR_MID_ALL, sec) >= 4
      );
      if (run.seconds <= MIR_MID_RUN_SECONDS) return null;
      return { marks: { 'Set from': run.start } };
    }
  },
  {
    key: 'mir-3mid',
    label: '3Mid Default',
    group: 'mir-mid-count',
    desc: 'Exactly 3 in T Mid / Mid by 1:30.',
    match(f) {
      const at = f.series.find(
        (s) => s.sec <= secondsAtClock('1:30') && f.countIn(MIR_MID_ALL, s.sec) === 3
      );
      if (!at) return null;
      return { marks: { 'Three in': at.sec } };
    }
  },
  {
    key: 'mir-2mid',
    label: '2Mid Default',
    group: 'mir-mid-count',
    desc: 'Exactly 2 in T Mid / Mid by 1:30.',
    match(f) {
      const at = f.series.find(
        (s) => s.sec <= secondsAtClock('1:30') && f.countIn(MIR_MID_ALL, s.sec) === 2
      );
      if (!at) return null;
      return { marks: { 'Two in': at.sec } };
    }
  },
  {
    key: 'mir-b-default',
    label: 'B Default',
    desc: '2+ in T Aps / Underground / Short / Ladder by 1:30, with nobody in T A.',
    match(f) {
      const by = secondsAtClock('1:30');
      if (f.playersDuring(MIR_T_A, 0, by).size) return null;
      const at = f.firstSecWith(MIR_B_STAGE, 2, 0, by);
      if (at === null) return null;
      return { marks: { 'Set from': at } };
    }
  },
  {
    key: 'mir-a-default',
    label: 'A Default',
    desc: '2+ in T A by 1:30 with nobody down B, or 3+ if one man is.',
    match(f) {
      const by = secondsAtClock('1:30');
      const down = f.playersDuring(MIR_B_STAGE, 0, by).size;
      if (down > 1) return null;
      // One body down B is a lurk, and the A side has to be that much fuller
      // before the round still reads as an A default.
      const at = f.firstSecWith(MIR_T_A, down === 1 ? 3 : 2, 0, by);
      if (at === null) return null;
      return { marks: { 'Set from': at } };
    }
  },
  {
    key: 'mir-b-rush',
    label: 'B rush',
    desc: '3+ through T Aps by 1:35, into B Aps AND trading with the B holders, all by 1:35.',
    match(f) {
      const push = mirPush(f, {
        stage: MIR_T_APS,
        into: MIR_B_APS,
        defend: MIR_B_DEFEND,
        from: 0,
        to: secondsAtClock('1:35'),
        min: 3,
        needBoth: true
      });
      if (!push) return null;
      return { marks: { Staged: push.staged, 'Into aps': push.entered, Contact: push.fight.sec } };
    }
  },
  {
    key: 'mir-b-pop',
    label: 'B pop',
    desc: '2+ through T Aps after 1:35, into B Aps or trading with the B holders, with the contact at least 3s before the kitchen smoke lands.',
    match(f) {
      return mirBLate(f, { min: 2, beforeKitchen: true });
    }
  },
  {
    key: 'mir-b-exec',
    label: 'B execute',
    desc: 'The same push with 3+, and the contact no earlier than 3s before the kitchen smoke lands.',
    match(f) {
      return mirBLate(f, { min: 3, beforeKitchen: false });
    }
  },
  {
    key: 'mir-b-fake',
    label: 'B Fake',
    desc: 'A smoke and a flash out of T Aps / B Aps onto the B ground, at most 2 bodies in aps, 3+ alive, and at most one man into B Site for 20s.',
    match(f) {
      const lands = (n) => f.regions.inside(MIR_B_LAND, n.x, n.y, n.z);
      const smokes = f.nadesFrom('smokegrenade', MIR_APS_THROW).filter(lands);
      const flashes = f.nadesFrom('flashbang', MIR_APS_THROW).filter(lands);
      if (!smokes.length || !flashes.length) return null;
      for (const smoke of smokes) {
        for (const flash of flashes) {
          const at = Math.max(smoke.at, flash.at);
          if (f.countIn(MIR_APS_THROW, at) > 2) continue;
          if (f.aliveCount(at) < 3) continue;
          if (f.playersDuring(MIR_B_SITE, at, at + MIR_FAKE_WINDOW).size > 1) continue;
          return { marks: { Smoke: smoke.at, Flash: flash.at } };
        }
      }
      return null;
    }
  },
  {
    key: 'mir-a-rush',
    label: 'A rush',
    desc: '2+ through A Ramp by 1:40, into Tetris or apEX AND trading with the A holders, all by 1:40.',
    match(f) {
      const push = mirPush(f, {
        stage: MIR_A_RAMP,
        into: MIR_A_IN,
        defend: MIR_A_DEFEND,
        from: 0,
        to: secondsAtClock('1:40'),
        min: 2,
        needBoth: true
      });
      if (!push) return null;
      return { marks: { Staged: push.staged, 'Into A': push.entered, Contact: push.fight.sec } };
    }
  },
  {
    key: 'mir-a-pop',
    label: 'A pop',
    desc: 'The same shape, all of it after 1:40.',
    match(f) {
      const push = mirPush(f, {
        stage: MIR_A_RAMP,
        into: MIR_A_IN,
        defend: MIR_A_DEFEND,
        from: secondsAtClock('1:40'),
        to: f.lastSec,
        min: 2,
        needBoth: true
      });
      if (!push) return null;
      return { marks: { Staged: push.staged, 'Into A': push.entered, Contact: push.fight.sec } };
    }
  },
  {
    key: 'mir-palace-contact',
    label: 'A palace contact',
    group: 'mir-palace',
    desc: '2+ through palace who duel the A holders, or both walk onto balcony, with no utility onto A Site / CT Spawn in the 4s before.',
    match(f) {
      return mirPalaceRead(f, { withUtil: false });
    }
  },
  {
    key: 'mir-palace-pop',
    label: 'A palace pop',
    group: 'mir-palace',
    desc: 'The same duel, with utility onto A Site / CT Spawn in the 4s before it.',
    match(f) {
      return mirPalaceRead(f, { withUtil: true });
    }
  },
  {
    key: 'mir-a-exec',
    label: 'A execute',
    group: 'mir-a-exec',
    desc: '2+ of the topcon / deepjungle / jungle / stairs / ct smokes, then 3+ onto the A site inside 15s.',
    match(f) {
      const smokes = mirAExecSmokes(f);
      if (!smokes) return null;
      const from = smokes[1].at;
      const entered = f.firstSecWith(MIR_A_SITE, 3, from, from + MIR_EXEC_WINDOW);
      if (entered === null) return null;
      return { marks: { Smokes: from, 'Three on site': entered } };
    }
  },
  {
    key: 'mir-a-fake',
    label: 'A Fake',
    group: 'mir-a-exec',
    desc: 'The same two smokes thrown with at most 2 in T A, and exactly one man onto the site inside 15s.',
    match(f) {
      const smokes = mirAExecSmokes(f);
      if (!smokes) return null;
      // Measured at the throw, not the landing: the question is how many were
      // standing there when the utility went out.
      if (smokes.slice(0, 2).some((n) => f.countIn(MIR_T_A, n.thrown) > 2)) return null;
      const from = smokes[1].at;
      const went = f.playersDuring(MIR_A_SITE, from, from + MIR_EXEC_WINDOW).size;
      if (went !== 1) return null;
      return { marks: { Smokes: from, 'One man in': f.firstSecWith(MIR_A_SITE, 1, from) } };
    }
  },
  {
    key: 'mir-a-split-fast',
    label: 'Fast A split',
    group: 'mir-a-split',
    desc: 'T A and A Jungle both held, a duel out of one of them before 1:27, and a body onto the site inside 15s.',
    match(f) {
      const hit = mirSplit(f, {
        lanes: [MIR_T_A, MIR_A_JUNGLE],
        defend: MIR_A_SPLIT_DEFEND,
        site: MIR_A_SITE
      });
      if (!hit || hit.duel.sec >= secondsAtClock('1:27')) return null;
      return { marks: { Split: hit.split, Duel: hit.duel.sec, 'On site': hit.onSite } };
    }
  },
  {
    key: 'mir-a-split',
    label: 'A split',
    group: 'mir-a-split',
    desc: 'The same split with the first qualifying duel after 1:27.',
    match(f) {
      const hit = mirSplit(f, {
        lanes: [MIR_T_A, MIR_A_JUNGLE],
        defend: MIR_A_SPLIT_DEFEND,
        site: MIR_A_SITE
      });
      if (!hit || hit.duel.sec < secondsAtClock('1:27')) return null;
      return { marks: { Split: hit.split, Duel: hit.duel.sec, 'On site': hit.onSite } };
    }
  },
  {
    key: 'mir-b-split-fast',
    label: 'Fast B split',
    group: 'mir-b-split',
    desc: 'B Aps and Short / Catwalk both held, a duel out of one of them before 1:30, and a body onto the site inside 15s.',
    match(f) {
      const hit = mirSplit(f, {
        lanes: [MIR_B_APS, MIR_B_SPLIT_LANE],
        defend: MIR_B_SPLIT_DEFEND,
        site: MIR_B_SITE
      });
      if (!hit || hit.duel.sec >= secondsAtClock('1:30')) return null;
      return { marks: { Split: hit.split, Duel: hit.duel.sec, 'On site': hit.onSite } };
    }
  },
  {
    key: 'mir-b-split',
    label: 'B split',
    group: 'mir-b-split',
    desc: 'The same split with the first qualifying duel after 1:30.',
    match(f) {
      const hit = mirSplit(f, {
        lanes: [MIR_B_APS, MIR_B_SPLIT_LANE],
        defend: MIR_B_SPLIT_DEFEND,
        site: MIR_B_SITE
      });
      if (!hit || hit.duel.sec < secondsAtClock('1:30')) return null;
      return { marks: { Split: hit.split, Duel: hit.duel.sec, 'On site': hit.onSite } };
    }
  },
  {
    key: 'mir-window-boost',
    label: 'Window boost',
    desc: 'A player out of Mid into Window, with a second man who was in Mid within 6s of it and is not up there with him.',
    match(f) {
      for (const moved of f.transitions(MIR_MID, MIR_WINDOW, { from: 0, to: f.lastSec })) {
        const at = moved.arrivedAt;
        const booster = [...f.playersDuring(MIR_MID, Math.max(0, at - MIR_UNDER_RECENT), at)].find(
          (id) => id !== moved.id && !f.playersIn(MIR_WINDOW, at).has(id)
        );
        if (!booster) continue;
        return { marks: { Window: at } };
      }
      return null;
    }
  }
];

/**
 * B Pop and B Execute: the same late push either side of the kitchen smoke.
 *
 * A pop with no kitchen smoke at all is still a pop — the contact cannot be
 * late for a smoke nobody threw — but an execute without one is not an
 * execute, so only that side of it requires the smoke to exist.
 */
function mirBLate(f, { min, beforeKitchen }) {
  const from = secondsAtClock('1:35');
  const push = mirPush(f, {
    stage: MIR_T_APS,
    into: MIR_B_APS,
    defend: MIR_B_DEFEND,
    from,
    to: f.lastSec,
    min
  });
  if (!push?.fight) return null;
  const kitchen = firstNamed(f, ['kitchen']);
  if (!kitchen) return beforeKitchen ? { marks: { Staged: push.staged, Contact: push.fight.sec } } : null;
  const edge = kitchen.at - MIR_KITCHEN_EDGE;
  if (beforeKitchen ? push.fight.sec > edge : push.fight.sec < edge) return null;
  const marks = { Staged: push.staged, Contact: push.fight.sec, 'kitchen smoke': kitchen.at };
  if (push.entered !== null) marks['Into aps'] = push.entered;
  return { marks };
}

// ---------------------------------------------------------------------------
// CT side, Mirage
// ---------------------------------------------------------------------------

/** A mid fight both CTs took part in, from ground a CT is allowed to hold. */
function mirMidFight(f, { from, to, enemies }) {
  const duels = f
    .fights({ from, to, enemyIn: MIR_MID_GROUND })
    .filter((x) => ourFighterIn(f, x, MIR_CT_MID_FROM));
  if (new Set(duels.map((x) => x.ours)).size < 2) return null;
  if (new Set(duels.map((x) => x.enemy)).size < enemies) return null;
  return duels;
}

/** @type {RoundTypeDef[]} */
const MIR_CT = [
  {
    key: 'mir-ct-mid-1st',
    label: '1st timing mid fight',
    group: 'mir-ct-mid',
    desc: '2 CTs both trading with a T in T Mid / Mid / Underground by 1:40.',
    match(f) {
      const duels = mirMidFight(f, { from: 0, to: secondsAtClock('1:40'), enemies: 1 });
      if (!duels) return null;
      return { marks: { Contact: duels[0].sec } };
    }
  },
  {
    key: 'mir-ct-mid-2nd',
    label: '2nd timing mid fight',
    group: 'mir-ct-mid',
    desc: '2 CTs both trading with 2 different Ts on that ground, after 1:40.',
    match(f) {
      const duels = mirMidFight(f, { from: secondsAtClock('1:40'), to: f.lastSec, enemies: 2 });
      if (!duels) return null;
      return { marks: { Contact: duels[0].sec } };
    }
  },
  {
    key: 'mir-ct-ramp-search',
    label: 'Ramp search',
    desc: 'A CT on A Ramp for 20s+, or killing someone in T Outside A from it, or walking into T Outside A.',
    match(f) {
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(MIR_A_RAMP, sec) >= 1);
      if (run.seconds > MIR_RAMP_SEARCH_SECONDS) return { marks: { 'Held from': run.start } };
      const been = f.playersDuring(MIR_A_RAMP, 0, f.lastSec);
      if (!been.size) return null;
      const kill = f
        .fights({ ours: been, killsOnly: true, enemyIn: MIR_T_OUTSIDE })
        .find((x) => x.killedThem);
      if (kill) return { marks: { Kill: kill.sec } };
      const out = [...f.playersDuring(MIR_T_OUTSIDE, 0, f.lastSec)].find((id) => been.has(id));
      if (!out) return null;
      return { marks: { Outside: f.firstSecWith(MIR_T_OUTSIDE, 1) } };
    }
  },
  {
    key: 'mir-ct-palace-search',
    label: 'Palace search',
    desc: 'A CT into A Palace.',
    match(f) {
      const at = f.firstSecWith(MIR_PALACE, 1);
      if (at === null) return null;
      return { marks: { Palace: at } };
    }
  },
  {
    key: 'mir-ct-awp-b',
    label: 'AWP B start',
    desc: 'The CT on B Car / B Balc / B Aps has the AWP out, before 1:30.',
    match(f) {
      const by = secondsAtClock('1:30');
      for (const s of f.series) {
        if (s.sec > by) break;
        for (const id of f.playersIn(MIR_AWP_START, s.sec)) {
          if (f.heldAwp(id, s.sec)) return { marks: { 'AWP set': s.sec } };
        }
      }
      return null;
    }
  },
  {
    key: 'mir-ct-aps-search',
    label: 'B aps search',
    desc: 'A CT into B Aps who either fights there or stays 15s+.',
    match(f) {
      const been = f.playersDuring(MIR_B_APS, 0, f.lastSec);
      if (!been.size) return null;
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(MIR_B_APS, sec) >= 1);
      if (run.seconds > MIR_APS_SEARCH_SECONDS) return { marks: { 'Held from': run.start } };
      const duel = f.fights({ ours: been }).find((x) => ourFighterIn(f, x, MIR_B_APS));
      if (!duel) return null;
      return { marks: { Contact: duel.sec } };
    }
  },
  {
    key: 'mir-ct-boost',
    label: 'B short boost',
    desc: 'A CT on the Boost for more than 3 consecutive seconds.',
    match(f) {
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(MIR_BOOST, sec) >= 1);
      if (run.seconds <= MIR_BOOST_SECONDS) return null;
      return { marks: { Boost: run.start } };
    }
  },
  {
    key: 'mir-ct-under-push',
    label: 'Under push',
    desc: 'A CT more than 3 consecutive seconds across Underground / Ladder / Short, and if he moved between them, having been in Underground inside the last 6s.',
    match(f) {
      // Per player, because "remains in this block" is one body's run and two
      // CTs passing each other through it is not the call.
      for (const id of f.playersDuring(MIR_UNDER_BLOCK, 0, f.lastSec)) {
        let start = null;
        let seen = new Set();
        for (const s of f.series) {
          const here = MIR_UNDER_BLOCK.filter((name) => f.playersIn([name], s.sec).has(id));
          if (!here.length) {
            start = null;
            seen = new Set();
            continue;
          }
          if (start === null) start = s.sec;
          for (const name of here) seen.add(name);
          if (s.sec - start <= MIR_UNDER_SECONDS) continue;
          // Rotating between the three only counts off the Underground.
          if (seen.size > 1) {
            const from = Math.max(0, s.sec - MIR_UNDER_RECENT);
            if (!f.playersDuring(MIR_UNDER, from, s.sec).has(id)) continue;
          }
          return { marks: { 'Set from': start } };
        }
      }
      return null;
    }
  }
];

// ---------------------------------------------------------------------------
// Cache vocabulary
// ---------------------------------------------------------------------------

const CCH_A_MAIN = ['A main'];
const CCH_A_POS = ['A'];
const CCH_A_DOOR = ['A door'];
const CCH_A_SITE = ['A Site'];
/** Whoever is holding A, wherever the map paints them. */
const CCH_A_DEFEND = ['A Site', 'A Heaven', 'Ticket'];
const CCH_A_FLANK = ['Highway', 'Ticket', 'Whitebox'];
const CCH_A_SPLIT_DEFEND = ['Highway', 'Ticket', 'Whitebox', 'A main', 'A door', 'A Site'];

const CCH_B_MAIN = ['B Main'];
const CCH_B_POS = ['B'];
const CCH_B_SITE = ['B Site'];
const CCH_B_DEFEND = ['B Site', 'B Checkers'];
const CCH_CHECKERS = ['Checkers'];
const CCH_VENTS = ['Vents'];
const CCH_RIGHT_MID = ['Right mid'];

const CCH_T_MID = ['T Mid'];
const CCH_CT_MID = ['CT Mid'];
const CCH_MID = ['mid'];
const CCH_UNDER_BOOST = ['under boost'];
const CCH_MID_IN = ['mid', 'under boost'];
const CCH_MID_TRADE_IN = ['mid', 'right mid', 'under boost'];
const CCH_BOOST = ['boost'];
const CCH_MID_GARAGE = ['Mid Garage'];
/** The mid ground a CT gives up, and comes back to on a retake. */
const CCH_MID_HOLD = ['sandbags', 'roof', 'mid', 'under boost'];

const CCH_A_SMOKES = ['a1', 'a2', 'awall1', 'awall2'];
const CCH_B_SMOKES = ['blurk', 'heaven', 'tree'];
/** The B contact only defers to two of the three: blurk is a lurk, not a wall. */
const CCH_B_CONTACT_SMOKES = ['heaven', 'tree'];
const CCH_MID_MOLLYS = ['sandbags', 'vents', 'underboost', 'whitebox'];

/** How long a trade may lead the entry it belongs to. */
const CCH_TRADE_FOLLOW = 8;
/** And how long a contact's smokes have to arrive behind the first fight. */
const CCH_CONTACT_SMOKE = 10;
const CCH_SPLIT_FOLLOW = 10;
const CCH_SEARCH_SECONDS = 5;
const CCH_MID_FIGHT_SECONDS = 10;

/**
 * The earliest of these stored spots to land, of any grenade at all.
 *
 * A fake thrown as a decoy lands in the same place as the smoke it imitates,
 * and the spot database records the grenade each spot was stored with, so the
 * type-strict lookup would miss it. Both readings are here because the calls
 * that want only the real smoke ask for it explicitly.
 */
function firstAtSpot(f, names) {
  let best = null;
  for (const name of names) {
    for (const n of f.nadesAtSpot(name)) {
      if (!best || n.at < best.at) best = n;
    }
  }
  return best;
}

/**
 * A Cache site take: the smoke, the bodies through the choke, and the bodies
 * onto the site.
 *
 * Rush, execute and fake are one shape read at different counts and either
 * side of a clock, so all three come through here.
 */
function cchTake(f, { smokes, main, into, from, to, mainMin, intoMin, cap = false, anyNade = false }) {
  const smoke = anyNade ? firstAtSpot(f, smokes) : firstNamed(f, smokes);
  if (!smoke || smoke.at < from || smoke.at > to) return null;
  const onMain = f.playersDuring(main, from, to).size;
  const inside = f.playersDuring(into, from, to).size;
  if (cap ? onMain > mainMin || inside > intoMin : onMain < mainMin || inside < intoMin) return null;
  return {
    marks: {
      Smoke: smoke.at,
      'On main': onMain,
      In: inside
    }
  };
}

/**
 * A Cache contact: bodies through the choke and either onto the site or into
 * the holders, with the smokes arriving behind the first fight rather than
 * in front of it. Smokes in front of it make the round an execute.
 */
function cchContact(f, { smokes, main, into, defend, from, min }) {
  if (f.playersDuring(main, from, f.lastSec).size < min) return null;
  const inside = f.playersDuring(into, from, f.lastSec);
  const duels = f.fights({ from, enemyIn: defend });
  if (inside.size < min && !duels.length) return null;
  const smoke = firstNamed(f, smokes);
  if (smoke) {
    const first = duels[0];
    if (!first) return null;
    if (smoke.at < first.sec || smoke.at > first.sec + CCH_CONTACT_SMOKE) return null;
  }
  const marks = { 'On main': f.playersDuring(main, from, f.lastSec).size };
  if (duels[0]) marks.Contact = duels[0].sec;
  if (smoke) marks.Smoke = smoke.at;
  return { marks };
}

/**
 * The mid take: bodies into mid, or a trade into CT Mid that a body follows
 * within 8s. Shared by Mid rush and Mid retake, which differ in the clock, in
 * where the follow-up counts, and in whether a molotov was part of it.
 */
function cchMidTake(f, { from, to, into, tradeInto, min }) {
  const straight = f.firstSecWith(into, min, from, to);
  if (straight !== null) return { at: straight, trade: null };
  for (const duel of f.fights({ from, to, enemyIn: CCH_CT_MID })) {
    for (const s of f.series) {
      if (s.sec < duel.sec || s.sec > Math.min(to, duel.sec + CCH_TRADE_FOLLOW)) continue;
      if (f.playersIn(tradeInto, s.sec).has(duel.ours)) {
        return { at: s.sec, trade: duel.sec };
      }
    }
  }
  return null;
}

/** The mid spend both fakes are built on: a molotov, two smokes, two flashes. */
function cchMidSpend(f, { from, to }) {
  const inWindow = (n) => n.at >= from && n.at <= to;
  const molly = CCH_MID_MOLLYS.flatMap((name) =>
    f.nadesNamed(name).filter((n) => n.type === 'molotov')
  ).filter(inWindow)[0];
  if (!molly) return null;
  const smokes = f.nadesIn('smokegrenade', CCH_CT_MID).filter(inWindow);
  if (smokes.length < 2) return null;
  const flashes = f
    .nadesIn('flashbang', [...CCH_T_MID, ...CCH_CT_MID])
    .filter(inWindow);
  if (flashes.length < 2) return null;
  return { marks: { Molotov: molly.at, Smokes: smokes[1].at, Flashes: flashes[1].at } };
}

// ---------------------------------------------------------------------------
// T side, Cache
// ---------------------------------------------------------------------------

/** @type {RoundTypeDef[]} */
const CCH_T = [
  {
    key: 'cch-a-rush',
    label: 'A rush',
    group: 'cch-a-take',
    desc: 'An a1 / a2 / awall1 / awall2 smoke, 3+ through A main and 2+ onto A, all by 1:39.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_A_SMOKES,
        main: CCH_A_MAIN,
        into: CCH_A_POS,
        from: 0,
        to: secondsAtClock('1:39'),
        mainMin: 3,
        intoMin: 2
      });
    }
  },
  {
    key: 'cch-a-rush-fake',
    label: 'A rush fake',
    group: 'cch-a-take',
    desc: 'The same utility by 1:39, real or thrown as a decoy, with at most 2 through A main and at most 1 onto A.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_A_SMOKES,
        main: CCH_A_MAIN,
        into: CCH_A_POS,
        from: 0,
        to: secondsAtClock('1:39'),
        mainMin: 2,
        intoMin: 1,
        cap: true,
        anyNade: true
      });
    }
  },
  {
    key: 'cch-a-exec',
    label: 'A execute',
    group: 'cch-a-take',
    desc: 'The same smoke with 2+ through A main and 2+ onto A, all after 1:39.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_A_SMOKES,
        main: CCH_A_MAIN,
        into: CCH_A_POS,
        from: secondsAtClock('1:39'),
        to: f.lastSec,
        mainMin: 2,
        intoMin: 2
      });
    }
  },
  {
    key: 'cch-a-contact',
    label: 'A contact',
    group: 'cch-a-take',
    desc: '2+ through A main after 1:39, onto A or into the A holders, with any A smoke landing behind the first fight.',
    match(f) {
      return cchContact(f, {
        smokes: CCH_A_SMOKES,
        main: CCH_A_MAIN,
        into: CCH_A_POS,
        defend: CCH_A_DEFEND,
        from: secondsAtClock('1:39'),
        min: 2
      });
    }
  },
  {
    key: 'cch-a-split',
    label: 'A split',
    desc: 'A body on Highway / Ticket / Whitebox and one in A main or A door, then two duels, a duel and an entry, or two entries onto the site.',
    match(f) {
      for (const s of f.series) {
        const flank = f.playersIn(CCH_A_FLANK, s.sec);
        const main = f.playersIn([...CCH_A_MAIN, ...CCH_A_DOOR], s.sec);
        if (!flank.size || !main.size) continue;
        const pair = new Set([...flank, ...main]);
        const duels = f.fights({ from: s.sec, ours: pair, enemyIn: CCH_A_SPLIT_DEFEND });
        const fighters = new Set(duels.map((x) => x.ours));
        const entered = new Set(
          [...f.playersDuring(CCH_A_SITE, s.sec, f.lastSec)].filter((id) => pair.has(id))
        );
        // Two men, and between them two commitments of any kind.
        const committed = new Set([...fighters, ...entered]);
        if (committed.size < 2) continue;
        const onSite = f.firstSecWith(CCH_A_SITE, 1, s.sec, f.lastSec);
        const marks = { Split: s.sec };
        if (duels[0]) marks.Duel = duels[0].sec;
        if (onSite !== null) marks['On site'] = onSite;
        return { marks };
      }
      return null;
    }
  },
  {
    key: 'cch-b-rush',
    label: 'B rush',
    group: 'cch-b-take',
    desc: 'A blurk / heaven / tree smoke, 3+ through B Main and 2+ onto B, all by 1:38.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_B_SMOKES,
        main: CCH_B_MAIN,
        into: CCH_B_POS,
        from: 0,
        to: secondsAtClock('1:38'),
        mainMin: 3,
        intoMin: 2
      });
    }
  },
  {
    key: 'cch-b-rush-fake',
    label: 'B rush fake',
    group: 'cch-b-take',
    desc: 'The same utility by 1:38, real or thrown as a decoy, with at most 2 through B Main and at most 1 onto B.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_B_SMOKES,
        main: CCH_B_MAIN,
        into: CCH_B_POS,
        from: 0,
        to: secondsAtClock('1:38'),
        mainMin: 2,
        intoMin: 1,
        cap: true,
        anyNade: true
      });
    }
  },
  {
    key: 'cch-b-exec',
    label: 'B execute',
    group: 'cch-b-take',
    desc: 'The same smoke with 3+ through B Main and 2+ onto B, all after 1:38.',
    match(f) {
      return cchTake(f, {
        smokes: CCH_B_SMOKES,
        main: CCH_B_MAIN,
        into: CCH_B_POS,
        from: secondsAtClock('1:38'),
        to: f.lastSec,
        mainMin: 3,
        intoMin: 2
      });
    }
  },
  {
    key: 'cch-b-contact',
    label: 'B contact',
    group: 'cch-b-take',
    desc: '2+ through B Main after 1:38, onto B or into the B Site / B Checkers holders, with any heaven or tree smoke landing behind the first fight.',
    match(f) {
      return cchContact(f, {
        smokes: CCH_B_CONTACT_SMOKES,
        main: CCH_B_MAIN,
        into: CCH_B_POS,
        defend: CCH_B_DEFEND,
        from: secondsAtClock('1:38'),
        min: 2
      });
    }
  },
  {
    key: 'cch-b-split',
    label: 'B split',
    desc: 'A player out of Right mid into Vents, with a second man onto B Checkers / B Site or fighting there inside 10s.',
    match(f) {
      for (const moved of f.transitions(CCH_RIGHT_MID, CCH_VENTS, { from: 0, to: f.lastSec })) {
        const to = moved.arrivedAt + CCH_SPLIT_FOLLOW;
        const onB = f.firstSecWith(CCH_B_DEFEND, 1, moved.arrivedAt, to);
        const duel = f.fights({ from: moved.arrivedAt, to, enemyIn: CCH_B_DEFEND })[0];
        if (onB === null && !duel) continue;
        const marks = { Vents: moved.arrivedAt };
        if (onB !== null) marks['On B'] = onB;
        if (duel) marks.Contact = duel.sec;
        return { marks };
      }
      return null;
    }
  },
  {
    key: 'cch-mid-rush',
    label: 'Mid rush',
    desc: '3+ into T Mid then 2 into mid, or a trade into CT Mid the same man follows inside 8s, all before 1:43, behind a smoke into CT Mid.',
    match(f) {
      const by = secondsAtClock('1:43');
      if (f.playersDuring(CCH_T_MID, 0, by).size < 3) return null;
      const smoke = f.nadesIn('smokegrenade', CCH_CT_MID).find((n) => n.at <= by);
      if (!smoke) return null;
      const take = cchMidTake(f, { from: 0, to: by, into: CCH_MID, tradeInto: CCH_MID, min: 2 });
      if (!take) return null;
      const marks = { Smoke: smoke.at, 'Into mid': take.at };
      if (take.trade !== null) marks.Contact = take.trade;
      return { marks };
    }
  },
  {
    key: 'cch-mid-retake',
    label: 'Mid retake',
    desc: 'The same take after 1:43 onto mid / under boost, behind a CT Mid smoke and a sandbags / vents / underboost / whitebox molotov.',
    match(f) {
      const from = secondsAtClock('1:43');
      const smoke = f.nadesIn('smokegrenade', CCH_CT_MID).find((n) => n.at >= from);
      if (!smoke) return null;
      const molly = CCH_MID_MOLLYS.flatMap((name) =>
        f.nadesNamed(name).filter((n) => n.type === 'molotov' && n.at >= from)
      )[0];
      if (!molly) return null;
      const take = cchMidTake(f, {
        from,
        to: f.lastSec,
        into: CCH_MID_IN,
        tradeInto: CCH_MID_TRADE_IN,
        min: 2
      });
      if (!take) return null;
      const marks = { Smoke: smoke.at, Molotov: molly.at, 'Into mid': take.at };
      if (take.trade !== null) marks.Contact = take.trade;
      return { marks };
    }
  },
  {
    key: 'cch-mid-fake',
    label: 'Mid fake',
    group: 'cch-mid-fake',
    desc: 'A mid molotov, 2 smokes into CT Mid and 2 flashes into T Mid / CT Mid, all before 1:43.',
    match(f) {
      return cchMidSpend(f, { from: 0, to: secondsAtClock('1:43') });
    }
  },
  {
    key: 'cch-mid-retake-fake',
    label: 'Mid retake fake',
    group: 'cch-mid-fake',
    desc: 'The same spend after 1:43.',
    match(f) {
      return cchMidSpend(f, { from: secondsAtClock('1:43'), to: f.lastSec });
    }
  },
  {
    key: 'cch-fast-boost',
    label: 'Fast boost',
    desc: 'A player onto the boost by 1:43.',
    match(f) {
      const at = f.firstSecWith(CCH_BOOST, 1, 0, secondsAtClock('1:43'));
      if (at === null) return null;
      return { marks: { Boost: at } };
    }
  },
  {
    key: 'cch-fast-mid-peek',
    label: 'Fast Mid peek',
    desc: 'Exactly one player trading with a CT in CT Mid, out of Mid Garage, by 1:43.',
    match(f) {
      const duels = f
        .fights({ to: secondsAtClock('1:43'), enemyIn: CCH_CT_MID })
        .filter((x) => ourFighterIn(f, x, CCH_MID_GARAGE));
      if (!duels.length) return null;
      // Exactly one man: two is a mid take, however fast it was.
      if (new Set(duels.map((x) => x.ours)).size !== 1) return null;
      return { marks: { Peek: duels[0].sec } };
    }
  }
];

// ---------------------------------------------------------------------------
// CT side, Cache
// ---------------------------------------------------------------------------

/** A CT holding one piece of ground with the AWP out. */
function cchAwpStart(f, names) {
  for (const s of f.series) {
    for (const id of f.playersIn(names, s.sec)) {
      if (f.heldAwp(id, s.sec)) return { marks: { 'AWP set': s.sec } };
    }
  }
  return null;
}

/** @type {RoundTypeDef[]} */
const CCH_CT = [
  {
    key: 'cch-ct-vents-boost',
    label: 'Vents boost',
    desc: 'A CT out of Checkers into Vents.',
    match(f) {
      const moved = f.transitions(CCH_CHECKERS, CCH_VENTS, { from: 0, to: f.lastSec })[0];
      if (!moved) return null;
      return { marks: { Vents: moved.arrivedAt } };
    }
  },
  {
    key: 'cch-ct-awp-b',
    label: 'AWP B start',
    desc: 'The AWP playing B Checkers or B Site.',
    match(f) {
      return cchAwpStart(f, CCH_B_DEFEND);
    }
  },
  {
    key: 'cch-ct-awp-a',
    label: 'AWP A start',
    desc: 'The AWP playing the A site.',
    match(f) {
      return cchAwpStart(f, CCH_A_SITE);
    }
  },
  {
    key: 'cch-ct-a-main-search',
    label: 'A main search',
    desc: 'A CT into A main behind a CT flash or smoke, or two of them, 8+ alive, and one of them there 5s+.',
    match(f) {
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(CCH_A_MAIN, sec) >= 1);
      if (run.seconds < CCH_SEARCH_SECONDS) return null;
      const been = f.playersDuring(CCH_A_MAIN, 0, f.lastSec);
      if (!been.size) return null;
      const alive = (sec) => f.aliveCount(sec) + f.enemy.aliveCount(sec) >= 8;
      const pair = f.firstSecWith(CCH_A_MAIN, 2);
      if (pair !== null && alive(pair)) return { marks: { 'Two in': pair } };
      const thrown = [
        ...f.nadesFrom('flashbang', CCH_A_MAIN),
        ...f.nadesFrom('smokegrenade', CCH_A_MAIN)
      ].sort((a, b) => a.at - b.at)[0];
      if (!thrown || !alive(thrown.at)) return null;
      return { marks: { Utility: thrown.at, 'Held from': run.start } };
    }
  },
  {
    key: 'cch-ct-door-push',
    label: 'Door push',
    desc: 'A CT on A door for 5s+.',
    match(f) {
      const run = longestRun(f.series, 0, f.lastSec, (sec) => f.countIn(CCH_A_DOOR, sec) >= 1);
      if (run.seconds < CCH_SEARCH_SECONDS) return null;
      return { marks: { 'Held from': run.start } };
    }
  },
  {
    key: 'cch-ct-3-mid',
    label: '3 mid fight',
    desc: '3 CTs starting in CT Mid and holding it, or fighting out of it, for 10s.',
    match(f) {
      const start = f.firstSecWith(CCH_CT_MID, 3);
      if (start === null) return null;
      const to = start + CCH_MID_FIGHT_SECONDS;
      const run = longestRun(f.series, start, to, (sec) => f.countIn(CCH_CT_MID, sec) >= 3);
      const fought = f
        .fights({ from: start, to })
        .some((x) => ourFighterIn(f, x, CCH_CT_MID));
      if (run.seconds < CCH_MID_FIGHT_SECONDS && !fought) return null;
      return { marks: { 'Set from': start } };
    }
  },
  {
    key: 'cch-ct-mid-retake',
    label: 'Mid retake',
    desc: 'Mid given up, a T stepping into mid / under boost / right mid, and a CT then taking that ground back or trading with him on it.',
    match(f) {
      // The T entry is the anchor: before it the ground has to be empty of CTs,
      // after it somebody has to go and get it.
      const stepped = f.enemy.firstSecWith(CCH_MID_TRADE_IN, 1);
      if (stepped === null) return null;
      if (f.playersDuring(CCH_MID_HOLD, 0, stepped).size) return null;
      const back = f.firstSecWith(CCH_MID_HOLD, 1, stepped, f.lastSec);
      const duel = f.fights({ from: stepped, enemyIn: CCH_MID_TRADE_IN })[0];
      if (back === null && !duel) return null;
      const marks = { 'T in': stepped };
      if (back !== null) marks.Retaken = back;
      if (duel) marks.Contact = duel.sec;
      return { marks };
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
  DD2: { T: DD2_T, CT: DD2_CT },
  ANU: { T: ANU_T, CT: ANU_CT },
  ANC: { T: ANC_T, CT: ANC_CT },
  MIR: { T: MIR_T, CT: MIR_CT },
  CCH: { T: CCH_T, CT: CCH_CT }
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
  },
  ANU: {
    utility: ['blurk', 'bleft', 'palace', 'heaven', 'camera'],
    regions: [
      ...ANU_B_STAGE.map((n) => [n]),
      ...ANU_B_IN.map((n) => [n]),
      ANU_B_SITE,
      ANU_CT_CON,
      ...ANU_CON.map((n) => [n]),
      BRIDGE,
      ...BLUE_CRAB.map((n) => [n]),
      ...BLUE_DOORS.map((n) => [n]),
      ANU_T_MID,
      ...ANU_MID_STAGE.map((n) => [n]),
      CAMERA,
      TEMPLE,
      ...ANU_A_HOLD.map((n) => [n]),
      ANU_A_WATER,
      ...ANU_A_ANCHOR.map((n) => [n]),
      ...WATER_FLASH.map((n) => [n]),
      ...WATER_SMOKE.map((n) => [n]),
      ...ANU_T_WATER_POS.map((n) => [n])
    ]
  },
  ANC: {
    utility: [
      ...ANC_B_EXEC_SMOKES,
      'blurk',
      'pillar',
      'window',
      ...ANC_MID_FAKE_MOLLYS,
      ...ANC_MID_MOLLYS,
      'elbow',
      'street',
      'door'
    ],
    regions: [
      ANC_B_RAMP,
      ANC_B_SITE,
      ANC_B_CAVE,
      ANC_B_STREET,
      ANC_T_SPAWN,
      ANC_B_DOOR,
      ...ANC_LURK_GROUND.map((n) => [n]),
      ANC_MID_1,
      ANC_MID_2,
      ANC_MID_3,
      ANC_ELBOW,
      ANC_LEDGE,
      ANC_RUNBOOST,
      ANC_STREET,
      ANC_HEAVEN,
      ANC_CT_MID,
      ANC_CT_WINDOW,
      ANC_CT_DONUT,
      ANC_WINDOW,
      ANC_A_MAIN,
      ANC_A_POS,
      ANC_A_SITE,
      ANC_CT_SPAWN,
      ANC_REDROOM,
      ANC_CT_CAVE,
      ...ANC_A_SMOKE_GROUND.map((n) => [n]),
      ...ANC_STREET_THROUGH.map((n) => [n]),
      ...ANC_MID_FAKE_THROW.map((n) => [n])
    ]
  },
  MIR: {
    utility: ['kitchen', ...MIR_A_EXEC_SMOKES],
    regions: [
      MIR_MID,
      MIR_T_MID,
      ...MIR_MID_GROUND.map((n) => [n]),
      ...MIR_CT_MID_FROM.map((n) => [n]),
      ...MIR_B_STAGE.map((n) => [n]),
      ...MIR_B_DEFEND.map((n) => [n]),
      ...MIR_B_SPLIT_LANE.map((n) => [n]),
      MIR_T_A,
      MIR_A_RAMP,
      ...MIR_A_IN.map((n) => [n]),
      ...MIR_A_DEFEND.map((n) => [n]),
      ...MIR_PALACE_FROM.map((n) => [n]),
      MIR_WINDOW,
      MIR_T_OUTSIDE,
      ...MIR_AWP_START.map((n) => [n]),
      MIR_BOOST,
      ...MIR_UNDER_BLOCK.map((n) => [n])
    ]
  },
  CCH: {
    utility: [...CCH_A_SMOKES, ...CCH_B_SMOKES, ...CCH_MID_MOLLYS],
    regions: [
      CCH_A_MAIN,
      CCH_A_POS,
      CCH_A_DOOR,
      ...CCH_A_DEFEND.map((n) => [n]),
      ...CCH_A_FLANK.map((n) => [n]),
      CCH_B_MAIN,
      CCH_B_POS,
      ...CCH_B_DEFEND.map((n) => [n]),
      CCH_CHECKERS,
      CCH_VENTS,
      CCH_RIGHT_MID,
      CCH_T_MID,
      CCH_CT_MID,
      ...CCH_MID_TRADE_IN.map((n) => [n]),
      ...CCH_MID_HOLD.map((n) => [n]),
      CCH_BOOST,
      CCH_MID_GARAGE
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
  return requiredRegionGroups(mapCode).map(regionGroupLabel);
}

/**
 * A group as a coach reads it. Layer qualifiers are an implementation detail
 * of the lookup, not something to print in a readiness note.
 */
export function regionGroupLabel(group) {
  return [...new Set(group.map(plainRegionName))].join(' / ');
}
