// Run: node server/pitchStore.test.js

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point the store at a scratch directory before it is imported: PITCH_DIR is
// resolved once, at module load.
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-pitch-'));
process.env.AIM4_PITCH_DIR = dir;

const { countPitchEdits, getPitchText, sanitizePitchText, savePitchText } = await import(
  './pitchStore.js'
);

// ---- sanitize ---------------------------------------------------------------

assert.deepEqual(sanitizePitchText(null), {});
assert.deepEqual(sanitizePitchText('nope'), {});
assert.deepEqual(sanitizePitchText({ 'ask-sale': { 'points.0': 'kept' } }), {
  'ask-sale': { 'points.0': 'kept' }
});

// Slide ids that could not have come from the deck are dropped.
assert.deepEqual(sanitizePitchText({ 'Bad Id': { title: 'x' } }), {});
assert.deepEqual(sanitizePitchText({ '../../etc/passwd': { title: 'x' } }), {});
assert.deepEqual(sanitizePitchText({ __proto__: { title: 'x' } }), {});

// Paths must be dotted identifiers, so nothing can address a prototype.
const paths = sanitizePitchText({
  demo: {
    title: 'ok',
    'points.2': 'ok',
    'table.rows.0.1': 'ok',
    '__proto__.x': 'no',
    'constructor.prototype.x': 'no',
    '../x': 'no',
    'a b': 'no',
    '': 'no'
  }
});
assert.deepEqual(Object.keys(paths.demo).sort(), ['points.2', 'table.rows.0.1', 'title']);

// Only strings, and control characters never survive.
const typed = sanitizePitchText({ demo: { a: 1, b: null, c: { d: 'x' }, e: 'one\ntwo\tthree' } });
assert.deepEqual(typed.demo, { e: 'one two three' });

// Over-long text is cut, not rejected: one bad paste must not lose the rest.
const long = sanitizePitchText({ demo: { title: 'x'.repeat(9000), lead: 'fine' } });
assert.equal(long.demo.title.length, 4000);
assert.equal(long.demo.lead, 'fine');

// A slide whose every field was dropped does not survive as an empty object.
assert.deepEqual(sanitizePitchText({ demo: { 'a b': 'no' } }), {});

assert.equal(countPitchEdits({ a: { x: '1', y: '2' }, b: { z: '3' } }), 3);
assert.equal(countPitchEdits(null), 0);

// ---- read / write -----------------------------------------------------------

assert.deepEqual(await getPitchText(), { updatedAt: 0, updatedBy: '', text: {} }, 'no file yet');

const saved = await savePitchText({ founder: { title: 'New title' }, junk: { 'a b': 'no' } }, 'admin-1');
assert.deepEqual(saved.text, { founder: { title: 'New title' } });
assert.ok(saved.updatedAt > 0);

const read = await getPitchText();
assert.deepEqual(read.text, { founder: { title: 'New title' } });
assert.equal(read.updatedBy, 'admin-1');

// Saving an empty map is how "revert everything" works.
await savePitchText({}, 'admin-1');
assert.deepEqual((await getPitchText()).text, {});

// A corrupt file reads as "no edits" rather than throwing the deck away.
await fsp.writeFile(path.join(dir, 'text.json'), '{ not json', 'utf8');
await assert.rejects(getPitchText(), 'a broken file is loud in the store');

await fsp.rm(dir, { recursive: true, force: true });
console.log('pitchStore: all assertions passed');
