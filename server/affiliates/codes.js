// ---------------------------------------------------------------------------
// server/affiliates/codes.js
// Affiliate codes: claiming one, and turning one back into an affiliate.
//
// Unlike trial codes (server/entitlements/codes.js) these are not generated
// and handed out. An affiliate picks their own, says it on streams and puts it
// in video descriptions, so it has to be a name rather than random characters.
// That changes what the rules are for: not "can this be guessed" but "can this
// be confused with something official, or with someone else's".
//
// The money lives in commissions.js. This file only decides who owns a code.
// ---------------------------------------------------------------------------

import { db } from '../entitlements/service.js';
import { writeAudit } from '../entitlements/audit.js';

export class AffiliateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AffiliateError';
    this.status = status;
  }
}

/** Percent of earnings a new affiliate starts on. */
export const DEFAULT_COMMISSION_PCT = Number(process.env.AIM4_AFFILIATE_PCT || 20);

/**
 * Codes nobody may claim.
 *
 * Two kinds. Words that would make a stranger's code look like it came from us
 * (ADMIN, SUPPORT, OFFICIAL), and words already meaningful somewhere in the
 * product or the URL space (FREE, TRIAL, ACCOUNT), where the confusion is with
 * a page rather than with the company.
 */
const RESERVED = new Set([
  'ADMIN', 'ADMINISTRATOR', 'AIM4', 'AIM', 'OFFICIAL', 'SUPPORT', 'HELP',
  'STAFF', 'MOD', 'MODERATOR', 'SYSTEM', 'ROOT', 'NULL', 'UNDEFINED', 'NONE',
  'API', 'WWW', 'MAIL', 'ACCOUNT', 'ACCOUNTS', 'BILLING', 'PADDLE', 'CHECKOUT',
  'FREE', 'TRIAL', 'PROMO', 'DISCOUNT', 'REFUND', 'TEAM', 'TEAMS', 'DEMO',
  'DEMOS', 'REPLAY', 'REPLAYS', 'LOGIN', 'SIGNUP', 'REGISTER', 'TEST'
]);

/** Uppercase, and only the characters a code may contain. */
export function normaliseCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 24);
}

/**
 * Why this code cannot be claimed, or null if it can.
 *
 * Shape rules match the check constraint in 0016_affiliates.sql. Duplicated
 * deliberately: the constraint is what guarantees it, this is what explains it
 * to the person typing, and a 23505 is not an explanation.
 */
export function codeProblem(raw) {
  const code = normaliseCode(raw);
  if (!code) return 'Pick a code.';
  if (code.length < 3) return 'A code needs at least 3 characters.';
  if (code.length > 24) return 'A code can be at most 24 characters.';
  if (!/^[A-Z0-9]/.test(code)) return 'A code has to start with a letter or a number.';
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
    return 'A code can only hold letters, numbers, dashes and underscores.';
  }
  if (RESERVED.has(code)) return 'That code is reserved. Pick another one.';
  return null;
}

/** A starting suggestion, from whatever we know the person as. */
export function suggestCode(seed) {
  const base = normaliseCode(seed).replace(/[_-]+$/, '');
  if (base.length >= 3 && !RESERVED.has(base)) return base;
  // Padded rather than rejected: someone called "Ed" should still be offered
  // something, and the suffix is what makes it long enough to be a code.
  const padded = `${base}${Math.floor(Math.random() * 9000) + 1000}`;
  return padded.slice(0, 24);
}

/** The affiliate row for a user, or null. */
export async function affiliateForUser(userId) {
  if (!userId) return null;
  return db.selectOne('affiliates', { select: '*', user_id: `eq.${userId}` });
}

/** The affiliate behind a code, or null. Case-insensitive, like the index. */
export async function affiliateForCode(rawCode) {
  const code = normaliseCode(rawCode);
  if (!code) return null;
  // PostgREST cannot query the functional index directly, so match with
  // `ilike` on the exact string: no wildcards, so it is still an equality
  // test, just a case-insensitive one.
  const rows = await db.select('affiliates', { select: '*', code: `ilike.${code}`, limit: 2 });
  return rows?.[0] || null;
}

