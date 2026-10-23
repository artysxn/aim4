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
    const body = JSON.parse(init.body);
    sent.push(body.messages);
    // Every request reasons, except a forced last answer and the retry of a reply that thought too long or said nothing.
    if (body.chat_template_kwargs?.enable_thinking !== true) {
      assert.match(String(body.messages.at(-1).content), /Answer now|planned enough|nothing new/, 'reasoning is off only for a forced answer or a retry');
    }
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

// B4: arguments cut off mid-JSON. The step is asked again with more room first (the 21 Oct
// 15-playlist job ran into the end of the context mid-call); only a reply still cut off with the
// least history is answered with why and how to send less.
const cut = callChunk('c1', 'rewrite_antistrat_document', '{"title":"A","sections":[{"heading":"T Tells","points":["a', 'length');
r = await turn([cut, cut, cut, textChunk('ok')]);
tools = r.messages.filter((m) => m.role === 'tool');
assert.match(tools[0].content, /not valid JSON \(your reply ran out of room and was cut off\)/);
assert.match(tools[0].content, /final false/);
assert.equal(r.events.filter((e) => e.type === 'retry' && e.reason === 'room').length, 2, 'asked twice more, with less room each time');
assert.equal(r.sent.length, 4);
// Once more with room is usually enough: the call goes through and the model never sees an error.
r = await turn([cut, callChunk('c2', 'site_map', '{}'), textChunk('Here are the pages.')]);
assert.equal(r.answer, 'Here are the pages.');
assert.ok(!r.messages.some((m) => m.role === 'tool' && /not valid JSON/.test(m.content)), 'no error reaches the model');
assert.ok(r.events.some((e) => e.type === 'retry' && e.reason === 'room'));
// A stream that just ends mid-call (no finish reason) is the same: that is how the app passed on llama-server's error.
r = await turn([[{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c3', function: { name: 'site_map', arguments: '{"page":"de' } }] } }] }], callChunk('c4', 'site_map', '{}'), textChunk('done')]);
assert.ok(r.events.some((e) => e.type === 'retry' && e.reason === 'room'));
assert.equal(r.answer, 'done');
{
  const { isOverflow } = await import('./eyeAgent.js');
  assert.ok(isOverflow(new Error('Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 2')), "llama-server's error for a reply cut off by the context");
}
// llama-server's error after the stream began comes as a data event of its own ({"error": ...}). It is an
// error, asked again with more room, not an empty reply (21 Oct: two chats filled its cache at once, and
// the turn ended on "did not reach an answer").
{
  const full = [{ error: { code: 500, message: 'Context size has been exceeded.', type: 'server_error' } }];
  r = await turn([full, textChunk('Done: 6 notes written.')]);
  assert.equal(r.answer, 'Done: 6 notes written.');
  assert.ok(r.events.some((e) => e.type === 'retry' && e.reason === 'room'), 'asked again with room, not as an empty reply');
  assert.ok(!r.events.some((e) => e.type === 'retry' && e.reason === 'empty'));
}

// B5: an empty reply after a tool result still ends with something readable.
r = await turn([callChunk('c1', 'no_such_tool', '{}'), textChunk('')]);
assert.match(r.answer, /ran 1 tool call.*did not reach an answer/);
assert.ok(r.events.some((e) => e.type === 'retry' && e.reason === 'empty'), 'an empty reply is asked once more first');
assert.equal(r.sent.length, 3, 'once more, not again and again');
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
  // The forced answer, and (it came back empty) one retry of it: no more tool steps.
  assert.equal(r2.sent.length, STUCK_LIMIT + 3, 'one answer step after the limit, no more tool steps');
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

// Reasoning that runs away (the 18 Oct HAVU chat) is stopped and the step asked again, told to act, without reasoning.
{
  const { THINK_LIMIT, thinkingLoops } = await import('./eyeAgent.js');
  const think = (text) => [{ choices: [{ delta: { reasoning_content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  const r3 = await turn([think('x'.repeat(THINK_LIMIT + 10)), textChunk('HAVU win 11 of 11 B executes.')]);
  assert.equal(r3.answer, 'HAVU win 11 of 11 B executes.');
  assert.ok(r3.events.some((e) => e.type === 'retry' && e.reason === 'overthought'));
  assert.match(r3.sent[1].at(-1).content, /planned enough/);
  // Going round in circles is caught before the limit.
  const plan = 'I should call review_antistrat_document, then rewrite the notes section with the for_notes lines. ';
  assert.ok(thinkingLoops(plan.repeat(12)));
  assert.ok(!thinkingLoops(Array.from({ length: 40 }, (_, i) => `step ${i} reads another part of the review and counts point ${i * 7}. `).join('')));
}

// Going back and forth ("But wait" ... "Or maybe" ...) is stopped, and the plan made before it goes back with the retry.
{
  const { hedgesIn, planOf, HEDGE_LIMIT, SAMPLING } = await import('./eyeAgent.js');
  const dither = 'Ask: rewrite the notes. Do: review_antistrat_document with the id. But wait, the user said populate. Hmm, maybe team_documents first. Actually no. Or maybe query_rounds. Wait, the rule says review first. Let me re-check the rule. Alternatively rewrite directly. But wait, numbers. Oh wait, the review has them.';
  assert.ok(hedgesIn(dither).length > HEDGE_LIMIT);
  assert.equal(planOf(dither), 'Ask: rewrite the notes. Do: review_antistrat_document with the id. But wait, the user said populate.', 'the plan keeps the first doubt, not the rest');
  assert.equal(hedgesIn('Players wait at B, then they actually go A.').length, 0, 'wait and actually inside a sentence are not reopening anything');
  const think = (text) => [{ choices: [{ delta: { reasoning_content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
  const r5 = await turn([think(dither.repeat(2)), textChunk('Saved the notes.')]);
  assert.equal(r5.answer, 'Saved the notes.');
  assert.ok(r5.events.some((e) => e.type === 'retry' && e.why === 'hedging'));
  assert.match(r5.sent[1].at(-1).content, /Your plan, before you started going back and forth on it:[\s\S]*review_antistrat_document with the id[\s\S]*Carry it out now/);
  // Qwen's thinking-mode sampling, not the 0.3 that it warns loops.
  assert.deepEqual(SAMPLING.thinking, { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 });
}

// A model server that ends reasoning itself (the app's --reasoning-budget, told in its hello) lets the model
// finish and act in the same reply: the page does not stop it for going back and forth. Without one, it still does.
{
  const dither = 'Ask: next playlist. Do: round_briefs part 2. But wait, the notes. Hmm, maybe write first. Actually no. Or maybe list again. Wait, part 2. Let me re-check the rule. Alternatively both. But wait, room. Oh wait, the rule says one at a time. ';
  const replies = [
    [{ choices: [{ delta: { reasoning_content: dither.repeat(3) } }] }, ...callChunk('b1', 'site_map', '{"part":2}')],
    textChunk('Notes written.')
  ];
  const run = async (serverBudget) => {
    let i = 0;
    globalThis.fetch = async () => new Response(sse(replies[Math.min(i++, replies.length - 1)]), { status: 200 });
    const events = [];
    const messages = [{ role: 'user', content: 'Next playlist.' }];
    const answer = await runAgentTurn(messages, { onEvent: (e) => events.push(e), serverBudget });
    return { events, messages, answer };
  };
  const trusted = await run(1500);
  assert.ok(!trusted.events.some((e) => e.type === 'retry'), 'not stopped: the server bounds the reasoning');
  assert.ok(trusted.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'b1'), 'the planned call ran');
  assert.equal(trusted.answer, 'Notes written.');
  const own = await run(0);
  assert.ok(own.events.some((e) => e.type === 'retry' && e.why === 'hedging'), 'without a server budget the page stops it');
}

// Five pictures in one step filled the context (19 Oct Anubis chat): past MAX_SHOTS_PER_STEP they are not taken.
{
  const { MAX_SHOTS_PER_STEP } = await import('./eyeAgent.js');
  const shots = Array.from({ length: 4 }, (_, k) => ({ index: k, id: `p${k}`, function: { name: 'screenshot_round', arguments: JSON.stringify({ round: `r${k}`, clock: '1:20' }) } }));
  const r4 = await turn([[{ choices: [{ delta: { tool_calls: shots } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }], textChunk('done')]);
  const answers = r4.messages.filter((m) => m.role === 'tool');
  assert.equal(answers.length, 4);
  assert.ok(answers.slice(MAX_SHOTS_PER_STEP).every((m) => /^Not taken: at most 2 pictures/.test(m.content)));
  assert.ok(answers.slice(0, MAX_SHOTS_PER_STEP).every((m) => !/^Not taken/.test(m.content)));
}

// A long job (21 Oct: notes on 126 rounds in 15 playlists) stays inside the context for 45 steps of
// reads. The fake model counts tokens the way the model's tokenizer was measured and refuses any
// request that leaves the reply less than its room; old steps fold into a line per call on the question.
{
  const { CHARS_PER_TOKEN, MODEL_CONTEXT, OUTPUT_TOKENS, PROGRESS_HEADING, TEMPLATE_TOKENS, THINK_MIN_TOKENS, sizeOf } = await import('./eyeContext.js');
  const LIMIT = MODEL_CONTEXT - OUTPUT_TOKENS - THINK_MIN_TOKENS;
  const tokensOf = (body) => {
    const [system, ...rest] = body.messages;
    return (String(system.content).length + JSON.stringify(body.tools || []).length) / CHARS_PER_TOKEN.prompt + TEMPLATE_TOKENS + rest.reduce((n, m) => n + sizeOf(m), 0) / CHARS_PER_TOKEN.history;
  };
  const STEPS = 45;
  const reads = (step) => [
    { choices: [{ delta: { tool_calls: Array.from({ length: 6 }, (_, k) => ({ index: k, id: `s${step}_${k}`, function: { name: 'site_map', arguments: JSON.stringify({ part: `${step}.${k}` }) } })) } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ];
  const sent = [];
  let over = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (tokensOf(body) > LIMIT) {
      over++;
      return new Response(JSON.stringify({ error: 'request exceeds the available context size' }), { status: 400 });
    }
    sent.push(body.messages);
    return new Response(sse(sent.length <= STEPS ? reads(sent.length) : textChunk('All 15 playlists have their notes.')), { status: 200 });
  };
  const messages = [{ role: 'user', content: 'Write a note on every round of every playlist.' }];
  const answer = await runAgentTurn(messages, {});
  assert.equal(answer, 'All 15 playlists have their notes.');
  assert.equal(over, 0, 'no request ran past the room');
  assert.match(messages[0].progress, /^- site_map\(part "1\.0"\) -> 8 items\n/, 'folded steps are a line per call, oldest first');
  const view = sent.at(-1);
  assert.ok(view[1].content.startsWith('Write a note on every round') && view[1].content.includes(PROGRESS_HEADING), 'the model reads them on the question');
  // Every call the model is shown has its result, and every result its call.
  const ids = view.filter((m) => m.role === 'assistant').flatMap((m) => (m.tool_calls || []).map((c) => c.id));
  assert.deepEqual(ids.sort(), view.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort());
  assert.ok(ids.includes(`s${STEPS}_5`), 'the latest step is in view');
  assert.equal(messages.filter((m) => m.role === 'tool').length, STEPS * 6, 'every result stays in the chat for the screen and the export');
  // llama-server reads the prompt again from where it first differs from the last one (12 to 20 s at 20,000
  // tokens). Room is made a few steps at a time, so most steps only add to the end: 41 of 45 broke it before.
  const texts = sent.map((x) => JSON.stringify(x));
  let breaks = 0;
  for (let i = 1; i < texts.length; i++) {
    let k = 0;
    while (k < texts[i - 1].length && texts[i - 1][k] === texts[i][k]) k++;
    if (k < texts[i - 1].length * 0.8) breaks++;
  }
  assert.ok(breaks <= 20, `the prompt's start changes on few steps (${breaks} of ${texts.length - 1})`);
}

// One step that reads too much at once (six playlists' briefs on 21 Oct): past its share of the room,
// further reads wait for the next step, and a held call runs when it is made again.
{
  const many = [
    { choices: [{ delta: { tool_calls: Array.from({ length: 24 }, (_, k) => ({ index: k, id: `m${k}`, function: { name: 'site_map', arguments: JSON.stringify({ part: k }) } })) } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ];
  const r6 = await turn([many, callChunk('again', 'site_map', JSON.stringify({ part: 23 })), textChunk('done')]);
  const results = r6.messages.filter((m) => m.role === 'tool');
  const held = results.slice(0, 24).filter((m) => /^Not run yet/.test(m.content));
  assert.ok(held.length > 0 && held.length < 24, `some reads wait (${held.length} of 24)`);
  assert.ok(!/^Not run yet/.test(results[0].content), 'the first read always runs');
  assert.ok(/^Not run yet/.test(results[23].content));
  assert.ok(!/already made this exact call|Not run yet/.test(results[24].content), 'made again, it runs');
}

// The server's own token count (llama-server's usage) tunes the budget: a history denser than
// measured is given less room. A short history says too little to go by.
{
  const { calibrate, getCalibration } = await import('./eyeAgent.js');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(calibrate({ prompt_tokens: 15000 + 8000 }, 8000 * 2.2, 15000), 1), 'the estimate was right');
  assert.ok(near(calibrate({ prompt_tokens: 15000 + 12000 }, 8000 * 2.2, 15000), 1.5), 'denser than measured');
  assert.ok(near(calibrate({ prompt_tokens: 15500 }, 1000, 15000), 1.5), 'a short history leaves it as it was');
  assert.ok(near(calibrate({ prompt_tokens: 15000 + 80000 }, 8000 * 2.2, 15000), 1.6), 'kept within bounds');
  calibrate({ prompt_tokens: 15000 + 8000 }, 8000 * 2.2, 15000);
  assert.ok(near(getCalibration(), 1));
}

// Every reasoning step asks for the same, brief reasoning effort (Qwen3.8's template defaults to "xhigh",
// "consider plausible alternatives"); a reply without reasoning does not send it.
{
  const { REASONING_EFFORT } = await import('./eyeAgent.js');
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(sse(bodies.length === 1 ? callChunk('e1', 'site_map', '{}') : textChunk('Done.')), { status: 200 });
  };
  await runAgentTurn([{ role: 'user', content: 'pages?' }], {});
  assert.equal(REASONING_EFFORT, 'low');
  assert.ok(bodies.every((b) => b.chat_template_kwargs.enable_thinking === true && b.chat_template_kwargs.reasoning_effort === 'low'), 'the same effort on every step');
  bodies.length = 0;
  const { summarizeChat } = await import('./eyeAgent.js');
  await summarizeChat('USER: hi', 'Write a summary.');
  assert.equal(bodies[0].chat_template_kwargs.reasoning_effort, undefined, 'a summary does not reason, so it names no effort');
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
