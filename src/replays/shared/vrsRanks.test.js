import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStandingsMarkdown } from './teamStandings.js';
import { latestStandingFiles } from './vrsStandings.js';
import {
  buildGlobalRanks,
  demoPassesRank,
  parseRankSpec,
  rankFilterHtml,
  rankInSpec,
  rankOfName,
  rankSummaryLabel,
  sidesPassRank,
  sidesPassRankEither
} from './vrsRanks.js';

assert.deepEqual(parseRankSpec(''), null);
assert.deepEqual(parseRankSpec('  '), null);
assert.deepEqual(parseRankSpec('50'), { min: 1, max: 50 });
assert.deepEqual(parseRankSpec('20-50'), { min: 20, max: 50 });
assert.deepEqual(parseRankSpec('50-20'), { min: 20, max: 50 });
assert.deepEqual(parseRankSpec('50-9999'), { min: 50, max: 9999, includeUnranked: true });
assert.deepEqual(parseRankSpec('30-300'), { min: 30, max: 300, includeUnranked: true });
assert.equal(parseRankSpec('abc'), null);
assert.equal(parseRankSpec('20-'), null);

const table = buildGlobalRanks([
  { name: 'Spirit', points: 2011, standing: 1, region: 'europe' },
  { name: 'Falcons', points: 1950, standing: 2, region: 'europe' },
  { name: '9z', points: 1847, standing: 1, region: 'americas' },
  { name: 'FURIA', points: 1771, standing: 3, region: 'americas' },
  { name: 'The MongolZ', points: 1600, standing: 1, region: 'asia' },
  { name: 'Spirit', points: 100, standing: 80, region: 'americas' }
]);
assert.equal(table.size, 5);
assert.equal(rankOfName('Spirit', table), 1, 'highest points wins across regions');
assert.equal(rankOfName('Falcons', table), 2);
assert.equal(rankOfName('9z', table), 3);
assert.equal(rankOfName('Unknown mix', table), 9999, 'unranked sits past the table');

assert.equal(rankInSpec(1, { min: 1, max: 50 }), true);
assert.equal(rankInSpec(50, { min: 1, max: 50 }), true);
assert.equal(rankInSpec(51, { min: 1, max: 50 }), false);
assert.equal(rankInSpec(6, { min: 50, max: 9999 }), false);
assert.equal(rankInSpec(6, parseRankSpec('50-9999')), false);
assert.equal(rankInSpec(6, parseRankSpec('5-9999')), true);
assert.equal(rankInSpec(9999, parseRankSpec('30-200')), false, '200 is still VRS-only');
assert.equal(rankInSpec(9999, parseRankSpec('30-300')), true, 'max above 200 includes unranked');
assert.equal(rankInSpec(9999, parseRankSpec('201')), false, 'a single Top N does not include unranked');
assert.equal(rankInSpec(50, parseRankSpec('30-300')), true);

assert.equal(sidesPassRank('Unknown mix', 'Spirit', '30-300', '', table), true, '30-300 includes unranked own');
assert.equal(sidesPassRank('Unknown mix', 'Spirit', '30-200', '', table), false, '30-200 excludes unranked');
assert.equal(sidesPassRank('9z', 'Falcons', '2', '', table), false, 'single value is 1..N');
assert.equal(sidesPassRank('9z', 'Spirit', '3-10', '1-2', table), true);
assert.equal(sidesPassRank('Spirit', '9z', '3-10', '1-2', table), false, 'subject orientation');

assert.equal(sidesPassRankEither('Spirit', '9z', '30-100', '1-29', table), false);
assert.equal(
  sidesPassRankEither('FURIA', 'Spirit', '3-10', '1-2', table),
  true,
  'either orientation when no subject'
);
assert.equal(sidesPassRankEither('Spirit', 'Unknown', '50', '', table), true, 'at least one in top 50');
assert.equal(
  sidesPassRankEither('Unknown', 'Also unknown', '50-9999', '', table),
  true,
  'unranked is outside top 49'
);

assert.equal(
  demoPassesRank(
    { name1: 'FURIA', name2: 'Spirit' },
    '3-10',
    '1-2',
    'furia',
    table
  ),
  true
);
assert.equal(
  demoPassesRank({ name1: 'FURIA', name2: 'Spirit' }, '3-10', '1-2', 'spirit', table),
  false
);

assert.equal(rankSummaryLabel('', ''), 'Rank');
assert.equal(rankSummaryLabel('50', ''), 'Top 50');
assert.equal(rankSummaryLabel('20-50', '1-19'), '20-50 vs 1-19');

const html = rankFilterHtml({ own: '30-100', opp: '1-29' });
assert.ok(html.includes('data-rank="rankOwn"'));
assert.ok(html.includes('placeholder="Own"'));
assert.ok(html.includes('placeholder="Enemy"'));
assert.ok(html.includes('30-100 vs 1-29'));
assert.ok(html.includes('mb-icon'), 'charts icon sits inside Rank');
assert.ok(html.includes('mb-label'), 'label is separate from the icon');

{
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/standings');
  const bundled = latestStandingFiles(readdirSync(dir).map((name) => ({ name })));
  const teams = ['europe', 'americas', 'asia'].flatMap((region) =>
    parseStandingsMarkdown(readFileSync(path.join(dir, bundled[region].file), 'utf8'), region)
  );
  const global = buildGlobalRanks(teams);
  assert.ok(global.size > 80, 'pooled table is larger than one region');
  const spirit = rankOfName('Spirit', global);
  const furia = rankOfName('FURIA', global);
  assert.ok(spirit >= 1 && spirit <= 10, `Spirit is global top, got ${spirit}`);
  assert.ok(furia >= 1 && furia <= 20, `FURIA is global top, got ${furia}`);
  const europeOnly = buildGlobalRanks(teams.filter((t) => t.region === 'europe'));
  assert.equal(
    rankOfName('FURIA', europeOnly),
    9999,
    'FURIA is unranked if we only read Europe'
  );
  assert.equal(
    rankInSpec(rankOfName('Not A Real Org', global), parseRankSpec('50')),
    false,
    'unranked is not top 50'
  );
  assert.equal(
    rankInSpec(rankOfName('Not A Real Org', global), parseRankSpec('50-9999')),
    true,
    '50-9999 includes everyone past 49'
  );
}

console.log('vrsRanks.test.js: ok');
