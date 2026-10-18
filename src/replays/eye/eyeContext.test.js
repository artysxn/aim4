// Run: node src/replays/eye/eyeContext.test.js
//
// Long eye conversations stay inside the model's context: the oldest tool
// results are shortened first, earlier questions before the current one, and
// the results the model is about to read never are. A shortened result is
// still readable: JSON keeps its shape, lists keep their first rows and length.

import assert from 'node:assert/strict';
import { compactHistory, shortenResult } from './eyeContext.js';

const big = (tag) => `${tag}:${'x'.repeat(12000)}`;
const step = (n, content = big(`result${n}`)) => [
  { role: 'assistant', content: '', tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'database_query', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${n}`, content }
];
const convo = () => [{ role: 'user', content: 'Top 5 AWP players on Mirage?' }, ...step(1), ...step(2), ...step(3), ...step(4)];

// Under budget: nothing changes.
let m = convo();
assert.equal(compactHistory(m, 1_000_000), 0);
assert.ok(m.every((x) => !x.compacted));

// Over budget: oldest first, until it fits; the latest result is whole.
m = convo();
const cut = compactHistory(m, 30000);
assert.equal(cut, 2, 'shortens the two oldest results');
const tools = m.filter((x) => x.role === 'tool');
assert.ok(tools[0].compacted && tools[1].compacted);
assert.ok(!tools[2].compacted && !tools[3].compacted);
assert.ok(tools[0].content.startsWith('result1:'), 'keeps the head of a plain-text result');
assert.match(tools[0].content, /shortened to save space/);
assert.equal(tools[0].full, big('result1'), 'the original is kept for the export and the saved chat');
assert.equal(tools[3].content, big('result4'));

// The latest step goes last: with a budget the older results can meet, it stays whole.
m = convo();
compactHistory(m, 18000);
assert.equal(m.filter((x) => x.role === 'tool').at(-1).content, big('result4'));
assert.ok(m.filter((x) => x.role === 'tool').slice(0, 3).every((x) => x.compacted));
// With a budget even that misses, the latest step is shortened too: a shortened answer beats an
// overflowed context (11 antistrat sheets in one step overflowed the model's 32k and the turn failed).
m = convo();
compactHistory(m, 10);
assert.ok(m.filter((x) => x.role === 'tool').every((x) => x.compacted));

// Shortening twice does not shorten again.
assert.equal(compactHistory(m, 10), 0);

// One step with many big results (11 sheets at once): the largest go first until it fits.
m = [{ role: 'user', content: 'best B executes?' }, { role: 'assistant', content: '', tool_calls: Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, type: 'function', function: { name: 'antistrat_summary', arguments: '{}' } })) }];
for (let i = 0; i < 11; i++) m.push({ role: 'tool', tool_call_id: `s${i}`, content: `sheet${i}:${'y'.repeat(8000 + i * 100)}` });
compactHistory(m, 48000, 0);
const size = m.reduce((n, x) => n + (typeof x.content === 'string' ? x.content.length : 0) + JSON.stringify(x.tool_calls || '').length, 0);
assert.ok(size <= 48000, `the step fits the budget (${size})`);
assert.ok(m.filter((x) => x.role === 'tool' && x.compacted).every((x) => x.full.startsWith('sheet')), 'originals kept for the export');

// A step left over from a question that failed is old history: the next question shortens it.
m = [
  { role: 'user', content: 'first question' }, ...step(1), ...step(2),
  { role: 'user', content: 'second question' }
];
compactHistory(m, 13000, m.length - 1);
assert.ok(m.filter((x) => x.role === 'tool').every((x) => x.compacted), 'the failed question\'s last step is shortened');

// Earlier questions go first: with a budget that needs one cut, the earlier
// question's result is shortened and the current question's are kept.
m = [
  { role: 'user', content: 'first question' }, ...step(1),
  { role: 'assistant', content: 'answer' },
  { role: 'user', content: 'second question' }, ...step(2), ...step(3)
];
const turnStart = m.findLastIndex((x) => x.role === 'user');
compactHistory(m, 30000, turnStart);
const t = m.filter((x) => x.role === 'tool');
assert.ok(t[0].compacted, 'the earlier question\'s result is shortened');
assert.ok(!t[1].compacted && !t[2].compacted, 'the current question\'s results are kept');

// A shortened JSON result is valid JSON plus a note: short fields kept, lists
// cut to their first rows with the count, a document text to its headings.
const rows = Array.from({ length: 40 }, (_, i) => ({ round: `r${i}`, map: 'Nuke', winner: 'HAVU' }));
const json = JSON.stringify({ total_matching: 40, shown: 40, rounds: rows, title: 'Outline: HAVU on Nuke', text: `HAVU: Nuke\nT Tells\n${'A long point about Garage flashes and A main molotovs. '.repeat(3)}\nCT Positions\n`.repeat(30) });
const short = shortenResult(json);
const [body, note] = short.split('\n[shortened');
const parsed = JSON.parse(body);
assert.equal(parsed.total_matching, 40);
assert.equal(parsed.title, 'Outline: HAVU on Nuke');
assert.equal(parsed.rounds.length, 4);
assert.match(parsed.rounds[3], /37 more \(40 in all\)/);
assert.match(parsed.text, /T Tells/);
assert.doesNotMatch(parsed.text, /A long point/);
assert.ok(note && short.length < json.length);

console.log('eyeContext.test.js ok');
