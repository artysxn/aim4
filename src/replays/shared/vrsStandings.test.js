import assert from 'node:assert/strict';
import {
  compareStandingDates,
  latestStandingFiles,
  msUntilNextDailyUtc,
  parseStandingFileName,
  remoteStandingsAreNewer,
  standingFileName,
  yearDirsFromLiveListing
} from './vrsStandings.js';

assert.deepEqual(parseStandingFileName('standings_europe_2026_08_03.md'), {
  region: 'europe',
  date: '2026_08_03',
  year: '2026',
  file: 'standings_europe_2026_08_03.md'
});
assert.equal(parseStandingFileName('standings_global_2026_08_03.md'), null);
assert.equal(parseStandingFileName('details'), null);
assert.equal(standingFileName('asia', '2027_01_04'), 'standings_asia_2027_01_04.md');

assert.ok(compareStandingDates('2026_08_03', '2026_07_06') > 0);
assert.equal(compareStandingDates('2026_08_03', '2026_08_03'), 0);
assert.ok(compareStandingDates('2026_12_07', '2027_01_04') < 0);

const latest = latestStandingFiles([
  { name: 'standings_europe_2026_07_06.md' },
  { name: 'standings_europe_2026_08_03.md' },
  { name: 'standings_americas_2026_08_03.md' },
  { name: 'standings_asia_2026_07_06.md' },
  { name: 'standings_asia_2026_08_03.md' },
  { name: 'standings_global_2026_08_03.md' },
  { name: 'details' }
]);
assert.equal(latest.europe.date, '2026_08_03');
assert.equal(latest.americas.date, '2026_08_03');
assert.equal(latest.asia.date, '2026_08_03');
assert.equal(latest.global, undefined);

const rolled = latestStandingFiles([
  { name: 'standings_europe_2026_12_07.md' },
  { name: 'standings_europe_2027_01_04.md' },
  { name: 'standings_americas_2026_12_07.md' },
  { name: 'standings_americas_2027_01_04.md' },
  { name: 'standings_asia_2026_12_07.md' },
  { name: 'standings_asia_2027_01_04.md' }
]);
assert.equal(rolled.europe.date, '2027_01_04');
assert.equal(rolled.europe.year, '2027');

assert.deepEqual(
  yearDirsFromLiveListing([
    { name: '2026', type: 'dir' },
    { name: 'details', type: 'dir' },
    { name: '2025', type: 'dir' },
    { name: '2027', type: 'dir' },
    { name: 'standings_europe_2026_08_03.md', type: 'file' }
  ]),
  ['2025', '2026', '2027']
);

assert.equal(
  remoteStandingsAreNewer(
    { europe: '2026_07_06', americas: '2026_07_06', asia: '2026_07_06' },
    latest
  ),
  true
);
assert.equal(
  remoteStandingsAreNewer(
    { europe: '2026_08_03', americas: '2026_08_03', asia: '2026_08_03' },
    latest
  ),
  false
);
assert.equal(
  remoteStandingsAreNewer(
    { europe: '2026_08_03', americas: '2026_07_06', asia: '2026_08_03' },
    latest
  ),
  true
);

const beforeHour = Date.UTC(2026, 7, 22, 5, 0, 0);
assert.equal(msUntilNextDailyUtc(beforeHour, 6), 60 * 60 * 1000);
const onHour = Date.UTC(2026, 7, 22, 6, 0, 0);
assert.equal(msUntilNextDailyUtc(onHour, 6), 24 * 60 * 60 * 1000);
const afterHour = Date.UTC(2026, 7, 22, 6, 0, 1);
assert.ok(msUntilNextDailyUtc(afterHour, 6) > 23 * 60 * 60 * 1000);
assert.ok(msUntilNextDailyUtc(afterHour, 6) < 24 * 60 * 60 * 1000);

console.log('vrsStandings.test.js: ok');
