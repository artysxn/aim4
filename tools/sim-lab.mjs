#!/usr/bin/env node
// ---------------------------------------------------------------------------
// tools/sim-lab.mjs
// Local training overview. Loopback only. This is the PC-side control surface
// for extract, collect, train, eval, RL, and matches. aim4.io/sim stays the
// library/export page; gradients live here.
//
//   npm run sim:lab
//   tools/sim-lab.bat
//
// Binds 127.0.0.1. Heavy jobs are on for this process even when the site
// server has AIM4_SIM_WORKERS=0. Same job runner as /api/sim/jobs.
// ---------------------------------------------------------------------------

if (!process.env.AIM4_SIM_WORKERS) process.env.AIM4_SIM_WORKERS = '1';

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { ROOT } from '../server/replays/demoStore.js';
import { readRoundMeta, readRoundTicks } from '../server/sim/matches.js';
import { loadBake } from '../server/sim/bakes.js';
import { listExportableDemos } from '../server/sim/export.js';
import { availableMaps } from '../server/sim/bakes.js';
import { listGenerations, listModels } from '../server/sim/models.js';
import {
  getJob,
  hostStatus,
  listJobs,
  loadJobHistory,
  startJob,
  stopJob
} from '../server/sim/jobs.js';
import { listMatches } from '../server/sim/matches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_FILE = path.join(__dirname, 'sim-lab.html');
const VIEW_FILE = path.join(__dirname, 'sim-view.html');
const PORT = Number(process.env.AIM4_SIM_LAB_PORT || 8742);
const HOST = '127.0.0.1';

function isLoopback(req) {
  const ip = String(req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const bytes = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(bytes)
  });
  res.end(bytes);
}

async function readJson(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function listDatasets() {
  const dir = path.join(ROOT, 'sim', 'datasets');
  let files;
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    try {
      const st = await fsp.stat(p);
      out.push({ name: f, path: p, bytes: st.size, mtime: st.mtime.toISOString() });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return out;
}

/**
 * One request. Exported so the bind/auth rules can be tested without listen().
 */
export async function handleLabRequest(req, res) {
  if (!isLoopback(req)) {
    send(res, 403, { error: 'loopback only' });
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}`);
  const p = url.pathname;
  const method = req.method || 'GET';

  // ---- playback -----------------------------------------------------------
  //
  // The lab could list matches but never show one, which made "watch what the
  // bots did" a thing you had to run the whole website for. Three endpoints
  // and a canvas fix that: the tick buffer as bytes, the round meta as JSON,
  // and the map's radar image with the calibration that maps world units onto
  // its pixels.

  const ticksMatch = p.match(/^\/api\/round\/([A-Za-z0-9_.-]+)\/(\d+)\/ticks$/);
  if (method === 'GET' && ticksMatch) {
    const bytes = await readRoundTicks(ticksMatch[1], Number(ticksMatch[2]));
    if (!bytes) return send(res, 404, { error: 'no such round' });
    return send(res, 200, Buffer.from(bytes), 'application/octet-stream');
  }

  const metaMatch = p.match(/^\/api\/round\/([A-Za-z0-9_.-]+)\/(\d+)\/meta$/);
  if (method === 'GET' && metaMatch) {
    const meta = await readRoundMeta(metaMatch[1], Number(metaMatch[2]));
    if (!meta) return send(res, 404, { error: 'no such round' });
    return send(res, 200, meta);
  }

  // The site's own viewer runs here unmodified. radarRenderer.js and its
  // whole import chain are relative-specifier ESM with no bare imports, so a
  // browser can load them straight off disk: serving src/ and the radar PNGs
  // is the entire "port", and the lab draws exactly what /sim draws instead of
  // a second, worse renderer that would drift from it.
  const staticMatch = p.match(/^\/(src|maps)\/(.+)$/);
  if (method === 'GET' && staticMatch) {
    const root = staticMatch[1] === 'src'
      ? path.join(__dirname, '..', 'src')
      : path.join(__dirname, '..', 'public', 'maps');
    const rel = staticMatch[2].split('?')[0];
    if (rel.includes('..')) return send(res, 400, { error: 'no' });
    const file = path.join(root, rel);
    const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.png') ? 'image/png'
      : file.endsWith('.svg') ? 'image/svg+xml'
      : 'application/octet-stream';
    try {
      return send(res, 200, fs.readFileSync(file), type);
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  // The viewer is its own page, full height, with the roster and the feed
  // beside the map rather than a canvas wedged under a table.
  if (method === 'GET' && p === '/view') {
    return send(res, 200, fs.readFileSync(VIEW_FILE), 'text/html; charset=utf-8');
  }

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    send(res, 200, fs.readFileSync(HTML_FILE), 'text/html; charset=utf-8');
    return;
  }

  if (method === 'GET' && p === '/api/status') {
    send(res, 200, {
      replayDir: ROOT,
      host: hostStatus(),
      maps: await availableMaps()
    });
    return;
  }

  if (method === 'GET' && p === '/api/demos') {
    send(res, 200, { demos: await listExportableDemos() });
    return;
  }

  if (method === 'GET' && p === '/api/models') {
    send(res, 200, {
      models: await listModels(),
      generations: await listGenerations(),
      builtins: ['scripted', 'desire']
    });
    return;
  }

  if (method === 'GET' && p === '/api/datasets') {
    send(res, 200, { datasets: await listDatasets() });
    return;
  }

  if (method === 'GET' && p === '/api/matches') {
    send(res, 200, { matches: await listMatches() });
    return;
  }

  if (method === 'GET' && p === '/api/jobs') {
    const live = listJobs();
    const history = await loadJobHistory();
    const seen = new Set(live.jobs.map((j) => j.id));
    const jobs = [...live.jobs, ...history.filter((j) => !seen.has(j.id))].slice(0, 40);
    send(res, 200, { jobs, host: live.host });
    return;
  }

  const jobGet = p.match(/^\/api\/jobs\/([A-Za-z0-9_.-]+)$/);
  if (method === 'GET' && jobGet) {
    const job = getJob(jobGet[1]);
    if (!job) {
      send(res, 404, { error: 'no such job' });
      return;
    }
    send(res, 200, { job });
    return;
  }

  const jobStop = p.match(/^\/api\/jobs\/([A-Za-z0-9_.-]+)\/stop$/);
  if (method === 'POST' && jobStop) {
    send(res, 200, stopJob(jobStop[1]));
    return;
  }

  if (method === 'POST' && p === '/api/jobs') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      send(res, 400, { error: 'bad body' });
      return;
    }
    const result = await startJob(String(body.kind || ''), body.params || {});
    send(res, result.error ? 409 : 200, result);
    return;
  }

  send(res, 404, { error: 'Not found' });
}

function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn(plat === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export function startLabServer({ port = PORT, open = true } = {}) {
  const server = http.createServer((req, res) => {
    handleLabRequest(req, res).catch((err) => {
      console.error('[sim-lab]', err?.message || err);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    });
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log(`Sim lab ${url}`);
    console.log(`replay dir ${ROOT}`);
    if (open && process.env.AIM4_SIM_LAB_NO_OPEN !== '1') openBrowser(url);
  });
  return server;
}

const launchedDirectly = (() => {
  const here = fileURLToPath(import.meta.url);
  const argv = process.argv[1] && path.resolve(process.argv[1]);
  return Boolean(argv && path.normalize(here).toLowerCase() === path.normalize(argv).toLowerCase());
})();
if (launchedDirectly) startLabServer();
