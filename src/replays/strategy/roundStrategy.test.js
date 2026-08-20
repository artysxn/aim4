// ---------------------------------------------------------------------------
// Round → stratbook row: seating, utility folding, and the note text.
//
// The round here is synthetic and tiny, because what is being pinned down is
// the reading, not the parser: a hold is four seconds, the spawn is never
// written, a smoke handed 1→2→1 is not a drop and 1→2→3 is two of them.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRoundNotes, buyString, lookTarget, utilityHandovers } from './roundNarrative.js';
import { foldRoundUtility, TYPE_WORDS } from './utilityImport.js';
import { seatPlayers } from './roundRoles.js';
import { sidePlayers } from './addStrategy.js';
import { createNamer } from './regionNames.js';

const RATE = 64;
const T0 = 1000;

/**
 * Four named boxes under three zones. Top Mid and Catwalk deliberately share
 * one zone: movement is measured at the zone layer, so walking between them is
 * not going anywhere, while walking on to A Ramp is.
 */
const NETWORK = {
  positions: [
    { id: 'p_spawn', name: 'T Spawn', pieces: [{ type: 'rect', x: -500, y: -500, w: 400, h: 400 }] },
    { id: 'p_mid', name: 'Top Mid', pieces: [{ type: 'rect', x: 0, y: 0, w: 400, h: 400 }] },
    { id: 'p_cat', name: 'Catwalk', pieces: [{ type: 'rect', x: 600, y: 0, w: 400, h: 400 }] },
    { id: 'p_ramp', name: 'A Ramp', pieces: [{ type: 'rect', x: 0, y: 800, w: 400, h: 400 }] }
  ],
  zones: [
    { id: 'z_t', name: 'T Side', positionIds: ['p_spawn'] },
    { id: 'z_mid', name: 'Mid', positionIds: ['p_mid', 'p_cat'] },
    { id: 'z_a', name: 'A Site', positionIds: ['p_ramp'] }
  ],
  areas: [],
  visionBlocks: [],
  // A bombsite sitting over the A Ramp box, so entries can be staged.
  bombSites: { a: [{ type: 'rect', x: 0, y: 800, w: 400, h: 400, level: 'default' }], b: [] }
};

const AT = {
  spawn: { x: -300, y: -300 },
  mid: { x: 200, y: 200 },
  cat: { x: 800, y: 200 },
  ramp: { x: 200, y: 1000 }
};

/** Weapon dictionary; a waypoint's `weapon` indexes into it. Default is the rifle. */
const WEAPONS = ['ak47', 'smokegrenade', 'flashbang', 'molotov', 'hegrenade'];
const GUN = 0;
const SMOKE_OUT = 1;

/**
 * A track whose bodies teleport between named boxes on a schedule.
 * @param {Record<number, Array<{ at: number, x: number, y: number, weapon?: number }>>} plan
 *   slot → waypoints, `at` in seconds after the round went live
 */
function fakeTrack(plan) {
  return {
    sample(slot, tick, out = {}) {
      const sec = (tick - T0) / RATE;
      const path = plan[slot] || [];
      let cur = path[0] || { x: 0, y: 0 };
      for (const p of path) if (p.at <= sec) cur = p;
      out.x = cur.x;
      out.y = cur.y;
      out.z = cur.z ?? 0;
      out.yaw = cur.yaw ?? 90;
      out.pitch = -10;
      out.alive = true;
      out.armor = cur.armor ?? 0;
      out.weapon = cur.weapon ?? GUN;
      out.flags = 1;
      return out;
    }
  };
}

function roundMeta({ players, grenades = [], items = [], stats = {} }) {
  return {
    map: 'MIR',
    tickRate: RATE,
    startTick: T0 - 3 * RATE,
    freezeEndTick: T0,
    endTick: T0 + 60 * RATE,
    officialEndTick: T0 + 65 * RATE,
    team1Side: 'T',
    team2Side: 'CT',
    players,
    weapons: WEAPONS,
    stats,
    events: { kills: [], shots: [], grenades, bomb: [], damage: [], items }
  };
}

/** Notes open with the player's name; the assertions below read what follows. */
const body = (note) => String(note || '').replace(/^[^:]*: /, '');

/** A throw late in the round, so a hold before it is never the last line. */
const LATE_NADE = {
  type: 'hegrenade',
  player: 'aaa',
  throwTick: T0 + 50 * RATE,
  detonateTick: T0 + 51 * RATE,
  at: { x: 5000, y: 5000, z: 0 }
};

const FIVE = [
  { id: 'aaa', name: 'one', team: 1, slot: 0 },
  { id: 'bbb', name: 'two', team: 1, slot: 1 },
  { id: 'ccc', name: 'three', team: 1, slot: 2 },
  { id: 'ddd', name: 'four', team: 1, slot: 3 },
  { id: 'eee', name: 'five', team: 1, slot: 4 },
  { id: 'fff', name: 'six', team: 2, slot: 5 }
];

// ---------------------------------------------------------------------------

test('sidePlayers reads the roster for the side, not the team number', () => {
  const meta = roundMeta({ players: FIVE });
  assert.deepEqual(sidePlayers(meta, 'T'), ['aaa', 'bbb', 'ccc', 'ddd', 'eee']);
  assert.deepEqual(sidePlayers(meta, 'CT'), ['fff']);
});

test('seatPlayers puts each label in its own column', () => {
  const roles = {
    maps: {
      MIR: {
        T: {
          aaa: { label: 'Mid' },
          bbb: { label: 'AWPer' },
          ccc: { label: 'A Lurk' },
          ddd: { label: 'B / UG' },
          eee: { label: 'Rotation' }
        }
      }
    }
  };
  const { columns, seats, matched } = seatPlayers({
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
    roles
  });
  assert.deepEqual(columns, ['Rotation', 'A Lurk', 'B / UG', 'AWPer', 'Mid']);
  assert.deepEqual(seats, ['eee', 'ccc', 'ddd', 'bbb', 'aaa']);
  assert.equal(matched, 5);
});

test('two players on one role still fill five distinct columns', () => {
  const roles = {
    maps: {
      MIR: {
        T: {
          aaa: { label: 'Mid' },
          bbb: { label: 'Mid' },
          ccc: { label: 'A Lurk' },
          ddd: { label: 'B / UG' },
          eee: { label: 'Rotation' }
        }
      }
    }
  };
  const { seats } = seatPlayers({
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
    roles
  });
  assert.equal(new Set(seats).size, 5, 'every column gets a different player');
  assert.ok(seats.every(Boolean), 'no column is left empty');
  // Whichever of the two Mids lost the toss lands in the one free column.
  assert.equal(seats[3], seats.includes('aaa') && seats[4] === 'bbb' ? 'aaa' : seats[3]);
});

test('no roles at all still seats everybody', () => {
  const { seats } = seatPlayers({
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'],
    roles: null
  });
  assert.equal(new Set(seats).size, 5);
});

// ---------------------------------------------------------------------------

