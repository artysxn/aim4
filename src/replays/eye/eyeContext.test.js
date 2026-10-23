// Run: node src/replays/eye/eyeContext.test.js
//
// Long eye conversations stay inside the model's context: the oldest tool
// results are shortened first, earlier questions before the current one, and
// the results the model is about to read never are. A shortened result is
// still readable: JSON keeps its shape, lists keep their first rows and length.

import assert from 'node:assert/strict';
import { compactHistory, modelMessages, shortenResult, sizeOf } from './eyeContext.js';

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

// Shortening has a floor: a long answer's old steps are folded into a line per call on its
// question. Big steps go first; small ones (a list of playlists, a confirmation) stay in view
// longer, and the latest step is kept.
{
  const playlists = JSON.stringify({ total: 2, playlists: [{ id: 'aa11', name: 'Anubis T Pistols', rounds: 4 }, { id: 'bb22', name: 'Inferno CT Pistols', rounds: 10 }] });
  const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const m = [
    { role: 'user', content: 'Write a note on every round of every playlist.' },
    call('l', 'list_playlists', {}),
    { role: 'tool', tool_call_id: 'l', content: playlists }
  ];
  for (let k = 0; k < 6; k++) {
    m.push(call(`b${k}`, 'round_briefs', { playlist: 'Anubis T Pistols', side: 'T', part: k + 1 }));
    m.push({ role: 'tool', tool_call_id: `b${k}`, content: JSON.stringify({ side: 'T', part: `${k + 1} of 6`, rounds: Array.from({ length: 4 }, (_, i) => ({ label: `r${i}`, shape: 'x'.repeat(1500) })) }) });
    m.push(call(`w${k}`, 'write_round_notes', { notes: [{ match: 'm1', number: k, text: 'Full A execute' }] }));
    m.push({ role: 'tool', tool_call_id: `w${k}`, content: 'Wrote 1 of 1 round notes. They show in the round viewer at their clock time.' });
  }
  compactHistory(m, 5000, 0);
  const total = m.reduce((n, x) => n + sizeOf(x), 0);
  assert.ok(total <= 5000, `it fits (${total})`);
  const briefs = m.filter((x) => x.role === 'tool' && x.tool_call_id.startsWith('b'));
  assert.ok(briefs.every((x) => x.compacted), 'shortened first');
  assert.ok(briefs.slice(0, 3).every((x) => x.stepFolded), `then the oldest briefs are folded (${briefs.filter((x) => x.stepFolded).length})`);
  assert.ok(!m.at(-1).stepFolded && !m.at(-2).stepFolded, 'the latest step is kept');
  assert.ok(!m[2].stepFolded, 'the small list of playlists stays in view while remnants go');
  assert.ok(m.filter((x) => x.role === 'tool' && x.tool_call_id.startsWith('w')).every((x) => !x.stepFolded), 'so do the confirmations');
  assert.match(m[0].progress, /^- round_briefs\(playlist "Anubis T Pistols", side "T", part 1\) -> side "T", part "1 of 6", 4 rounds: r0; r1; r2; r3/);
  const view = modelMessages(m);
  assert.match(view[0].content, /^Write a note on every round of every playlist\.\n\nDone so far on this question/);
  assert.ok(!view.some((x) => x.stepFolded || x.progress), 'panel fields stay out of the model view');
  const ids = view.flatMap((x) => (x.tool_calls || []).map((c) => c.id)).sort();
  assert.deepEqual(ids, view.filter((x) => x.role === 'tool').map((x) => x.tool_call_id).sort(), 'every call in view has its result');
  assert.equal(m.filter((x) => x.role === 'tool').length, 13, 'nothing is removed from the chat');
  // Tighter still: the small steps go too, the list last of all its question's lines.
  compactHistory(m, 2500, 0);
  assert.ok(m[2].stepFolded);
  assert.match(m[0].progress, /^- list_playlists\(\) -> total 2, 2 playlists: Anubis T Pistols \(aa11\); Inferno CT Pistols \(bb22\)\n/);
}

// Big results are shortened before small ones: a list the job works through stays whole the
// longest (21 Oct: the 15-playlist list cut to 3 rows, and the model guessed the 4th playlist's id).
{
  const list = JSON.stringify({ total: 15, playlists: Array.from({ length: 15 }, (_, i) => ({ id: `id${String(i).padStart(10, '0')}`, name: `Playlist ${i}`, rounds: 10 })) });
  assert.ok(list.length < 1800, 'the fixture list is small');
  const m = [
    { role: 'user', content: 'Notes on every playlist.' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'l', type: 'function', function: { name: 'list_playlists', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'l', content: list }
  ];
  for (let k = 0; k < 4; k++) {
    m.push({ role: 'assistant', content: '', tool_calls: [{ id: `b${k}`, type: 'function', function: { name: 'round_briefs', arguments: JSON.stringify({ playlist: `id${k}`, part: 1 }) } }] });
    m.push({ role: 'tool', tool_call_id: `b${k}`, content: JSON.stringify({ rounds: [{ label: `r${k}`, shape: 'x'.repeat(6000) }] }) });
  }
  compactHistory(m, 14000, 0);
  assert.ok(!m[2].compacted && !m[2].stepFolded, 'the list is whole');
  assert.equal(m[2].content, list);
  assert.ok(m.filter((x) => x.role === 'tool' && x.tool_call_id.startsWith('b')).slice(0, 2).every((x) => x.compacted), 'the old briefs are shortened');
}

// Making room for a few steps at once (the prompt cache survives longer) never shortens the latest
// step below what the real budget allows.
{
  const m = [{ role: 'user', content: 'q' }];
  for (let k = 0; k < 3; k++) {
    m.push({ role: 'assistant', content: '', tool_calls: [{ id: `s${k}`, type: 'function', function: { name: 'site_map', arguments: '{}' } }] });
    m.push({ role: 'tool', tool_call_id: `s${k}`, content: `${k}:${'z'.repeat(8000)}` });
  }
  compactHistory(m, 9000, 0, { latest: 12000 });
  assert.ok(m[2].stepFolded || m[2].compacted, 'old steps make room');
  assert.ok(!m.at(-1).compacted, 'the latest result is whole: it fits the real budget');
}

// A picture costs what the model pays for it, not the length of its base64 text; and a tool's
// picture turned to text by limitImages is not mistaken for a question.
{
  const shot = { role: 'user', content: [{ type: 'text', text: 'The picture from screenshot_round, as the tool result describes.' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'A'.repeat(200000)}` } }] };
  assert.ok(sizeOf(shot) < 4000, `a picture counts as its tokens (${sizeOf(shot)})`);
  const m = [
    { role: 'user', content: 'Where do they stand at 1:20?' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'p', type: 'function', function: { name: 'screenshot_round', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'p', content: 'x'.repeat(5000) },
    { role: 'user', content: 'The picture from screenshot_round, as the tool result describes.\n[The picture was removed to save space. Take it again if you need it.]' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'q', type: 'function', function: { name: 'site_map', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'q', content: 'y'.repeat(5000) }
  ];
  compactHistory(m, 1200, 0);
  assert.ok(m[3].stepFolded, 'the picture goes with its step');
  assert.match(m[0].progress, /screenshot_round/);
  assert.ok(!m[3].progress);
}

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
