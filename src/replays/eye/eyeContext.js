// ---------------------------------------------------------------------------
// replays/eye/eyeContext.js
// Keeping a conversation inside the model's context.
//
// Every tool result stays in the conversation, and a database answer can be
// 12,000 characters. Three of those plus the system prompt and the tool list
// were enough to overflow a 16k context ("request exceeds the available
// context size", a 400 from llama-server), which ended the answer with an
// error. When the conversation grows past a budget, the oldest tool results
// are shortened, newest kept whole.
//
// Shortened, not cut off: a result is a JSON object, and a 400-character slice
// of one is a broken string the model cannot use, so it asked again, the repeat
// guard told it the full answer was above, and it looped. A shortened result
// keeps every short field, the start of every list with how many rows it had,
// and the headings of a document text, and says plainly what was dropped.
// Results from earlier questions go first; the current question's results are
// only shortened when the conversation still does not fit without them.
//
// Shortening alone has a floor: questions, answers, call arguments and every
// shortened result still add up, so a long chat overflowed in the end. Past
// FOLD_AT the oldest finished questions are folded into a memory the model
// writes (foldPoint, modelMessages): they stay in the chat for the screen, the
// export and the saved chat, and the model reads the memory in their place,
// with recall_earlier to read one of them in full again.
// ---------------------------------------------------------------------------

/** Characters of conversation (not counting the system prompt and tools) kept before older results are shortened. */
export const HISTORY_BUDGET = 44000;
/** Roughly what a shortened result may take. */
const KEEP_CHARS = 1200;
/** Rows kept from each list in a shortened result. */
const KEEP_ROWS = 3;
/** Longer strings inside a shortened result are cut to this. */
const KEEP_STRING = 160;

const NOTE = '[shortened to save space: the rows and text above are the start of the result. Call the tool again, once, if you need the rest.]';

/** Earlier questions (characters) past which the oldest are folded into the memory. */
export const FOLD_AT = 32000;
/** Earlier questions kept word for word after a fold (the newest is always kept). */
export const KEEP_RECENT = 12000;
/** The memory never grows past this. */
export const MEMORY_CHARS = 4000;
/** Tool-call arguments longer than this are shortened like a result. */
const KEEP_ARGS = 600;

/** Characters a message costs the model. A folded one costs only the memory it carries, if any. */
export const sizeOf = (m) =>
  m.folded ? m.memory?.length || 0 : (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length) + JSON.stringify(m.tool_calls || '').length;

/** A document text: its short lines (headings, names) kept, long points dropped. */
function shortenText(text) {
  const lines = String(text).split('\n');
  const kept = lines.filter((l) => l.trim() && l.length <= 40).slice(0, 25);
  return `${kept.join('\n')}\n… (${lines.length} lines in full)`;
}

function shortenValue(v, key) {
  if (typeof v === 'string') {
    if (v.length <= KEEP_STRING) return v;
    return key === 'text' && v.includes('\n') ? shortenText(v) : `${v.slice(0, KEEP_STRING)}…`;
  }
  if (Array.isArray(v)) {
    const head = v.slice(0, KEEP_ROWS).map((x) => shortenValue(x));
    return v.length > KEEP_ROWS ? [...head, `… ${v.length - KEEP_ROWS} more (${v.length} in all)`] : head;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = shortenValue(x, k);
    return out;
  }
  return v;
}

/**
 * A tool result made small enough to keep: JSON keeps its shape, plain text its start.
 * @param {string} content
 * @returns {string}
 */
export function shortenResult(content) {
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    // Plain text (an error, a confirmation): its start is the useful part.
  }
  let body = json !== undefined && typeof json === 'object' ? JSON.stringify(shortenValue(json)) : content;
  if (body.length > KEEP_CHARS) body = `${body.slice(0, KEEP_CHARS)}…`;
  return `${body}\n${NOTE}`;
}

/**
 * Shorten the oldest tool results until the conversation fits the budget.
 * Results from before `turnStart` (earlier questions) go first. The current
 * question's results are only shortened when that is not enough, and the
 * latest tool step's results never are: the model is about to read them.
 *
 * @param {Array<object>} messages  OpenAI-style, edited in place
 * @param {number} [budget]
 * @param {number} [turnStart]  index of the current question; results before it go first
 * @returns {number} how many results were shortened
 */
