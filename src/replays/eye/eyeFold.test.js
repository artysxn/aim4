// Run: node src/replays/eye/eyeFold.test.js
//
// Long chats: once the earlier questions pass FOLD_AT, the oldest are folded into
// a memory the model writes. The messages stay (screen, export, saved chat), the
// model reads the memory instead, recall_earlier reads one back, and a 30-question
// chat against a model with a fixed context never overflows.

import assert from 'node:assert/strict';
import { foldEarlier, runAgentTurn } from './eyeAgent.js';
import { exportJson } from './eyeCommands.js';
import {
  CHARS_PER_TOKEN,
  FOLD_AT,
  HISTORY_BUDGET,
  KEEP_RECENT,
  MODEL_CONTEXT,
  OUTPUT_TOKENS,
  TEMPLATE_TOKENS,
  THINK_MIN_TOKENS,
  compactHistory,
  digestOf,
  foldPoint,
  leastSize,
  memoryOf,
  modelMessages,
  recallEarlier,
  sizeOf
} from './eyeContext.js';

const big = (n, tag) => JSON.stringify({ rows: Array.from({ length: n }, (_, i) => ({ round: i + 1, note: `${tag} row ${i} `.repeat(6) })), total: n });
const rewriteArgs = JSON.stringify({ title: 'HAVU Nuke', sections: Array.from({ length: 12 }, (_, i) => ({ heading: `S${i}`, points: ['a long point about outside smokes and ramp control '.repeat(4)] })) });

/** One finished question as the agent leaves it: question, a call, its result, the answer. */
function pushTurn(messages, k) {
  messages.push({ role: 'user', content: `Question ${k} about HAVU`, ui: { text: `Question ${k} about HAVU`, chips: [] } });
  messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `q${k}`, type: 'function', function: { name: 'rewrite_antistrat_document', arguments: rewriteArgs } }] });
  messages.push({ role: 'tool', tool_call_id: `q${k}`, content: big(60, `q${k}`) });
  messages.push({ role: 'assistant', content: `Answer ${k}: HAVU go B in ${k} of 20 rounds. `.repeat(20) });
}

// ---- foldPoint ----
{
  const m = [];
  for (let k = 1; k <= 3; k++) pushTurn(m, k);
  m.push({ role: 'user', content: 'now', ui: { text: 'now' } });
  assert.equal(foldPoint(m, m.length - 1), -1, 'a short chat is not folded');
  assert.equal(foldPoint(m, m.length - 1, { force: true }), m.length - 1, 'force folds every earlier question');
}
{
  const m = [];
  for (let k = 1; k <= 12; k++) pushTurn(m, k);
  m.push({ role: 'user', content: 'now', ui: { text: 'now' } });
  const turnStart = m.length - 1;
  // Measured the way foldPoint measures: what the questions cost with their steps folded.
  assert.ok(leastSize(m, 0, turnStart) > FOLD_AT, 'the fixture is past the fold line');
  const cut = foldPoint(m, turnStart);
  assert.ok(cut > 0 && m[cut].role === 'user', 'the cut is at a question');
  assert.ok(cut <= turnStart - 4, 'the newest earlier question is kept');
  const kept = leastSize(m, cut, turnStart);
  assert.ok(kept <= KEEP_RECENT || cut === turnStart - 4, 'kept turns fit KEEP_RECENT');

  // ---- foldEarlier with a model summary ----
  const asks = [];
  const events = [];
  const n = await foldEarlier(m, turnStart, { onEvent: (e) => events.push(e.type), summarize: async (text) => (asks.push(text), 'Q1-Q9: HAVU on Nuke, B heavy.') });
  const asked = asks.join('\n');
  assert.doesNotMatch(asks[0], /EARLIER SUMMARY/);
  assert.ok(n >= 2);
  assert.deepEqual(events, ['folding', 'folded']);
  assert.match(asked, /USER: Question 1 about HAVU/);
  assert.match(asked, /row 0/, 'the summary is written from the results whole, not the shortened ones');
  assert.equal(memoryOf(m), 'Q1-Q9: HAVU on Nuke, B heavy.');
  assert.equal(m.length, 12 * 4 + 1, 'no message is removed');
  const view = modelMessages(m);
  assert.equal(view[0].role, 'user');
  assert.match(view[1].content, /Summary of the earlier part.*Q1-Q9/s);
  assert.ok(!view.some((x) => x.folded || x.memory || x.ui), 'panel fields stay out of the model view');
  assert.equal(view.filter((x) => x.role === 'user' && /^Question/.test(x.content)).length, (turnStart - cut) / 4, 'only the kept questions are sent');

  // A second fold merges the first memory.
  for (let k = 13; k <= 24; k++) pushTurn(m, k);
  m.push({ role: 'user', content: 'again', ui: { text: 'again' } });
  asks.length = 0;
  await foldEarlier(m, m.length - 1, { summarize: async (text) => (asks.push(text), 'merged') });
  assert.match(asks[0], /^EARLIER SUMMARY:\nQ1-Q9/);
  assert.equal(memoryOf(m), 'merged');

  // ---- recall_earlier ----
  const list = JSON.parse(recallEarlier(m, {}));
  assert.ok(list.folded_questions.length >= 10);
  assert.equal(list.folded_questions[0].asked, 'Question 1 about HAVU');
  const one = JSON.parse(recallEarlier(m, { question: 2 }));
  assert.equal(one.question, 'Question 2 about HAVU');
  assert.match(one.answer, /^Answer 2/);
  assert.equal(one.tools[0].tool, 'rewrite_antistrat_document');
  assert.ok(JSON.stringify(one).length <= 8000);
  assert.match(recallEarlier(m, { question: 99 }), /^Error: there are \d+ folded questions/);
  assert.match(recallEarlier([{ role: 'user', content: 'hi' }], {}), /Nothing has been folded/);

  // ---- export and saved chat keep everything ----
  const json = JSON.parse(exportJson({ messages: m, meta: {} }));
  assert.equal(json.messages.length, m.length);
}