test('a landing takes the nearest painted position, and a second throw folds in', () => {
  const namer = createNamer(NETWORK, 'MIR');
  const track = fakeTrack({ 0: [{ at: 0, ...AT.spawn }], 1: [{ at: 0, ...AT.mid }] });
  const grenades = [
    { type: 'smokegrenade', player: 'aaa', throwTick: T0 + RATE, detonateTick: T0 + 2 * RATE, at: { ...AT.cat, z: 0 } },
    // Same landing, thrown from somewhere else: one spot, two lineups.
    { type: 'smokegrenade', player: 'bbb', throwTick: T0 + 3 * RATE, detonateTick: T0 + 4 * RATE, at: { x: AT.cat.x + 20, y: AT.cat.y, z: 0 } }
  ];
  const slotOf = { aaa: 0, bbb: 1 };
  const folded = foldRoundUtility({
    archive: { map: 'MIR', updatedAt: 0, grenades: [] },
    grenades,
    originOf: (g) => track.sample(slotOf[g.player], g.throwTick, {}),
    namer,
    coachUtilities: [],
    strategyName: 'Testcall',
    side: 'T',
    roundFile: 'RND~DEMO',
    viewTickOf: (g) => g.throwTick - 0.5 * RATE
  });

  assert.equal(folded.archive.grenades.length, 1, 'one landing spot');
  assert.equal(folded.archive.grenades[0].throws.length, 2, 'two lineups onto it');
  assert.equal(folded.archive.grenades[0].name, 'T Testcall Catwalk Smoke');
  assert.equal(folded.links.length, 2);
  const [th] = folded.archive.grenades[0].throws;
  assert.match(th.setpos, /^setpos -300\./);
  assert.equal(th.round, 'RND~DEMO');
  assert.equal(th.tick, T0 + RATE - 32);
  assert.equal(th.player, 'aaa');

  // Re-importing the same round must not double anything.
  const again = foldRoundUtility({
    archive: folded.archive,
    grenades,
    originOf: (g) => track.sample(slotOf[g.player], g.throwTick, {}),
    namer,
    coachUtilities: [],
    strategyName: 'Testcall',
    side: 'T',
    roundFile: 'RND~DEMO',
    viewTickOf: (g) => g.throwTick - 0.5 * RATE
  });
  assert.equal(again.archive.grenades.length, 1);
  assert.equal(again.archive.grenades[0].throws.length, 2);
  assert.equal(again.changed, false);
});

test('a stored coaching name beats the painted position', () => {
  const namer = createNamer(NETWORK, 'MIR');
  const folded = foldRoundUtility({
    archive: { map: 'MIR', updatedAt: 0, grenades: [] },
    grenades: [
      { type: 'smokegrenade', player: 'aaa', throwTick: T0, detonateTick: T0 + RATE, at: { ...AT.cat, z: 0 } }
    ],
    originOf: () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }),
    namer,
    coachUtilities: [{ id: 'x', name: 'a1', type: 'smokegrenade', detonate: { ...AT.cat } }],
    strategyName: 'Call',
    side: 'T',
    roundFile: '',
    viewTickOf: () => 0
  });
  assert.equal(folded.links[0].spot, 'a1');
  assert.equal(folded.archive.grenades[0].name, 'T Call a1 Smoke');
});

test('incendiaries and molotovs are both Molo', () => {
  assert.equal(TYPE_WORDS.molotov, 'Molo');
  const namer = createNamer(NETWORK, 'MIR');
  const folded = foldRoundUtility({
    archive: { map: 'MIR', updatedAt: 0, grenades: [] },
    grenades: [
      { type: 'incgrenade', player: 'aaa', throwTick: T0, detonateTick: T0 + RATE, at: { ...AT.mid, z: 0 } }
    ],
    originOf: () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }),
    namer,
    strategyName: 'Call',
    side: 'CT',
    roundFile: '',
    viewTickOf: () => 0
  });
  assert.equal(folded.links[0].word, 'Molo');
  assert.equal(folded.archive.grenades[0].type, 'molotov');
});

// ---------------------------------------------------------------------------

test('a smoke passed 1 -> 2 -> 1 is not written; 1 -> 2 -> 3 is', () => {
  const near = (id) => ({ x: id === 'zzz' ? 5000 : 0, y: 0 });
  const base = {
    grenades: [],
    loadouts: new Map([
      ['aaa', ['Smoke Grenade']],
      ['bbb', []],
      ['ccc', []]
    ]),
    deadAt: new Map(),
    positionAt: (id) => near(id),
    secOf: (tick) => (tick - T0) / RATE,
    tickRate: RATE,
    sideIds: new Set(['aaa', 'bbb', 'ccc']),
    fromTick: T0,
    toTick: T0 + 60 * RATE
  };

  const roundTrip = utilityHandovers({
    ...base,
    items: [
      { tick: T0 + 2 * RATE, player: 'bbb', item: 'smokegrenade', op: 'pickup' },
      { tick: T0 + 6 * RATE, player: 'aaa', item: 'smokegrenade', op: 'pickup' }
    ]
  });
  assert.deepEqual(roundTrip, [], 'a there-and-back is a shuffle, not a relay');

  const relay = utilityHandovers({
    ...base,
    items: [
      { tick: T0 + 2 * RATE, player: 'bbb', item: 'smokegrenade', op: 'pickup' },
      { tick: T0 + 6 * RATE, player: 'ccc', item: 'smokegrenade', op: 'pickup' }
    ]
  });
  assert.deepEqual(
    relay.map((h) => `${h.from}>${h.to}`),
    ['aaa>bbb', 'bbb>ccc']
  );
});

test('utility off the floor with no teammate holding one is nobody\'s drop', () => {
  const out = utilityHandovers({
    items: [{ tick: T0 + 2 * RATE, player: 'bbb', item: 'hegrenade', op: 'pickup' }],
    grenades: [],
    loadouts: new Map([['aaa', []], ['bbb', []]]),
    deadAt: new Map(),
    positionAt: () => ({ x: 0, y: 0 }),
    secOf: (tick) => (tick - T0) / RATE,
    tickRate: RATE,
    sideIds: new Set(['aaa', 'bbb']),
    fromTick: T0,
    toTick: T0 + 60 * RATE
  });
  assert.deepEqual(out, []);
});

