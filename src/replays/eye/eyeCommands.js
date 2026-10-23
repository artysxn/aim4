// ---------------------------------------------------------------------------
// replays/eye/eyeCommands.js
// Slash commands in the aim4 eye composer: what they are, how a line is read as
// one, and the pure parts of the ones that make a file or a summary. The panel
// (eyePanel.js) does the clicking, downloading and calling.
// ---------------------------------------------------------------------------

import { sizeOf } from './eyeContext.js';

/** @typedef {{ name: string, aliases?: string[], args?: string, about: string }} Command */

/** @type {Command[]} */
export const COMMANDS = [
  { name: 'export', aliases: ['download'], args: '[md | copy]', about: 'Download this chat as a file: every question, tool call and result' },
  { name: 'compact', about: 'Summarise the chat so far, to make room' },
  { name: 'retry', about: 'Ask the last question again' },
  { name: 'copy', about: 'Copy the last answer' },
  { name: 'context', about: 'How full the conversation is' },
  { name: 'new', aliases: ['clear'], about: 'Start a new chat' },
  { name: 'help', about: 'List the commands' }
];

const byName = new Map(COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])].map((n) => [n, c])));

/**
 * A composer line as a command. Returns null when it is not one (it is sent as a
 * question), or { command, args } / { unknown } when it starts with a slash and a word.
 * A line that is a path or a link ("/demos/abc", "/ ") is a question, not a command.
 *
 * @param {string} text
 * @returns {null | { command: Command, args: string } | { unknown: string }}
 */
export function parseCommand(text) {
  const m = /^\/([a-z]{2,12})(?:[ \t]+([^\n]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const command = byName.get(m[1].toLowerCase());
  if (!command) return { unknown: m[1].toLowerCase() };
  return { command, args: (m[2] || '').trim() };
}

/** Commands whose name starts with what is typed after the slash, for the list under the cursor. */
export function matchCommands(text) {
  const m = /^\/([a-z]*)$/i.exec(String(text || ''));
  if (!m) return [];
  const p = m[1].toLowerCase();
  return COMMANDS.filter((c) => [c.name, ...(c.aliases || [])].some((n) => n.startsWith(p)));
}

// ---- export ---------------------------------------------------------------------

/** A message as it was first written (a shortened result whole again), pictures left out. */
const plain = ({ compacted, callsCompacted, full, fullCalls, ...m }) => {
  if (fullCalls) m = { ...m, tool_calls: fullCalls };
  if (full !== undefined) return { ...m, content: full };
  if (!Array.isArray(m.content)) return m;
  return { ...m, content: m.content.map((part) => (part.type === 'image_url' ? { type: 'text', text: '[picture]' } : part)) };
};

/**
 * The whole chat as JSON: the messages exactly as the model saw them, tool results
 * in full, and what a reviewer needs to reproduce it (model, prompt, tools).
 *
 * @param {{ messages: object[], meta: object }} chat
 */
export function exportJson({ messages, meta }) {
  return JSON.stringify({ format: 'aim4-eye-chat', version: 1, ...meta, messages: messages.map(plain) }, null, 2);
}

const fence = (text) => `\`\`\`\n${String(text).replace(/```/g, "'''")}\n\`\`\``;
const textOf = (content) => (Array.isArray(content) ? content.map((p) => (p.type === 'text' ? p.text : '[picture]')).join('\n') : String(content ?? ''));

/**
 * The chat as Markdown to read: each question and answer, with the tool calls
 * between them and what came back (long results cut).
 *
 * @param {{ messages: object[], meta: object }} chat
 * @param {{ resultChars?: number }} [opts]
 */
export function exportMarkdown({ messages, meta }, { resultChars = 1500 } = {}) {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, textOf(m.full ?? m.content)]));
  const out = [`# ${meta.title || 'aim4 eye chat'}`, '', `Exported ${meta.exportedAt}${meta.model ? ` · model ${meta.model}` : ''}`, ''];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push('## You', '', m.ui?.text ?? textOf(m.content), '');
      if (m.ui?.chips?.length) out.push(`_Attached: ${m.ui.chips.map((c) => `${c.kind} ${c.label}`).join(', ')}_`, '');
    } else if (m.role === 'assistant') {
      if (String(m.content || '').trim()) out.push(m.tool_calls?.length ? `> ${String(m.content).trim().split('\n')[0]}` : `## aim4 eye\n\n${String(m.content).trim()}`, '');
      for (const tc of m.tool_calls || []) {
        const raw = results.get(tc.id) ?? '(no result)';
        out.push(`**${tc.function?.name}** \`${String(tc.function?.arguments || '{}').slice(0, 600)}\``, '', fence(raw.length > resultChars ? `${raw.slice(0, resultChars)}\n… [${raw.length - resultChars} more characters]` : raw), '');
      }
    }
  }
  return out.join('\n');
}