// ---- a big fold is summarised in batches, oldest first, nothing cut ----
{
  const m = [];
  for (let k = 1; k <= 14; k++) {
    pushTurn(m, k);
    m[m.length - 1].content = `Answer ${k}: ${'a long answer about HAVU defaults and the B split '.repeat(80)}`;
  }
  m.push({ role: 'user', content: 'now', ui: { text: 'now' } });
  const asks = [];
  await foldEarlier(m, m.length - 1, { summarize: async (text) => (asks.push(text), `memory ${asks.length}`) });
  assert.ok(asks.length >= 2, 'a big fold is summarised in batches');
  assert.match(asks[0], /USER: Question 1 about HAVU/, 'the oldest question goes first');
  assert.doesNotMatch(asks[0], /EARLIER SUMMARY/);
  assert.ok(asks.slice(1).every((a, i) => a.startsWith(`EARLIER SUMMARY:\nmemory ${i + 1}`)), 'each batch merges the memory so far');
  assert.ok(asks.every((a) => a.length <= 22100), 'each request fits');
  assert.doesNotMatch(asks.join('\n'), /\[start cut\]/, 'nothing is cut');
  assert.equal(memoryOf(m), `memory ${asks.length}`);
}

// ---- the model cannot summarise: a plain digest stands in ----
{
  const m = [];
  for (let k = 1; k <= 12; k++) pushTurn(m, k);
  m.push({ role: 'user', content: 'now', ui: { text: 'now' } });
  await foldEarlier(m, m.length - 1, {
    summarize: async () => {
      throw new Error('400');
    }
  });
  assert.match(memoryOf(m), /- Asked: Question 1 about HAVU\n {2}Answered: Answer 1/);
  assert.ok(digestOf('x'.repeat(5000), []).length <= 4000, 'the digest is capped');
}

// ---- old call arguments are shortened like results, and restored for export ----
{
  const m = [];
  for (let k = 1; k <= 6; k++) pushTurn(m, k);
  m.push({ role: 'user', content: 'now', ui: { text: 'now' } });
  compactHistory(m, 8000, m.length - 1);
  const call = m[1];
  assert.ok(call.callsCompacted);
  assert.ok(call.tool_calls[0].function.arguments.length < rewriteArgs.length);
  JSON.parse(call.tool_calls[0].function.arguments); // still valid JSON for the chat template
  assert.equal(JSON.parse(exportJson({ messages: m, meta: {} })).messages[1].tool_calls[0].function.arguments, rewriteArgs);
}

// ---- 30 questions against a model with a fixed context ----
// The fake model counts tokens the way the model's tokenizer was measured (CHARS_PER_TOKEN)
// and refuses (400) any request that leaves the reply less than its room. Each question
// calls a tool once (recall_earlier, answered here) and answers; between questions
// the history grows by the size real questions do (a rewrite call, a big result).
{
  const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const tokensOf = (body) => {
    const [system, ...rest] = body.messages;
    return (String(system.content).length + JSON.stringify(body.tools || []).length) / CHARS_PER_TOKEN.prompt + TEMPLATE_TOKENS + rest.reduce((n, m) => n + sizeOf(m), 0) / CHARS_PER_TOKEN.history;
  };
  const LIMIT = MODEL_CONTEXT - OUTPUT_TOKENS - THINK_MIN_TOKENS;
  let biggest = 0;
  let overflows = 0;
  let summaries = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const tokens = tokensOf(body);
    if (tokens > LIMIT) {
      overflows++;
      return new Response(JSON.stringify({ error: `request (${Math.round(tokens)} tokens) exceeds the available context size` }), { status: 400 });
    }
    biggest = Math.max(biggest, tokens);
    if (!body.tools) {
      summaries++;
      assert.equal(body.chat_template_kwargs.enable_thinking, false, 'a summary does not reason');
      assert.ok(body.max_tokens > 0 && body.max_tokens <= 2000, 'a summary has a token cap');
      return new Response(sse([{ choices: [{ delta: { content: `Memory after ${summaries} folds.` } }] }]), { status: 200 });
    }
    const last = body.messages.at(-1);
    const reply =
      last.role === 'user'
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `r${body.messages.length}`, function: { name: 'recall_earlier', arguments: '{}' } }] } }] }]
        : [{ choices: [{ delta: { content: 'Answer: HAVU go B. '.repeat(60) } }] }];
    return new Response(sse(reply), { status: 200 });
  };
  const messages = [];
  for (let q = 1; q <= 30; q++) {
    pushTurn(messages, `pre${q}`);
    messages.push({ role: 'user', content: `Live question ${q}`, ui: { text: `Live question ${q}` } });
    const answer = await runAgentTurn(messages, {});
    assert.match(answer, /^Answer: HAVU go B/, `question ${q} is answered`);
  }
  assert.equal(overflows, 0, 'no request overflowed');
  assert.ok(summaries >= 3, 'the chat was folded more than once');
  assert.ok(biggest <= LIMIT, `the biggest request (${Math.round(biggest)} tokens) leaves the reply its room`);
  assert.equal(messages.filter((m) => m.ui).length, 60, 'every question is still in the chat');
  const view = modelMessages(messages).reduce((n, m) => n + JSON.stringify(m).length, 0);
  assert.ok(view < FOLD_AT + HISTORY_BUDGET, 'the model view stays bounded');
}

console.log('eyeFold.test.js ok');