export function compactHistory(messages, budget = HISTORY_BUDGET, turnStart = 0) {
  let total = messages.reduce((n, m) => n + sizeOf(m), 0);
  if (total <= budget) return 0;
  // The latest step's results: the tool messages after the last assistant message with tool calls.
  // Kept whole only when that step is this question's: a step left over from a question that
  // failed (the model's context overflowed on it) is old history like any other, and keeping it
  // whole made every later question fail the same way.
  let lastCalls = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].tool_calls?.length) {
      lastCalls = i;
      break;
    }
  }
  const keepFrom = lastCalls >= turnStart ? lastCalls + 1 : messages.length;
  let cut = 0;
  const shorten = (m) => {
    if (m.folded) return;
    if (m.role === 'assistant') return void (shortenCalls(m) && cut++);
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.compacted) return;
    const short = shortenResult(m.content);
    if (short.length >= m.content.length) return;
    total -= m.content.length - short.length;
    // The original stays on the message for the export and the saved chat; only the model reads `content`.
    m.full ??= m.content;
    m.content = short;
    m.compacted = true;
    cut++;
  };
  /** A call's long arguments (a rewrite's sections) shortened like a result; the originals stay in `fullCalls`. */
  const shortenCalls = (m) => {
    if (!m.tool_calls?.length || m.callsCompacted) return false;
    const before = sizeOf(m);
    const calls = m.tool_calls.map((tc) => {
      const raw = String(tc.function?.arguments || '');
      if (raw.length <= KEEP_ARGS) return tc;
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        return tc;
      }
      const short = JSON.stringify(shortenValue(json));
      return short.length < raw.length ? { ...tc, function: { ...tc.function, arguments: short } } : tc;
    });
    if (calls.every((c, i) => c === m.tool_calls[i])) return false;
    m.fullCalls ??= m.tool_calls;
    m.tool_calls = calls;
    m.callsCompacted = true;
    total -= before - sizeOf(m);
    return true;
  };
  const pass = (end) => {
    for (let i = 0; i < Math.min(end, keepFrom) && total > budget; i++) shorten(messages[i]);
  };
  pass(turnStart);
  pass(messages.length);
  // Still over: the latest step itself is too big (eleven antistrat sheets in one step overflowed
  // the model's 32k context). Shorten its largest results first; shortened beats not answering.
  if (total > budget) {
    const latest = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => i >= keepFrom && m.role === 'tool' && typeof m.content === 'string' && !m.compacted)
      .sort((a, b) => b.m.content.length - a.m.content.length);
    for (const { m } of latest) {
      if (total <= budget) break;
      shorten(m);
    }
  }
  return cut;
}

// ---- folding earlier questions into a memory ------------------------------------

/** What opens the memory pair in the model's view. */
export const MEMORY_HEADING = 'Summary of the earlier part of our conversation (older questions were folded to make room: recall_earlier lists them and returns one in full):';

/** A question the user asked (pictures a tool returned ride on user messages too, as a list). */
const isQuestion = (m) => m.role === 'user' && (m.ui || typeof m.content === 'string');
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '');

/**
 * The questions of a chat as index ranges, each with its question and final answer.
 * @param {object[]} messages
 * @param {number} [end]  stop before this index
 */
export function turnsOf(messages, end = messages.length) {
  const turns = [];
  for (let i = 0; i < end; i++) {
    if (isQuestion(messages[i])) turns.push({ start: i, end, question: messages[i].ui?.text ?? textOf(messages[i].content), answer: '' });
    else if (!turns.length) turns.push({ start: i, end, question: '', answer: '' });
    if (turns.length > 1) turns.at(-2).end = Math.min(turns.at(-2).end, turns.at(-1).start);
    const m = messages[i];
    if (m.role === 'assistant' && !m.tool_calls?.length && String(m.content || '').trim()) turns.at(-1).answer = String(m.content).trim();
  }
  return turns;
}

/** The latest memory, carried by the last folded message. */
export function memoryOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].folded && messages[i].memory) return messages[i].memory;
  return '';
}

/**
 * Where to fold: the index of the first earlier question to keep, or -1 when
 * nothing needs folding. Earlier questions (before `turnStart`) past FOLD_AT are
 * folded oldest first until KEEP_RECENT characters of them are left; the newest
 * earlier question is always kept. `force` folds every earlier question (the
 * request overflowed anyway).
 *
 * @param {object[]} messages
 * @param {number} turnStart  index of the current question
 * @param {{ force?: boolean }} [opts]
 */
