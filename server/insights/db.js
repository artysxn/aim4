// ---------------------------------------------------------------------------
// server/insights/db.js
// Decision records and model versions in SQLite (node:sqlite, built into
// Node 22). Decisions are the system's memory: every candidate trade, taken
// or not, with what each analyst said, the risk checks, the AI review, and
// what the price did afterwards. They are also the training data.
// ---------------------------------------------------------------------------

import path from 'node:path';
import fs from 'node:fs';
import { insightsDir } from './store.js';

let db = null;

function open() {
  if (db) return db;
  // node:sqlite prints an ExperimentalWarning once; it is stable enough here.
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  fs.mkdirSync(insightsDir(), { recursive: true });
  db = new DatabaseSync(path.join(insightsDir(), 'insights.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      strategy TEXT, variant TEXT, mode TEXT,
      event_id TEXT, condition_id TEXT, token TEXT, outcome TEXT, side TEXT,
      price REAL, p_market REAL, p_final REAL, edge REAL, stake REAL,
      action TEXT, reason TEXT,
      live INTEGER, start INTEGER,
      m5 REAL, m30 REAL, close REAL, result REAL, pnl REAL,
      json TEXT
    );
    CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);
    CREATE INDEX IF NOT EXISTS decisions_sv ON decisions(strategy, variant);
    CREATE INDEX IF NOT EXISTS decisions_ev ON decisions(event_id);
    CREATE INDEX IF NOT EXISTS decisions_cond ON decisions(condition_id);
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      adopted INTEGER NOT NULL DEFAULT 0,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS models_kind ON models(kind, at);
  `);
  return db;
}

const COLS = ['id', 'at', 'strategy', 'variant', 'mode', 'event_id', 'condition_id', 'token', 'outcome', 'side', 'price', 'p_market', 'p_final', 'edge', 'stake', 'action', 'reason', 'live', 'start'];

/** Store a decision. `d` carries the column fields plus anything else in `extra`. */
export function saveDecision(d) {
  const row = {
    id: d.id,
    at: d.at,
    strategy: d.strategy,
    variant: d.variant,
    mode: d.mode,
    event_id: d.eventId,
    condition_id: d.conditionId,
    token: d.token,
    outcome: d.outcome,
    side: d.side,
    price: d.price ?? null,
    p_market: d.pMarket ?? null,
    p_final: d.pFinal ?? null,
    edge: d.edge ?? null,
    stake: d.stake ?? null,
    action: d.action,
    reason: d.reason || '',
    live: d.live ? 1 : 0,
    start: d.start || 0
  };
  const json = JSON.stringify({ analysts: d.analysts, risk: d.risk, review: d.review, plan: d.plan, betId: d.betId, trigger: d.trigger, combined: d.combined, title: d.title, market: d.market });
  open()
    .prepare(`INSERT OR REPLACE INTO decisions (${COLS.join(',')}, json) VALUES (${COLS.map(() => '?').join(',')}, ?)`)
    .run(...COLS.map((c) => row[c]), json);
}

export function updateDecision(id, fields) {
  const allowed = ['action', 'reason', 'stake', 'm5', 'm30', 'close', 'result', 'pnl'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  open()
    .prepare(`UPDATE decisions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

/** Merge into the JSON blob (the AI review lands after the row is written). */
export function patchDecisionJson(id, patch) {
  const row = open().prepare('SELECT json FROM decisions WHERE id = ?').get(id);
  if (!row) return;
  const obj = { ...JSON.parse(row.json || '{}'), ...patch };
  open().prepare('UPDATE decisions SET json = ? WHERE id = ?').run(JSON.stringify(obj), id);
}

function hydrate(r) {
  if (!r) return null;
  const extra = JSON.parse(r.json || '{}');
  delete r.json;
  return { ...r, ...extra };
}

export function getDecision(id) {
  return hydrate(open().prepare('SELECT * FROM decisions WHERE id = ?').get(id));
}

/** Newest first, filtered. */
export function listDecisions({ strategy, variant, action, eventId, limit = 200, before } = {}) {
  const where = [];
  const args = [];
  if (strategy) where.push('strategy = ?') && args.push(strategy);
  if (variant) where.push('variant = ?') && args.push(variant);
  if (action === 'taken') where.push("action IN ('entered','queued','quoted','exited')");
  else if (action === 'skipped') where.push("action IN ('skipped','vetoed','review')");
  else if (action) where.push('action = ?') && args.push(action);
  if (eventId) where.push('event_id = ?') && args.push(eventId);
  if (before) where.push('at < ?') && args.push(before);
  const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`;
  return open().prepare(sql).all(...args, Math.min(2000, limit)).map(hydrate);
}

/** Decisions still waiting for a follow-up price. */
export function pendingFollowups(now) {
  return open()
    .prepare(
      `SELECT id, at, token, condition_id, side, price, start, live, m5, m30, close, result
       FROM decisions
       WHERE at > ? AND (
         (m5 IS NULL AND at <= ?) OR (m30 IS NULL AND at <= ?) OR
         (close IS NULL AND live = 0 AND start > 0 AND start <= ?)
       ) LIMIT 400`
    )
    .all(now - 3 * 86400e3, now - 5 * 60e3, now - 30 * 60e3, now);
}

export function decisionsForCondition(conditionId) {
  return open().prepare('SELECT id, token, side, price, stake, action FROM decisions WHERE condition_id = ? AND result IS NULL').all(conditionId);
}

/** Rows for training: decisions with their analyst blob and at least the 30-minute follow-up. */
export function trainingRows(since = 0) {
  return open()
    .prepare('SELECT * FROM decisions WHERE at >= ? AND m30 IS NOT NULL ORDER BY at ASC LIMIT 50000')
    .all(since)
    .map(hydrate);
}

/** Per variant: how its taken decisions did against the price at the start and 30 minutes later. */
export function variantStats() {
  return open()
    .prepare(
      `SELECT variant, COUNT(*) n,
         SUM(CASE WHEN close IS NOT NULL THEN 1 ELSE 0 END) nClose,
         AVG(CASE WHEN close IS NOT NULL AND side = 'BUY' THEN close - price END) clv,
         AVG(CASE WHEN m30 IS NOT NULL AND side = 'BUY' THEN m30 - price END) move30,
         SUM(CASE WHEN m30 IS NOT NULL THEN 1 ELSE 0 END) n30
       FROM decisions WHERE action IN ('entered','queued') GROUP BY variant`
    )
    .all();
}

export function counts() {
  const d = open();
  return {
    decisions: d.prepare('SELECT COUNT(*) n FROM decisions').get().n,
    taken: d.prepare("SELECT COUNT(*) n FROM decisions WHERE action IN ('entered','queued','quoted','exited')").get().n,
    followed: d.prepare('SELECT COUNT(*) n FROM decisions WHERE m30 IS NOT NULL').get().n
  };
}

// ---- models ---------------------------------------------------------------------

export function saveModel(kind, obj, adopted) {
  open().prepare('INSERT INTO models (at, kind, adopted, json) VALUES (?, ?, ?, ?)').run(Date.now(), kind, adopted ? 1 : 0, JSON.stringify(obj));
}

export function latestModel(kind, adoptedOnly = true) {
  const r = open()
    .prepare(`SELECT * FROM models WHERE kind = ? ${adoptedOnly ? 'AND adopted = 1' : ''} ORDER BY at DESC LIMIT 1`)
    .get(kind);
  return r ? { ...r, ...JSON.parse(r.json) } : null;
}

export function modelHistory(limit = 30) {
  return open()
    .prepare('SELECT id, at, kind, adopted, json FROM models ORDER BY at DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: r.id, at: r.at, kind: r.kind, adopted: Boolean(r.adopted), ...JSON.parse(r.json) }));
}

export function closeDb() {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
}
