// ---------------------------------------------------------------------------
// server/admin/trainingStore.js
// Labels from the admin training pages (/admin/training_1 … training_5).
//
//   {AIM4_REPLAY_DIR}/training/training_<stage>.jsonl
//
// One JSON object per line, appended as the admin answers. JSON Lines because
// it is the smallest format that is still trivially read by anything (a loop,
// jq, pandas.read_json(lines=True)), streams, and survives a crash mid-write
// with every earlier line intact.
//
// A record (format version 1):
//
//   {
//     "v": 1,
//     "id": "a1b2c3d4e5f6",
//     "stage": 1,                       1 … 5, the page it came from
//     "task": "round-describe",         what the bot was doing (TASKS below)
//     "at": 1792213053626,              ms since epoch
//     "by": "<admin id>",
//     "engine": "rules-1",              which generator wrote `bot`
//     "subject": { … },                 what was looked at: a round, a team
//     "bot": { "text": "…", … },        what the bot said, with its inputs
//     "verdict": "yes" | "no",
//     "answer": "…",                    stage 2, after yes: the admin's own words
//     "comment": "…"                    stage 4 after no (required), stage 5 (optional)
//   }
//
// The export is the same lines behind one header line:
//   {"format":"aim4-training","v":1,"exportedAt":…,"counts":{…}}
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT as REPLAY_ROOT } from '../replays/demoStore.js';

export const TRAINING_DIR = process.env.AIM4_TRAINING_DIR || path.join(REPLAY_ROOT, 'training');
export const FORMAT = 'aim4-training';
export const FORMAT_VERSION = 1;

/** The task each page trains. */
export const TASKS = {
  1: 'round-describe',
  2: 'round-describe',
  3: 'antistrat-point',
  4: 'antistrat-point',
  5: 'opinion',
  // Not a page: aim4 eye answers an admin rated in the chat ("Good" / "Bad").
  // bot.messages is the whole turn (tool calls and results), the shape a
  // tool-use fine-tune trains on.
  6: 'eye-trace'
};
export const STAGES = Object.keys(TASKS).map(Number);

const MAX_TEXT = 4000;
/** subject + bot together: a description with its beats, a point with its rounds. */
const MAX_PAYLOAD = 96 * 1024;
/** An eye turn carries its tool results; the admin body limit (256 KB) is the real cap. */
const MAX_TRACE_PAYLOAD = 240 * 1024;
const ENGINE = /^[a-z0-9][a-z0-9.-]{0,31}$/;

export class TrainingError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const fileOf = (stage) => path.join(TRAINING_DIR, `training_${stage}.jsonl`);

export function stageOf(value) {
  const n = Number(value);
  if (!STAGES.includes(n)) throw new TrainingError('Unknown training stage.');
  return n;
}

function text(value, label, required = false) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new TrainingError(`${label} is required.`);
  if (s.length > MAX_TEXT) throw new TrainingError(`${label} is too long.`);
  return s;
}

/** A plain JSON object, nothing that does not survive a JSON round trip. */
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TrainingError(`${label} must be an object.`);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Check one answer from a training page and turn it into a stored record.
 *
 * @param {number} stage
 * @param {object} body  { engine, subject, bot, verdict, answer?, comment? }
 * @param {string} by    the admin's id
 */
