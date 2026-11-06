// ---------------------------------------------------------------------------
// server/insights/recorder.js
// Every tick of every tracked match, on disk, so strategies can be replayed
// against what really happened (books, trades, scores), not 5-minute prices.
//
// Layout: <insights dir>/ticks/YYYY-MM-DD/<eventId>.ndjson, one line per
// record: {t, k, ...} with k = 'q' top-of-book snapshot (5 levels a side,
// written every 2 s while the top changed), 'x' trade, 's' score. Every level
// change would be ~7 GB a day; the top five levels are what fills and exits
// depend on. Only live matches and those starting within three hours are
// recorded. Yesterday's files are gzipped once the day is over.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import * as feeds from './feeds.js';
import { insightsDir } from './store.js';

const FLUSH_MS = 2000;
const SNAP_MS = 2000;
const LEVELS = 5;
const lastTop = new Map(); // token -> serialized top
let shouldRecord = () => true;
/** The engine says which events are worth recording (live or starting soon). */
export function setRecordFilter(fn) {
  shouldRecord = fn;
}

const buffers = new Map(); // file -> lines[]
let timer = null;
let unsub = [];
export const recStatus = { running: false, lines: 0, bytes: 0, lastFlush: 0, error: '' };

export function ticksDir() {
  return path.join(insightsDir(), 'ticks');
}

const day = (t) => new Date(t).toISOString().slice(0, 10);
const r4 = (x) => Math.round(Number(x) * 10000) / 10000;

function push(eventId, t, rec) {
  if (!eventId) return;
  const file = path.join(ticksDir(), day(t), `${eventId}.ndjson`);
  let buf = buffers.get(file);
  if (!buf) buffers.set(file, (buf = []));
  buf.push(JSON.stringify({ t, ...rec }));
  recStatus.lines++;
}

function onRaw(source, m, now) {
  if (source !== 'market' || m.event_type !== 'last_trade_price') return;
  const info = feeds.tokenInfo.get(m.asset_id);
  if (!info || !shouldRecord(info.eventId)) return;
  push(info.eventId, Number(m.timestamp) || now, { k: 'x', a: m.asset_id, p: r4(m.price), z: r4(m.size), d: m.side === 'BUY' ? 'b' : 's' });
}

/** Top five levels a side of every recorded token, when they changed. */
function snapshot() {
  const now = Date.now();
  for (const [token, b] of feeds.books) {
    const info = feeds.tokenInfo.get(token);
    if (!info || !b.at || !shouldRecord(info.eventId)) continue;
    const bids = [...b.bids].filter(([, z]) => z > 0).sort((x, y) => y[0] - x[0]).slice(0, LEVELS).map(([p, z]) => [r4(p), r4(z)]);
    const asks = [...b.asks].filter(([, z]) => z > 0).sort((x, y) => x[0] - y[0]).slice(0, LEVELS).map(([p, z]) => [r4(p), r4(z)]);
    const key = JSON.stringify([bids, asks]);
    if (lastTop.get(token) === key) continue;
    lastTop.set(token, key);
    push(info.eventId, now, { k: 'q', a: token, b: bids, s: asks });
  }
}

function onScore(eventId, prev, next) {
  push(eventId, next.at, { k: 's', sc: next.score, pe: next.period, l: next.live ? 1 : 0, e: next.ended ? 1 : 0 });
}

function flushNow() {
  for (const [file, lines] of buffers) {
    if (!lines.length) continue;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = lines.join('\n') + '\n';
      fs.appendFileSync(file, text);
      recStatus.bytes += text.length;
    } catch (err) {
      recStatus.error = err.message;
    }
    lines.length = 0;
  }
  buffers.clear();
  recStatus.lastFlush = Date.now();
}

/** Gzip finished days (anything before today, UTC). */
export function compactOldDays() {
  const today = day(Date.now());
  let dirs = [];
  try {
    dirs = fs.readdirSync(ticksDir());
  } catch {
    return 0;
  }
  let n = 0;
  for (const d of dirs) {
    if (d >= today) continue;
    const dir = path.join(ticksDir(), d);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ndjson')) continue;
      const src = path.join(dir, f);
      fs.writeFileSync(`${src}.gz`, zlib.gzipSync(fs.readFileSync(src)));
      fs.unlinkSync(src);
      n++;
    }
  }
  return n;
}

export function startRecorder() {
  if (recStatus.running) return;
  recStatus.running = true;
  unsub = [feeds.on('raw', onRaw), feeds.on('score', onScore)];
  timer = setInterval(flushNow, FLUSH_MS);
  timer.unref?.();
  const snap = setInterval(snapshot, SNAP_MS);
  snap.unref?.();
  unsub.push(() => clearInterval(snap));
  const compact = setInterval(() => {
    try {
      compactOldDays();
    } catch (err) {
      recStatus.error = err.message;
    }
  }, 3600e3);
  compact.unref?.();
}

export function stopRecorder() {
  recStatus.running = false;
  for (const u of unsub) u();
  unsub = [];
  clearInterval(timer);
  flushNow();
}

/** Every recorded match: [{ day, eventId, file, bytes }]. */
export function listRecordings() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(ticksDir()).sort();
  } catch {
    return out;
  }
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ticksDir(), d))) {
      const m = f.match(/^(.+)\.ndjson(\.gz)?$/);
      if (!m) continue;
      const file = path.join(ticksDir(), d, f);
      out.push({ day: d, eventId: m[1], file, bytes: fs.statSync(file).size });
    }
  }
  return out;
}

/** Read one recording, oldest line first. */
export async function readRecording(file) {
  const input = file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const out = [];
  for await (const line of rl) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn last line of a live file */
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function diskUsage() {
  return listRecordings().reduce((s, r) => s + r.bytes, 0);
}
