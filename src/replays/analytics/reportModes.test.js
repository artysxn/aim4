// Run: node src/replays/analytics/reportModes.test.js
//
// The summary and internal documents, from hand-built reports: the shape the
// sheets are read in (headings, the blue notes, the red negative, the rating
// bands, in-document links), not the scan that fills them.

import assert from 'node:assert/strict';
import { buildSummaryDocHtml, shortCall, NOTE_COLOR, NEGATIVE_COLOR } from './antistratSummary.js';
import { buildInternalDocHtml, ratingColor } from './antistratInternal.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- calls as a tell answers with them ------------------------------------

assert.equal(shortCall('All B hits'), 'B');
assert.equal(shortCall('All A hits'), 'A');
assert.equal(shortCall('Mid take'), 'mid');
assert.equal(shortCall('A Pop'), 'A pop');
assert.equal(shortCall('AWP Long lateround'), 'AWP long lateround');
assert.equal(shortCall('Default / Other'), 'default');

// ---- rating bands ------------------------------------------------------------

assert.equal(ratingColor(0.8), '#e06666');
assert.equal(ratingColor(0.9), '#f6a04d');
assert.equal(ratingColor(1.05), '#9c9ca2');
assert.equal(ratingColor(1.2), '');
assert.equal(ratingColor(1.5), '#7bc96f');
assert.equal(ratingColor(2.84), '#5ea3f2');
assert.equal(ratingColor(NaN), '');

// ---- summary -----------------------------------------------------------------

const summary = buildSummaryDocHtml(
  {
    teamName: 'WBT',
    mapCode: 'ANU',
    categories: ['sideT', 'positions', 'pace', 'tells', 'defaults', 'danger', 'antiforce', 'pistols', 'players', 'misc'],
    report: {
      sides: {
        T: {
          positions: [{ id: 'a', name: 'Psycho', role: 'Mid' }],
          pace: {
            basis: 59,
            rows: [
              { pace: 'rush', label: 'Rush', count: 6, share: 10, siteA: 0, siteB: 5, files: ['r1'], note: 'They never rush A' },
              { pace: 'default', label: 'Default', count: 23, share: 39, siteA: 0, siteB: 0, files: [], note: '' }
            ]
          },
          tells: {
            tells: [{ utility: 'Top Con flash', freq: 'Always', outcome: 'B', hits: 6, rounds: 6, hitFiles: ['r1'] }],
            siteGroups: [
              {
                outcome: 'B',
                freq: 'Always',
                items: [
                  { utility: 'Kitchen smoke', hits: 11, rounds: 11 },
                  { utility: 'B Bench molo', hits: 6, rounds: 6 }
                ]
              }
            ],
            absent: [{ utility: 'Window smoke', usual: 70, freq: 'Mostly', outcome: 'A', hits: 8, rounds: 10 }],
            firstBuy: { rounds: 4, tells: [] }
          },
          defaults: { rounds: 30, rows: [{ label: 'Top mid', type: 'smokegrenade', share: 90, clock: '1:50', thrower: 'Psycho' }] },
          danger: { lines: ['Smash gets the first kill in 13 rounds, 6 of them A Main around 1:16.'] },
          antiforce: {
            rounds: 7,
            lines: ['4x Quick 4 mid fight', 'Others: 2x B rush (won 1), 1x A pop (won 0).'],
            notes: ['No Top mid smoke (90% of full buys, 10% here).']
          },
          force: null,
          sites: [],
          pistols: { rounds: 3, lines: ['2x A rush', '1x Other variations'], notes: ['They never ran the same pistol twice in a row.'] },
          players: [{ name: 'Psycho', role: 'Mid', text: 'Plays mid.', rec: '' }]
        }
      },
      misc: {
        T: ['On their T side, they win 55% of A rounds and 53% of B rounds.', { list: ['Enemy AWP B start (WBT have 44% winrate against this, 9 rounds)'] }],
        CT: ['On their CT side, they have a 61% winrate against A rounds.']
      }
    }
  },
  esc
);

assert.match(summary, /<h1 style="font-size: 25px">WBT: Anubis<\/h1>/);
assert.match(summary, /<h2 style="font-size: 19px">WBT T SIDE<\/h2>/);
assert.match(summary, /<h3>T Positions<\/h3><ul><li>Psycho: Mid<\/li><\/ul>/);
assert.match(summary, /Rush: 10% \(6, 5 towards B, 0 towards A\)/);
assert.equal(NOTE_COLOR, '#6aa84f', 'notes are green');
assert.ok(summary.includes(`<span style="color: ${NOTE_COLOR}">*They never rush A</span>`), 'pace note in green');
assert.ok(summary.includes(`<span style="color: ${NOTE_COLOR}">Always B</span>`), 'tell answer in green');
assert.match(summary, /No Window smoke \(thrown in 70% of rounds\): <span[^>]*>Mostly A<\/span> \(8 of 10\)/);
assert.match(summary, /Kitchen smoke \(11 of 11\) and B Bench molo \(6 of 6\): <span[^>]*>Always B<\/span>/, 'site tells grouped by answer');
assert.match(summary, /<h3>T Default utility<\/h3><ul><li>Top mid smoke: 90% \(usually 1:50, Psycho\)<\/li><\/ul>/);
assert.match(summary, /<li>Others: 2x B rush \(won 1\), 1x A pop \(won 0\)\.<\/li>/, 'the rest are listed, not counted');
assert.ok(summary.includes(`<span style="color: ${NOTE_COLOR}">*No Top mid smoke (90% of full buys, 10% here).</span>`), 'dropped default in green');
assert.match(summary, /<h2 style="font-size: 19px">MISC STATISTICS:<\/h2><p>On their T side, they win 55%/);
assert.match(summary, /<ol><li>Enemy AWP B start \(WBT have 44% winrate against this, 9 rounds\)<\/li><\/ol>/);
assert.ok(summary.includes(`<span style="color: ${NEGATIVE_COLOR}">No tells for first buy</span>`), 'missing tells in red');
assert.match(summary, /<h3>T Antiforces<\/h3><ul><li>4x Quick 4 mid fight<\/li>/);
assert.match(summary, /<h3>T Pistols<\/h3>.*They never ran the same pistol/);
assert.match(summary, /<h3>Psycho \(Mid\)<\/h3><p>Plays mid\.<\/p>/);
assert.ok(!summary.includes('<a '), 'printed: no links');
assert.ok(!summary.includes('CT SIDE'), 'an unticked side is left out');
assert.ok(!summary.includes('—'), 'no long dashes');