/**
 * Claim a code for a user.
 *
 * One code per account, and the code cannot be changed afterwards: it is
 * already printed in video descriptions by the time anyone wants to change it,
 * and a changed code silently stops attributing the links that carry it.
 */
export async function claimCode({ userId, code, req = null }) {
  if (!userId) throw new AffiliateError('Sign in first.', 401);

  const existing = await affiliateForUser(userId);
  if (existing) {
    throw new AffiliateError(`You already have the code ${existing.code}.`, 409);
  }

  const problem = codeProblem(code);
  if (problem) throw new AffiliateError(problem);
  const wanted = normaliseCode(code);

  // Checked before inserting so the common case gets a sentence rather than a
  // constraint violation. The unique index is still what decides: two people
  // claiming the same code at once both pass this and one loses below.
  if (await affiliateForCode(wanted)) {
    throw new AffiliateError('That code is taken. Pick another one.', 409);
  }

  let row;
  try {
    row = await db.insert('affiliates', [
      {
        user_id: userId,
        code: wanted,
        commission_pct: DEFAULT_COMMISSION_PCT,
        recurring: true,
        status: 'active'
      }
    ]);
  } catch (err) {
    if (err?.status === 409 || err?.details?.code === '23505') {
      throw new AffiliateError('That code is taken. Pick another one.', 409);
    }
    throw err;
  }

  await writeAudit({
    actorId: userId,
    action: 'affiliate.claim',
    targetUser: userId,
    payload: { code: wanted, commissionPct: row.commission_pct },
    req
  });
  return row;
}

/**
 * Admin: change the terms of one affiliate.
 *
 * `commission_pct` here only affects commissions earned AFTER the change.
 * Every ledger row freezes the rate it was earned at (see the table comment),
 * so this cannot restate history.
 */
export async function updateAffiliate({ affiliateId, patch = {}, actorId, req = null }) {
  if (!actorId) throw new AffiliateError('actorId is required.', 500);
  if (!affiliateId) throw new AffiliateError('An affiliate id is required.');

  const next = {};
  if (patch.commissionPct !== undefined) {
    const pct = Number(patch.commissionPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new AffiliateError('A commission has to be between 0 and 100 percent.');
    }
    next.commission_pct = pct;
  }
  if (patch.recurring !== undefined) next.recurring = Boolean(patch.recurring);
  if (patch.maxMonths !== undefined) {
    if (patch.maxMonths === null || patch.maxMonths === '') next.max_months = null;
    else {
      const m = Number(patch.maxMonths);
      if (!Number.isInteger(m) || m < 1) {
        throw new AffiliateError('A month limit has to be a whole number above zero.');
      }
      next.max_months = m;
    }
  }
  if (patch.status !== undefined) {
    if (!['active', 'suspended'].includes(patch.status)) {
      throw new AffiliateError(`Unknown status: ${patch.status}`);
    }
    next.status = patch.status;
    next.suspended_at = patch.status === 'suspended' ? new Date().toISOString() : null;
    next.suspended_reason = patch.status === 'suspended' ? patch.reason || null : null;
  }
  if (patch.note !== undefined) next.note = String(patch.note || '').slice(0, 500) || null;
  if (patch.paddleDiscountId !== undefined) {
    next.paddle_discount_id = String(patch.paddleDiscountId || '') || null;
  }
  if (!Object.keys(next).length) throw new AffiliateError('Nothing to change.');
  next.updated_at = new Date().toISOString();

  const [row] = await db.update('affiliates', { id: `eq.${affiliateId}` }, next);
  if (!row) throw new AffiliateError('No such affiliate.', 404);

  await writeAudit({
    actorId,
    action: 'affiliate.update',
    targetUser: row.user_id,
    payload: { affiliateId, ...next },
    req
  });
  return row;
}

/** Every affiliate, newest first. */
export async function listAffiliates({ status = null, limit = 200 } = {}) {
  const params = { select: '*', order: 'created_at.desc', limit };
  if (status) params.status = `eq.${status}`;
  return db.select('affiliates', params);
}
