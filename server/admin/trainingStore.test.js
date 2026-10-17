// Run: node server/admin/trainingStore.test.js

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// TRAINING_DIR is resolved at module load, so point it at scratch first.
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-training-'));
process.env.AIM4_TRAINING_DIR = dir;

const { appendRecord, exportTraining, makeRecord, readStage, removeRecord, TrainingError, trainingStats } = await import(
  './trainingStore.js'
);

const bot = { text: 'Ts rush B through T Aps at 1:39.' };
const subject = { round: 'abc~123', map: 'MIR' };

// ---- validation --------------------------------------------------------------

assert.throws(() => makeRecord(9, { verdict: 'yes', subject, bot }, 'me'), TrainingError, 'unknown stage');
assert.throws(() => makeRecord(1, { verdict: 'maybe', subject, bot }, 'me'), /yes or no/);
assert.throws(() => makeRecord(1, { verdict: 'yes', subject, bot: { text: '' } }, 'me'), /text/);
assert.throws(() => makeRecord(1, { verdict: 'yes', subject: [], bot }, 'me'), /Subject/);
assert.throws(() => makeRecord(2, { verdict: 'yes', subject, bot }, 'me'), /Your description is required/, 'stage 2: yes needs your own words');
assert.throws(() => makeRecord(4, { verdict: 'no', subject, bot }, 'me'), /comment is required/, 'stage 4: no needs a comment');
assert.throws(
  () => makeRecord(1, { verdict: 'yes', subject: { big: 'x'.repeat(100 * 1024) }, bot }, 'me'),
  /too large/
);

const r1 = makeRecord(1, { verdict: 'yes', subject, bot, answer: 'ignored on stage 1', engine: 'rules-1' }, 'me');
assert.equal(r1.task, 'round-describe');
assert.equal(r1.answer, undefined, 'stage 1 keeps no answer');
assert.equal(r1.v, 1);
assert.match(r1.id, /^[a-f0-9]{12}$/);
assert.equal(makeRecord(2, { verdict: 'no', subject, bot }, 'me').answer, undefined, 'stage 2: no needs nothing more');
assert.equal(makeRecord(2, { verdict: 'yes', subject, bot, answer: '  mine  ' }, 'me').answer, 'mine');
assert.equal(makeRecord(4, { verdict: 'no', subject, bot, comment: 'It was a B split' }, 'me').comment, 'It was a B split');
assert.equal(makeRecord(5, { verdict: 'yes', subject, bot }, 'me').comment, undefined, 'stage 5: the note is optional');
assert.equal(makeRecord(3, { verdict: 'no', subject, bot, engine: 'Bad Engine!' }, 'me').engine, 'rules-1');

// ---- storage, stats, undo, export --------------------------------------------

await appendRecord(r1);
const r2 = await appendRecord(makeRecord(1, { verdict: 'no', subject, bot }, 'me'));
await appendRecord(makeRecord(4, { verdict: 'no', subject, bot, comment: 'why' }, 'me'));
// A crash mid-write leaves a torn last line; everything before it still reads.
await fsp.appendFile(path.join(dir, 'training_1.jsonl'), '{"v":1,"id":"torn');

assert.equal((await readStage(1)).length, 2);
let stats = await trainingStats();
assert.deepEqual(stats.counts[1], { total: 2, yes: 1, no: 1 });
assert.equal(stats.counts[5].total, 0);
assert.equal(stats.last[1].id, r2.id);

assert.equal(await removeRecord(1, r2.id), true);
assert.equal(await removeRecord(1, r2.id), false, 'already gone');
stats = await trainingStats();
assert.deepEqual(stats.counts[1], { total: 1, yes: 1, no: 0 });

const exported = (await exportTraining()).trim().split('\n').map((l) => JSON.parse(l));
assert.equal(exported[0].format, 'aim4-training');
assert.deepEqual(exported[0].counts, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0 });

// Stage 6: an aim4 eye answer rated in the chat, with its whole turn.
const trace = makeRecord(6, { verdict: 'no', comment: 'Wrong site', engine: 'qwen3.5-4b', subject: { question: 'q' }, bot: { text: 'a', messages: [{ role: 'user', content: 'q' }] } }, 'admin');
assert.equal(trace.task, 'eye-trace');
assert.equal(trace.comment, 'Wrong site');
assert.ok(makeRecord(6, { verdict: 'yes', subject: {}, bot: { text: 'a', messages: ['x'.repeat(150 * 1024)] } }, 'admin'), 'a trace may be larger than a page label');
assert.throws(() => makeRecord(1, { verdict: 'yes', subject: {}, bot: { text: 'a', big: 'x'.repeat(150 * 1024) } }, 'admin'), /too large/);
assert.equal(exported.length, 3, 'header + one line per record');
const only4 = (await exportTraining(['4'])).trim().split('\n');
assert.equal(only4.length, 2);
assert.equal(JSON.parse(only4[1]).task, 'antistrat-point');

await fsp.rm(dir, { recursive: true, force: true });
console.log('trainingStore.test.js ok');
