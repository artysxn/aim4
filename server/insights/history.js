// ---------------------------------------------------------------------------
// server/insights/history.js
// The comeback history pack: one line per settled esports match with its start
// price and its in-game price path, so a comeback bot can be replayed over a
// year in a second.
//
//   packs/comeback-pack.ndjson.gz    the base year (built offline, uploaded once)
//   packs/comeback-recent.ndjson     every match settled since, appended here
//
// Line: { g, id, cid, s, f, low, tier, n:[teamA, teamB], w, pre, e, p }
//   g     game: cs2 | valorant | lol | dota2 | r6
//   s, e  start and last-trade time (unix seconds)
//   f     series length (BO1/BO3/BO5)
//   low   low tier (CS2: both teams outside the VRS top 30; others: league tier 3-5 or none)
//   n, w  the two teams (match-market outcomes) and the winner's index
//   pre   team A's price before the start (last $50+ trade in the 90 minutes before)
//   p     flat [secondsAfterStart, teamA price x 1000, ...], in-game trades of $2+,
//         equal consecutive prices collapsed
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as pm from './polymarket.js';
import { insightsDir, logLine } from './store.js';

const dir = () => path.join(insightsDir(), 'packs');
const BASE = 'comeback-pack.ndjson.gz';
const RECENT = 'comeback-recent.ndjson';
const IDLE_MS = 10 * 60e3;

let cache = null; // { key, matches, at }
let dropTimer = null;

function fileKey() {
  const parts = [BASE, RECENT].map((f) => {
    try {
      const st = fs.statSync(path.join(dir(), f));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return '-';
    }
  });
  return parts.join('|');
}

/** Every match in the pack (base + recent), parsed once and dropped after 10 idle minutes. */
export function loadPack() {
  const key = fileKey();
  if (!cache || cache.key !== key) {
    const out = [];
    const seen = new Set();
    const eat = (text) => {
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (seen.has(r.cid)) continue;
          seen.add(r.cid);
          out.push(r);
        } catch {
          /* a torn last line */
        }
      }
    };
    try {
      eat(zlib.gunzipSync(fs.readFileSync(path.join(dir(), BASE))).toString());
    } catch {
      /* no base pack yet */
    }
    try {
      eat(fs.readFileSync(path.join(dir(), RECENT), 'utf8'));
    } catch {
      /* nothing appended yet */
    }
    out.sort((a, b) => a.s - b.s);
    cache = { key, matches: out };
  }
  clearTimeout(dropTimer);
  dropTimer = setTimeout(() => (cache = null), IDLE_MS);
  dropTimer.unref?.();
  return cache.matches;
}

export function packInfo() {
  const m = loadPack();
  const games = {};
  for (const r of m) games[r.g] = (games[r.g] || 0) + 1;
  return { matches: m.length, games, from: m[0]?.s || null, to: m[m.length - 1]?.s || null };
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** A pack line for one settled match market, from its full trade history. */
export async function buildLine(ev, m, win) {
  if (win !== 0 && win !== 1) return null;
  const names = m.outcomes;
  const trades = [];
  let cursor = '';
  for (let page = 0; page < 8; page++) {
    const body = await pm.listTrades({ condition: m.conditionId, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const t of body?.data || []) if (t.condition_id === m.conditionId && names.includes(t.outcome)) trades.push({ t: t.timestamp, o: t.outcome, p: Number(t.price), s: Number(t.size) });
    cursor = body?.pagination?.next_cursor || '';
    if (!cursor || !body?.pagination?.has_more) break;
  }
  const tr = trades.filter((t) => t.s * t.p >= 2).sort((a, b) => a.t - b.t);
  if (tr.length < 20 || !ev.start) return null;
  const s0 = Math.round(ev.start / 1000);
  const pA = (t) => (t.o === names[0] ? t.p : 1 - t.p);
  const preTr = tr.filter((t) => t.t >= s0 - 5400 && t.t < s0);
  if (preTr.length < 3) return null;
  const big = preTr.filter((t) => t.s * t.p >= 50);
  const pre = big.length ? pA(big[big.length - 1]) : median(preTr.map(pA));
  const inGame = tr.filter((t) => t.t >= s0);
  const p = [];
  let last = -1;
  inGame.forEach((t, i) => {
    const v = Math.round(pA(t) * 1000);
    if (v === last && i !== inGame.length - 1) return;
    last = v;
    p.push(t.t - s0, v);
  });
  if (p.length < 6) return null;
  const game = ev.game || 'cs2';
  const tier = Number(ev.tier) || 0;
  const low = game === 'cs2' ? (ev.vrs || []).every((r) => !r || r > 30) : tier === 0 || tier >= 3;
  return { g: game, id: ev.id, cid: m.conditionId, s: s0, f: ev.format || '', low, tier, n: names, w: win, pre: Math.round(pre * 1000) / 1000, e: tr[tr.length - 1].t, p };
}

// Settled matches join the pack one at a time, in the background.
const queue = [];
let running = false;

/** Called when a tracked match market settles. */
export function queueSettled(ev, m, win) {
  if (m.kind !== 'match' || (win !== 0 && win !== 1)) return;
  queue.push({ ev: { ...ev, markets: undefined }, m, win });
  if (!running) drain();
}

async function drain() {
  running = true;
  while (queue.length) {
    const { ev, m, win } = queue.shift();
    try {
      const line = await buildLine(ev, m, win);
      if (line) {
        fs.mkdirSync(dir(), { recursive: true });
        fs.appendFileSync(path.join(dir(), RECENT), JSON.stringify(line) + '\n');
      }
    } catch (err) {
      logLine('warn', `history pack ${ev.title}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  running = false;
}