test('a teammate too far away did not hand anything over', () => {
  const out = utilityHandovers({
    items: [{ tick: T0 + 2 * RATE, player: 'bbb', item: 'smokegrenade', op: 'pickup' }],
    grenades: [],
    loadouts: new Map([['aaa', ['Smoke Grenade']], ['bbb', []]]),
    deadAt: new Map(),
    positionAt: (id) => (id === 'aaa' ? { x: 4000, y: 0 } : { x: 0, y: 0 }),
    secOf: (tick) => (tick - T0) / RATE,
    tickRate: RATE,
    sideIds: new Set(['aaa', 'bbb']),
    fromTick: T0,
    toTick: T0 + 60 * RATE
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------

test('buy letters follow the stratbook shorthand', () => {
  assert.equal(buyString(['P250', 'Smoke Grenade', 'Flashbang'], { armor: 100 }), 'KPSF');
  assert.equal(buyString(['Dual Berettas'], { armor: 0 }), 'D');
  assert.equal(buyString(['Tec-9', 'High Explosive Grenade'], { armor: 0 }), 'TN');
  assert.equal(buyString(['Molotov'], { armor: 100 }), 'KM');
  assert.equal(buyString(['Incendiary Grenade'], { armor: 0 }), 'M');
  // A Glock has no letter in the shorthand, so a naked pistol round is blank.
  assert.equal(buyString(['Glock-18'], { armor: 0 }), '');
});

// ---------------------------------------------------------------------------

test('the spawn is never written, and a five second stay is', () => {
  const meta = roundMeta({ players: FIVE, grenades: [LATE_NADE] });
  // Sits in spawn for ten seconds, holds Top Mid, then moves off it.
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 10, ...AT.mid },
      { at: 40, ...AT.ramp }
    ]
  });
  const notes = buildRoundNotes({
    meta,
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    links: [],
    economy: 'Full buy'
  });
  const note = body(notes.get('aaa'));
  assert.ok(!note.includes('T Spawn'), `spawn leaked into "${note}"`);
  assert.match(note, /^Stay Top Mid until \d:\d\d, Nade \d:\d\d$/);
});

test('going somewhere is a zone; staying somewhere is a position', () => {
  // Top Mid → Catwalk is one zone, so crossing it is not going anywhere. Each
  // arrival is escorted by a teammate flash so the Go lines are eligible.
  const flashes = [8, 16, 26].map((at) => ({
    type: 'flashbang',
    player: 'bbb',
    throwTick: T0 + (at - 1) * RATE,
    detonateTick: T0 + at * RATE,
    at: { ...AT.mid, z: 0 }
  }));
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 8, ...AT.mid },
      { at: 16, ...AT.cat },
      { at: 26, ...AT.ramp }
    ],
    1: [{ at: 0, ...AT.spawn }]
  });
  const note = body(buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [...flashes, LATE_NADE] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa'));

  const gos = note.match(/Go [^,]+/g) || [];
  assert.deepEqual(gos, ['Go Mid', 'Go A Site on flash from two']);
  // …while the spots he sat on inside those zones are named exactly.
  assert.match(note, /Stay Top Mid until \d:\d\d/);
  assert.match(note, /Stay Catwalk until \d:\d\d/);
});

test('a note opens with the buy on a pistol round and not on a full buy', () => {
  const meta = roundMeta({
    players: FIVE,
    stats: { aaa: { loadout: ['P250', 'Flashbang'] } }
  });
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 5, ...AT.mid, armor: 100 }
    ]
  });
  const pistol = buildRoundNotes({
    meta,
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Pistol'
  }).get('aaa');
  assert.match(body(pistol), /^PF\./, `expected a buy prefix in "${pistol}"`);

  const full = buildRoundNotes({
    meta,
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa');
  assert.ok(!body(full).startsWith('PF.'), `buy leaked into a full buy: "${full}"`);
});

test('a throw is written at its clock and carries its link tags', () => {
  const grenades = [
    {
      type: 'smokegrenade',
      player: 'aaa',
      throwTick: T0 + 6 * RATE,
      detonateTick: T0 + 8 * RATE,
      at: { ...AT.cat, z: 0 }
    }
  ];
  const meta = roundMeta({ players: FIVE, grenades });
  const track = fakeTrack({ 0: [{ at: 0, ...AT.spawn }] });
  const note = buildRoundNotes({
    meta,
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    links: [{ grenade: grenades[0], type: 'smokegrenade', word: 'Smoke', spot: 'Catwalk', throwId: 'nF4e' }],
    economy: 'Full buy'
  }).get('aaa');
  assert.equal(body(note), '<Smoke Catwalk 1:49><!nF4e>');
});

test('walking in behind a teammate\'s grenade is an entry; walking in alone is not', () => {
  const cover = [
    {
      type: 'flashbang',
      player: 'bbb',
      throwTick: T0 + 9 * RATE,
      detonateTick: T0 + 11 * RATE,
      at: { ...AT.cat, z: 0 }
    }
  ];
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 10, ...AT.mid },
      { at: 13, ...AT.ramp },
      { at: 40, ...AT.mid }
    ],
    1: [{ at: 0, ...AT.spawn }]
  });
  const withCover = body(buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [...cover, LATE_NADE] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa'));
  assert.match(withCover, /Go Mid on flash from two/);

  const earlySmoke = {
    type: 'smokegrenade',
    player: 'bbb',
    throwTick: T0 + 5 * RATE,
    detonateTick: T0 + 7 * RATE,
    at: { ...AT.mid, z: 0 }
  };
  const earlyGo = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [earlySmoke, LATE_NADE] }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }, { at: 40, ...AT.ramp }],
        1: [{ at: 0, ...AT.spawn }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(earlyGo, /Go Mid/);
  assert.ok(!/on smoke from/i.test(earlyGo), `opening Go named the thrower: "${earlyGo}"`);

  const alone = body(buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [LATE_NADE] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa'));
  assert.ok(!alone.includes('on flash'), `cover-less arrival named a thrower: "${alone}"`);
  assert.match(alone, /Go Top Mid to A Site\. Stay A Ramp until \d:\d\d/);
});

test('standing in a smoke is written', () => {
  const grenades = [
    {
      type: 'smokegrenade',
      player: 'bbb',
      throwTick: T0 + RATE,
      detonateTick: T0 + 2 * RATE,
      at: { x: AT.mid.x, y: AT.mid.y, z: 0 }
    }
  ];
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 6, ...AT.mid }
    ],
    1: [{ at: 0, ...AT.spawn }]
  });
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa');
  assert.match(body(note), /In smoke at Top Mid/);
});

test('five seconds with a smoke out is a line-up, not a hold', () => {
  const nade = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 18 * RATE,
    detonateTick: T0 + 20 * RATE,
    at: { ...AT.cat, z: 0 }
  };
  // Walks on to Top Mid at 8s, pulls the smoke out, throws it ten seconds later.
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 8, ...AT.mid, weapon: SMOKE_OUT },
      { at: 19, ...AT.mid, weapon: GUN },
      { at: 40, ...AT.cat, weapon: GUN }
    ]
  });
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [nade, LATE_NADE] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    links: [{ grenade: nade, type: 'smokegrenade', word: 'Smoke', spot: 'Window', throwId: 'nF4e' }],
    economy: 'Full buy'
  }).get('aaa');

  // He holds the spot AND puts the smoke up from it: both lines, one throw.
  assert.match(note, /Stay Top Mid until \d:\d\d/);
  assert.match(note, /Line up <Window smoke><!nF4e> from Top Mid, throw at 1:37/);
  assert.equal(note.match(/nF4e/g).length, 1, 'the throw is not written twice');
  assert.ok(!note.includes('Smoke Window at'), `plain throw line survived: "${note}"`);
});

test('a gun back in hand after the throw still earns its own hold', () => {
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 8, ...AT.mid, weapon: GUN },
      { at: 40, ...AT.ramp, weapon: GUN }
    ]
  });
  const note = body(buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [LATE_NADE] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa'));
  assert.match(note, /^Stay Top Mid until \d:\d\d, Nade \d:\d\d$/);
});

