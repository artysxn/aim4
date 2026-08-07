// ---------------------------------------------------------------------------
// Pattern finder rework, Chapter 0: shared definitions as data.
//
// Formation notation, lane-to-region mappings, snapshot clocks, pace types and
// the fake descriptor, straight from the rework plan. The UI reads labels from
// here; the future analysis passes read the region references and thresholds.
// Clock values count DOWN ("1:42" means 1:42 left on the round timer).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ kind: 'area'|'zone'|'position', name: string }} RegionRef
 *   A named region in the map's region hierarchy (see zones/regionHierarchy.js).
 *   Referenced by name; resolution against the actual network happens at
 *   analysis time, not here.
 *
 * @typedef {object} Lane
 * @property {string} key
 * @property {string} label     as written in the notation header, e.g. "B / UG"
 * @property {string} short     single token used for the 5-stack form ("5B")
 * @property {RegionRef[]} regions  membership: a player in any of these is in the lane
 *
 * @typedef {object} FormationDef
 * @property {Lane[]} t            T lanes in notation order
 * @property {{ label: string }[]} ct  CT notation slots ("ee" = everything else)
 * @property {string} snapshot     clock at which the default is measured
 * @property {{ lane: string, when: string } | null} skip
 *   Which T lane may be omitted from the notation when empty, and the exact
 *   positional condition from the plan. null = zeros are always written.
 */

/** Maps covered by the pattern finder, in veto-screen order. */
export const PATTERN_MAP_CODES = ['DD2', 'MIR', 'INF', 'NUK', 'ANC', 'ANU', 'CCH'];

const area = (name) => ({ kind: 'area', name });
const zone = (name) => ({ kind: 'zone', name });
const position = (name) => ({ kind: 'position', name });

/** @type {Record<string, FormationDef>} */
export const FORMATIONS = {
  DD2: {
    t: [
      { key: 'b', label: 'B', short: 'B', regions: [area('T_B')] },
      { key: 'mid', label: 'Mid', short: 'Mid', regions: [area('T_MID')] },
      { key: 'long', label: 'Long', short: 'Long', regions: [area('T_LONG')] }
    ],
    ct: [{ label: 'B' }, { label: 'ee' }, { label: 'A' }],
    snapshot: '1:42',
    skip: { lane: 'long', when: 'No player in the Long box or Taxi positions' }
  },
  MIR: {
    // The plan's notation header writes the third lane as "Long" but defines
    // its membership as the zone "T A"; the worked example also calls it A.
    t: [
      {
        key: 'b',
        label: 'B / UG',
        short: 'B',
        regions: [position('T Aps'), position('Underground'), position('B Aps')]
      },
      {
        key: 'mid',
        label: 'Mid',
        short: 'Mid',
        regions: [
          position('T Mid'),
          position('Top mid'),
          position('Boxes'),
          position('Delpan'),
          position('Mid'),
          position('Catwalk'),
          position('T Spawn'),
          position('TV'),
          position('Lower mid')
        ]
      },
      { key: 'a', label: 'A', short: 'A', regions: [zone('T A')] }
    ],
    ct: [{ label: 'B' }, { label: 'ee' }, { label: 'A' }],
    snapshot: '1:46',
    skip: null
  },
  ANC: {
    t: [
      {
        key: 'b',
        label: 'B',
        short: 'B',
        regions: [
          position('B Door'),
          position('Shrek'),
          zone('B Ramp'),
          zone('B Street'),
          zone('Cave')
        ]
      },
      { key: 'mid', label: 'Mid', short: 'Mid', regions: [position('T Spawn'), zone('T Mid')] },
      { key: 'a', label: 'A', short: 'A', regions: [zone('A Main')] }
    ],
    ct: [{ label: 'B' }, { label: 'ee' }, { label: 'A' }],
    snapshot: '1:44',
    skip: { lane: 'a', when: 'No player in the A Main or A Lobby positions' }
  },
  INF: {
    t: [
      { key: 'b', label: 'B', short: 'B', regions: [area('T_B')] },
      { key: 'a', label: 'A', short: 'A', regions: [area('T_A')] }
    ],
    ct: [{ label: 'B' }, { label: 'A' }],
    snapshot: '1:40',
    skip: null
  },
  NUK: {
    t: [
      { key: 'outside', label: 'Outside', short: 'Outside', regions: [area('T_YARD')] },
      { key: 'lobby', label: 'Lobby', short: 'Lobby', regions: [area('T_LOBBY')] }
    ],
    // Ramp players are read straight off the ramp zone at snapshot time.
    ct: [{ label: 'A' }, { label: 'ee' }, { label: 'Ramp' }],
    snapshot: '1:42',
    skip: null
  },
  ANU: {
    t: [
      { key: 'b', label: 'B', short: 'B', regions: [area('T_B')] },
      { key: 'mid', label: 'Mid', short: 'Mid', regions: [area('T_MID')] },
      { key: 'a', label: 'Con / A', short: 'A', regions: [area('T_WATER')] }
    ],
    ct: [{ label: 'B' }, { label: 'ee' }, { label: 'A' }],
    snapshot: '1:42',
    skip: null
  },
  CCH: {
    t: [
      { key: 'a', label: 'A', short: 'A', regions: [area('T_A')] },
      { key: 'mid', label: 'Mid', short: 'Mid', regions: [area('T_MID')] },
      { key: 'b', label: 'B', short: 'B', regions: [area('T_B')] }
    ],
    ct: [{ label: 'A' }, { label: 'ee' }, { label: 'B' }],
    snapshot: '1:39',
    skip: null
  }
};