/** "aim4-eye_what-are-havus-weaknesses_2026-10-18.json" */
export function exportName(title, ext, now = new Date()) {
  const slug = String(title || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'chat';
  return `aim4-eye_${slug}_${now.toISOString().slice(0, 10)}.${ext}`;
}

// ---- compact --------------------------------------------------------------------

/**
 * The chat as plain text for the model to summarise: questions and answers whole,
 * each tool call on a line with its result cut short. Steps folded during a long
 * answer are given as the line per call they were folded into: sixty calls in
 * full did not fit one summary request, and its start was cut.
 */
export function transcriptOf(messages, { resultChars = 500 } = {}) {
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, textOf(m.content)]));
  const lines = [];
  for (const m of messages) {
    if (m.stepFolded) continue;
    if (m.role === 'user') {
      lines.push(`USER: ${m.ui?.text ?? textOf(m.content)}`);
      if (m.progress) lines.push(`DONE (a line per call):\n${m.progress}`);
    } else if (m.role === 'assistant') {
      if (String(m.content || '').trim()) lines.push(`${m.tool_calls?.length ? 'NOTE' : 'ASSISTANT'}: ${String(m.content).trim()}`);
      for (const tc of m.tool_calls || []) {
        const raw = results.get(tc.id) ?? '';
        lines.push(`TOOL ${tc.function?.name} ${String(tc.function?.arguments || '{}').slice(0, 300)} -> ${raw.length > resultChars ? `${raw.slice(0, resultChars)}…` : raw}`);
      }
    }
  }
  return lines.join('\n');
}

export const SUMMARY_PROMPT = `You write the summary that replaces the start of a conversation between a user and aim4 eye, a Counter-Strike 2 demo analyst. The assistant will continue the conversation from your summary alone.
Keep: what the user asked and still wants; the teams, maps, players and rounds in play (by name and label, not by file or id); every number the tools measured and what it was measured over (side, buy, map, how many rounds); conclusions already given; documents made or reviewed (title and date); what is unfinished.
Leave out: tool names, arguments, errors that were fixed, greetings, anything repeated.
Plain sentences and short bullet lists, under 300 words. Write only the summary.`;

/** The memory that stands in for folded questions in a long chat (eyeAgent.js foldEarlier). */
export const MEMORY_PROMPT = `${SUMMARY_PROMPT.replace('under 300 words', 'under 450 words')}
The text may start with an EARLIER SUMMARY of questions folded before: merge it with what follows into one summary, keeping what still matters from both. Number the user's questions in the order they were asked (Q1, Q2 ...).`;

/** The messages that replace a chat once it is summarised: the command, and the summary as the answer. */
export function compactedMessages(summary) {
  return [
    { role: 'user', content: 'Continue from a summary of our conversation so far.', ui: { text: '/compact', chips: [] } },
    { role: 'assistant', content: `Summary of the conversation so far:\n\n${String(summary).trim()}` }
  ];
}

// ---- context --------------------------------------------------------------------

/** How big the conversation is, the way the agent counts it. */
export function contextStats(messages, budget) {
  // A folded question costs only the memory that stands in for it, a folded step only its line.
  const chars = messages.reduce((n, m) => n + sizeOf(m), 0);
  return {
    messages: messages.length,
    questions: messages.filter((m) => m.role === 'user' && m.ui).length,
    toolCalls: messages.filter((m) => m.role === 'tool').length,
    shortened: messages.filter((m) => m.compacted).length,
    stepsFolded: messages.filter((m) => m.stepFolded && m.role === 'assistant').length,
    folded: messages.filter((m) => m.folded && m.role === 'user' && m.ui).length,
    chars,
    budget,
    percent: Math.round((chars / budget) * 100)
  };
}
