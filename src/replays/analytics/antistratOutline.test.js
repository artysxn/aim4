// Summary mode, simple outline: what buildOutlineDocHtml prints from a report.
import assert from 'node:assert/strict';
import { buildOutlineDocHtml } from './antistratSummary.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const report = {
  sides: {
    T: {
      positions: [
        { name: 'sl3nd', role: 'AWPer' },
        { name: 'volt', role: 'B Lurk' }
      ],
      pistols: { files: ['p1'], lines: [{ text: '3x Default 2-3 into B.', files: ['p1'] }], notes: [] },
      tells: {
        files: ['t1'],
        tells: [{ utility: 'flash into A main', outcome: 'B', hits: 6, rounds: 7, files: ['t1'], hitFiles: ['t1'] }],
        siteGroups: [],
        absent: [{ utility: 'mid smoke', usual: 80, outcome: 'B', hits: 4, rounds: 4, files: ['t2'], hitFiles: ['t2'] }]
      },
      force: { files: ['f1'], lines: [{ text: '2x A rush.', files: ['f1'] }] },
      antiforce: null
    },
    CT: {
      positions: [{ name: 'dytor', role: 'A Anchor' }],
      pistols: null,
      defaults: { files: ['d1'], rows: [{ label: 'A main', type: 'smokegrenade', share: 79, clock: '1:30', thrower: 'dytor', files: ['d1'] }] },
      forceStyle: { files: ['c1'], lines: [{ text: 'Stack: 4 of 7 (3x B, 1x A)', files: ['c1'] }] },
      antiecoStyle: { files: ['c2'], lines: [{ text: 'Further up, aggressive: 3 of 5 (2x Mid)', files: ['c2'] }] }
    }
  }
};

const html = buildOutlineDocHtml(
  { teamName: 'Mouz', mapCode: 'DD2', categories: ['sideT', 'sideCT'], report },
  esc
);

// Headings in order, T first.
const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);
assert.deepEqual(headings, [
  'T Positions',
  'T Pistol',
  'T Tells',
  'T Notes and preparation (our CT)',
  'T Force / Antiforce',
  'CT Positions',
  'CT Default utility',
  'CT Notes and preparation (our T)',
  'CT Force / Antiforce'
]);

assert.match(html, /sl3nd: AWPer/);
assert.match(html, /Flash into A main → most likely B \(6 of 7\)/);
assert.match(html, /No mid smoke → most likely B \(4 of 4\)/);
assert.match(html, /A main smoke: 79% \(usually 1:30, dytor\)/);
assert.match(html, /Stack: 4 of 7 \(3x B, 1x A\)/);
assert.match(html, /Anti-eco:/);
// No antiforce rounds: only the force list is labelled.
assert.doesNotMatch(html, /Antiforce:/);
// Notes sections are empty for the analyst to fill.
assert.match(html, /T Notes and preparation \(our CT\)<\/h2><p><br><\/p>/);
// Printed sheet: no links unless asked for.
assert.doesNotMatch(html, /<a /);

// No tells at all: the section is left out.
const noTells = buildOutlineDocHtml(
  {
    teamName: 'Mouz',
    mapCode: 'DD2',
    categories: ['sideT'],
    report: { sides: { T: { ...report.sides.T, tells: { tells: [], siteGroups: [], absent: [] } } } }
  },
  esc
);
assert.doesNotMatch(noTells, /T Tells/);

// Links on: headings open their rounds.
const linked = buildOutlineDocHtml(
  { teamName: 'Mouz', mapCode: 'DD2', categories: ['sideCT'], report, links: true },
  esc
);
assert.match(linked, /<a href="\/demos\?rounds=d1">CT Default utility<\/a>/);

console.log('antistratOutline.test.js: ok');
