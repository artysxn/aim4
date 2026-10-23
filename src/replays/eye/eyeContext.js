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
//
// One long answer has the same floor inside it: a job over 15 playlists makes
// dozens of calls, and every shortened result still costs its 1,200 characters.
// So when shortening is not enough, whole old steps are folded (stepFolded):
// the model reads one line per call in their place, on the question ("done so
// far"), and calls a tool again if it still needs what it said.
// ---------------------------------------------------------------------------

// ---- what fits: the model's context, in tokens ------------------------------------

/** The model's context in tokens: llama-server runs with -c 32768 (recorder/app/src/eye/runtime.rs CONTEXT). */
export const MODEL_CONTEXT = 32768;
/**
 * Characters per token, measured with the model's own tokenizer (Qwen3.8 27B, 21 Oct): the system
 * prompt and the tool list 4.1, chat text 2.8, tool results only 2.2 to 2.4. The budgets here were
 * set as if everything were 4 characters a token: the 44,000-character history was about 19,000
 * tokens, and with the 14,500 the prompt and the tool list take, the 32k context was full before the
 * model wrote anything (21 Oct, notes for 15 playlists: the reply was cut off mid-call at token 32,767).
 */
export const CHARS_PER_TOKEN = { prompt: 4.1, history: 2.2 };
/** A picture costs about this many tokens (a 768 px radar shot). Its base64 text is not what the model reads. */
export const IMAGE_TOKENS = 1200;
const IMAGE_CHARS = Math.round(IMAGE_TOKENS * CHARS_PER_TOKEN.history);
/** The chat template's own tokens around the system prompt and the tool list. */
export const TEMPLATE_TOKENS = 400;
/** Room kept for the reply: its answer or tool call, and at least this much reasoning (more when there is room). */
export const OUTPUT_TOKENS = 2500;
export const THINK_MIN_TOKENS = 3000;

/**
 * Characters of conversation that fit beside a system prompt and tool list of `fixedChars`, with
 * room left for the reply. `calibration` is the server's own count of the history's tokens over
 * this estimate (from the last reply), so the budget follows what the model really reads.
 */
export function historyBudget(fixedChars, calibration = 1) {
  const fixed = fixedChars / CHARS_PER_TOKEN.prompt + TEMPLATE_TOKENS;
  const room = MODEL_CONTEXT - fixed - OUTPUT_TOKENS - THINK_MIN_TOKENS;
  return Math.max(4000, Math.floor((room * CHARS_PER_TOKEN.history) / calibration));
}

/**
 * Characters of conversation (not counting the system prompt and tools) kept before older results
 * are shortened: what historyBudget gives for the prompt and tool list of 21 Oct (59,000 characters).
 * The agent works the budget out again each step; this is the default and what /context shows.
 */
export const HISTORY_BUDGET = 27000;
/** Roughly what a shortened result may take. */
const KEEP_CHARS = 1200;
/** Rows kept from each list in a shortened result. */
const KEEP_ROWS = 3;
/** Longer strings inside a shortened result are cut to this. */
const KEEP_STRING = 160;

const NOTE = '[shortened to save space: the rows and text above are the start of the result. Call the tool again, once, if you need the rest.]';

/** Earlier questions (characters) past which the oldest are folded into the memory. */
export const FOLD_AT = 12000;
/** Earlier questions kept word for word after a fold (the newest is always kept). */
export const KEEP_RECENT = 6000;
/** The memory never grows past this. */
export const MEMORY_CHARS = 4000;
/** Tool-call arguments longer than this are shortened like a result. */
const KEEP_ARGS = 600;
/** Steps this small (a list of playlists, a confirmation) are folded last: they say much in little room. */
const SMALL_STEP = 1800;

const contentChars = (c) =>
  typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, p) => n + (p?.type === 'image_url' ? IMAGE_CHARS : String(p?.text || '').length), 0) : JSON.stringify(c || '').length;

/** What the model is asked before the memory, and what opens it (modelMessages). */
const MEMORY_ASK = 'What have we covered so far?';
export const MEMORY_HEADING = 'Summary of the earlier part of our conversation (older questions were folded to make room: recall_earlier lists them and returns one in full):';

/**
 * Characters a message costs the model, a picture at what it costs in tokens. A folded question
 * costs only the memory it carries, if any, with the lines around it; a folded step nothing (its
 * lines are on the question, with their heading).
 */
export const sizeOf = (m) =>
  m.folded
    ? m.memory
      ? m.memory.length + MEMORY_ASK.length + MEMORY_HEADING.length + 2
      : 0
    : m.stepFolded
      ? 0
      : contentChars(m.content) + JSON.stringify(m.tool_calls || '').length + (m.progress ? m.progress.length + PROGRESS_HEADING.length + 3 : 0);

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '');
/**
 * A picture a tool returned: it rides on a user message after the results (eyeAgent.js), and stays
 * one once limitImages has turned it into plain text.
 */
