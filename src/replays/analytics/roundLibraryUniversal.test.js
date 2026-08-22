// ---------------------------------------------------------------------------
// Universal round types: All A/B hits and A/B retake / afterplant.
// Ground is bombsite + a1-a4 / b1-b4 key zones (`site:a` / `site:b` in fakes).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { ROUND_LIBRARY } from './roundLibrary.js';
import { fakeRound } from './roundFactsFake.js';

const round = fakeRound;

const defOf = (side, key) => {
  const hit = ROUND_LIBRARY.MIR[side].find((d) => d.key === key);
  assert.ok(hit, `${key} exists on every library map`);
  return hit;
};
const hits = (side, key, f) => defOf(side, key).match(f);

const onSite = (n, letter, tag) =>
  Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, names: [`site:${letter}`] }));

const stacked = (letter, extra = {}) =>
  round(
    'T',
    {
      aliveFromStays: true,
      stays: onSite(2, letter, 't'),
      ...extra
    },
    {
      aliveFromStays: true,
      stays: onSite(2, letter, 'ct')
    }
  );

const threeKills = (letter) => [
  { site: letter, sec: 20 },
  { site: letter, sec: 22 },
  { site: letter, sec: 24 }
];

// ---------------------------------------------------------------------------
// All A / All B hits
// ---------------------------------------------------------------------------

{
  assert.ok(hits('T', 'all-b-hits', stacked('b', { killsInSite: threeKills('b') })), '3 kills on B');
  assert.ok(hits('CT', 'all-b-hits', stacked('b', { killsInSite: threeKills('b') })), 'same from CT');
  assert.ok(hits('T', 'all-a-hits', stacked('a', { killsInSite: threeKills('a') })), '3 kills on A');
}

{
  assert.equal(
    hits('T', 'all-b-hits', stacked('b', { killsInSite: threeKills('b').slice(0, 2) })),
    null,
    'two kills and no plant is not a hit'
  );
}

{
  const planted = stacked('b', {
    killsInSite: [
      { site: 'b', sec: 18 },
      { site: 'b', sec: 19 }
    ],
    plant: { site: 'b', sec: 30 }
  });
  assert.ok(hits('T', 'all-b-hits', planted), '2 kills then a B plant');
  assert.equal(
    hits(
      'T',
      'all-b-hits',
      stacked('b', {
        killsInSite: [
          { site: 'b', sec: 18 },
          { site: 'b', sec: 19 }
        ],
        plant: { site: 'a', sec: 30 }
      })
    ),
    null,
    'an A plant does not finish a B hit'
  );
}

{
  assert.equal(
    hits(
      'T',
      'all-b-hits',
      round(
        'T',
        {
          aliveFromStays: true,
          stays: onSite(2, 'b', 't'),
          killsInSite: threeKills('b')
        },
        {
          aliveFromStays: true,
          stays: onSite(1, 'b', 'ct')
        }
      )
    ),
    null,
    'one CT on site is not a hit'
  );
}

{
  assert.equal(
    hits('T', 'all-b-hits', stacked('a', { killsInSite: threeKills('a') })),
    null,
    'an A stack is not a B hit'
  );
}

// ---------------------------------------------------------------------------
// Afterplant / retake
// ---------------------------------------------------------------------------

function plantedFight(letter, extra = {}, enemyExtra = {}) {
  return round(
    'T',
    {
      aliveFromStays: true,
      stays: onSite(1, letter, 't'),
      plant: { site: letter, sec: 40 },
      killsInSite: [{ site: letter, sec: 45 }],
      ...extra
    },
    {
      aliveFromStays: true,
      stays: onSite(2, letter, 'ct'),
      ...enemyExtra
    }
  );
}

{
  const f = plantedFight('b');
  assert.ok(hits('T', 'b-afterplant', f), 'T reads B Afterplant');
  assert.ok(hits('CT', 'b-retake', f), 'CT reads B Retake');
  assert.equal(hits('T', 'a-afterplant', f), null, 'a B plant is not A Afterplant');
}

{
  const f = plantedFight('a');
  assert.ok(hits('T', 'a-afterplant', f), 'T reads A Afterplant');
  assert.ok(hits('CT', 'a-retake', f), 'CT reads A Retake');
}

{
  assert.equal(
    hits(
      'T',
      'b-afterplant',
      plantedFight('b', { killsInSite: [{ site: 'b', sec: 30 }] })
    ),
    null,
    'a kill before the plant is the execute, not the afterplant'
  );
}

{
  assert.equal(
    hits(
      'T',
      'b-afterplant',
      plantedFight('b', {}, { stays: onSite(1, 'b', 'ct') })
    ),
    null,
    'one CT alive is not a retake'
  );
}

{
  assert.equal(
    hits('T', 'b-afterplant', plantedFight('b', { stays: [] })),
    null,
    'no T alive is not an afterplant'
  );
}

console.log('roundLibraryUniversal.test.js ok');
