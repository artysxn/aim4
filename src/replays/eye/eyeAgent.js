// ---------------------------------------------------------------------------
// replays/eye/eyeAgent.js
// One conversation turn with aim4 eye: ask the model, run the tools it asks
// for, hand the results back, and repeat until it answers.
//
// The model runs on the user's own computer (the aim4 desktop app) and is
// reached through the server's relay (POST /api/eye/chat, server-sent events
// in the OpenAI streaming shape). The tools run here, in the page.
// ---------------------------------------------------------------------------

import { accessToken } from '../api.js';
import { TOOLS, runTool } from './eyeTools.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
/** Tool rounds per question before the agent is made to answer with what it has. */
export const MAX_STEPS = 10;

export const SYSTEM_PROMPT = `You are aim4 eye, the analyst assistant inside aim4, a Counter-Strike 2 demo analysis site.
You answer questions about teams in the user's demo library: how they play, their tendencies, their weaknesses, and you prepare antistrat documents.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate or invent statistics. If a tool cannot answer, say so.
- Use exact team names (list_teams) and exact callout names for the map (map_zones) before querying positions or utility.
- query_rounds counts rounds. Say how many rounds a number is based on, and treat fewer than about 8 rounds as thin.
- The round clock runs from 1:55 at the start of the live round down to 0:00. "Early" is roughly 1:55-1:30, "midround" 1:30-0:50.
- "T side" / "CT side" is the side the scouted team played. Unless asked otherwise, look at full buys against full buys.
- A question about a specific situation (where players stood, utility, kills, timings, what happens next) is a query_rounds question. Put the situation in "where" and what you want to know in "group_by". Do not answer it from antistrat_summary.
  Example: "When HAVU have 1+ players in Silo before 1:20 on T, do they go A or B?" ->
  query_rounds {"team":"HAVU","map":"Nuke","side":"T","buy":"full","where":[{"players_in":{"zone":"Silo","who":"team","min":1,"from":"1:55","to":"1:20"}}],"group_by":"site"}
  then report matched of considered, and each group's count and wins.
- For broad questions ("biggest weaknesses", "review the antistrat"), read antistrat_summary for each relevant map first, then check anything surprising with query_rounds.
- To create documents, call create_antistrat_document; the user confirms it.
- Answer in plain, short sentences a CS2 coach would use. Lead with the answer, then the numbers behind it.`;

/**
 * Stream one model reply through the relay.
 * @returns {Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }> }>}
 */
async function streamReply(messages, { onEvent, signal, thinking }) {
  const token = await accessToken();
  const res = await fetch(`${API_BASE}/api/eye/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      messages,
      tools: TOOLS,
      temperature: 0.3,
      chat_template_kwargs: { enable_thinking: Boolean(thinking) }
    }),
    signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `aim4 eye could not answer (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  /** index -> call being assembled from deltas */
  const calls = new Map();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let type = 'message';
      let data = '';
      for (const lineText of event.split('\n')) {
        if (lineText.startsWith('event:')) type = lineText.slice(6).trim();
        else if (lineText.startsWith('data:')) data += lineText.slice(5).trim();
      }
      if (!data) continue;
      if (type === 'error') throw new Error(JSON.parse(data).error || 'aim4 eye failed.');
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.reasoning_content) onEvent?.({ type: 'thinking', text: delta.reasoning_content });
      if (delta.content) {
        content += delta.content;
        onEvent?.({ type: 'text', text: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!calls.has(i)) calls.set(i, { id: tc.id || `call_${i}`, name: '', arguments: '' });
        const c = calls.get(i);
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: [...calls.values()].filter((c) => c.name) };
}

/**
 * Answer the last user message of a conversation, running tools as needed.
 * The conversation is extended in place with every assistant and tool message.
 *
 * @param {Array<object>} messages  OpenAI-style, without the system prompt
 * @param {{
 *   onEvent?: (e: object) => void,
 *   signal?: AbortSignal,
 *   thinking?: boolean,
 *   confirm?: (question: string) => Promise<boolean>
 * }} opts
 */
export async function runAgentTurn(messages, { onEvent, signal, thinking = false, confirm } = {}) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
    if (last) convo.push({ role: 'system', content: 'Answer now with what the tools have shown. No more tool calls.' });
    onEvent?.({ type: 'step', step });
    const { content, toolCalls } = await streamReply(convo, { onEvent, signal, thinking });
    const calls = last ? [] : toolCalls;
    messages.push({
      role: 'assistant',
      content,
      ...(calls.length
        ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) }
        : {})
    });
    if (!calls.length) {
      onEvent?.({ type: 'done' });
      return content;
    }
    for (const call of calls) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      let args = {};
      let result;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        result = { content: 'Error: the arguments were not valid JSON. Call the tool again with valid JSON.', display: `${call.name}: unreadable arguments` };
      }
      onEvent?.({ type: 'tool-start', id: call.id, name: call.name, args });
      result ||= await runTool(call.name, args, {
        onProgress: (label) => onEvent?.({ type: 'tool-progress', id: call.id, label }),
        confirm
      });
      onEvent?.({ type: 'tool-done', id: call.id, name: call.name, args, result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }
  onEvent?.({ type: 'done' });
  return '';
}
