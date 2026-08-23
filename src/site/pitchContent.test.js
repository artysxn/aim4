// Run: node src/site/pitchContent.test.js

import assert from 'node:assert/strict';
import { PITCH_SLIDES, applyPitchText, textLeaves } from './pitchContent.js';
import { TALK_SLIDES } from './pitchTalk.js';

// ---- the deck itself --------------------------------------------------------

const ids = PITCH_SLIDES.map((s) => s.id);
assert.equal(new Set(ids).size, ids.length, 'slide ids are unique');
for (const slide of PITCH_SLIDES) {
  assert.match(slide.id, /^[a-z][a-z0-9-]{0,39}$/, `${slide.id} is a storable id`);
  assert.ok(slide.title, `${slide.id} has a title`);
}

// Every table row is as wide as its head, or the slide renders ragged.
for (const slide of PITCH_SLIDES) {
  if (!slide.table) continue;
  for (const row of slide.table.rows) {
    assert.equal(row.length, slide.table.head.length, `${slide.id} row width`);
  }
}

// ---- the talking deck -------------------------------------------------------

assert.ok(
  TALK_SLIDES.length >= 12 && TALK_SLIDES.length <= 14,
  `the talking deck is ${TALK_SLIDES.length} slides; it is meant to sit at 12-14`
);

const allIds = [...PITCH_SLIDES, ...TALK_SLIDES].map((s) => s.id);
assert.equal(new Set(allIds).size, allIds.length, 'ids are unique across both decks');

for (const slide of TALK_SLIDES) {
  assert.match(slide.id, /^t-[a-z][a-z0-9-]*$/, `${slide.id} is prefixed for the talking deck`);
  assert.ok(slide.title, `${slide.id} has a title`);

  // The whole point of this deck: labels, not prose. Explanation belongs in the
  // script, which is why a lead or a note here is a mistake worth failing on.
  assert.equal(slide.lead, undefined, `${slide.id} must not carry a lead`);
  assert.equal(slide.note, undefined, `${slide.id} must not carry a note`);
  assert.equal(slide.tableNote, undefined, `${slide.id} must not carry a table note`);
  assert.equal(slide.points, undefined, `${slide.id} must not carry prose bullets`);

  assert.ok(Array.isArray(slide.script) && slide.script.length, `${slide.id} has a script`);
  for (const para of slide.script) {
    assert.equal(typeof para, 'string');
    // A short opener ("Where it goes next.") is real speech; an empty or stub
    // paragraph is not.
    assert.ok(para.trim().length > 8, `${slide.id} script paragraphs are spoken sentences`);
    assert.ok(!para.includes('\n'), `${slide.id} script paragraphs are single lines`);
  }

  for (const row of slide.table?.rows || []) {
    assert.equal(row.length, slide.table.head.length, `${slide.id} row width`);
  }
  for (const col of slide.columns || []) {
    for (const bar of col.bars || []) {
      assert.equal(typeof bar.n, 'number', `${slide.id} bars carry a magnitude`);
      assert.ok(bar.n > 0);
      assert.equal(typeof bar.label, 'string');
      assert.equal(typeof bar.value, 'string');
    }
  }
}

// The script is editable like everything else.
const talkLeaves = textLeaves(TALK_SLIDES[0]).map((l) => l.path);
assert.ok(talkLeaves.includes('script.0'));

// Grouped lists and bare lists both expose their labels for editing.
const listSlide = TALK_SLIDES.find((s) => Array.isArray(s.lists) && s.lists[0]?.items);
assert.ok(textLeaves(listSlide).map((l) => l.path).includes('lists.0.items.0'));
const colListSlide = TALK_SLIDES.find((s) => s.columns?.some((c) => Array.isArray(c.lists)));
assert.ok(textLeaves(colListSlide).map((l) => l.path).includes('columns.0.lists.0'));

// ---- textLeaves -------------------------------------------------------------

const leaves = textLeaves(PITCH_SLIDES[1]);
const paths = leaves.map((l) => l.path);
assert.ok(paths.includes('title'));
assert.ok(paths.includes('points.0'));
assert.ok(paths.includes('stats.0.value'));
assert.ok(!paths.includes('id'), 'the id is structure, not wording');
assert.ok(
  leaves.every((l) => typeof l.value === 'string'),
  'only strings are offered for editing'
);

const toned = textLeaves(PITCH_SLIDES.find((s) => s.tone === 'plus'));
assert.ok(!toned.map((l) => l.path).includes('tone'), 'tone is not editable text');

// A table slide exposes its cells individually.
const table = PITCH_SLIDES.find((s) => s.table);
const tablePaths = textLeaves(table).map((l) => l.path);
assert.ok(tablePaths.includes('table.head.0'));
assert.ok(tablePaths.includes('table.rows.0.0'));

// ---- applyPitchText ---------------------------------------------------------

const base = [
  {
    id: 'demo',
    title: 'Before',
    lead: 'Lead',
    points: ['one', 'two'],
    columns: [{ title: 'Col', points: ['a'] }],
    table: { head: ['H'], rows: [['R']], highlight: 0 },
    tone: 'plus',
    center: true
  }
];

const out = applyPitchText(base, {
  demo: {
    title: 'After',
    'points.1': 'second',
    'columns.0.points.0': 'A!',
    'table.rows.0.0': 'r'
  }
});
assert.equal(out[0].title, 'After');
assert.deepEqual(out[0].points, ['one', 'second']);
assert.equal(out[0].columns[0].points[0], 'A!');
assert.equal(out[0].table.rows[0][0], 'r');
assert.equal(out[0].tone, 'plus', 'structure survives');
assert.equal(out[0].center, true);
assert.equal(base[0].title, 'Before', 'the source array is never mutated');

// No override, no copy: the slide comes back by reference.
assert.equal(applyPitchText(base, {})[0], base[0]);
assert.equal(applyPitchText(base, null)[0], base[0]);
assert.equal(applyPitchText(base, { demo: { title: 'Before' } })[0], base[0], 'no-op edit');

// ---- what an override may not do -------------------------------------------

const hostile = applyPitchText(base, {
  demo: {
    // A path that does not exist: no field is created.
    newField: 'nope',
    // Past the end of an array: no row is grown.
    'points.9': 'nope',
    // A non-string target: layout is not text.
    highlight: 'nope',
    center: 'nope',
    // Prototype reach.
    '__proto__.polluted': 'nope',
    'constructor.prototype.polluted': 'nope'
  },
  // A slide that is not in the deck is ignored rather than added.
  ghost: { title: 'nope' }
});
assert.equal(hostile.length, 1);
assert.equal(hostile[0].newField, undefined);
assert.equal(hostile[0].points.length, 2);
assert.equal(hostile[0].table.highlight, 0);
assert.equal(hostile[0].center, true);
assert.equal({}.polluted, undefined, 'no prototype pollution');
assert.equal(hostile[0], base[0], 'nothing applied, so nothing copied');

// Non-string values are dropped, whatever they are.
const typed = applyPitchText(base, { demo: { title: 42, lead: { evil: true } } });
assert.equal(typed[0].title, 'Before');
assert.equal(typed[0].lead, 'Lead');

console.log('pitchContent: all assertions passed');
