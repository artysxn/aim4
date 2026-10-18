// Run: node src/replays/eye/eyeAgent.test.js
//
// The agent loop with a scripted model (a fake /api/eye/chat): a call that
// fails the same way twice is not run a third time, a cut-off tool call is
// answered with a way forward, and a turn never ends without an answer.

import assert from 'node:assert/strict';
import { attemptKey, fallbackAnswer, runAgentTurn } from './eyeAgent.js';

// ---- attemptKey: short plain arguments only ----
assert.equal(
  attemptKey('rewrite_antistrat_document', { title: 'A', sections: [{ heading: 'x' }], mode: 'copy' }),
  attemptKey('rewrite_antistrat_document', { mode: 'copy', title: 'A', sections: [{ heading: 'y', points: ['2'] }] }),
  'a reworded list is the same attempt'
);
assert.notEqual(attemptKey('review_antistrat_document', { title: 'A' }), attemptKey('review_antistrat_document', { title: 'B' }));
assert.equal(attemptKey('find_rounds', { team: 'HAVU', limit: 5 }), attemptKey('find_rounds', { team: 'HAVU', limit: 30 }), 'limit is not part of it');

// ---- fallbackAnswer ----
assert.match(fallbackAnswer(3, 'Reviewed "x"'), /ran 3 tool calls.*last step was: Reviewed "x"/);
assert.match(fallbackAnswer(0, ''), /did not reach an answer/);

// ---- a scripted model ----
const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const callChunk = (id, name, args, finish) => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] },
  { choices: [{ delta: {}, finish_reason: finish || 'tool_calls' }] }
];
const textChunk = (text) => [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];

/** Runs a turn against replies given in order; returns the final messages, events and what the model was sent. */
async function turn(replies) {
  const sent = [];
  let i = 0;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).messages);
    assert.equal(JSON.parse(init.body).chat_template_kwargs?.enable_thinking, true, 'every request reasons');
    const next = replies[Math.min(i++, replies.length - 1)];
    return new Response(sse(next), { status: 200 });
  };
  const messages = [{ role: 'user', content: 'review it' }];
  const events = [];
  const answer = await runAgentTurn(messages, { onEvent: (e) => events.push(e) });
  return { messages, events, sent, answer };
}

// B3 / C14: a failing tool. Unknown tool = a ToolError ("Error: There is no tool called ...").
// A call that changes its arguments (another section) still runs: in the 17 Oct chat every
// later rewrite was blocked after two refusals, even ones that would have worked.
// After TOOL_ERROR_LIMIT failures of one tool in a turn, it is not run again.
const { TOOL_ERROR_LIMIT } = await import('./eyeAgent.js');
let r = await turn([
  ...Array.from({ length: TOOL_ERROR_LIMIT + 1 }, (_, k) => callChunk(`c${k}`, 'no_such_tool', JSON.stringify({ title: 'A', sections: [String(k)] }))),
  textChunk('It kept failing; please check the document yourself.')
]);
let tools = r.messages.filter((m) => m.role === 'tool');
assert.equal(tools.length, TOOL_ERROR_LIMIT + 1);
assert.match(tools[0].content, /^Error: There is no tool called/);
assert.doesNotMatch(tools[0].content, /same error a second time/);
assert.match(tools[1].content, /same error a second time.*Change exactly what it names/s, 'the second failure says what to change');
assert.match(tools[2].content, /^Error: There is no tool called/, 'a call with other arguments still runs');
assert.match(tools[TOOL_ERROR_LIMIT].content, new RegExp(`failed ${TOOL_ERROR_LIMIT} times this turn.*not run again`), 'stopped after the limit');
assert.match(r.answer, /check the document yourself/);

// Narration written before a tool call is kept for the user, but not sent back to the model.
{
  const first = await turn([
    [{ choices: [{ delta: { content: 'Let me think. Wait, actually...' } }] }, ...callChunk('c1', 'no_such_tool', '{"title":"Q"}')],
    textChunk('done')
  ]);
  const second = first.sent[1];
  const narrated = second.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(narrated.content, '', 'the model does not read its own plan again');
  assert.equal(first.messages.find((m) => m.role === 'assistant' && m.tool_calls).content, 'Let me think. Wait, actually...', 'the chat keeps it');
}

// The identical call again gets the failure back, not a claim that its answer is above.
r = await turn([callChunk('c1', 'no_such_tool', '{"title":"A"}'), callChunk('c2', 'no_such_tool', '{"title":"A"}'), textChunk('stop')]);
tools = r.messages.filter((m) => m.role === 'tool');
assert.match(tools[1].content, /already failed this turn.*no tool called/);

// A different title is a different attempt: not blocked.
r = await turn([
  callChunk('c1', 'no_such_tool', '{"title":"A"}'),
  callChunk('c2', 'no_such_tool', '{"title":"B"}'),
  callChunk('c3', 'no_such_tool', '{"title":"C"}'),
  textChunk('done')
]);
tools = r.messages.filter((m) => m.role === 'tool');
assert.ok(tools.every((t) => /^Error: There is no tool called/.test(t.content)), 'three different calls all run');

// B4: arguments cut off mid-JSON. The reply says why and how to send less.
r = await turn([callChunk('c1', 'rewrite_antistrat_document', '{"title":"A","sections":[{"heading":"T Tells","points":["a', 'length'), textChunk('ok')]);
tools = r.messages.filter((m) => m.role === 'tool');
assert.match(tools[0].content, /not valid JSON \(your reply ran out of room and was cut off\)/);
assert.match(tools[0].content, /final false/);

