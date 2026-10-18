// Put an exam (multiple choice) to a llama-server and grade the picks.
//
//   llama-server -m model.gguf --jinja -c 32768 --port 8899
//   node tools/eye/exam/run-exam.mjs --exam tools/eye/exam/exam-1.json --model qwen3.8-27b --runs 2
//
// Each run shuffles the options with its own seed, so a model that always
// says "a" scores like chance. The key and the grader's note are never sent.
// Writes <exam>.<model>.results.json beside the exam: picks, reasoning and answers.
import fs from 'node:fs';
import path from 'node:path';
import { SYSTEM_PROMPT } from '../../../src/replays/eye/eyeAgent.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const LLAMA = args.llama || 'http://127.0.0.1:8899';
const MODEL = args.model || 'local';
const RUNS = Number(args.runs || 2);
const exam = JSON.parse(fs.readFileSync(args.exam, 'utf8'));
const LETTERS = ['a', 'b', 'c', 'd'];

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function shuffle(n, rand) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const EXAM_NOTE =
  'This is an exam question, not a request about the database. No tools are available: answer from your Counter-Strike 2 knowledge. ' +
  'Pick the single best option. Start your reply with a line "ANSWER: <letter>", then explain in a few sentences why it is best and why each other option is worse.';

async function ask(content) {
  const res = await fetch(`${LLAMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content }
      ],
      stream: true,
      temperature: 0.6,
      max_tokens: 12000,
      chat_template_kwargs: { enable_thinking: true }
    })
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  let text = '';
  let thinking = '';
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      const d = JSON.parse(line.slice(5)).choices?.[0]?.delta || {};
      text += d.content || '';
      thinking += d.reasoning_content || '';
    }
  }
  return { text, thinking };
}

const results = [];
for (let run = 0; run < RUNS; run++) {
  const rand = rng(1000 + run);
  for (const [qi, item] of exam.questions.entries()) {
    const order = shuffle(item.options.length, rand); // order[shown] = original index
    const shown = order.map((o, i) => `${LETTERS[i]}) ${item.options[o]}`).join('\n');
    const key = LETTERS[order.indexOf(0)];
    const started = Date.now();
    const { text, thinking } = await ask(`${EXAM_NOTE}\n\nQuestion ${qi + 1} (${item.topic}):\n${item.q}\n\n${shown}`);
    const pick = (text.match(/ANSWER:\s*\**\s*([a-d])/i) || [])[1]?.toLowerCase() || null;
    const picked = pick ? order[LETTERS.indexOf(pick)] : null; // 0 is the key
    const row = { run, q: qi + 1, topic: item.topic, key, pick, correct: picked === 0, pickedOriginal: picked === null ? null : LETTERS[picked], seconds: Math.round((Date.now() - started) / 1000), thinkingChars: thinking.length, answer: text.trim() };
    results.push(row);
    console.log(`run ${run + 1} q${qi + 1}: picked ${pick} (orig ${row.pickedOriginal}) key ${key} ${row.correct ? 'RIGHT' : 'WRONG'} ${row.seconds}s`);
  }
}
const right = results.filter((r) => r.correct).length;
console.log(`\n${MODEL}: ${right}/${results.length} (${Math.round((100 * right) / results.length)}%)`);
const out = args.exam.replace(/\.json$/, `.${MODEL}.results.json`);
fs.writeFileSync(out, JSON.stringify({ model: MODEL, runs: RUNS, right, total: results.length, results }, null, 2));
console.log(`wrote ${path.resolve(out)}`);
