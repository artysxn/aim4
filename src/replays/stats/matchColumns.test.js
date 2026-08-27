// Run: node src/replays/stats/matchColumns.test.js
//
// The per-match tables — Performance's form table, the Database's drill-down —
// are one row per game, and the date cell is the row's handle on that game.

import assert from 'node:assert/strict';
import {
  MATCH_IDENTITY_COLUMNS,
  matchHref,
  playerMatchColumns,
  statsTableHtml,
  teamMatchColumns
} from './statsTables.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const dateCol = MATCH_IDENTITY_COLUMNS.find((c) => c.key === 'date');
assert.ok(dateCol, 'the identity columns carry a date');

// ---- the link ---------------------------------------------------------------

assert.equal(matchHref({ demoId: 'feedbead12345678' }), '/demos?demo=feedbead12345678');
assert.equal(matchHref({}), '', 'a row with no match behind it links nowhere');
assert.equal(matchHref({ demoId: '' }), '');
assert.equal(
  matchHref({ demoId: '../../etc/passwd' }),
  '',
  'an id outside the store charset is refused rather than escaped into an href'
);
assert.equal(matchHref({ demoId: 'a'.repeat(65) }), '', 'and one that is absurdly long');

const at = Date.UTC(2026, 7, 26, 12);
{
  const html = dateCol.html({ uploadedAt: at, demoId: 'abc123' });
  assert.match(html, /<a class="st-link" href="\/demos\?demo=abc123"/, 'the date is the link');
  assert.match(html, /target="_blank"/, 'opening a match keeps the table it came from');
  assert.match(html, /rel="noopener noreferrer"/);
  // Whatever the runner's locale renders, the visible text is the date itself.
  assert.ok(html.includes(dateCol.cell({ uploadedAt: at })), 'and the text is still the date');
}
{
  const plain = dateCol.html({ uploadedAt: at });
  assert.equal(plain, dateCol.cell({ uploadedAt: at }), 'no match id, no anchor');
  assert.ok(!plain.includes('<a '), 'and nothing that looks like one');
}
assert.equal(dateCol.html({ uploadedAt: 0 }), '—', 'an unknown date is a dash, not a link');

// Sorting still reads the timestamp, not the rendered string.
assert.equal(dateCol.get({ uploadedAt: at }), at);
assert.equal(dateCol.get({}), 0);

// ---- through the table both callers actually render -------------------------

for (const [what, cols] of [['player', playerMatchColumns()], ['team', teamMatchColumns()]]) {
  const html = statsTableHtml(
    [
      // `members` because the team columns' tips read the side's roster; real
      // rows always carry it.
      { demoId: 'match0001', uploadedAt: at, map: 'ANU', mapName: 'Anubis', rating: 1.2, rounds: 20, members: [] },
      { uploadedAt: at - 86_400_000, map: 'ANU', mapName: 'Anubis', rating: 0.9, rounds: 18, members: [] }
    ],
    { columns: cols.columns, fixedCount: cols.fixedCount, escapeHtml: esc, sortKey: 'date' }
  );
  assert.equal(
    [...html.matchAll(/href="\/demos\?demo=match0001"/g)].length,
    1,
    `${what} table: the row with a match links to it`
  );
  assert.equal(
    [...html.matchAll(/href="\/demos\?demo=/g)].length,
    1,
    `${what} table: the row without one does not`
  );
}

console.log('matchColumns.test.js ok');
