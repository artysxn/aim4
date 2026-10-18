// ---------------------------------------------------------------------------
// tools/eye/valueScore.mjs
// How a model's answer to a value-eval case is scored. Pure functions, no
// model and no data, so the grading itself can be tested.
//
// A case (tools/eye/value-out/value-eval.jsonl) is a question about one round
// plus what the pricing models say is true. A run is what the model did with
// it: the tool calls it made and the answer it gave. Four things are graded:
//
//   tool choice    first call is round_value, on the right round (as the tool read
//                  it: a mangled id it repaired counts, and exact copies are
//                  reported apart), with a clock moment_value can read; calls to
//                  anything else are counted
//   grounding      every number in the answer is in a tool result (rounding to
//                  a whole number is allowed, inventing one is not), and every
//                  clock time it names is one the tools returned
//   swing recall   of the moments that moved the round most, how many it named
//   the verdict    best / worst player, whether a death was behind, close or
//                  favoured, which side's flagged moments it found
//
// A case passes when tool choice and grounding hold and its own check passes.
// ---------------------------------------------------------------------------

/** Tools the offline harness can run. Any other call is a wrong tool. */
export const VALUE_TOOLS = new Set(['round_value', 'moment_value']);

/** Share of the biggest swings an answer must name to pass "what decided it". */
export const RECALL_PASS = 2 / 3;

const CLOCK = /\b\d{1,2}:\d{2}\b/g;
const NUMBER = /\d+(?:\.\d+)?/g;

/** Clock times written in a text, as "m:ss". */
export function clocksIn(text) {
  return new Set((String(text).match(CLOCK) || []).map((c) => c.replace(/^0(?=\d:)/, '')));
}

/**
 * Numbers in `answer` that no tool result (or the question) contains.
 * Clock times are checked on their own, and list markers are not numbers.
 *
 * @returns {{ total: number, ungrounded: string[], strictUngrounded: string[] }}
 *   `ungrounded` allows a whole number that a tool decimal rounds to (31 for
 *   30.7); `strictUngrounded` does not.
 */
export function groundingOf(answer, toolTexts, question = '') {
  const source = `${toolTexts.join(' ')} ${question}`;
  const known = (source.replace(CLOCK, ' ').match(NUMBER) || []).map(Number);
  const text = String(answer)
    .replace(CLOCK, ' ')
    .replace(/^\s*(?:\d+[.)]|[-*])\s+/gm, '');
  const tokens = text.match(NUMBER) || [];
  const exact = (t) => new RegExp(`(?<![\\d.])${t.replace('.', '\\.')}(?!\\d)`).test(source);
  const ungrounded = [];
  const strictUngrounded = [];
  const knownValues = new Set(known);
  for (const t of tokens) {
    // "36.0" for a tool's 36 is the same number written differently.
    if (exact(t) || knownValues.has(Number(t))) continue;
    strictUngrounded.push(t);
    const n = Number(t);
    if (Number.isInteger(n) && known.some((k) => !Number.isInteger(k) && Math.round(k) === n)) continue;
    ungrounded.push(t);
  }
  return { total: tokens.length, ungrounded, strictUngrounded };
}

/** Clock times the answer names that appear in no tool result and not in the question. */
export function inventedClocks(answer, toolTexts, question = '') {
  const seen = clocksIn(`${toolTexts.join(' ')} ${question}`);
  return [...clocksIn(answer)].filter((c) => !seen.has(c));
}

/**
 * Which verdict a death answer gives, by the words it leans on.
 * Keyword voting; a tie is no verdict. Good enough to separate the three
 * readings, and it errs towards "no verdict", which scores as a miss.
 *
 * @returns {'behind'|'close'|'favoured'|null}
 */
export function classifyTake(answer) {
  const t = String(answer).toLowerCase();
  const votes = {
    favoured: [/\bvariance\b/, /\bfavou?rite\b/, /\bnot a mistake\b/, /^no\b/, /\bupset\b/],
    behind: [/\bbehind\b/, /\blosing fight\b/, /\bunderdog\b/, /\bbad take\b/, /\bfrom the start\b/, /^yes\b/],
    close: [/\bnot clearly\b/, /\bclose\b/, /\bcoin ?flip\b/, /\bevenly\b/, /\bjust as likely\b/]
  };
  const score = Object.fromEntries(Object.entries(votes).map(([k, res]) => [k, res.filter((re) => re.test(t)).length]));
  const best = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!best[0][1] || best[0][1] === best[1][1]) return null;
  return best[0][0];
}

