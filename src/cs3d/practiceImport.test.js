// Run: node src/cs3d/practiceImport.test.js

import { gameLabel, gameSearchText, filterGames, roundChoices } from './practiceImport.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const faZe = {
  id: 'a',
  status: 'ready',
  map: 'ANC',
  team1: { name: 'FaZe' },
  team2: { name: 'NaVi' },
  filename: 'faze-navi-m1-ancient.dem'
};
const other = { id: 'b', status: 'ready', map: 'MIR', team1: { name: 'FaZe' }, team2: { name: 'Vitality' } };
const parsing = { id: 'c', status: 'parsing', map: 'ANC', team1: { name: 'FaZe' }, team2: { name: 'G2' } };

assert(gameLabel(faZe) === 'FaZe vs NaVi', 'label');
assert(gameSearchText(faZe).includes('ancient'), 'filename in search');
assert(filterGames([faZe, other, parsing], '', 'ANC').map((d) => d.id).join() === 'a', 'map + ready');
assert(filterGames([faZe], 'navi', 'ANC').length === 1, 'query hits team');
assert(filterGames([faZe], 'spirit', 'ANC').length === 0, 'query miss');
assert(roundChoices({ rounds: [{ round: 3 }, { meta: { round: 5 } }] }).map((c) => c.label).join() === 'Round 3,Round 5', 'round labels');

console.log('practiceImport.test.js ok');