test('four grenades from two players after 1:35 gather under one exec clause', () => {
  const nadeAt = (player, sec) => ({
    type: 'flashbang',
    player,
    throwTick: T0 + sec * RATE,
    detonateTick: T0 + (sec + 1) * RATE,
    at: { ...AT.ramp, z: 0 }
  });
  // 1:35 is 20 seconds in. Four throws inside five seconds, from two players.
  const grenades = [nadeAt('aaa', 24), nadeAt('bbb', 25), nadeAt('aaa', 26), nadeAt('bbb', 27)];
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 30, ...AT.ramp }],
    1: [{ at: 0, ...AT.spawn }]
  });
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa');
  assert.match(body(note), /^On exec, do Flash /);
  // Both of his throws sit inside the one clause, and being the same throw two
  // seconds apart they read as a double rather than as two identical lines.
  assert.equal((note.match(/On exec/g) || []).length, 1);
  assert.match(note, / 2x/);
});

test('the same burst before 1:35 is the default, not an exec', () => {
  const nadeAt = (player, sec) => ({
    type: 'flashbang',
    player,
    throwTick: T0 + sec * RATE,
    detonateTick: T0 + (sec + 1) * RATE,
    at: { ...AT.ramp, z: 0 }
  });
  const grenades = [nadeAt('aaa', 4), nadeAt('bbb', 5), nadeAt('aaa', 6), nadeAt('bbb', 7)];
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades }),
    track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }], 1: [{ at: 0, ...AT.spawn }] }),
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa');
  assert.ok(!note.includes('On exec'), `an opening default read as an exec: "${note}"`);
});

/** Every clock a note prints, as seconds elapsed, in the order it prints them. */
function clocksIn(note) {
  return [...String(note).matchAll(/(\d):(\d\d)/g)].map(
    (m) => 115 - (Number(m[1]) * 60 + Number(m[2]))
  );
}

test('a note never steps backwards in time', () => {
  // A hold that outlasts a throw made from the same spot: the stay ends at
  // 1:38 while the flash leaves at 1:45, so ordering the stay by when it began
  // would print 1:38 before 1:45 and read backwards.
  const flash = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 10 * RATE,
    detonateTick: T0 + 11 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const late = {
    type: 'hegrenade',
    player: 'aaa',
    throwTick: T0 + 40 * RATE,
    detonateTick: T0 + 41 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 6, ...AT.mid, weapon: 2 },
      { at: 11, ...AT.mid, weapon: GUN },
      { at: 34, ...AT.cat, weapon: GUN }
    ]
  });
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [flash, late] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    links: [
      { grenade: flash, type: 'flashbang', word: 'Flash', spot: 'A Ramp', throwId: 'aaaa' },
      { grenade: late, type: 'hegrenade', word: 'Nade', spot: 'A Ramp', throwId: 'bbbb' }
    ],
    economy: 'Full buy'
  }).get('aaa');

  const clocks = clocksIn(note);
  assert.ok(clocks.length >= 3, `expected several clocks in "${note}"`);
  for (let i = 1; i < clocks.length; i++) {
    assert.ok(
      clocks[i] >= clocks[i - 1],
      `clock went backwards at index ${i} in "${note}"`
    );
  }
});

test('a note names the player it was read off', () => {
  const notes = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [LATE_NADE] }),
    track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }], 4: [{ at: 0, ...AT.spawn }] }),
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'eee'],
    economy: 'Full buy'
  });
  assert.match(notes.get('aaa'), /^one: /);
  // Nothing happened to this one all round; the column still says who he is.
  assert.equal(notes.get('eee'), 'five');
});

test('a hold with nothing after it is not written', () => {
  // Walks on to Top Mid and never leaves. "Stay Top Mid until 0:55" would just
  // be where the round ran out, and leaves the reader asking "then what?".
  const alone = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!alone.includes('Stay'), `a dangling hold was written: "${alone}"`);

  // The same hold, with somewhere to go afterwards, is worth writing.
  const withNext = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [LATE_NADE] }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 40, ...AT.ramp }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(withNext, /Stay Top Mid until \d:\d\d/);
});

test('shots traded name both ends of the fight', () => {
  const meta = roundMeta({ players: FIVE });
  // Our man is on Top Mid; the enemy he trades with is on A Ramp.
  meta.events.damage = [
    { tick: T0 + 20 * RATE, attacker: 'aaa', victim: 'fff', hp: 30 },
    // …and again a moment later: one fight, not two.
    { tick: T0 + 21 * RATE, attacker: 'aaa', victim: 'fff', hp: 27 }
  ];
  const note = body(
    buildRoundNotes({
      meta,
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }],
        5: [{ at: 0, ...AT.ramp }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Fight A Ramp from Top Mid/);
  assert.equal((note.match(/Fight /g) || []).length, 1, 'one exchange, one line');
});

test('a fight gives an otherwise dangling hold its "then what"', () => {
  // Holds Top Mid, steps off it, and takes a fight from where he lands. The
  // hold now answers "then what?" and survives.
  const meta = roundMeta({ players: FIVE });
  meta.events.damage = [{ tick: T0 + 40 * RATE, attacker: 'fff', victim: 'aaa', hp: 30 }];
  const note = body(
    buildRoundNotes({
      meta,
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 30, ...AT.cat }],
        5: [{ at: 0, ...AT.ramp }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /^Stay Top Mid until \d:\d\d, Fight A Ramp from Catwalk$/);
});

test('the same angle traded twice is one line', () => {
  const meta = roundMeta({ players: FIVE });
  // Two different enemies on the same spot, far enough apart to be two
  // exchanges. To the reader it is one thing: that angle.
  meta.events.damage = [
    { tick: T0 + 20 * RATE, attacker: 'aaa', victim: 'fff', hp: 30 },
    { tick: T0 + 35 * RATE, attacker: 'aaa', victim: 'ggg', hp: 30 }
  ];
  const note = body(
    buildRoundNotes({
      meta: { ...meta, players: [...FIVE, { id: 'ggg', name: 'seven', team: 2, slot: 6 }] },
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }],
        5: [{ at: 0, ...AT.ramp }],
        6: [{ at: 0, ...AT.ramp }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.equal((note.match(/Fight /g) || []).length, 1, `repeated angle: "${note}"`);
});

test('a fight on one spot does not say it twice', () => {
  const meta = roundMeta({ players: FIVE });
  meta.events.damage = [{ tick: T0 + 20 * RATE, attacker: 'aaa', victim: 'fff', hp: 30 }];
  const note = body(
    buildRoundNotes({
      meta,
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }],
        5: [{ at: 0, ...AT.mid }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Fight in Top Mid$/);
  assert.ok(!note.includes('from Top Mid'), `said the same spot twice: "${note}"`);
});

test('a smoke off spawn is an insta, not a clock', () => {
  const insta = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 1 * RATE,
    detonateTick: T0 + 3 * RATE,
    at: { ...AT.cat, z: 0 }
  };
  const later = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 30 * RATE,
    detonateTick: T0 + 32 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [insta, later] }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: insta, type: 'smokegrenade', word: 'Smoke', spot: 'Catwalk', throwId: 'aaaa' },
        { grenade: later, type: 'smokegrenade', word: 'Smoke', spot: 'A Ramp', throwId: 'bbbb' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /^<Smoke Catwalk insta><!aaaa>/);
  assert.match(note, /<Smoke A Ramp 1:25><!bbbb>/);
});

test('a time window keeps only events inside it', () => {
  const early = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 5 * RATE,
    detonateTick: T0 + 6 * RATE,
    at: { ...AT.mid, z: 0 }
  };
  const mid = {
    type: 'hegrenade',
    player: 'aaa',
    throwTick: T0 + 40 * RATE,
    detonateTick: T0 + 41 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [early, mid, LATE_NADE] }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 38, ...AT.ramp }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy',
      windowFrom: 30,
      windowTo: 45
    }).get('aaa')
  );
  assert.equal(note.includes('Flash'), false, `early flash leaked through: "${note}"`);
  assert.match(note, /Nade/);
});

