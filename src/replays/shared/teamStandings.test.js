import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchStandingTeam,
  normalizePlayerName,
  parseStandingsMarkdown,
  resolveDemoTeams
} from './teamStandings.js';
import { latestStandingFiles } from './vrsStandings.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/standings');
const bundled = latestStandingFiles(readdirSync(dir).map((name) => ({ name })));
assert.ok(bundled.europe && bundled.americas && bundled.asia, 'bundled snapshots present');
const europe = parseStandingsMarkdown(
  readFileSync(path.join(dir, bundled.europe.file), 'utf8'),
  'europe'
);
const americas = parseStandingsMarkdown(
  readFileSync(path.join(dir, bundled.americas.file), 'utf8'),
  'americas'
);
const asia = parseStandingsMarkdown(
  readFileSync(path.join(dir, bundled.asia.file), 'utf8'),
  'asia'
);
const all = [...europe, ...americas, ...asia];

assert.ok(europe.length > 50, 'europe standings parsed');
assert.ok(americas.length > 20, 'americas standings parsed');
assert.ok(asia.length > 10, 'asia standings parsed');

assert.equal(normalizePlayerName('m0NESY'), 'm0nesy');
assert.equal(normalizePlayerName('huNter-'), 'hunter');
assert.equal(normalizePlayerName('nut nut'), 'nutnut');

const falcons = matchStandingTeam(['NiKo', 'karrigan', 'm0NESY', 's1mple', 'ZyWoo'], all);
assert.equal(falcons?.team.name, 'Falcons');
assert.equal(falcons?.hits, 3);

const tooFew = matchStandingTeam(['NiKo', 'karrigan'], all);
assert.equal(tooFew, null);

const vitality = matchStandingTeam(['ZywOo', 'apEX', 'ropz', 'mezii', 'flameZ'], all);
assert.equal(vitality?.team.name, 'Vitality');

const furia = matchStandingTeam(['yuurih', 'KSCERATO', 'FalleN', 'YEKINDAR'], all);
assert.equal(furia?.team.name, 'FURIA');

const resolved = resolveDemoTeams(
  [
    { name: 'NiKo', team: 1 },
    { name: 'karrigan', team: 1 },
    { name: 'm0NESY', team: 1 },
    { name: 'kyousuke', team: 1 },
    { name: 'TeSeS', team: 1 },
    { name: 'ZywOo', team: 2 },
    { name: 'apEX', team: 2 },
    { name: 'ropz', team: 2 },
    { name: 'mezii', team: 2 },
    { name: 'flameZ', team: 2 }
  ],
  all
);
assert.equal(resolved.team1?.name, 'Falcons');
assert.equal(resolved.team2?.name, 'Vitality');

console.log('teamStandings.test.js: ok');
