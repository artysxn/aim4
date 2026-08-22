import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forgetOrgIndex } from '../ingest/hltv/hltvNames.js';
import {
  discoverStandingFiles,
  forgetStandingTeams,
  loadStandingTeams,
  loadedStandingSnapshot
} from './teamStandingsDb.js';
import { syncVrsStandings } from './vrsSync.js';

const prevLive = process.env.AIM4_STANDINGS_DIR;
const prevBundled = process.env.AIM4_STANDINGS_BUNDLED_DIR;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-vrs-'));
const bundledDir = path.join(root, 'bundled');
const liveDir = path.join(root, 'live');
await fsp.mkdir(bundledDir);
await fsp.mkdir(liveDir);

process.env.AIM4_STANDINGS_BUNDLED_DIR = bundledDir;
process.env.AIM4_STANDINGS_DIR = liveDir;
forgetStandingTeams();
forgetOrgIndex();

function standingTable(region, date, count) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(
      `| ${i} | ${2000 - i} | ${region} Team ${i} | p${i}a, p${i}b, p${i}c, p${i}d, p${i}e |`
    );
  }
  return [
    `### Regional Standings for ${region} as of ${date}`,
    '',
    '| Standing | Points | Team Name | Roster |',
    '| :- | -: | :- | :- |',
    ...rows,
    ''
  ].join('\n');
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body
  };
}

const COUNTS = { europe: 24, americas: 12, asia: 8 };

function listingEntry(region, date, year) {
  const name = `standings_${region}_${date}.md`;
  return {
    name,
    type: 'file',
    download_url: `https://example.test/${year}/${name}`
  };
}

const bodies = {
  'https://example.test/2026/standings_europe_2026_08_03.md': standingTable('europe', '2026_08_03', COUNTS.europe),
  'https://example.test/2026/standings_americas_2026_08_03.md': standingTable('americas', '2026_08_03', COUNTS.americas),
  'https://example.test/2026/standings_asia_2026_08_03.md': standingTable('asia', '2026_08_03', COUNTS.asia),
  'https://example.test/2027/standings_europe_2027_01_04.md': standingTable('europe', '2027_01_04', COUNTS.europe),
  'https://example.test/2027/standings_americas_2027_01_04.md': standingTable('americas', '2027_01_04', COUNTS.americas),
  'https://example.test/2027/standings_asia_2027_01_04.md': standingTable('asia', '2027_01_04', COUNTS.asia)
};

function mockFetch(filesByYear) {
  return async (url) => {
    if (url.endsWith('/contents/live')) {
      return jsonResponse(Object.keys(filesByYear).map((year) => ({ name: year, type: 'dir' })));
    }
    const yearHit = /\/contents\/live\/(\d{4})$/.exec(url);
    if (yearHit) {
      return jsonResponse(filesByYear[yearHit[1]] || []);
    }
    if (Object.hasOwn(bodies, url)) return textResponse(bodies[url]);
    return jsonResponse(null, 404);
  };
}

await fsp.writeFile(
  path.join(bundledDir, 'standings_europe_2026_07_06.md'),
  standingTable('europe', '2026_07_06', COUNTS.europe)
);
await fsp.writeFile(
  path.join(bundledDir, 'standings_americas_2026_07_06.md'),
  standingTable('americas', '2026_07_06', COUNTS.americas)
);
await fsp.writeFile(
  path.join(bundledDir, 'standings_asia_2026_07_06.md'),
  standingTable('asia', '2026_07_06', COUNTS.asia)
);

{
  const snap = loadedStandingSnapshot();
  assert.equal(snap.europe, '2026_07_06');
  const teams = loadStandingTeams();
  assert.ok(teams.some((t) => t.name === 'europe Team 1'));
  forgetStandingTeams();
}

{
  const result = await syncVrsStandings({
    fetch: mockFetch({
      2026: [
        listingEntry('europe', '2026_07_06', '2026'),
        listingEntry('europe', '2026_08_03', '2026'),
        listingEntry('americas', '2026_08_03', '2026'),
        listingEntry('asia', '2026_08_03', '2026'),
        { name: 'standings_global_2026_08_03.md', type: 'file' },
        { name: 'details', type: 'dir' }
      ]
    }),
    liveDir
  });
  assert.equal(result.ok, true);
  assert.equal(result.updated.length, 3);
  assert.equal(result.snapshot.europe, '2026_08_03');
  assert.ok(
    await fsp
      .readFile(path.join(liveDir, 'standings_europe_2026_08_03.md'), 'utf8')
      .then((t) => t.includes('2026_08_03'))
  );
  forgetStandingTeams();
  const files = discoverStandingFiles();
  assert.equal(files.europe.date, '2026_08_03');
  assert.equal(files.europe.dir, liveDir);
  assert.ok(loadStandingTeams().some((t) => t.name === 'europe Team 1'));
}

{
  const result = await syncVrsStandings({
    fetch: mockFetch({
      2026: [
        listingEntry('europe', '2026_08_03', '2026'),
        listingEntry('americas', '2026_08_03', '2026'),
        listingEntry('asia', '2026_08_03', '2026')
      ]
    }),
    liveDir
  });
  assert.equal(result.updated.length, 0, 'already current is a no-op');
}

{
  const result = await syncVrsStandings({
    fetch: mockFetch({
      2026: [
        listingEntry('europe', '2026_08_03', '2026'),
        listingEntry('americas', '2026_08_03', '2026'),
        listingEntry('asia', '2026_08_03', '2026')
      ],
      2027: [
        listingEntry('europe', '2027_01_04', '2027'),
        listingEntry('americas', '2027_01_04', '2027'),
        listingEntry('asia', '2027_01_04', '2027')
      ]
    }),
    liveDir
  });
  assert.equal(result.snapshot.europe, '2027_01_04');
  assert.equal(result.snapshot.americas, '2027_01_04');
  assert.equal(result.snapshot.asia, '2027_01_04');
  const names = await fsp.readdir(liveDir);
  assert.ok(names.includes('standings_europe_2027_01_04.md'));
  assert.ok(!names.includes('standings_europe_2026_08_03.md'), 'older live copy pruned');
}

if (prevLive === undefined) delete process.env.AIM4_STANDINGS_DIR;
else process.env.AIM4_STANDINGS_DIR = prevLive;
if (prevBundled === undefined) delete process.env.AIM4_STANDINGS_BUNDLED_DIR;
else process.env.AIM4_STANDINGS_BUNDLED_DIR = prevBundled;
forgetStandingTeams();
forgetOrgIndex();
await fsp.rm(root, { recursive: true, force: true });

console.log('vrsSync.test.js: ok');
