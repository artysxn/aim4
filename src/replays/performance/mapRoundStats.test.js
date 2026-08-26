// Run: node src/replays/performance/mapRoundStats.test.js

import assert from 'node:assert/strict';
import {
  MAP_ROUND_CODES,
  mapGridFilter,
  mapRoundGrid,
  teamMapRoundGrid
} from './mapRoundStats.js';
import { roundTypeRows } from '../analytics/roundLibrary.js';
import { aggregateTeams, indexMaps } from '../shared/statsMath.js';

// Every map the Performance page lists has a library to list rows from.
assert.deepEqual(MAP_ROUND_CODES, ['ANC', 'DD2', 'INF', 'CCH', 'MIR', 'NUK', 'ANU']);

// The maps grid never filters by map or side: a section is a map, a table is a
// side, and half of every table is the rounds spent on the other one.
{
  const f = mapGridFilter({ map: 'NUK', side: 'CT', econ: 4, dateFrom: '2026-01-01', last: 10 });
  assert.deepEqual(f.maps, []);
  assert.equal(f.side, '');
  assert.equal(f.econ, 4);
  assert.equal(f.dateFrom, '2026-01-01');
}

/** One round: who played which side, who won, the tags, and the opening duel. */
const mkRound = ({ n, s1, w, t = [], ct = [], ok = '', od = '' }) => ({
  f: `r${n}`,
  d: 'd1',
  m: 'NUK',
  n,
  w,
  s1,
  s2: s1 === 'T' ? 'CT' : 'T',
  e1: 4,
  e2: 4,
  ok,
  od,
  p: { p1: [2, 1, 0, 100, 10, 5, 1, 0, 0, 1], p2: [1, 1, 0, 80, 8, 4, 0, 0, 0, 1] },
  sw: { p1: 6, p2: 0 },
  rl: { v: 7, t: t.map((k) => ({ k, m: {} })), ct: ct.map((k) => ({ k, m: {} })) }
});

const payload = {
  demos: [
    {
      id: 'd1',
      map: 'NUK',
      uploadedAt: 500,
      name1: 'Vitality',
      name2: 'FaZe',
      players: [
        { id: 'p1', name: 'artysan', team: 1 },
        { id: 'p2', name: 'rival', team: 2 }
      ],
      rounds: [
        // p1 is on team 1. Rounds 1-2: team 1 plays T and runs a-fake.
        mkRound({ n: 1, s1: 'T', w: 1, t: ['a-fake'], ct: ['two-ramp'] }),
        mkRound({ n: 2, s1: 'T', w: 2, t: ['a-fake'], ct: ['default'] }),
        // Rounds 3-5: team 1 plays CT, so the enemy T runs a-fake at them.
        mkRound({ n: 3, s1: 'CT', w: 1, t: ['a-fake'], ct: ['lobby-crunch'] }),
        mkRound({ n: 4, s1: 'CT', w: 2, t: ['a-fake'], ct: ['lobby-crunch'] }),
        mkRound({ n: 5, s1: 'CT', w: 1, t: ['default'], ct: ['lobby-crunch'] })
      ]
    },
    // A map with a library the player never played: rows, all of them empty.
    {
      id: 'd2',
      map: 'ANC',
      uploadedAt: 400,
      name1: 'Spirit',
      name2: 'G2',
      players: [{ id: 'p9', name: 'someone', team: 1 }],
      rounds: []
    }
  ]
};

const { players, demos } = indexMaps(payload);
const grid = mapRoundGrid(payload, 'p1', {}, players, demos);

// Every map, every side, every type in the library gets a row whether or not
// the player has ever seen it.
for (const code of MAP_ROUND_CODES) {
  for (const side of ['T', 'CT']) {
    assert.equal(grid[code][side].length, roundTypeRows(code, side).length, `${code} ${side} rows`);
  }
}
assert.equal(grid.ANC.T[0].ran.rounds, 0, 'a map never played is all zeroes');
assert.equal(grid.ANC.T[0].ran.rating, null);

const nukT = new Map(grid.NUK.T.map((r) => [r.key, r]));
const nukCt = new Map(grid.NUK.CT.map((r) => [r.key, r]));

// T table, "A Fake": ran it twice on T (won 1), faced it twice on CT (won 1).
assert.equal(nukT.get('a-fake').ran.rounds, 2);
assert.equal(nukT.get('a-fake').ran.wins, 1);
assert.equal(nukT.get('a-fake').ran.winrate, 50);
assert.equal(nukT.get('a-fake').faced.rounds, 2);
assert.equal(nukT.get('a-fake').faced.wins, 1);

