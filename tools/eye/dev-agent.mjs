#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/eye/dev-agent.mjs
// A stand-in for the aim4 desktop app's aim4 eye, for working on the site
// without building the app: it links (or reuses a token), connects to the
// relay exactly the way the app does, and answers chats from a llama-server
// you started yourself.
//
//   llama-server -m model.gguf --jinja -c 16384 --port 8899
//   node tools/eye/dev-agent.mjs --base http://localhost:3784 --llama http://127.0.0.1:8899
//
// Options:
//   --base URL     the aim4 site (default http://localhost:3784)
//   --llama URL    the llama-server to answer with (default http://127.0.0.1:8899)
//   --token TOKEN  a device token; without one it links itself (local mode only,
//                  where every request is the owner)
//   --model ID     what to report as the loaded model (default qwen3.5-dev)
//
// It is also the reference for recorder/app/src/eye: same messages, same order.
// ---------------------------------------------------------------------------

import { WebSocket } from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith('--') ? [...out, [a.slice(2), all[i + 1]]] : out), [])
);
const BASE = (args.base || 'http://localhost:3784').replace(/\/$/, '');
const LLAMA = (args.llama || 'http://127.0.0.1:8899').replace(/\/$/, '');
const MODEL = args.model || 'qwen3.5-dev';

async function token() {
  if (args.token) return args.token;
  const res = await fetch(`${BASE}/api/eye/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'dev-agent' })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`link failed: ${body.error || res.status} (pass --token outside local mode)`);
  console.log(`linked as device ${body.device.id}`);
  return body.token;
}

/** Stream one chat from llama-server, forwarding each SSE data line. */
async function answer(ws, id, body, signal) {
  const res = await fetch(`${LLAMA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal
  });
  if (!res.ok) throw new Error(`llama-server answered ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const lineText = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!lineText.startsWith('data:')) continue;
      const data = lineText.slice(5).trim();
      if (data === '[DONE]') continue;
      ws.send(JSON.stringify({ type: 'chunk', id, data }));
    }
  }
}

async function main() {
  const t = await token();
  const health = await fetch(`${LLAMA}/health`).then((r) => r.ok).catch(() => false);
  if (!health) console.warn(`warning: ${LLAMA}/health is not answering yet`);
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/eye/agent`, { headers: { Authorization: `Bearer ${t}` } });
  const running = new Map();
  ws.on('open', () => {
    console.log('connected');
    ws.send(JSON.stringify({ type: 'hello', version: 'dev', platform: process.platform, hardware: { ramGb: 0, recommended: 'qwen3.5-4b' } }));
    ws.send(JSON.stringify({ type: 'status', state: 'ready', model: MODEL, message: `dev-agent → ${LLAMA}` }));
  });
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'chat') {
      const ctrl = new AbortController();
      running.set(msg.id, ctrl);
      console.log(`chat ${msg.id}: ${msg.body.messages.length} messages, ${msg.body.tools?.length || 0} tools`);
      ws.send(JSON.stringify({ type: 'status', state: 'busy', model: MODEL }));
      try {
        await answer(ws, msg.id, msg.body, ctrl.signal);
        ws.send(JSON.stringify({ type: 'done', id: msg.id }));
      } catch (err) {
        if (err.name !== 'AbortError') ws.send(JSON.stringify({ type: 'error', id: msg.id, message: err.message }));
      }
      running.delete(msg.id);
      ws.send(JSON.stringify({ type: 'status', state: 'ready', model: MODEL }));
    } else if (msg.type === 'cancel') {
      running.get(msg.id)?.abort();
    } else if (msg.type === 'command') {
      console.log(`command ${msg.command} ${JSON.stringify(msg.args)} (ignored by the dev agent)`);
    }
  });
  ws.on('close', (code) => {
    console.log(`disconnected (${code})`);
    process.exit(code === 4001 ? 0 : 1);
  });
  ws.on('unexpected-response', (_req, res) => {
    console.error(`refused: ${res.statusCode}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