// ---- summary with round links (for checking it) ----------------------------

const linked = buildSummaryDocHtml(
  {
    teamName: 'WBT',
    mapCode: 'ANU',
    categories: ['sideT', 'tells', 'force', 'players'],
    links: true,
    report: {
      sides: {
        T: {
          positions: [],
          tells: {
            files: ['r1', 'r2', 'r3'],
            tells: [{ utility: 'Xbox smoke', freq: 'Always', outcome: 'short pop', hits: 2, rounds: 2, files: ['r1', 'r2'], hitFiles: ['r1', 'r2'] }],
            absent: [],
            firstBuy: null
          },
          force: {
            files: ['f1', 'f2', 'f3'],
            lines: [
              { text: '2x B rush through Upper.', files: ['f1', 'f2'] },
              { text: 'Others: ', parts: [{ text: '1x A pop (won 0)', files: ['f3'] }], tail: '.', files: ['f3'] }
            ]
          },
          sites: [],
          players: [{ name: 'Psycho', role: 'Mid', text: 'Plays mid.', files: ['r1'] }]
        }
      }
    }
  },
  esc
);
assert.match(linked, /<h3><a href="\/demos\?rounds=f1,f2,f3">T Force buys<\/a><\/h3>/, 'a heading opens the whole section');
assert.match(linked, /<li><a href="\/demos\?rounds=f1,f2">2x B rush through Upper\.<\/a><\/li>/, 'a line opens its own rounds');
assert.match(linked, /Others: <a href="\/demos\?rounds=f3">1x A pop \(won 0\)<\/a>\./, 'each of the others opens its own');
assert.match(linked, /<a href="\/demos\?rounds=r1,r2">Xbox smoke<\/a>: <a href="\/demos\?rounds=r1,r2"><span[^>]*>Always short pop<\/span><\/a>/);
assert.match(linked, /<h3><a href="\/demos\?rounds=r1">Psycho \(Mid\)<\/a><\/h3>/);

// ---- internal ----------------------------------------------------------------

const cell = (rounds, wins, wr, opk, c54, c45) => ({
  rounds,
  wins,
  winrate: wr,
  opkRate: opk,
  conv5v4: c54,
  conv4v5: c45,
  files: ['f1']
});
const internal = buildInternalDocHtml(
  {
    teamName: 'Inner Circle',
    mapCode: 'DD2',
    categories: ['sideT', 'tables', 'ratings', 'conclusion'],
    report: {
      positions: [{ name: 'dawy', tRole: 'T Mid', ctRole: 'B Mid', matches: 10 }],
      sides: {
        T: {
          tables: {
            own: [
              { key: 'all-a-hits', label: 'All A hits', cell: cell(22, 12, 55, 45, 80, 33) },
              { key: 'long-take', label: 'Long take', cell: cell(4, 2, 50, 100, 50, null) }
            ],
            faced: [{ key: 'ug', label: 'UG setup', cell: cell(4, 1, 25, 75, 33, 0) }]
          },
          notes: { weakest: null, punishing: [], restFine: true, own: null, faced: [], random: null },
          ratings: {
            players: ['dawy'],
            own: { rows: [{ key: 'a', label: 'A Afterplant', values: [2.84], avg: 2.84 }], playerAvg: [2.84], teamAvg: 2.84 },
            faced: { rows: [], playerAvg: [], teamAvg: null }
          },
          players: { best: null, officials: null, worst: null }
        }
      },
      conclusion: { paragraphs: ['The average game lasts 21 rounds (13-8).\n50% round win rate: 21 × 0.50 = 10.5 rounds'] }
    }
  },
  esc
);

assert.match(internal, /<h1 style="font-size: 25px">INNER CIRCLE: DUST2<\/h1>/);
assert.match(internal, /dawy: T T Mid, CT B Mid \(10 matches\)/);
assert.match(internal, /<h1 style="font-size: 25px" id="t-side">T SIDE<\/h1>/);
assert.match(internal, /<h2 style="font-size: 19px" id="t-full">T SIDE, FULL BUY vs FULL BUY<\/h2>/);
assert.match(internal, /<a style="[^"]*" href="#t-side">/, 'contents link into the document');
assert.match(internal, /<td>55% \(22 rounds\)<\/td>/, 'the biggest bucket says how big');
assert.match(internal, /<td>50% \(2 of 4\)<\/td>/, 'a small bucket says how small');
assert.match(internal, /<td>––<\/td>/, 'an empty cell is two dashes');
assert.match(internal, /<td>25% \(1 of 4\)<\/td>/);
assert.ok(internal.includes('<span style="color: #5ea3f2">2.84</span>'), 'a rating above 1.7 is blue');
assert.match(internal, /<h1 style="font-size: 25px" id="conclusion">Conclusion<\/h1>/);
assert.match(internal, /21 rounds \(13-8\)\.<br>50% round win rate/);
assert.ok(!internal.includes('CT SIDE,'), 'an unticked side is left out');

console.log('reportModes.test.js ok');