export function foldPoint(messages, turnStart, { force = false } = {}) {
  const size = (a, b) => {
    let n = 0;
    for (let i = a; i < b; i++) if (!messages[i].folded) n += sizeOf(messages[i]);
    return n;
  };
  const hasUnfolded = (cut) => messages.slice(0, cut).some((m) => !m.folded);
  if (force) return hasUnfolded(turnStart) ? turnStart : -1;
  if (size(0, turnStart) <= FOLD_AT) return -1;
  const starts = turnsOf(messages, turnStart)
    .filter((t) => !messages[t.start].folded && isQuestion(messages[t.start]))
    .map((t) => t.start);
  if (starts.length < 2) return -1;
  let cut = starts.at(-1);
  for (let k = starts.length - 2; k >= 0 && size(starts[k], turnStart) <= KEEP_RECENT; k--) cut = starts[k];
  return hasUnfolded(cut) ? cut : -1;
}

/**
 * Fold everything before `cut` behind `memory`: the messages stay (screen, export,
 * saved chat) and the model reads the memory instead.
 */
export function applyFold(messages, cut, memory) {
  for (let i = 0; i < cut; i++) messages[i].folded = true;
  messages[cut - 1].memory = String(memory).trim().slice(0, MEMORY_CHARS);
}

/** A memory without the model: the earlier memory, then each folded question and the start of its answer. */
export function digestOf(previous, messages) {
  const lines = previous ? [previous.slice(0, MEMORY_CHARS / 2), ''] : [];
  const turns = turnsOf(messages).filter((t) => t.question || t.answer);
  // Every question gets a line; the answers share what is left.
  const room = Math.max(80, Math.floor((MEMORY_CHARS - (lines[0]?.length || 0)) / Math.max(1, turns.length)) - 140);
  for (const t of turns) {
    lines.push(`- Asked: ${t.question.slice(0, 120)}`);
    if (t.answer) lines.push(`  Answered: ${t.answer.replace(/\s+/g, ' ').slice(0, Math.min(500, room))}`);
  }
  const text = lines.join('\n');
  return text.length > MEMORY_CHARS ? `…${text.slice(-(MEMORY_CHARS - 1))}` : text;
}

/**
 * The conversation as the model reads it: folded messages replaced by the memory,
 * the panel's own fields left out, and narration before a tool call blanked (the
 * model would read its planning again and plan more).
 */
export function modelMessages(messages) {
  const memory = memoryOf(messages);
  const out = memory
    ? [
        { role: 'user', content: 'What have we covered so far?' },
        { role: 'assistant', content: `${MEMORY_HEADING}\n\n${memory}` }
      ]
    : [];
  for (const { compacted, callsCompacted, ui, full, fullCalls, folded, memory: _memory, ...m } of messages) {
    if (folded) continue;
    out.push(m.role === 'assistant' && m.tool_calls?.length && m.content ? { ...m, content: '' } : m);
  }
  return out;
}

/** Most a recalled question may take. */
const RECALL_CHARS = 8000;

/**
 * The recall_earlier tool: with no number, the folded questions listed; with one,
 * that question, its whole answer and its tool calls with short results.
 */
export function recallEarlier(messages, args = {}) {
  const turns = turnsOf(messages).filter((t) => messages[t.start].folded && t.question);
  if (!turns.length) return 'Nothing has been folded: every earlier question is still in the conversation above.';
  const n = Number(args.question);
  if (!n) {
    return JSON.stringify({
      folded_questions: turns.map((t, i) => ({ question: i + 1, asked: t.question.slice(0, 160) })),
      how: 'Call recall_earlier with question set to one of these numbers to read it in full.'
    });
  }
  const t = turns[n - 1];
  if (!t) return `Error: there are ${turns.length} folded questions; question must be 1 to ${turns.length}.`;
  const results = new Map(messages.slice(t.start, t.end).filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.full ?? m.content]));
  const tools = [];
  for (const m of messages.slice(t.start, t.end)) {
    for (const tc of (m.fullCalls || m.tool_calls || [])) {
      tools.push({ tool: tc.function?.name, arguments: String(tc.function?.arguments || '').slice(0, 300), result: shortenResult(String(results.get(tc.id) ?? '')).replace(`\n${NOTE}`, '') });
    }
  }
  let out = { question: t.question, answer: t.answer, tools };
  while (JSON.stringify(out).length > RECALL_CHARS && out.tools.length) out = { ...out, tools: out.tools.slice(0, -1), tools_left_out: (out.tools_left_out || 0) + 1 };
  return JSON.stringify(out);
}