test('ten bullets into a cloud is spam; nine is not', () => {
  const smoke = {
    type: 'smokegrenade',
    player: 'fff',
    throwTick: T0 + 4 * RATE,
    detonateTick: T0 + 5 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  // Standing on Top Mid, facing A Ramp (straight up +Y, so yaw 90).
  const shotsAt = (n) =>
    Array.from({ length: n }, (_, i) => ({
      tick: T0 + (10 + i * 0.2) * RATE,
      player: 'aaa',
      weapon: 'ak47',
      x: AT.mid.x,
      y: AT.mid.y,
      z: 0,
      yaw: 90,
      pitch: 0
    }));

  const noteFor = (n) => {
    const meta = roundMeta({ players: FIVE, grenades: [smoke] });
    meta.events.shots = shotsAt(n);
    return body(
      buildRoundNotes({
        meta,
        track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }] }),
        network: NETWORK,
        mapCode: 'MIR',
        side: 'T',
        playerIds: ['aaa'],
        economy: 'Full buy'
      }).get('aaa')
    );
  };
  assert.match(noteFor(10), /Spam the A Ramp smoke/);
  assert.ok(!noteFor(9).includes('Spam'), 'nine rounds is not spamming a smoke');
});

test('the man who carries the bomb out of spawn is told so first', () => {
  const notes = buildRoundNotes({
    meta: roundMeta({
      players: FIVE,
      stats: { ccc: { loadout: ['P250', 'C4 Explosive'] } }
    }),
    track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }], 2: [{ at: 0, ...AT.spawn, armor: 100 }] }),
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'ccc'],
    economy: 'Pistol'
  });
  // Buy first, then the bomb, then whatever he does.
  assert.equal(notes.get('ccc'), 'three: KP. Take bomb.');
  assert.ok(!notes.get('aaa').includes('Take bomb'), 'the bomb went to two people');
});

test('a bomb dropped in freezetime follows the pickup, not the loadout', () => {
  // Nobody has it at the buy: it was thrown on the floor before the round went
  // live, and someone else scooped it up two seconds in.
  const meta = roundMeta({ players: FIVE });
  meta.events.bomb = [
    { type: 'dropped', tick: T0 - 2 * RATE, player: 'ccc', site: 'A' },
    { type: 'pickup', tick: T0 + 2 * RATE, player: 'eee', site: 'A' }
  ];
  const notes = buildRoundNotes({
    meta,
    track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }] }),
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'ccc', 'eee'],
    economy: 'Full buy'
  });
  assert.equal(notes.get('eee'), 'five: Take bomb.');
  assert.ok(!notes.get('ccc').includes('Take bomb'), 'the dropper kept it');
});

test('brushing the bomb for a second is not carrying it', () => {
  const meta = roundMeta({ players: FIVE });
  meta.events.bomb = [
    { type: 'pickup', tick: T0 + 1 * RATE, player: 'eee', site: 'A' },
    { type: 'dropped', tick: T0 + 2 * RATE, player: 'eee', site: 'A' }
  ];
  const notes = buildRoundNotes({
    meta,
    track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }] }),
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'eee'],
    economy: 'Full buy'
  });
  assert.ok(!notes.get('eee').includes('Take bomb'), 'one second counted as carrying');
});

test('the line stops when two Ts are standing on the site', () => {
  const late = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 45 * RATE,
    detonateTick: T0 + 46 * RATE,
    at: { ...AT.cat, z: 0 }
  };
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 20, ...AT.ramp }],
    1: [{ at: 0, ...AT.spawn }, { at: 30, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const meta = roundMeta({ players: FIVE, grenades: [late] });
  // A fight at 25s, inside the call; the smoke at 45s is outside it.
  meta.events.damage = [{ tick: T0 + 25 * RATE, attacker: 'aaa', victim: 'fff', hp: 30 }];
  const note = body(
    buildRoundNotes({
      meta,
      track,
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [{ grenade: late, type: 'smokegrenade', word: 'Smoke', spot: 'Catwalk', throwId: 'zzzz' }],
      economy: 'Full buy'
    }).get('aaa')
  );
  // The second body lands on the site at 30s, which is where the call ends.
  assert.ok(!note.includes('zzzz'), `wrote past the cutoff: "${note}"`);
  assert.match(note, /Stay Top Mid until \d:\d\d, Fight/);
});

test('the line stops when the bomb goes down', () => {
  const meta = roundMeta({ players: FIVE });
  meta.events.bomb = [{ type: 'planted', tick: T0 + 25 * RATE, player: 'aaa', site: 'A' }];
  const note = body(
    buildRoundNotes({
      meta,
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 30, ...AT.cat }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!note.includes('Catwalk'), `wrote past the plant: "${note}"`);
});

test('the line stops when a side is cut to three', () => {
  const meta = roundMeta({ players: FIVE });
  // Two of ours die: 5v5 to 4v5 to 3v5.
  meta.events.kills = [
    { tick: T0 + 12 * RATE, attacker: 'fff', victim: 'ddd', weapon: 'ak47' },
    { tick: T0 + 20 * RATE, attacker: 'fff', victim: 'eee', weapon: 'ak47' }
  ];
  const note = body(
    buildRoundNotes({
      meta,
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 5, ...AT.mid }, { at: 30, ...AT.cat }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!note.includes('Catwalk'), `wrote past three alive: "${note}"`);
});

test('the first man of a group entry is marked on the line that took him in', () => {
  const molo = {
    type: 'molotov',
    player: 'eee',
    throwTick: T0 + 17 * RATE,
    detonateTick: T0 + 19 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  // Three men onto the site, aaa first, behind eee's molotov.
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 12, ...AT.mid }, { at: 20, ...AT.ramp }],
    1: [{ at: 0, ...AT.spawn }, { at: 24, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }, { at: 26, ...AT.ramp }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const notes = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [molo] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb'],
    economy: 'Full buy'
  });
  assert.match(body(notes.get('aaa')), /Go 1st\. Go A Site on molo from five/);
  assert.ok(!notes.get('bbb').includes('Go 1st'), 'two men were both first');
});