// B5: an empty reply after a tool result still ends with something readable.
r = await turn([callChunk('c1', 'no_such_tool', '{}'), textChunk('')]);
assert.match(r.answer, /ran 1 tool call.*did not reach an answer/);
assert.equal(r.messages.at(-1).role, 'assistant');
assert.equal(r.messages.at(-1).content, r.answer);
assert.ok(r.events.some((e) => e.type === 'text' && e.text === r.answer), 'the user sees it');
assert.equal(r.events.at(-1).type, 'done');

// B5: the model keeps asking for tools until the steps run out: the turn still closes with an answer.
const { MAX_STEPS } = await import('./eyeAgent.js');
r = await turn(Array.from({ length: MAX_STEPS + 2 }, (_, k) => callChunk(`c${k}`, 'no_such_tool', JSON.stringify({ title: `t${k}` }))));
assert.ok(r.answer.length > 0, 'a final answer exists');
assert.equal(r.events.at(-1).type, 'done');

// A bigger limit is new information only when the earlier answer was partial.
{
  const { shownIn } = await import('./eyeAgent.js');
  assert.equal(shownIn('{"total_matching":20,"shown":12,"rounds":[]}'), 12, 'partial: a bigger limit may run');
  assert.equal(shownIn('{"total_matching":20,"shown":20}'), Infinity, 'complete: a bigger limit returns nothing new');
  assert.equal(shownIn('{"total_matching":"400+ (the search stops at 400 rounds)","shown":12}'), 12);
  assert.equal(shownIn('{"rows_total":5,"rows":[1,2,3,4,5]}'), Infinity);
  assert.equal(shownIn('{"rows_total":50,"rows":[1,2]}'), 2);
  assert.equal(shownIn('Error: nope'), Infinity);
}

// Stuck: repeated calls that are refused end the turn with an answer, not 19 more tries.
{
  const { STUCK_LIMIT } = await import('./eyeAgent.js');
  const same = (k) => callChunk(`s${k}`, 'no_such_tool', '{"title":"X"}');
  const r2 = await turn([...Array.from({ length: STUCK_LIMIT + 1 }, (_, k) => same(k)), same(99), textChunk('')]);
  const lastSent = r2.sent.at(-1);
  assert.match(lastSent.at(-1).content, /repeated earlier ones and returned nothing new/, 'the model is told it is stuck');
  assert.equal(r2.sent.length, STUCK_LIMIT + 2, 'one answer step after the limit, no more tool steps');
  assert.ok(r2.answer.length > 0);
}

// The model's context overflows (llama-server's 400): shorten everything and retry once,
// instead of failing this question and every one after it.
{
  const { isOverflow } = await import('./eyeAgent.js');
  assert.ok(isOverflow(new Error('http://127.0.0.1:58699/v1/chat/completions: status code 400')));
  assert.ok(!isOverflow(new Error('aim4 eye could not answer (502).')));
  const sent = [];
  let n = 0;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).messages);
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: 'http://127.0.0.1:58699/v1/chat/completions: status code 400' }), { status: 502 });
    return new Response(sse(textChunk('HAVU, 5 of 7.')), { status: 200 });
  };
  // A question after a failed one: the failed turn's 11 big results are still in the history.
  const messages = [
    { role: 'user', content: 'best B executes on Inferno?' },
    { role: 'assistant', content: '', tool_calls: Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, type: 'function', function: { name: 'antistrat_summary', arguments: '{}' } })) },
    ...Array.from({ length: 11 }, (_, i) => ({ role: 'tool', tool_call_id: `a${i}`, content: `{"team":"T${i}","sheet":"${'z'.repeat(11000)}"}` })),
    { role: 'user', content: 'Okay, nevermind. Find any random B execute round.' }
  ];
  const answer = await runAgentTurn(messages, {});
  assert.equal(answer, 'HAVU, 5 of 7.');
  const size = (msgs) => msgs.reduce((s, m) => s + String(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length, 0);
  assert.ok(size(sent[0]) < 80000, `the first request is already shortened (${size(sent[0])} chars): the failed turn's results are old history`);
  assert.ok(size(sent[1]) <= size(sent[0]), 'the retry is no bigger');
  const shortened = messages.filter((m) => m.role === 'tool' && m.compacted);
  assert.ok(shortened.length >= 6, `most of the failed turn's results are shortened (${shortened.length})`);
  assert.ok(shortened.every((m) => m.full.length > 11000), 'originals kept for the export');
}

// /compact: one reply, no tools, the conversation as one plain message after the instructions.
{
  const { summarizeChat } = await import('./eyeAgent.js');
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(sse([{ choices: [{ delta: { content: '  HAVU lose A fights.  ' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 });
  };
  const summary = await summarizeChat('USER: weaknesses?\nASSISTANT: A fights.', 'Write a summary.');
  assert.equal(summary, 'HAVU lose A fights.');
  assert.equal(body.tools, undefined, 'no tools are offered');
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user'], 'the system message is first and alone');
  assert.match(body.messages[1].content, /USER: weaknesses\?/);
  // A very long chat keeps its end.
  await summarizeChat(`START${'x'.repeat(30000)}END`, 'Write a summary.');
  assert.match(body.messages[1].content, /\[earlier part cut\]/);
  assert.match(body.messages[1].content, /END$/);
  assert.doesNotMatch(body.messages[1].content, /START/);
}

console.log('eyeAgent.test.js ok');
