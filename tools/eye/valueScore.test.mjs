// Run: node tools/eye/valueScore.test.mjs
//
// The grading of value-eval runs (valueScore.mjs) and the loop that produces
// them (evalLoop.mjs), with scripted models and made-up tool results.

import assert from 'node:assert/strict';

import { runCase } from './evalLoop.mjs';
import { classifyTake, clocksIn, groundingOf, inventedClocks, scoreCase, summarise } from './valueScore.mjs';

// ---- grounding ----------------------------------------------------------------

const tool = '{"clock":"1:15","swing_pp":32.6,"win_chance":{"before":35,"after":67},"wpa_pp":-12.4}';
let g = groundingOf('At 1:15 CT went from 35% to 67% (+32.6 points).', [tool]);
assert.deepEqual(g.ungrounded, [], 'copied numbers are grounded');
g = groundingOf('It moved about 33 points.', [tool]);
assert.deepEqual(g.ungrounded, [], 'a whole number a tool decimal rounds to is allowed');
assert.deepEqual(g.strictUngrounded, ['33'], '...but counted as rounded');
g = groundingOf('CT went from 35% to 71%.', [tool]);
assert.deepEqual(g.ungrounded, ['71'], 'an invented number is caught');
g = groundingOf('1. First point\n2. Second point\n- third', [tool]);
assert.deepEqual(g.ungrounded, [], 'list markers are not numbers');
g = groundingOf('He had -12.4 points.', [tool]);
assert.deepEqual(g.ungrounded, [], 'a sign is not part of the number');
g = groundingOf('It cost 36.0 points, then 15.', ['{"wpa_pp":36,"x":15.0}']);
assert.deepEqual(g.ungrounded, [], 'the same number written as 36.0 or 15 is grounded');
g = groundingOf('35 was it.', ['{"x":135}']);
assert.deepEqual(g.ungrounded, ['35'], '35 is not inside 135');
g = groundingOf('Round 7 on Anubis.', [], 'Round 7 (Anubis)');
assert.deepEqual(g.ungrounded, [], 'numbers in the question count');

assert.deepEqual([...clocksIn('at 1:15 and 0:41 and 01:02')].sort(), ['0:41', '1:02', '1:15']);
assert.deepEqual(inventedClocks('At 1:15 and 0:50.', [tool]), ['0:50']);

// ---- the verdict on a death --------------------------------------------------

assert.equal(classifyTake('jcobbb was behind from the start: 9% to win the fight when it opened.'), 'behind');
assert.equal(classifyTake('No. jcobbb was the favourite at 66%. Losing that is variance, not a mistake.'), 'favoured');
assert.equal(classifyTake('Not clearly. The fight was close: 42% when it opened.'), 'close');
assert.equal(classifyTake('It happened at 1:15.'), null);

// ---- scoring a run -----------------------------------------------------------

const round = 'r-1';
const result = JSON.stringify({ biggest_swings: [{ clock: '1:15', swing_pp: 32.6 }, { clock: '1:01', swing_pp: 29.7 }, { clock: '0:41', swing_pp: 31.2 }], players: [{ player: 'Ro1f' }, { player: 'jcobbb' }] });
const call = (name = 'round_value', args = { round }) => ({ name, args, result });
const decided = { kind: 'decided', round, question: 'What decided it?', truth: { swing_clocks: ['1:15', '1:01', '0:41'] } };

let s = scoreCase(decided, { calls: [call()], answer: 'It turned at 1:15 (+32.6), 1:01 (+29.7) and 0:41 (+31.2).' });
assert.equal(s.pass, true);
assert.equal(s.recall, 1);

s = scoreCase(decided, { calls: [call()], answer: 'It turned at 1:15 (+32.6).' });
assert.equal(s.recall, 1 / 3);
assert.equal(s.pass, false, 'naming one of three swings fails');

s = scoreCase(decided, { calls: [call('find_rounds', {})], answer: 'It turned at 1:15, 1:01 and 0:41.' });
assert.equal(s.tool_first, false);
assert.equal(s.wrong_tools, 1);
assert.equal(s.pass, false);

s = scoreCase(decided, { calls: [call('round_value', { round: 'other' })], answer: 'It turned at 1:15, 1:01 and 0:41.' });
assert.equal(s.args_ok, false, 'the wrong round is a failure');

s = scoreCase(decided, { calls: [call()], answer: 'It turned at 1:15, 1:01 and 0:41, by 77 points.' });
assert.equal(s.grounded, false);
assert.deepEqual(s.ungrounded_numbers, ['77']);
assert.equal(s.pass, false, 'an invented number fails even with full recall');

s = scoreCase(decided, { calls: [call()], answer: 'It turned at 1:15, 1:01, 0:41 and 0:20.' });
assert.deepEqual(s.invented_clocks, ['0:20']);
assert.equal(s.pass, false, 'an invented clock fails');

s = scoreCase(decided, { calls: [], answer: 'It turned at 1:15, 1:01 and 0:41.' });
assert.equal(s.pass, false, 'no tool call at all fails');

s = scoreCase(decided, { calls: [call()], answer: '', error: 'the model server answered 500' });
assert.equal(s.pass, false);