const isPicture = (m) => m.role === 'user' && !m.ui && /^The picture from /.test(textOf(m.content));
/** A question the user asked. */
const isQuestion = (m) => m.role === 'user' && !isPicture(m) && Boolean(m.ui || typeof m.content === 'string');

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
 * Shorten the oldest tool results until the conversation fits the budget; when
 * that is not enough, fold whole old steps into a line per call (foldSteps).
 * Earlier questions (before `turnStart`) go first. The current question's
 * results are only shortened, then folded, when that is not enough, and the
 * latest tool step is only shortened when nothing else is left: the model is
 * about to read it.
 *
 * @param {Array<object>} messages  OpenAI-style, edited in place
 * @param {number} [budget]
 * @param {number} [turnStart]  index of the current question; results before it go first
 * @param {{ latest?: number }} [opts]  latest: the budget the latest step is shortened to, when it is
 *   more than `budget` (the agent makes room below its budget, for a few steps at once, but never cuts
 *   the results the model is about to read for that)
 * @returns {number} how many results were shortened or steps folded
 */
export function compactHistory(messages, budget = HISTORY_BUDGET, turnStart = 0, { latest = budget } = {}) {
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
    if (m.folded || m.stepFolded) return;
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
  /** Shorten what is in [from, end) oldest first until it fits, only what is bigger than `least`. */
  const pass = (from, end, least = 0) => {
    for (let i = from; i < Math.min(end, keepFrom) && total > budget; i++) if (sizeOf(messages[i]) > least) shorten(messages[i]);
  };
  /**
   * Fold the steps in [from, end) oldest first until it fits: first the big ones and those already
   * shortened (what is left of them is a remnant), then the small whole ones.
   */
  const fold = (from, end) => {
    const steps = stepsIn(messages, from, Math.min(end, keepFrom));
    for (const small of [false, true]) {
      for (const s of steps) {
        if (total <= budget) return;
        if (messages[s.start].stepFolded) continue;
        let size = 0;
        let shortened = false;
        for (let i = s.start; i < s.end; i++) {
          size += sizeOf(messages[i]);
          shortened ||= Boolean(messages[i].compacted);
        }
        if (!small && size <= SMALL_STEP && !shortened) continue;
        for (let i = s.start; i < s.end; i++) messages[i].stepFolded = true;
        const q = questionAt(messages, s.start);
        const before = q >= 0 ? sizeOf(messages[q]) : 0;
        if (q >= 0) messages[q].progress = progressOf(messages, q);
        total += (q >= 0 ? sizeOf(messages[q]) - before : 0) - size;
        cut++;
      }
    }
  };
  // Earlier questions first, then this one. In each: big results shortened, then old steps folded, and
  // small results shortened only after that: a list the job works through stays whole the longest. On
  // 21 Oct the 15-playlist list was cut to its first 3 rows, and the model guessed the next playlist's id.
  for (const [from, end] of [
    [0, turnStart],
    [turnStart, messages.length]
  ]) {
    pass(from, end, SMALL_STEP);
    fold(from, end);
    pass(from, end);
  }
  // Still over: the latest step itself is too big (eleven antistrat sheets in one step overflowed
  // the model's 32k context). Shorten its largest results first; shortened beats not answering.
  const roomForLatest = Math.max(budget, latest);
  if (total > roomForLatest) {
    const newest = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => i >= keepFrom && m.role === 'tool' && typeof m.content === 'string' && !m.compacted)
      .sort((a, b) => b.m.content.length - a.m.content.length);
    for (const { m } of newest) {
      if (total <= roomForLatest) break;
      shorten(m);
    }
  }
  return cut;
}

// ---- folding old steps of an answer into a line per call ---------------------------

/** What opens the folded steps on a question, in the model's view. */
export const PROGRESS_HEADING =
  'Done so far on this question (older steps were folded to make room: their results are no longer shown, so call a tool again if you still need one):';
/** The lines of folded steps on one question never grow past this; the oldest become a count. */
const PROGRESS_CHARS = 3000;

/** The tool steps in messages[from, end): an assistant message with calls, its results and the pictures they returned. */
function stepsIn(messages, from, end) {
  const steps = [];
  for (let i = from; i < end; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) steps.push({ start: i, end: i + 1 });
    else if (steps.at(-1)?.end === i && (m.role === 'tool' || isPicture(m))) steps.at(-1).end = i + 1;
  }
  return steps;
}

/** The question a message belongs to, or -1. */
function questionAt(messages, i) {
  for (let k = i; k >= 0; k--) if (isQuestion(messages[k])) return k;
  return -1;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Short plain fields as "key value", lists as "N key", nested objects left out. */
function plainFields(obj, longest) {
  return Object.entries(obj)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        // A list of named things (playlists, rounds) keeps its names: a long job goes through them.
        const names = v.map((x) => (x && typeof x === 'object' ? x.name || x.label || x.title : null)).filter((x) => typeof x === 'string');
        return names.length ? `${v.length} ${k}: ${clip(names.map((n, i) => `${n}${typeof v[i]?.id === 'string' && v[i].id.length <= 16 ? ` (${v[i].id})` : ''}`).join('; '), 400)}` : `${v.length} ${k}`;
      }
      if (v && typeof v === 'object') return null;
      return String(v).length <= longest ? `${k} ${typeof v === 'string' ? `"${v}"` : v}` : null;
    })
    .filter(Boolean)
    .join(', ');
}