test('one man wandering onto a site is not leading an entry', () => {
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 12, ...AT.mid }, { at: 20, ...AT.ramp }],
    1: [{ at: 0, ...AT.spawn }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = buildRoundNotes({
    meta: roundMeta({ players: FIVE }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa'],
    economy: 'Full buy'
  }).get('aaa');
  assert.ok(!note.includes('Go 1st'), `a lurker was called the entry: "${note}"`);
});

/** A real plant zone: bigger than the bombsite rectangle, and containing it. */
const PLANT_A = { type: 'rect', x: -200, y: 600, w: 800, h: 800, level: 'default' };
/** An approach piece, off to the side of the site. */
const APPROACH_A = { type: 'rect', x: 600, y: 0, w: 400, h: 400, level: 'default' };
/** Inside PLANT_A, outside the bombsite rectangle. */
const AT_EDGE = { x: 520, y: 700 };

/** Two men walk somewhere, and a grenade is thrown late. Did the call end? */
function endedBefore(net, where, late) {
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 20, ...where }],
    1: [{ at: 0, ...AT.spawn }, { at: 22, ...where }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [late] }),
      track,
      network: net,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [{ grenade: late, type: 'smokegrenade', word: 'Smoke', spot: 'Catwalk', throwId: 'zzzz' }],
      economy: 'Full buy'
    }).get('aaa')
  );
  return !note.includes('zzzz');
}

const LATE_SMOKE = {
  type: 'smokegrenade',
  player: 'aaa',
  throwTick: T0 + 40 * RATE,
  detonateTick: T0 + 41 * RATE,
  at: { ...AT.cat, z: 0 }
};

test('the plant zone is the biggest key zone, not its approach pieces', () => {
  const net = { ...NETWORK, keyZones: { a: [APPROACH_A, PLANT_A], b: [] } };
  // PLANT_A is the larger piece and the one holding the bombsite, so it is A.
  assert.equal(endedBefore(net, AT_EDGE, LATE_SMOKE), true, 'the site itself did not end the call');
  // Standing in the smaller approach piece is not standing on the site.
  assert.equal(endedBefore(net, AT.cat, LATE_SMOKE), false, 'an approach piece ended the call');
});

test('the key zone beats the bombsite rectangle when it is a real plant zone', () => {
  const net = { ...NETWORK, keyZones: { a: [PLANT_A], b: [] } };
  // AT_EDGE is inside the key zone but outside the tight bombsite rectangle.
  assert.equal(endedBefore(net, AT_EDGE, LATE_SMOKE), true);
  assert.equal(endedBefore(NETWORK, AT_EDGE, LATE_SMOKE), false, 'the rectangle reached too far');
});

test('key zones that miss their own bombsite fall back to the rectangle', () => {
  // Every piece is an approach and none covers the plant, which is how most of
  // the library is painted. That paint cannot be the plant zone.
  const net = { ...NETWORK, keyZones: { a: [APPROACH_A], b: [] } };
  assert.equal(endedBefore(net, AT.cat, LATE_SMOKE), false, 'an approach ended the call');
  assert.equal(endedBefore(net, AT.ramp, LATE_SMOKE), true, 'the bombsite did not stand in');
});

test('the call covers the two seconds after the second man is in', () => {
  const net = {
    ...NETWORK,
    keyZones: { a: [{ type: 'rect', x: 0, y: 800, w: 400, h: 400, level: 'default' }], b: [] }
  };
  const nadeAt = (sec, id) => ({
    type: 'hegrenade',
    player: 'aaa',
    throwTick: T0 + sec * RATE,
    detonateTick: T0 + (sec + 1) * RATE,
    at: { ...AT.cat, z: 0 },
    _id: id
  });
  // Second body is in at 22s, so the call runs to 24s.
  const inGrace = nadeAt(23, 'keep');
  const past = nadeAt(26, 'drop');
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.mid }, { at: 20, ...AT.ramp }],
    1: [{ at: 0, ...AT.spawn }, { at: 22, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [inGrace, past] }),
      track,
      network: net,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: inGrace, type: 'hegrenade', word: 'Nade', spot: 'Catwalk', throwId: 'keep' },
        { grenade: past, type: 'hegrenade', word: 'Nade', spot: 'Catwalk', throwId: 'drop' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(note.includes('keep'), `the grace window was not covered: "${note}"`);
  assert.ok(!note.includes('drop'), `wrote past the grace window: "${note}"`);
});

test('a quick pull and throw is a throw, not a line-up', () => {
  // On the spot at 8s, smoke out at 20s, thrown at 21s. One second is not
  // setting something up.
  const nade = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 21 * RATE,
    detonateTick: T0 + 23 * RATE,
    at: { ...AT.cat, z: 0 }
  };
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 8, ...AT.mid, weapon: GUN },
      { at: 20, ...AT.mid, weapon: SMOKE_OUT },
      { at: 22, ...AT.mid, weapon: GUN },
      { at: 40, ...AT.ramp, weapon: GUN }
    ]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [nade] }),
      track,
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [{ grenade: nade, type: 'smokegrenade', word: 'Smoke', spot: 'Catwalk', throwId: 'nF4e' }],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!note.includes('Line up'), `a one second pull became a line-up: "${note}"`);
  assert.match(note, /<Smoke Catwalk 1:34><!nF4e>/);
});

test('grenades in succession are timed once and share their origin', () => {
  const at = (sec, type) => ({
    type,
    player: 'aaa',
    throwTick: T0 + sec * RATE,
    detonateTick: T0 + (sec + 1) * RATE,
    at: { ...AT.ramp, z: 0 }
  });
  // Three throws a second apart, all from Top Mid.
  const one = at(10, 'molotov');
  const two = at(11, 'flashbang');
  const three = at(12, 'hegrenade');
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [one, two, three] }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: one, type: 'molotov', word: 'Molo', spot: 'Con', throwId: 'aaaa' },
        { grenade: two, type: 'flashbang', word: 'Flash', spot: 'Con', throwId: 'bbbb' },
        { grenade: three, type: 'hegrenade', word: 'Nade', spot: 'Con', throwId: 'cccc' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.equal(
    note,
    '<Molo Con 1:45><!aaaa>, <Flash Con><!bbbb>, <Nade Con><!cccc> from Top Mid'
  );
});

test('grenades far apart keep their own clocks', () => {
  const at = (sec, type) => ({
    type,
    player: 'aaa',
    throwTick: T0 + sec * RATE,
    detonateTick: T0 + (sec + 1) * RATE,
    at: { ...AT.ramp, z: 0 }
  });
  const one = at(10, 'molotov');
  const two = at(20, 'flashbang');
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [one, two] }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: one, type: 'molotov', word: 'Molo', spot: 'Con', throwId: 'aaaa' },
        { grenade: two, type: 'flashbang', word: 'Flash', spot: 'Con', throwId: 'bbbb' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /<Molo Con 1:45><!aaaa>/);
  assert.match(note, /<Flash Con 1:35><!bbbb>/);
  assert.ok(!note.includes('from Top Mid'), 'unrelated throws were merged');
});

const AT_B1 = { x: 1800, y: 200 };