/**
 * Notation rules that apply on every map:
 * - Dead players count as alive; the death location decides their lane at the
 *   snapshot clock.
 * - Five players toward one lane is written "5" + lane, never 5-0-0.
 */
export const FORMATION_RULES = {
  deadCountAsAlive: true,
  fiveStackForm: true
};

/**
 * T-side pace types, strictest first. `criteria` keeps the plan's thresholds
 * as data for the analysis pass; `desc` is the human wording shown in UI.
 * All clocks count down.
 *
 * @typedef {object} PaceType
 * @property {string} key
 * @property {string} label
 * @property {string} desc
 * @property {object} criteria
 */

/** @type {PaceType[]} */
export const PACE_TYPES = [
  {
    key: 'rush',
    label: 'Rush',
    desc: 'Plant, 3 players on site, or 3 combined deaths by 1:33.',
    criteria: {
      by: '1:33',
      plantCounts: true,
      siteEntryPlayers: 3,
      combinedDeaths: 3,
      note: '1 or 2 players holding W for at least 80% of the round until it transitions or they die.'
    }
  },
  {
    key: 'pop',
    label: 'Pop',
    desc: 'Plant, 3 players on site, or 3 combined deaths by 1:20, with no kill at 1:42 or earlier.',
    criteria: {
      by: '1:20',
      plantCounts: true,
      siteEntryPlayers: 3,
      combinedDeaths: 3,
      noKillsAtOrBefore: '1:42'
    }
  },
  {
    key: 'contact',
    label: 'Contact',
    desc: 'Plant, 4 players on site, or 4 combined deaths by 1:15, with no kill at 1:28 or earlier.',
    criteria: {
      by: '1:15',
      plantCounts: true,
      siteEntryPlayers: 4,
      combinedDeaths: 4,
      noKillsAtOrBefore: '1:28'
    }
  },
  {
    key: 'full-exec',
    label: 'Full exec',
    desc: 'At least 2 molotovs, 2 smokes and 2 flashes spent, 4 players in key zones or the site, at most 1 dead per team.',
    criteria: {
      minMolotovs: 2,
      minSmokes: 2,
      minFlashes: 2,
      playersCommitted: 4,
      maxDeadPerTeam: 1,
      fightsBetween: ['1:30', '0:30']
    }
  },
  {
    key: 'default',
    label: 'Default',
    desc: 'No 2 players entering a site earlier than 1:17, spread across the lanes.',
    criteria: {
      noSiteEntryPlayersBefore: { players: 2, clock: '1:17' },
      validSpreads: 'At least 2 players in 2 lanes (2-2-1, 1-2-2, 2-1-2, 3-2, 2-3), or no more than 3 players in any lane (3-1-1, 3-0-2, 3-2-0 and mirrors).'
    }
  },
  {
    key: 'slow-default',
    label: 'Slow default',
    desc: 'A default with at most 2 smokes, 2 molotovs and 2 flashes by 1:25 and no kill until 1:20.',
    criteria: {
      base: 'default',
      byClock: '1:25',
      maxSmokes: 2,
      maxMolotovs: 2,
      maxFlashes: 2,
      noKillsUntil: '1:20'
    }
  }
];

/**
 * The fake descriptor. Not a pace of its own; written before the real call,
 * e.g. "Fake A, 3-0-2 B Pop".
 */
export const FAKE_DESCRIPTOR = {
  key: 'fake',
  label: 'Fake',
  desc: 'A smoke, decoy, molotov, or 1 player (2 if the other 3 hold a core) showing on one site while at least 3 of the rest go the other way.',
  criteria: {
    signals: ['smoke', 'decoy', 'molotov', 'player'],
    maxFakingPlayers: 2,
    minPlayersOtherWay: 3
  }
};

export function paceType(key) {
  return PACE_TYPES.find((p) => p.key === key) || null;
}

/** "1:42" -> 102 seconds left on the round clock. null when unparseable. */
export function clockSeconds(clock) {
  const m = /^(\d+):([0-5]\d)$/.exec(String(clock || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Write a T formation notation from per-lane counts (notation order).
 * Applies the plan's rules: the 5-stack form, and lane omission where the map
 * allows it. Returns '' when counts do not line up with the map's lanes.
 *
 * @param {string} mapCode
 * @param {number[]} counts
 */
export function formatFormation(mapCode, counts) {
  const def = FORMATIONS[mapCode];
  if (!def || !Array.isArray(counts) || counts.length !== def.t.length) return '';
  const clean = counts.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));

  const five = clean.findIndex((n) => n >= 5);
  if (five !== -1) {
    const lane = def.t[five];
    return lane.short.length === 1 ? `5${lane.short}` : `5 ${lane.short}`;
  }

  const parts = [];
  for (let i = 0; i < def.t.length; i++) {
    const lane = def.t[i];
    if (def.skip && def.skip.lane === lane.key && clean[i] === 0) continue;
    parts.push(String(clean[i]));
  }
  return parts.join('-');
}