/** "round_briefs(playlist "Anubis T Pistols", side "T", part 2)". */
function callLine(tc) {
  let args = {};
  try {
    args = JSON.parse(String(tc.function?.arguments || '{}')) || {};
  } catch {
    /* cut off: the name is enough */
  }
  return clip(`${tc.function?.name || 'tool'}(${typeof args === 'object' ? plainFields(args, 60) : ''})`, 200);
}

/** What a result said, in a line: an error or a confirmation as written, JSON as its short fields and list sizes. */
function outcomeOf(content) {
  const text = String(content ?? '');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  const line = json && typeof json === 'object' ? plainFields(Array.isArray(json) ? { items: json } : json, 80) : text.replace(/\s+/g, ' ').trim();
  return clip(line || '(nothing)', 600);
}

/**
 * The folded steps of the question at `q`, a line per call, oldest first. Past PROGRESS_CHARS
 * the oldest lines (all but the first, which is often the list the job works through) become a count.
 */
export function progressOf(messages, q) {
  const results = new Map();
  const calls = [];
  for (let i = q + 1; i < messages.length && !isQuestion(messages[i]); i++) {
    const m = messages[i];
    if (!m.stepFolded) continue;
    if (m.role === 'tool') results.set(m.tool_call_id, m.full ?? m.content);
    else if (m.role === 'assistant') calls.push(...(m.fullCalls || m.tool_calls || []));
  }
  const lines = calls.map((tc) => ({ name: tc.function?.name || 'tool', text: `- ${callLine(tc)} -> ${outcomeOf(results.get(tc.id))}` }));
  let size = lines.reduce((n, l) => n + l.text.length + 1, 0);
  const dropped = [];
  while (size > PROGRESS_CHARS && lines.length > 2) {
    const [gone] = lines.splice(1, 1);
    dropped.push(gone.name);
    size -= gone.text.length + 1;
  }
  if (dropped.length) {
    const counts = [...dropped.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map())].map(([n, c]) => `${n} x${c}`).join(', ');
    lines.splice(1, 0, { text: `- (${dropped.length} more calls here: ${counts})` });
  }
  return lines.map((l) => l.text).join('\n');
}

// ---- folding earlier questions into a memory ------------------------------------


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

/** Roughly what one call's line costs in a question's folded steps. */
const LINE_CHARS = 200;

/**
 * What messages[from, to) cost once every step in them is folded: the questions,
 * the answers and a line per call. Shortening and folding steps cannot go below it;
 * only folding the questions into the memory can.
 */
export function leastSize(messages, from, to) {
  let n = 0;
  let lines = 0;
  const close = () => {
    n += Math.min(PROGRESS_CHARS, lines * LINE_CHARS);
    lines = 0;
  };
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (m.folded) continue;
    if (isQuestion(m)) {
      close();
      n += contentChars(m.content);
    } else if (m.role === 'assistant' && m.tool_calls?.length) lines += m.tool_calls.length;
    else if (m.role === 'assistant') n += contentChars(m.content);
  }
  close();
  return n;
}

/**
 * Where to fold: the index of the first earlier question to keep, or -1 when
 * nothing needs folding. Earlier questions (before `turnStart`) past FOLD_AT are
 * folded oldest first until KEEP_RECENT characters of them are left; the newest
 * earlier question is always kept. Both count what the questions cost with their
 * steps folded (leastSize): their results can be made small without the model,
 * only the questions and answers need it. `force` folds every earlier question
 * (the request overflowed anyway).
 *
 * @param {object[]} messages
 * @param {number} turnStart  index of the current question
 * @param {{ force?: boolean }} [opts]
 */
export function foldPoint(messages, turnStart, { force = false } = {}) {
  const size = (a, b) => leastSize(messages, a, b);
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
 * folded steps by their lines on the question, the panel's own fields left out, and
 * narration before a tool call blanked (the model would read its planning again and
 * plan more).
 */
export function modelMessages(messages) {
  const memory = memoryOf(messages);
  const out = memory
    ? [
        { role: 'user', content: MEMORY_ASK },
        { role: 'assistant', content: `${MEMORY_HEADING}\n\n${memory}` }
      ]
    : [];
  for (const { compacted, callsCompacted, ui, full, fullCalls, folded, memory: _memory, stepFolded, progress, ...m } of messages) {
    if (folded || stepFolded) continue;
    if (progress) {
      const done = `${PROGRESS_HEADING}\n${progress}`;
      out.push({ ...m, content: Array.isArray(m.content) ? [...m.content, { type: 'text', text: done }] : `${m.content}\n\n${done}` });
      continue;
    }
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