/** Approaches a1/b1 plus plant pieces that contain the bombsites. */
const KEY_NET = {
  ...NETWORK,
  positions: [
    ...NETWORK.positions,
    { id: 'p_b1', name: 'Water', pieces: [{ type: 'rect', x: 1600, y: 0, w: 400, h: 400 }] },
    { id: 'p_bsite', name: 'B Site', pieces: [{ type: 'rect', x: 2000, y: 0, w: 400, h: 400 }] }
  ],
  zones: [
    ...NETWORK.zones,
    { id: 'z_b', name: 'B Site', positionIds: ['p_b1', 'p_bsite'] }
  ],
  bombSites: {
    a: NETWORK.bombSites.a,
    b: [{ type: 'rect', x: 2000, y: 0, w: 400, h: 400, level: 'default' }]
  },
  keyZones: {
    a: [
      { type: 'rect', x: 600, y: 0, w: 400, h: 400, level: 'default' },
      { type: 'rect', x: -50, y: 750, w: 500, h: 500, level: 'default' }
    ],
    b: [
      { type: 'rect', x: 1600, y: 0, w: 400, h: 400, level: 'default' },
      { type: 'rect', x: 1950, y: -50, w: 500, h: 500, level: 'default' }
    ]
  }
};

test('a solo on A lurks when the core walks into B', () => {
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.cat }],
    1: [{ at: 0, ...AT.spawn }, { at: 12, ...AT_B1 }],
    2: [{ at: 0, ...AT.spawn }, { at: 12, ...AT_B1 }],
    3: [{ at: 0, ...AT.spawn }, { at: 12, ...AT_B1 }],
    4: [{ at: 0, ...AT.spawn }, { at: 12, ...AT_B1 }]
  });
  const notes = buildRoundNotes({
    meta: roundMeta({ players: FIVE }),
    track,
    network: KEY_NET,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb'],
    economy: 'Full buy'
  });
  assert.match(body(notes.get('aaa')), /Lurk A/);
  assert.match(body(notes.get('bbb')), /Go 1st out B/);
  assert.ok(!notes.get('aaa').includes('Go 1st'), `the lurker was marked first: "${notes.get('aaa')}"`);
});

test('entering an approach then the plant is a Search when utility was just thrown', () => {
  const flash = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 7 * RATE,
    detonateTick: T0 + 8 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.cat }],
    1: [{ at: 0, ...AT.spawn }, { at: 22, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [flash] }),
      track,
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [{ grenade: flash, type: 'flashbang', word: 'Flash', spot: 'A Site', throwId: 'srch' }],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Search Catwalk/);
  assert.ok(!note.includes('Contact'), note);
  assert.ok(!note.includes('Rush out'), note);
});

test('the same walk is Contact when nobody threw in the last five seconds', () => {
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.cat }],
    1: [{ at: 0, ...AT.spawn }, { at: 22, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE }),
      track,
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Contact Catwalk/);
  assert.ok(!note.includes('Search'), note);
});

test('a 1000 PSDT burst after the approach is Rush out', () => {
  const flash = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 7 * RATE,
    detonateTick: T0 + 8 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const track = fakeTrack({
    0: [
      { at: 0, ...AT.spawn },
      { at: 10, ...AT.cat },
      { at: 12, x: AT.cat.x + 1200, y: AT.cat.y }
    ],
    1: [{ at: 0, ...AT.spawn }, { at: 22, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [flash] }),
      track,
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Rush out/);
  assert.ok(!note.includes('Search'), note);
});

test('two nades from a minority opposite a core of four are a Fake', () => {
  const one = {
    type: 'smokegrenade',
    player: 'aaa',
    throwTick: T0 + 10 * RATE,
    detonateTick: T0 + 11 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const two = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 11 * RATE,
    detonateTick: T0 + 12 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.cat }],
    1: [{ at: 0, x: AT.spawn.x + 80, y: AT.spawn.y }],
    2: [{ at: 0, x: AT.spawn.x, y: AT.spawn.y + 80 }],
    3: [{ at: 0, x: AT.spawn.x + 80, y: AT.spawn.y + 80 }],
    4: [{ at: 0, x: AT.spawn.x - 80, y: AT.spawn.y }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [one, two] }),
      track,
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: one, type: 'smokegrenade', word: 'Smoke', spot: 'Window', throwId: 'fake' },
        { grenade: two, type: 'flashbang', word: 'Flash', spot: 'Con', throwId: 'fak2' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /^Fake Mid\. /);
});

test('two of the same flash from one step collapse to 2x', () => {
  const one = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 10 * RATE,
    detonateTick: T0 + 11 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const two = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 11 * RATE,
    detonateTick: T0 + 12 * RATE,
    at: { x: AT.ramp.x + 40, y: AT.ramp.y, z: 0 }
  };
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [one, two] }),
      track: fakeTrack({ 0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }] }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [
        { grenade: one, type: 'flashbang', word: 'Flash', spot: 'over B', throwId: 'fla1' },
        { grenade: two, type: 'flashbang', word: 'Flash', spot: 'over B', throwId: 'fla2' }
      ],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Flash over B 2x /);
  assert.ok(!note.includes('Flash over B 1:'), `wrote the second flash loose: "${note}"`);
});

test('a flash and HE thrown together are marked synced on both lines', () => {
  const flash = {
    type: 'flashbang',
    player: 'aaa',
    throwTick: T0 + 10 * RATE,
    detonateTick: T0 + 11 * RATE,
    at: { ...AT.ramp, z: 0 }
  };
  const nade = {
    type: 'hegrenade',
    player: 'bbb',
    throwTick: T0 + 10.3 * RATE,
    detonateTick: T0 + 11.3 * RATE,
    at: { x: AT.ramp.x + 80, y: AT.ramp.y, z: 0 }
  };
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }],
    1: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }]
  });
  const notes = buildRoundNotes({
    meta: roundMeta({ players: FIVE, grenades: [flash, nade] }),
    track,
    network: NETWORK,
    mapCode: 'MIR',
    side: 'T',
    playerIds: ['aaa', 'bbb'],
    links: [
      { grenade: flash, type: 'flashbang', word: 'Flash', spot: 'mid', throwId: 'syn1' },
      { grenade: nade, type: 'hegrenade', word: 'Nade', spot: 'mid', throwId: 'syn2' }
    ],
    economy: 'Full buy'
  });
  assert.match(body(notes.get('aaa')), /synced with HE from two/);
  assert.match(body(notes.get('bbb')), /synced with flash from one/);
});

test('an HE that lands in a smoke is named as nading that smoke', () => {
  const smoke = {
    type: 'smokegrenade',
    player: 'bbb',
    throwTick: T0 + 8 * RATE,
    detonateTick: T0 + 9 * RATE,
    at: { ...AT.cat, z: 0 }
  };
  const nade = {
    type: 'hegrenade',
    player: 'aaa',
    throwTick: T0 + 12 * RATE,
    detonateTick: T0 + 13 * RATE,
    at: { x: AT.cat.x + 10, y: AT.cat.y, z: 0 }
  };
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: FIVE, grenades: [smoke, nade] }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT.mid }],
        1: [{ at: 0, ...AT.spawn }]
      }),
      network: NETWORK,
      mapCode: 'MIR',
      side: 'T',
      playerIds: ['aaa'],
      links: [{ grenade: nade, type: 'hegrenade', word: 'Nade', spot: 'Catwalk', throwId: 'nsmk' }],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Nade the Catwalk smoke/);
});

