// Run: node server/eye/eye.test.js
//
// aim4 eye end to end on the server: link a device from a signed-in page,
// connect a fake desktop app over a real WebSocket with its token, and stream
// a chat from the page through the relay to the app and back.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-eye-'));
process.env.AIM4_EYE_DIR = dir;
// Local mode: every request is the one local owner, signed in.
process.env.AIM4_LOCAL = '1';
process.env.AIM4_LOCAL_DIR = path.join(dir, 'local');

const { handleEyeRequest } = await import('./routes.js');
const { EyeRelay } = await import('./relay.js');
const store = await import('./eyeStore.js');

const relay = new EyeRelay();
const wss = new WebSocketServer({ noServer: true });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!(await handleEyeRequest(req, res, url, relay))) {
    res.writeHead(404);
    res.end();
  }
});
server.on('upgrade', (req, socket, head) => void relay.handleUpgrade(wss, req, socket, head));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- nothing running yet ------------------------------------------------------

assert.deepEqual(await (await api('/api/eye/status')).json(), { online: false, ready: false, devices: [] });
let res = await api('/api/eye/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
assert.equal(res.status, 409, 'no app connected');
assert.match((await res.json()).error, /not running/);

// ---- link, then connect the app -------------------------------------------------

const linked = await (await api('/api/eye/link', { method: 'POST', body: JSON.stringify({ name: 'Test PC' }) })).json();
assert.match(linked.token, /^eye_/);
assert.equal(linked.device.name, 'Test PC');

// A wrong token never gets a socket.
const refused = await new Promise((resolve) => {
  const bad = new WebSocket(`${base.replace('http', 'ws')}/eye/agent`, { headers: { Authorization: 'Bearer eye_nope' } });
  bad.on('unexpected-response', (_req, r) => resolve(r.statusCode));
  bad.on('open', () => resolve('open'));
});
assert.equal(refused, 401);

const app = new WebSocket(`${base.replace('http', 'ws')}/eye/agent`, { headers: { Authorization: `Bearer ${linked.token}` } });
await new Promise((r) => app.on('open', r));
app.send(JSON.stringify({ type: 'hello', version: '0.2.0', platform: 'test', hardware: { ramGb: 32 } }));
app.send(JSON.stringify({ type: 'status', state: 'ready', model: 'qwen3.5-4b' }));
// The fake app answers every chat with two deltas and done; a cancel is noted.
const seen = { chats: [], cancels: [], commands: [] };
app.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'chat') {
    seen.chats.push(msg);
    if (msg.body.messages[0].content === 'hang') return;
    app.send(JSON.stringify({ type: 'chunk', id: msg.id, data: JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) }));
    app.send(JSON.stringify({ type: 'chunk', id: msg.id, data: JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) }));
    app.send(JSON.stringify({ type: 'done', id: msg.id }));
  } else if (msg.type === 'cancel') seen.cancels.push(msg.id);
  else if (msg.type === 'command') seen.commands.push(msg);
});
await wait(50);

const status = await (await api('/api/eye/status')).json();
assert.equal(status.online, true);
assert.equal(status.ready, true);
assert.equal(status.devices[0].model, 'qwen3.5-4b');
assert.equal(status.devices[0].hardware.ramGb, 32);

// ---- a chat, streamed ------------------------------------------------------------

res = await api('/api/eye/chat', {
  method: 'POST',
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'x' } }], secret: 'dropped' })
});
assert.equal(res.status, 200);
assert.match(res.headers.get('content-type'), /text\/event-stream/);
const text = await res.text();
assert.deepEqual(
  text.trim().split('\n\n').map((e) => e.replace(/^data: /, '')),
  ['{"choices":[{"delta":{"content":"Hel"}}]}', '{"choices":[{"delta":{"content":"lo"}}]}', '[DONE]']
);
assert.equal(seen.chats[0].body.stream, true, 'always streamed');
assert.equal(seen.chats[0].body.secret, undefined, 'only chat fields go to the app');
assert.equal(seen.chats[0].body.tools.length, 1);

// ---- the page going away cancels the answer ----------------------------------------

const ctrl = new AbortController();
const hanging = api('/api/eye/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hang' }] }), signal: ctrl.signal });
const hung = await hanging;
assert.equal(hung.status, 200);
ctrl.abort();
await wait(100);
assert.equal(seen.cancels.length, 1, 'the app is told to stop');

// ---- commands, devices, revoke ----------------------------------------------------

res = await api('/api/eye/command', { method: 'POST', body: JSON.stringify({ command: 'use-model', args: { model: 'qwen3.5-9b' } }) });
assert.equal(res.status, 200);
res = await api('/api/eye/command', { method: 'POST', body: JSON.stringify({ command: 'rm -rf' }) });
assert.equal(res.status, 409, 'unknown commands are not passed on');
await wait(50);
assert.deepEqual(seen.commands.map((c) => [c.command, c.args.model]), [['use-model', 'qwen3.5-9b']]);

const devices = (await (await api('/api/eye/devices')).json()).devices;
assert.equal(devices.length, 1);
assert.equal(devices[0].online, true);
assert.equal(devices[0].hash, undefined, 'the token hash never leaves the server');

const closed = new Promise((r) => app.on('close', (code) => r(code)));
res = await api(`/api/eye/devices/${linked.device.id}`, { method: 'DELETE' });
assert.equal(res.status, 200);
assert.equal(await closed, 4001, 'a revoked device is disconnected');
assert.equal(await store.deviceForToken(linked.token), null, 'and its token no longer works');

server.close();
await fsp.rm(dir, { recursive: true, force: true });
console.log('eye.test.js ok');
process.exit(0);