// T table, Default: only round 5, which the player's team faced and won.
assert.equal(nukT.get('default').ran.rounds, 0);
assert.equal(nukT.get('default').faced.rounds, 1);
assert.equal(nukT.get('default').faced.winrate, 100);

// The same rounds read from the CT table: the calls the player's team made on
// CT are "ran" there, and the CT calls made at them on T are "faced".
assert.equal(nukCt.get('lobby-crunch').ran.rounds, 3, 'three CT rounds, all lobby crunch');
assert.equal(nukCt.get('lobby-crunch').ran.wins, 2);
assert.equal(nukCt.get('two-ramp').faced.rounds, 1, 'faced on T in round 1');
assert.equal(nukCt.get('two-ramp').faced.wins, 1);
assert.equal(nukCt.get('two-ramp').ran.rounds, 0);

// Player numbers are the player's, not the team's.
assert.ok(Number.isFinite(nukT.get('a-fake').ran.rating), 'rating over those rounds');
assert.equal(nukT.get('a-fake').ran.swing, 6, 'swing is p1 swing, not p2 swing');

// Files ride along newest first, ready for a timeline link.
assert.deepEqual(nukT.get('a-fake').ran.files.sort(), ['r1', 'r2']);
assert.deepEqual(nukCt.get('lobby-crunch').ran.files.sort(), ['r3', 'r4', 'r5']);

// Last-N is a match filter, and one match is still one match.
const lastOne = mapRoundGrid(payload, 'p1', { last: 1 }, players, demos);
assert.equal(new Map(lastOne.NUK.T.map((r) => [r.key, r])).get('a-fake').ran.rounds, 2);

// A buy filter narrows the rounds behind every cell.
const ecoOnly = mapRoundGrid(payload, 'p1', { econ: 1 }, players, demos);
assert.equal(new Map(ecoOnly.NUK.T.map((r) => [r.key, r])).get('a-fake').ran.rounds, 0);

// Untagged rounds (an index built before the library covered this map) are
// skipped rather than counted as Default.
const untagged = {
  demos: [
    {
      ...payload.demos[0],
      rounds: payload.demos[0].rounds.map(({ rl, ...rest }) => rest)
    }
  ]
};
const bare = indexMaps(untagged);
const noTags = mapRoundGrid(untagged, 'p1', {}, bare.players, bare.demos);
assert.equal(new Map(noTags.NUK.T.map((r) => [r.key, r])).get('default').ran.rounds, 0);

// A player's cell carries their own opening duels.
{
  const duels = {
    demos: [
      {
        ...payload.demos[0],
        rounds: [
          mkRound({ n: 1, s1: 'T', w: 1, t: ['a-fake'], ok: 'p1', od: 'p2' }),
          mkRound({ n: 2, s1: 'T', w: 2, t: ['a-fake'], ok: 'p2', od: 'p1' }),
          mkRound({ n: 3, s1: 'T', w: 2, t: ['a-fake'], ok: 'p1', od: 'p2' })
        ]
      }
    ]
  };
  const ix = indexMaps(duels);
  const cell = new Map(
    mapRoundGrid(duels, 'p1', {}, ix.players, ix.demos).NUK.T.map((r) => [r.key, r])
  ).get('a-fake').ran;
  // p1 opened two of the three and died first in the other.
  assert.equal(Math.round(cell.opkRate), 67, "the player's own opening duel rate");
  assert.equal(nukT.get('a-fake').ran.opkRate, null, 'no opening duels, no rate');
}

// ---- the same grid for a team ---------------------------------------------

/** Vitality (team 1) on Nuke: three T rounds it ran a-fake, one CT round. */
const teamRounds = [
  mkRound({ n: 1, s1: 'T', w: 1, t: ['a-fake'], ct: ['two-ramp'], ok: 'p1', od: 'p2' }),
  mkRound({ n: 2, s1: 'T', w: 2, t: ['a-fake'], ct: ['default'], ok: 'p2', od: 'p1' }),
  mkRound({ n: 3, s1: 'T', w: 2, t: ['a-fake'], ct: ['default'], ok: 'p1', od: 'p2' }),
  mkRound({ n: 4, s1: 'CT', w: 1, t: ['a-fake'], ct: ['lobby-crunch'], ok: 'p1', od: 'p2' })
];
// A round the library could not name: it belongs to the map's record and to no
// call's row.
const untaggedRound = mkRound({ n: 5, s1: 'T', w: 1, t: ['a-fake'] });
delete untaggedRound.rl;

