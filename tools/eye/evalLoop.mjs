// ---------------------------------------------------------------------------
// tools/eye/evalLoop.mjs
// One question put to a model the way aim4 eye puts it: the system prompt, the
// question, then tool calls answered and handed back until the model answers
// or runs out of steps. The same loop as src/replays/eye/eyeAgent.js
// (runAgentTurn), without the page: the model and the tools are passed in, so
// the loop can be tested with a script standing in for the model.
// ---------------------------------------------------------------------------

/** Tool rounds per question before the model is made to answer, as in the app. */
export const MAX_STEPS = 10;

/** A reasoning block some chat templates leave in the content. */
const stripThinking = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

const argsText = (args) => (typeof args === 'string' ? args : JSON.stringify(args || {}));

/**
 * @param {{ question: string }} evalCase
 * @param {object} deps
 * @param {(messages: Array, tools: Array) => Promise<{ content?: string, tool_calls?: Array }>} deps.callModel
 * @param {(name: string, args: object) => Promise<string | { content: string, resolved?: string }>} deps.runTool
 *   the text the model reads, or that and the round the call was read as
 * @param {Array} deps.tools
 * @param {string} deps.systemPrompt
 * @param {number} [deps.maxSteps]
 * @returns {Promise<{ calls: Array<{ name: string, args: object, result: string, resolved?: string }>, answer: string, steps: number, error?: string, messages: Array }>}
 */
export async function runCase(evalCase, { callModel, runTool, tools, systemPrompt, maxSteps = MAX_STEPS }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: evalCase.question }
  ];
  const calls = [];
  let answer = '';
  let steps = 0;
  let error;
  try {
    for (let step = 0; step < maxSteps; step++) {
      const last = step === maxSteps - 1;
      const convo = last ? [...messages, { role: 'system', content: 'Answer now with what the tools have shown. No more tool calls.' }] : messages;
      const reply = await callModel(convo, tools);
      steps++;
      // On the last step any tool call is dropped, as the app drops it.
      const toolCalls = last ? [] : reply.tool_calls || [];
      const content = stripThinking(reply.content);
      const withIds = toolCalls.map((c, i) => ({
        id: c.id || `call_${step}_${i}`,
        type: 'function',
        function: { name: c.function.name, arguments: argsText(c.function.arguments) }
      }));
      messages.push({ role: 'assistant', content, ...(withIds.length ? { tool_calls: withIds } : {}) });
      if (!withIds.length) {
        answer = content;
        break;
      }
      for (const call of withIds) {
        const name = call.function.name;
        let args = {};
        let result;
        let resolved;
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          result = 'Error: the arguments were not valid JSON. Call the tool again with valid JSON.';
        }
        if (result === undefined) {
          const ran = await runTool(name, args);
          result = typeof ran === 'string' ? ran : ran.content;
          resolved = typeof ran === 'string' ? undefined : ran.resolved;
        }
        calls.push({ name, args, result, ...(resolved ? { resolved } : {}) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
  } catch (err) {
    error = err.message;
  }
  return { calls, answer, steps, error, messages };
}