export function makeRecord(stage, body, by) {
  const s = stageOf(stage);
  const src = body && typeof body === 'object' ? body : {};
  const verdict = src.verdict === 'yes' || src.verdict === 'no' ? src.verdict : null;
  if (!verdict) throw new TrainingError('Verdict must be yes or no.');
  const engine = typeof src.engine === 'string' && ENGINE.test(src.engine) ? src.engine : 'rules-1';
  const subject = plain(src.subject, 'Subject');
  const bot = plain(src.bot, 'Bot output');
  if (typeof bot.text !== 'string' || !bot.text.trim()) throw new TrainingError('Bot output needs its text.');
  if (Buffer.byteLength(JSON.stringify({ subject, bot })) > (s === 6 ? MAX_TRACE_PAYLOAD : MAX_PAYLOAD)) throw new TrainingError('Record is too large.');
  const record = {
    v: FORMAT_VERSION,
    id: crypto.randomBytes(6).toString('hex'),
    stage: s,
    task: TASKS[s],
    at: Date.now(),
    by: String(by || ''),
    engine,
    subject,
    bot,
    verdict
  };
  // Stage 2 asks for the admin's own description after a yes; stage 4 asks
  // what is wrong after a no; stage 5 takes an optional note either way.
  if (s === 2 && verdict === 'yes') record.answer = text(src.answer, 'Your description', true);
  if (s === 4 && verdict === 'no') record.comment = text(src.comment, 'The comment', true);
  if (s === 5 || s === 6) {
    const c = text(src.comment, 'The comment');
    if (c) record.comment = c;
  }
  return record;
}

export async function appendRecord(record) {
  await fsp.mkdir(TRAINING_DIR, { recursive: true });
  await fsp.appendFile(fileOf(record.stage), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/** Every record of one stage, oldest first. A torn last line is skipped. */
export async function readStage(stage) {
  let raw = '';
  try {
    raw = await fsp.readFile(fileOf(stageOf(stage)), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const lineText of raw.split('\n')) {
    if (!lineText.trim()) continue;
    try {
      out.push(JSON.parse(lineText));
    } catch {
      /* a write cut short by a crash; the lines before it are intact */
    }
  }
  return out;
}

/**
 * The corrections admins wrote under "Bad" eye answers, newest first: what
 * the eye is told before its next answers (eyeAgent.js gradeLessonsNote), so
 * a grade counts at once and not only after the next fine-tune.
 *
 * @param {number} [limit]
 * @returns {Promise<Array<{ question: string, comment: string, at: number, model: string }>>}
 */
export async function gradeLessons(limit = 20) {
  const rows = await readStage(6);
  const out = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    const r = rows[i];
    if (r.verdict !== 'no' || !r.comment) continue;
    out.push({ question: String(r.subject?.question || '').slice(0, 300), comment: String(r.comment).slice(0, 600), at: r.at, model: String(r.subject?.model || r.engine || '') });
  }
  return out;
}

/** Totals per stage, and the newest record of each so a page can offer "undo". */
export async function trainingStats() {
  const counts = {};
  const last = {};
  for (const s of STAGES) {
    const list = await readStage(s);
    counts[s] = {
      total: list.length,
      yes: list.filter((r) => r.verdict === 'yes').length,
      no: list.filter((r) => r.verdict === 'no').length
    };
    const newest = list[list.length - 1];
    last[s] = newest ? { id: newest.id, at: newest.at, by: newest.by, text: String(newest.bot?.text || '').slice(0, 140) } : null;
  }
  return { counts, last };
}

/** Take one record back out (an answer clicked by mistake). */
export async function removeRecord(stage, id) {
  const s = stageOf(stage);
  const list = await readStage(s);
  const keep = list.filter((r) => r.id !== id);
  if (keep.length === list.length) return false;
  const file = fileOf(s);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
  await fsp.rename(tmp, file);
  return true;
}

/**
 * The export: one header line, then every record of the chosen stages.
 * @param {number[]} [stages] all when empty
 */
export async function exportTraining(stages = []) {
  const chosen = stages.length ? [...new Set(stages.map(stageOf))].sort() : STAGES;
  const lines = [];
  const counts = {};
  for (const s of chosen) {
    const list = await readStage(s);
    counts[s] = list.length;
    for (const r of list) lines.push(JSON.stringify(r));
  }
  const header = { format: FORMAT, v: FORMAT_VERSION, exportedAt: Date.now(), stages: chosen, counts, tasks: TASKS };
  return `${[JSON.stringify(header), ...lines].join('\n')}\n`;
}