const teamPayload = {
  demos: [{ ...payload.demos[0], rounds: [...teamRounds, untaggedRound] }, payload.demos[1]]
};
const tix = indexMaps(teamPayload);
const teamGrid = teamMapRoundGrid(teamPayload, 'Vitality', {}, tix.players, tix.demos);

// Same shape as the player grid: every map, every side, every call in the
// library, whether or not this team has ever played it.
for (const code of MAP_ROUND_CODES) {
  for (const side of ['T', 'CT']) {
    assert.equal(
      teamGrid[code][side].length,
      roundTypeRows(code, side).length,
      `team ${code} ${side} rows`
    );
  }
}
assert.equal(teamGrid.ANC.T[0].ran.rounds, 0, 'a map never played is all zeroes');
assert.equal(teamGrid.ANC.T[0].ran.winrate, null);
assert.equal(teamGrid.ANC.total.rounds, 0);

const tT = new Map(teamGrid.NUK.T.map((r) => [r.key, r]));
const tCt = new Map(teamGrid.NUK.CT.map((r) => [r.key, r]));
const ran = tT.get('a-fake').ran;

// Ran a-fake on T three times: won one, opened two of the three duels, won the
// round in one of those two, and lost the one round it was opened on.
assert.equal(ran.rounds, 3);
assert.equal(Math.round(ran.winrate), 33);
assert.equal(ran.openKills, 2);
assert.equal(ran.openDeaths, 1);
assert.equal(Math.round(ran.opkRate), 67);
assert.equal(ran.conv5v4, 50);
assert.equal(ran.conv4v5, 0);

// The cell is the shared team aggregation over exactly those rounds, not a
// second opinion about it.
{
  const t = aggregateTeams(teamRounds.slice(0, 3), tix.players, tix.demos, {}).find(
    (x) => x.key === 'vitality'
  );
  assert.equal(ran.winrate, t.roundWinrate);
  assert.equal(ran.opkRate, t.opkRate);
  assert.equal(ran.conv5v4, t.conv5v4);
  assert.equal(ran.conv4v5, t.conv4v5);
}

// The CT round is the a-fake this team FACED, and its own call there was lobby
// crunch.
assert.equal(tT.get('a-fake').faced.rounds, 1);
assert.equal(tT.get('a-fake').faced.winrate, 100);
assert.equal(tCt.get('lobby-crunch').ran.rounds, 1);
assert.equal(tCt.get('two-ramp').faced.rounds, 1, 'faced on T in round 1');

// The map line counts every round that passed the filter, tagged or not.
assert.equal(teamGrid.NUK.total.rounds, 5, 'the untagged round is still a round played');
assert.equal(teamGrid.NUK.total.wins, 3);
assert.equal(Math.round(teamGrid.NUK.total.winrate), 60);
assert.equal(teamGrid.NUK.total.openKills, 3);
assert.equal(Math.round(teamGrid.NUK.total.opkRate), 75);
assert.equal(Math.round(teamGrid.NUK.total.conv5v4), 67);
assert.equal(teamGrid.NUK.total.conv4v5, 0);
assert.equal(
  tT.get('a-fake').ran.rounds + tT.get('a-fake').faced.rounds,
  4,
  'and no call row claims it'
);

// Cells with no opening duel on either side say so rather than reading 0%.
assert.equal(tCt.get('lobby-crunch').ran.conv4v5, null, 'never opened on in that call');

// Filters reach the team grid the same way they reach the player one.
const teamEco = teamMapRoundGrid(teamPayload, 'Vitality', { econ: 1 }, tix.players, tix.demos);
assert.equal(new Map(teamEco.NUK.T.map((r) => [r.key, r])).get('a-fake').ran.rounds, 0);
assert.equal(teamEco.NUK.total.rounds, 0);

// A team that is not in the payload gets the empty grid, not a crash.
const nobody = teamMapRoundGrid(teamPayload, 'Nobody', {}, tix.players, tix.demos);
assert.equal(nobody.NUK.total.rounds, 0);

console.log('mapRoundStats.test.js ok');
