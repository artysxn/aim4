// ---------------------------------------------------------------------------
// server/ingest/hltv/cursor.js
// Sequential HLTV demo-ID cursor. Survives restarts under stateDir.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';

const COMPLETED_KEEP = 200;

function cursorPath(cfg) {
  return path.join(cfg.stateDir, 'demo-cursor.json');
}

function defaults(cfg) {
  const start = Math.max(1, Number(cfg.demoStart) || 109575);
  const hint = Math.max(start, Number(cfg.demoHint) || start);
  return {
    nextId: start,
    lastSuccessId: null,
    highWaterId: hint,
    frontierKnown: false,
    frontierMisses: 0,
    completedAt: [],
    startId: start,
    updatedAt: null
  };
}

export async function readCursor(cfg) {
  const base = defaults(cfg);
  try {
    const raw = JSON.parse(await fsp.readFile(cursorPath(cfg), 'utf8'));
    const startId = Math.max(1, Number(raw.startId) || base.startId);
    const nextId = Math.max(startId, Number(raw.nextId) || startId);
    const hint = Math.max(startId, Number(cfg.demoHint) || startId);
    const frontierKnown = Boolean(raw.frontierKnown);
    const highWaterId = frontierKnown
      ? raw.highWaterId == null
        ? null
        : Number(raw.highWaterId)
      : Math.max(Number(raw.highWaterId) || 0, hint, nextId);
    return {
      nextId,
      lastSuccessId: raw.lastSuccessId == null ? null : Number(raw.lastSuccessId),
      highWaterId,
      frontierKnown,
      frontierMisses: Number(raw.frontierMisses) || 0,
      completedAt: Array.isArray(raw.completedAt)
        ? raw.completedAt.map(Number).filter(Number.isFinite)
        : [],
      startId,
      updatedAt: raw.updatedAt || null
    };
  } catch {
    return base;
  }
}

export async function writeCursor(cfg, cursor) {
  const next = {
    ...cursor,
    updatedAt: new Date().toISOString()
  };
  await fsp.mkdir(cfg.stateDir, { recursive: true });
  const file = cursorPath(cfg);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2));
  await fsp.rename(tmp, file);
  return next;
}

/** Jump the walker to a demo id (e.g. one the probe already proved works). */
export async function seekCursor(cfg, nextId) {
  const cursor = await readCursor(cfg);
  const id = Math.max(1, Math.floor(Number(nextId) || 0));
  if (!Number.isFinite(id) || id < 1) {
    throw new Error('nextId must be a positive demo id');
  }
  return writeCursor(cfg, {
    ...cursor,
    nextId: id,
    startId: Math.min(Number(cursor.startId) || id, id),
    frontierMisses: 0
  });
}

/** Mark demo id finished (success, duplicate, or permanent fail) and advance. */
export async function advanceCursor(cfg, cursor, { success = false } = {}) {
  const now = Date.now();
  const completedAt = [...(cursor.completedAt || []), now].slice(-COMPLETED_KEEP);
  const lastSuccessId = success
    ? Number(cursor.nextId)
    : cursor.lastSuccessId == null
      ? null
      : Number(cursor.lastSuccessId);
  const hint = Math.max(Number(cfg.demoHint) || 0, Number(cursor.startId) || 0);
  const highWaterId = cursor.frontierKnown
    ? Math.max(Number(cursor.highWaterId) || 0, lastSuccessId || 0) || null
    : Math.max(Number(cursor.highWaterId) || 0, hint, Number(cursor.nextId) + 1, lastSuccessId || 0);
  return writeCursor(cfg, {
    ...cursor,
    nextId: Number(cursor.nextId) + 1,
    lastSuccessId,
    highWaterId,
    frontierMisses: 0,
    completedAt
  });
}

/** Record a frontier 404 without advancing. */
export async function noteFrontierMiss(cfg, cursor) {
  const lastSuccessId =
    cursor.lastSuccessId != null
      ? Number(cursor.lastSuccessId)
      : Number(cursor.nextId) > Number(cursor.startId)
        ? Number(cursor.nextId) - 1
        : null;
  const highWaterId = lastSuccessId != null ? lastSuccessId : Number(cursor.highWaterId) || null;
  return writeCursor(cfg, {
    ...cursor,
    lastSuccessId,
    highWaterId,
    frontierKnown: true,
    frontierMisses: (Number(cursor.frontierMisses) || 0) + 1
  });
}

/** Completions in the last hour (for loops/hour). */
export function loopsPerHour(cursor, now = Date.now()) {
  const since = now - 60 * 60 * 1000;
  const n = (cursor.completedAt || []).filter((t) => t >= since).length;
  return n;
}

export function cursorProgress(cursor) {
  const startId = Number(cursor.startId) || 109575;
  const nextId = Number(cursor.nextId) || startId;
  const highWater = Math.max(
    Number(cursor.highWaterId) || 0,
    Number(cursor.lastSuccessId) || 0,
    nextId
  );
  const span = Math.max(1, highWater - startId + (cursor.frontierKnown ? 0 : 0));
  const done = Math.max(0, Math.min(span, nextId - startId));
  const atFrontier = Boolean(cursor.frontierKnown && Number(cursor.frontierMisses) > 0);
  const left = atFrontier ? 0 : Math.max(0, highWater - nextId + 1);
  return {
    startId,
    nextId,
    lastSuccessId: cursor.lastSuccessId,
    highWaterId: highWater,
    done,
    total: Math.max(span, done + left),
    left,
    percent: Math.round((done / Math.max(1, done + left || span)) * 1000) / 10,
    loopsPerHour: loopsPerHour(cursor),
    atFrontier,
    frontierMisses: Number(cursor.frontierMisses) || 0
  };
}
