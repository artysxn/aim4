// ---------------------------------------------------------------------------
// server/entitlements/quota.js
// Rolling window arithmetic, and the two calls that touch the counter table.
//
// The window rolls from first use: it opens the moment a user first spends the
// capability and closes 24h later, rather than everyone resetting together at
// midnight. That is what the FAQ promises, and it also avoids the thundering
// herd of a fixed reset.
//
// The arithmetic lives here as pure functions so the boundaries can be tested
// without a database. Everything is done in absolute milliseconds, never in
// calendar days, so a DST transition cannot shorten or lengthen a window: 24h
// after 01:30 on a spring-forward night is 24h, not 23.
// ---------------------------------------------------------------------------

import { db, isConfigured } from './service.js';

export const WINDOW_SECONDS = Number(process.env.AIM4_QUOTA_WINDOW_SECONDS || 86400);

const UNLIMITED = -1;

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** When does a window that opened at `windowStart` close? */
export function resetsAt(windowStart, windowSeconds = WINDOW_SECONDS) {
  const start = toMs(windowStart);
  return start == null ? null : new Date(start + windowSeconds * 1000);
}

/** Is a window that opened at `windowStart` still open? */
export function windowIsOpen(windowStart, now = Date.now(), windowSeconds = WINDOW_SECONDS) {
  const start = toMs(windowStart);
  if (start == null) return false;
  const nowMs = toMs(now) ?? Date.now();
  // A window_start in the future means the database clock ran ahead of this
  // box, or a row was written by a machine with a skewed clock. Treat it as
  // open rather than as closed: the alternative silently hands out a fresh
  // allowance every request until the clocks agree.
  if (start > nowMs) return true;
  return nowMs < start + windowSeconds * 1000;
}

/**
 * Uses left in the window. Unlimited stays unlimited; a closed window is a full
 * allowance again.
 */
export function remaining(limit, used, windowStart, now = Date.now(), windowSeconds = WINDOW_SECONDS) {
  if (Number(limit) === UNLIMITED) return UNLIMITED;
  if (Number(limit) <= 0) return 0;
  if (!windowIsOpen(windowStart, now, windowSeconds)) return Number(limit);
  return Math.max(0, Number(limit) - Number(used || 0));
}

/**
 * Spend one use, atomically.
 *
 * The check and the increment are one statement inside Postgres, so two
 * requests arriving together cannot both see "0 used" and both pass. Doing this
 * in Node would need a lock this server does not have.
 *
 * @returns {Promise<{allowed: boolean, used: number, limit: number, resetsAt: string|null, remaining: number}>}
 */
export async function consume(userId, capability, limit, { windowSeconds = WINDOW_SECONDS } = {}) {
  const numericLimit = Number(limit);

  if (numericLimit === UNLIMITED) {
    return { allowed: true, used: 0, limit: UNLIMITED, resetsAt: null, remaining: UNLIMITED };
  }
  if (numericLimit <= 0) {
    return { allowed: false, used: 0, limit: 0, resetsAt: null, remaining: 0 };
  }
  if (!userId || !isConfigured()) {
    // Cannot meter without the service role. Fail closed so a missing key does
    // not silently hand Free users unlimited quota'd features.
    return {
      allowed: false,
      used: 0,
      limit: numericLimit,
      resetsAt: null,
      remaining: 0,
      unmetered: true
    };
  }

  let rows;
  try {
    rows = await db.rpc('consume_quota', {
      p_user_id: userId,
      p_capability: capability,
      p_limit: numericLimit,
      p_window_seconds: windowSeconds
    });
  } catch (err) {
    console.warn(`[entitlements] consume_quota failed for ${capability}: ${err.message}`);
    return {
      allowed: false,
      used: 0,
      limit: numericLimit,
      resetsAt: null,
      remaining: 0
    };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    return { allowed: false, used: 0, limit: numericLimit, resetsAt: null, remaining: 0 };
  }

  const used = Number(row.used_count || 0);
  return {
    allowed: Boolean(row.allowed),
    used,
    limit: numericLimit,
    resetsAt: row.resets_at || null,
    remaining: Math.max(0, numericLimit - used)
  };
}

/** Read the open window without spending anything. For UI payloads. */
export async function peek(userId, capability, limit, { windowSeconds = WINDOW_SECONDS } = {}) {
  const numericLimit = Number(limit);
  if (numericLimit === UNLIMITED) {
    return { used: 0, limit: UNLIMITED, resetsAt: null, remaining: UNLIMITED };
  }
  if (numericLimit <= 0 || !userId || !isConfigured()) {
    return { used: 0, limit: Math.max(0, numericLimit), resetsAt: null, remaining: Math.max(0, numericLimit) };
  }

  let row = null;
  try {
    const rows = await db.rpc('peek_quota', {
      p_user_id: userId,
      p_capability: capability,
      p_window_seconds: windowSeconds
    });
    row = Array.isArray(rows) ? rows[0] : rows;
  } catch {
    row = null;
  }

  const used = Number(row?.used_count || 0);
  return {
    used,
    limit: numericLimit,
    resetsAt: row?.resets_at || null,
    remaining: Math.max(0, numericLimit - used)
  };
}

/** Nightly cleanup. Counter rows outlive their window by design, but not forever. */
export async function sweepCounters(olderThanHours = 48) {
  if (!isConfigured()) return 0;
  try {
    const result = await db.rpc('sweep_usage_counters', { p_older_than_hours: olderThanHours });
    return Number(result) || 0;
  } catch (err) {
    console.warn(`[entitlements] counter sweep failed: ${err.message}`);
    return 0;
  }
}
