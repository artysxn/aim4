// Stratbook rows for the clipboard: the cells a spreadsheet will paste back.
import assert from 'node:assert/strict';
import { mapRows, notePlain, playerStratsTsv, stratbookTsv, tsvCell } from './stratbookCopy.js';

assert.equal(notePlain('SFF. <Window smoke><!ab12> insta, <Guide><URL=https://x.io/a>.'), 'SFF. Window smoke insta, Guide https://x.io/a.');
assert.equal(tsvCell('plain'), 'plain');
assert.equal(tsvCell('1st: go\n2nd: "flash"'), '"1st: go\n2nd: ""flash"""');

const strategies = [
  { map: 'MIR', side: 'T', name: 'B split', economy: 'Full buy', category: 'Set call', description: '', roleNotes: ['ropz: <Window smoke><!ab12> insta.', 'K. Go B.'] },
  { map: 'MIR', side: 'CT', name: 'Stack A', economy: 'Eco', category: 'Setup', description: 'Give B.', roleNotes: ['Hold A.'] },
  { map: 'DD2', side: 'T', name: 'Long', economy: 'Pistol', category: 'Pistol', description: '', roleNotes: ['1st: rush\n2nd: flash'] }
];
const columns = (side) => (side === 'T' ? ['Mid', 'B'] : ['A']);
const maps = [{ code: 'MIR', name: 'Mirage' }, { code: 'ANU', name: 'Anubis' }, { code: 'DD2', name: 'Dust2' }];

assert.deepEqual(mapRows({ strategies, map: maps[0], columns }), [
  'Mirage T',
  'Name\tEconomy\tCategory\tDescription\tMid\tB',
  'B split\tFull buy\tSet call\t\tropz: Window smoke insta.\tK. Go B.',
  '',
  'Mirage CT',
  'Name\tEconomy\tCategory\tDescription\tA',
  'Stack A\tEco\tSetup\tGive B.\tHold A.'
]);
// A map with nothing is left out; a multi-line note is one quoted cell.
const all = stratbookTsv({ strategies, maps, columns });
assert.ok(!all.includes('Anubis'));
assert.ok(all.endsWith('Long\tPistol\tPistol\t\t"1st: rush\n2nd: flash"\t'));

assert.equal(
  playerStratsTsv({ strategies, maps, noteOf: (s) => s.roleNotes[0] }),
  'Map\tSide\tName\tEconomy\tCategory\tNote\nMirage\tT\tB split\tFull buy\tSet call\tropz: Window smoke insta.\nMirage\tCT\tStack A\tEco\tSetup\tHold A.\nDust2\tT\tLong\tPistol\tPistol\t"1st: rush\n2nd: flash"'
);
assert.equal(playerStratsTsv({ strategies: [], maps, noteOf: () => '' }), '');

console.log('stratbookCopy.test.js ok');