const players = { kind: 'players', round, question: 'Best?', truth: { best: 'Ro1f', worst: 'jcobbb' } };
assert.equal(scoreCase(players, { calls: [call()], answer: 'Ro1f had the best round. jcobbb had the worst.' }).pass, true);
assert.equal(scoreCase(players, { calls: [call()], answer: 'jcobbb had the worst round. Ro1f had the best.' }).pass, false, 'worst before best is a swap');

const take = { kind: 'take', round, question: 'Was it a bad take?', truth: { verdict: 'favoured' } };
s = scoreCase(take, { calls: [call()], answer: 'No. The favourite lost, which is variance.' });
assert.equal(s.verdict, 'favoured');
assert.equal(s.pass, true);
assert.equal(scoreCase(take, { calls: [call()], answer: 'Yes, behind from the start.' }).pass, false);

const wrong = { kind: 'wrong', round, question: 'What went wrong?', truth: { flag_clocks: ['1:15', '0:41'], hit_clocks: ['1:01'] } };
assert.equal(scoreCase(wrong, { calls: [call()], answer: 'At 1:15 and 0:41.' }).pass, true, 'two of three is half or better');
assert.equal(scoreCase(wrong, { calls: [call()], answer: 'Nothing at 1:01.' }).pass, false, 'one of three is not');
const noFlags = { ...wrong, truth: { flag_clocks: [], hit_clocks: ['1:01', '0:41'] } };
assert.equal(scoreCase(noFlags, { calls: [call()], answer: 'It went wrong at 1:01 and 0:41.' }).pass, true, 'with nothing flagged, the hits are what to find');
assert.equal(scoreCase(noFlags, { calls: [call()], answer: 'They lost the round.' }).pass, false, 'a vague answer does not pass');

const sum = summarise([scoreCase(decided, { calls: [call()], answer: 'It turned at 1:15, 1:01 and 0:41.' }), scoreCase(decided, { calls: [], answer: 'x' })]);
assert.equal(sum.overall.cases, 2);
assert.equal(sum.overall.pass, 0.5);
assert.equal(sum.by_kind.decided.tool_first, 0.5);

// ---- the loop ----------------------------------------------------------------

const tc = (name, args) => ({ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const scripted = (replies) => {
  const seen = [];
  let i = 0;
  return { seen, callModel: async (messages) => (seen.push(messages.length), replies[Math.min(i++, replies.length - 1)]) };
};
const deps = (callModel, ran = []) => ({
  callModel,
  runTool: async (name, args) => (ran.push([name, args]), `result of ${name}`),
  tools: [],
  systemPrompt: 'sys'
});

// Tool call, result handed back, then the answer; a reasoning block is stripped.
let ran = [];
let m = scripted([{ tool_calls: [tc('round_value', { round })] }, { content: '<think>hmm</think>Done at 1:15.' }]);
let r = await runCase(decided, deps(m.callModel, ran));
assert.equal(r.answer, 'Done at 1:15.');
assert.deepEqual(ran, [['round_value', { round }]]);
assert.deepEqual(r.calls.map((c) => c.result), ['result of round_value']);
assert.deepEqual(m.seen, [2, 4], 'the model saw the tool call and its result on the second step');
assert.equal(r.messages.at(-2).role, 'tool');

// Arguments that are not JSON are handed back as an error, not run.
ran = [];
m = scripted([{ tool_calls: [tc('round_value', '{not json')] }, { tool_calls: [tc('round_value', { round })] }, { content: 'ok' }]);
r = await runCase(decided, deps(m.callModel, ran));
assert.equal(ran.length, 1, 'only the valid call ran');
assert.match(r.calls[0].result, /not valid JSON/);
assert.equal(r.answer, 'ok');

// A model that never stops calling tools is made to answer on the last step, and that step's calls are dropped.
ran = [];
m = scripted([{ tool_calls: [tc('round_value', { round })] }, { tool_calls: [tc('round_value', { round })], content: 'forced answer' }]);
r = await runCase(decided, { ...deps(m.callModel, ran), maxSteps: 2 });
assert.equal(r.answer, 'forced answer');
assert.equal(ran.length, 1);
assert.equal(r.steps, 2);

// A tool that read a mangled id as the right round: on the round, but not an exact copy.
m = scripted([{ tool_calls: [tc('round_value', { round: 'r-1-mangled' })] }, { content: 'It turned at 1:15, 1:01 and 0:41.' }]);
r = await runCase(decided, { ...deps(m.callModel), runTool: async () => ({ content: result, resolved: round }) });
assert.equal(r.calls[0].resolved, round);
s = scoreCase(decided, r);
assert.equal(s.args_ok, true, 'a repaired id is the right round');
assert.equal(s.exact_ids, false, '...but not an exact copy');
assert.equal(s.pass, true);

// A model that fails mid-run is an error, not a crash.
r = await runCase(decided, deps(async () => { throw new Error('boom'); }));
assert.equal(r.error, 'boom');
assert.equal(scoreCase(decided, r).pass, false);

console.log('valueScore.test.js: ok');