function yawTowards(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

const CT_PLAYERS = [
  { id: 'aaa', name: 'one', team: 2, slot: 0 },
  { id: 'bbb', name: 'two', team: 1, slot: 1 },
  { id: 'ccc', name: 'three', team: 1, slot: 2 },
  { id: 'ddd', name: 'four', team: 1, slot: 3 },
  { id: 'eee', name: 'five', team: 1, slot: 4 }
];

test('Search / Contact in a key zone is T only', () => {
  const cts = [
    { id: 'aaa', name: 'one', team: 2, slot: 0 },
    { id: 'bbb', name: 'two', team: 2, slot: 1 },
    { id: 'ccc', name: 'three', team: 1, slot: 2 },
    { id: 'ddd', name: 'four', team: 1, slot: 3 },
    { id: 'eee', name: 'five', team: 1, slot: 4 }
  ];
  const track = fakeTrack({
    0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.cat }],
    1: [{ at: 0, x: 5000, y: 5000 }, { at: 22, ...AT.ramp }],
    2: [{ at: 0, ...AT.spawn }],
    3: [{ at: 0, ...AT.spawn }],
    4: [{ at: 0, ...AT.spawn }]
  });
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: cts }),
      track,
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!/Search |Contact |Rush out/.test(note), note);
});

test('a CT in a key zone looking at one spot is Go / hold', () => {
  const yaw = yawTowards(AT.cat, AT.ramp);
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: CT_PLAYERS }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 10, ...AT.cat, yaw }],
        1: [{ at: 0, ...AT.spawn }],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Go Catwalk, hold A Ramp/);
  assert.ok(!note.includes('Stay Catwalk'), note);
});

test('a CT who switches the held angle is marked again with the clock', () => {
  const yawRamp = yawTowards(AT.cat, AT.ramp);
  const yawMid = yawTowards(AT.cat, AT.mid);
  const note = body(
    buildRoundNotes({
      meta: roundMeta({ players: CT_PLAYERS }),
      track: fakeTrack({
        0: [
          { at: 0, ...AT.spawn },
          { at: 10, ...AT.cat, yaw: yawRamp },
          { at: 20, ...AT.cat, yaw: yawMid }
        ],
        1: [{ at: 0, ...AT.spawn }],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: KEY_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Go Catwalk, hold A Ramp/);
  assert.match(note, /At \d:\d\d, hold Top Mid from Catwalk/);
});

const AT_WIN = { x: 3100, y: 100 };
const AT_LOW = { x: 2600, y: 100 };
const BOOST_NET = {
  ...KEY_NET,
  positions: [
    ...KEY_NET.positions,
    { id: 'p_win', name: 'Window', pieces: [{ type: 'rect', x: 3000, y: 0, w: 200, h: 200 }] },
    { id: 'p_low', name: 'Lower', pieces: [{ type: 'rect', x: 2500, y: 0, w: 300, h: 200 }] }
  ],
  zones: [
    ...KEY_NET.zones,
    { id: 'z_win', name: 'Apps', positionIds: ['p_win'] },
    { id: 'z_low', name: 'Lower', positionIds: ['p_low'] }
  ]
};

test('two stacked players and a 60 Z rise that sticks is a boost', () => {
  const note = body(
    buildRoundNotes({
      meta: roundMeta({
        players: [...CT_PLAYERS, { id: 'ggg', name: 'seven', team: 2, slot: 6 }]
      }),
      track: fakeTrack({
        0: [
          { at: 0, ...AT.spawn },
          { at: 6, ...AT_WIN, z: 0 },
          { at: 8, ...AT_WIN, z: 80 }
        ],
        6: [
          { at: 0, ...AT.spawn },
          { at: 6, ...AT_WIN, z: 0 }
        ],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: BOOST_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Get boosted Window by seven/);
});

test('a 60 Z rise that comes back down is not a boost', () => {
  const note = body(
    buildRoundNotes({
      meta: roundMeta({
        players: [...CT_PLAYERS, { id: 'ggg', name: 'seven', team: 2, slot: 6 }]
      }),
      track: fakeTrack({
        0: [
          { at: 0, ...AT.spawn },
          { at: 6, ...AT_WIN, z: 0 },
          { at: 8, ...AT_WIN, z: 80 },
          { at: 8.4, ...AT_WIN, z: 0 }
        ],
        6: [
          { at: 0, ...AT.spawn },
          { at: 6, ...AT_WIN, z: 0 }
        ],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: BOOST_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!note.includes('Get boosted'), note);
});

test('leaving a stack then hitting 300 u/s within a second is a runboost', () => {
  const dash = [];
  const dist = Math.hypot(AT_LOW.x - AT_WIN.x, AT_LOW.y - AT_WIN.y);
  const speed = 360;
  const dt = dist / speed;
  const n = Math.max(2, Math.round(dt * RATE));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    dash.push({
      at: 8 + dt * u,
      x: AT_WIN.x + (AT_LOW.x - AT_WIN.x) * u,
      y: AT_WIN.y + (AT_LOW.y - AT_WIN.y) * u
    });
  }
  const note = body(
    buildRoundNotes({
      meta: roundMeta({
        players: [...CT_PLAYERS, { id: 'ggg', name: 'seven', team: 2, slot: 6 }]
      }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT_WIN }, ...dash],
        6: [{ at: 0, ...AT.spawn }, { at: 6, ...AT_WIN }],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: BOOST_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.match(note, /Get runboosted Lower by seven/);
});

test('300 u/s more than a second after leaving the stack is not a runboost', () => {
  const walk = [];
  for (let i = 0; i <= 40; i++) {
    walk.push({ at: 8 + i * 0.05, x: AT_WIN.x + i, y: AT_WIN.y });
  }
  const note = body(
    buildRoundNotes({
      meta: roundMeta({
        players: [...CT_PLAYERS, { id: 'ggg', name: 'seven', team: 2, slot: 6 }]
      }),
      track: fakeTrack({
        0: [{ at: 0, ...AT.spawn }, { at: 6, ...AT_WIN }, ...walk, { at: 12, ...AT.mid }],
        6: [{ at: 0, ...AT.spawn }, { at: 6, ...AT_WIN }],
        3: [{ at: 0, ...AT.spawn }],
        4: [{ at: 0, ...AT.spawn }]
      }),
      network: BOOST_NET,
      mapCode: 'MIR',
      side: 'CT',
      playerIds: ['aaa'],
      economy: 'Full buy'
    }).get('aaa')
  );
  assert.ok(!note.includes('Get runboosted'), note);
});

test('lookTarget follows yaw onto the next painted position', () => {
  const namer = createNamer(NETWORK, 'MIR');
  const yaw = yawTowards(AT.cat, AT.ramp);
  assert.equal(lookTarget(namer, AT.cat.x, AT.cat.y, 0, yaw, 'Catwalk'), 'A Ramp');
});
