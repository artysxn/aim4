// Run: node src/replays/analytics/antistratConfig.test.js

import assert from 'node:assert/strict';
import { buildAntistratDocHtml } from './antistratConfig.js';

const html = buildAntistratDocHtml(
  {
    teamName: 'BOREALIS',
    mapCode: 'MIR',
    matches: [{ label: 'vs X' }],
    categories: ['pistols', 'positions'],
    results: {
      sections: {
        pistols: {
          t: [{ opponent: 'X', file: 'a.dem', formation: '', pace: '', site: '', smokes: [], molotovs: [], turnaround: false, shown: '', won: false }],
          ct: [{ opponent: 'X', file: 'a.dem', a: 2, ee: 1, b: 2, won: false }],
          ctOrder: ['A', 'ee', 'B']
        },
        positions: []
      }
    }
  },
  (s) => String(s)
);

assert.match(html, /<h1 style="font-size: 25px">Antistrat: BOREALIS on Mirage<\/h1>/);
assert.match(html, /<h1 style="font-size: 25px">Pistol rounds<\/h1>/);
assert.match(html, /<h1 style="font-size: 25px">Positions on T and CT<\/h1>/);
assert.match(html, /<h2 style="font-size: 19px">T pistols<\/h2>/);
assert.match(html, /<h2 style="font-size: 19px">CT pistols \(A - ee - B\)<\/h2>/);

console.log('antistratConfig.test.js ok');