const mention = (answer, name) => String(answer).toLowerCase().indexOf(String(name).toLowerCase());

/**
 * Grade one run.
 *
 * @param {object} evalCase  a line of value-eval.jsonl
 * @param {{ calls: Array<{ name: string, args: object, result?: string }>, answer: string, error?: string }} run
 */
export function scoreCase(evalCase, run) {
  const { kind, truth, round, question } = evalCase;
  const calls = run.calls || [];
  const answer = String(run.answer || '').trim();
  const toolTexts = calls.map((c) => c.result || '').filter(Boolean);

  const toolFirst = calls[0]?.name === 'round_value';
  const wrongTools = calls.filter((c) => !VALUE_TOOLS.has(c.name)).length;
  const valueCalls = calls.filter((c) => VALUE_TOOLS.has(c.name));
  // A call is on the right round when the tool read it as that round, which includes a mangled id the tool repaired.
  const onRound = (c) => (c.resolved ?? c.args?.round) === round;
  const argsOk = valueCalls.length > 0 && valueCalls.every((c) => onRound(c) && (c.name !== 'moment_value' || /^\d{1,2}:\d{2}$/.test(String(c.args?.clock ?? ''))));
  const exactIds = valueCalls.length > 0 && valueCalls.every((c) => c.args?.round === round);
  const usedMoment = calls.some((c) => c.name === 'moment_value');

  const grounding = groundingOf(answer, toolTexts, question);
  const invented = inventedClocks(answer, toolTexts, question);
  const grounded = grounding.ungrounded.length === 0 && invented.length === 0;

  const out = {
    kind,
    tool_first: toolFirst,
    args_ok: argsOk,
    exact_ids: exactIds,
    wrong_tools: wrongTools,
    used_moment_value: usedMoment,
    grounded,
    ungrounded_numbers: grounding.ungrounded,
    rounded_numbers: grounding.strictUngrounded.length - grounding.ungrounded.length,
    invented_clocks: invented,
    recall: null,
    verdict: null,
    check: false
  };

  if (kind === 'decided') {
    const want = truth.swing_clocks || [];
    const said = clocksIn(answer);
    const hit = want.filter((c) => said.has(c.replace(/^0(?=\d:)/, '')));
    out.recall = want.length ? hit.length / want.length : null;
    out.check = out.recall !== null && out.recall >= RECALL_PASS;
  } else if (kind === 'wrong') {
    // The loser's costliest flagged moments and the winner's hardest hits: name half of them.
    const want = [...new Set([...(truth.flag_clocks || []), ...(truth.hit_clocks || [])])];
    const said = clocksIn(answer);
    out.recall = want.length ? want.filter((c) => said.has(c)).length / want.length : null;
    out.check = out.recall !== null && out.recall >= 0.5;
  } else if (kind === 'players') {
    const b = mention(answer, truth.best);
    const w = mention(answer, truth.worst);
    // Both named, best first: the answer is built best-then-worst, and a swap is the failure to catch.
    out.check = b >= 0 && w >= 0 && b < w;
  } else if (kind === 'take') {
    out.verdict = classifyTake(answer);
    out.check = out.verdict === truth.verdict;
  }

  out.pass = Boolean(answer) && !run.error && toolFirst && argsOk && grounded && out.check;
  return out;
}

const rate = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Roll scored cases up into per-kind and overall rates. */
export function summarise(scored) {
  const group = (rows) => ({
    cases: rows.length,
    pass: rate(rows, (r) => r.pass),
    tool_first: rate(rows, (r) => r.tool_first),
    args_ok: rate(rows, (r) => r.args_ok),
    exact_ids: rate(rows, (r) => r.exact_ids),
    grounded: rate(rows, (r) => r.grounded),
    wrong_tool_calls: rows.reduce((a, r) => a + r.wrong_tools, 0),
    used_moment_value: rate(rows, (r) => r.used_moment_value),
    swing_recall: mean(rows.filter((r) => r.recall !== null).map((r) => r.recall)),
    check: rate(rows, (r) => r.check)
  });
  const kinds = [...new Set(scored.map((r) => r.kind))];
  return { overall: group(scored), by_kind: Object.fromEntries(kinds.map((k) => [k, group(scored.filter((r) => r.kind === k))])) };
}
