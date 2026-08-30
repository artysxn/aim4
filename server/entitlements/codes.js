// ---------------------------------------------------------------------------
// server/entitlements/codes.js
// Trial codes: minting them, and redeeming them into grants.
//
// Redeeming does not invent a new kind of access. It calls createGrant(), so a
// redeemed code is an entitlement_grants row like any other: time-aware at
// read, swept when it expires, revocable, and merged with a paid subscription
// by taking the stronger of the two. Everything that already understands
// grants understands trial codes for free.
//
// Promo codes are not here. A promo code discounts a payment, so it only means
// anything at checkout, so Paddle owns it. See server/billing/promoCodes.js.
// ---------------------------------------------------------------------------

import { PLAN_IDS } from '../../shared/entitlements/catalogue.js';
import { createGrant, ValidationError } from './grants.js';
import { writeAudit } from './audit.js';
import { db } from './service.js';

/**
 * The alphabet codes are generated from.
 *
 * No O/0, I/1, or U. The first two are the classic misreadings when someone
 * copies a code off a stream or a screenshot, and U is dropped because a random
 * four-letter run of consonants plus U produces real words often enough to be
 * worth avoiding on a code people paste in public.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';

const MAX_BATCH = 500;

/** Uppercase, and only the characters a code can contain. */
export function normaliseCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 64);
}

function randomBlock(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  // Rejection-free modulo bias is irrelevant at this alphabet size, but the
  // source has to be the CSPRNG: Math.random codes are guessable in bulk, and a
  // guessable trial code is free Elite for whoever guesses it.
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * `AIM4-X7K2-9PQR`, or whatever shape the prefix and blocks ask for.
 * Grouped because people read and retype these by hand.
 */
export function generateCode({ prefix = '', blocks = 2, blockLength = 4 } = {}) {
  const parts = [];
  const clean = normaliseCode(prefix).replace(/-+$/, '');
  if (clean) parts.push(clean);
  for (let i = 0; i < blocks; i++) parts.push(randomBlock(blockLength));
  return parts.join('-');
}

/**
 * Mint codes.
 *
 * `names` mints exactly those codes, for when someone wants MYSTREAM or
 * LAUNCHDAY rather than random noise. Otherwise `count` random ones are made.
 * A collision with an existing code is a unique-index violation, which is
 * reported rather than silently skipped: a batch that quietly returns fewer
 * codes than asked for is how people hand out a code that does not exist.
 *
 * @returns {Promise<{created: object[], rejected: {code: string, reason: string}[]}>}
 */
export async function mintCodes({
  planId,
  durationDays,
  count = 1,
  names = null,
  prefix = '',
  maxRedemptions = 1,
  expiresAt = null,
  batch = null,
  note = '',
  createdBy,
  req = null
}) {
  if (!createdBy) throw new ValidationError('createdBy is required.');
  if (!PLAN_IDS.includes(planId) || planId === 'free') {
    throw new ValidationError(`Unknown plan: ${planId}`);
  }
  const days = Number(durationDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new ValidationError('durationDays must be a whole number of days, 1 to 3650.');
  }
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    throw new ValidationError('maxRedemptions must be a positive whole number, or null.');
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    throw new ValidationError('expiresAt is not a date.');
  }

  let wanted;
  if (Array.isArray(names) && names.length) {
    wanted = names.map(normaliseCode).filter(Boolean);
    if (!wanted.length) throw new ValidationError('None of those names are usable as codes.');
  } else {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
      throw new ValidationError(`count must be a whole number, 1 to ${MAX_BATCH}.`);
    }
    wanted = new Set();
    // Generate into a Set so a collision inside one batch costs another draw
    // rather than a row that fails at insert.
    let guard = n * 20;
    while (wanted.size < n && guard-- > 0) wanted.add(generateCode({ prefix }));
    wanted = [...wanted];
  }

  const created = [];
  const rejected = [];
  for (const code of wanted) {
    try {
      const row = await db.insert('redemption_codes', [
        {
          code,
          plan_id: planId,
          duration_days: days,
          max_redemptions: maxRedemptions,
          expires_at: expiresAt,
          batch: batch || null,
          note: String(note || '').slice(0, 500) || null,
          created_by: createdBy
        }
      ]);
      created.push(row);
    } catch (err) {
      const duplicate = err?.status === 409 || err?.details?.code === '23505';
      rejected.push({ code, reason: duplicate ? 'already exists' : err?.message || 'insert failed' });
    }
  }

  await writeAudit({
    actorId: createdBy,
    action: 'code.mint',
    payload: {
      planId,
      durationDays: days,
      batch: batch || null,
      requested: wanted.length,
      created: created.length,
      rejected: rejected.length
    },
    req
  });

  return { created, rejected };
}

/**
 * Why a code cannot be used, or null if it can.
 * Split out so the admin list can show a reason without trying a redemption.
 */
export function codeProblem(row, nowMs = Date.now()) {
  if (!row) return 'That code was not recognised.';
  if (row.archived_at) return 'That code is no longer active.';
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return 'That code has expired.';
  if (row.max_redemptions !== null && row.times_redeemed >= row.max_redemptions) {
    return 'That code has already been used.';
  }
  return null;
}

/**
 * Redeem a code for a user.
 *
 * The order matters. The redemption row is written FIRST, because its unique
 * index on (code_id, user_id) is the only thing that actually stops a double
 * redemption: checking times_redeemed and then writing loses the race between
 * two tabs, and the prize for winning that race is a second free month.
 * The grant is created after the claim is held, and the counter moves last.
 *
 * @returns {Promise<{planId: string, expiresAt: string, durationDays: number}>}
 */
export async function redeemCode({ code, userId, req = null }) {
  if (!userId) throw new ValidationError('You need to be signed in to redeem a code.');
  const wanted = normaliseCode(code);
  if (!wanted) throw new ValidationError('Enter a code.');

  // Stored uppercase, so an exact match is a case-insensitive match.
  const row = await db.selectOne('redemption_codes', { select: '*', code: `eq.${wanted}` });
  const problem = codeProblem(row);
  if (problem) throw new ValidationError(problem);

  let redemption;
  try {
    redemption = await db.insert('code_redemptions', [{ code_id: row.id, user_id: userId }]);
  } catch (err) {
    if (err?.status === 409 || err?.details?.code === '23505') {
      throw new ValidationError('You have already redeemed that code.');
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + row.duration_days * 24 * 60 * 60 * 1000).toISOString();
  let grant;
  try {
    grant = await createGrant({
      userId,
      planId: row.plan_id,
      mode: 'upgrade',
      expiresAt,
      reason: `Trial code ${row.code}`,
      // Codes are minted by an admin, and the grant records that admin as the
      // granter. Self-granting would make the audit trail read as though the
      // user handed themselves a plan.
      grantedBy: row.created_by,
      req
    });
  } catch (err) {
    // The claim is held but nothing was granted. Give it back, or this account
    // can never redeem this code again and has nothing to show for it.
    await db.remove('code_redemptions', { id: `eq.${redemption.id}` }).catch(() => {});
    throw err;
  }

  await db.update(
    'redemption_codes',
    { id: `eq.${row.id}` },
    { times_redeemed: row.times_redeemed + 1 },
    { returning: false }
  );
  await db.update(
    'code_redemptions',
    { id: `eq.${redemption.id}` },
    { grant_id: grant?.id || null },
    { returning: false }
  );

  await writeAudit({
    actorId: userId,
    action: 'code.redeem',
    targetUser: userId,
    payload: { code: row.code, planId: row.plan_id, durationDays: row.duration_days, expiresAt },
    req
  });

  return { planId: row.plan_id, expiresAt, durationDays: row.duration_days };
}

/** Newest first, with a usable/unusable reason already worked out. */
export async function listCodes({ batch = null, includeArchived = false, limit = 200 } = {}) {
  const params = { select: '*', order: 'created_at.desc', limit };
  if (batch) params.batch = `eq.${batch}`;
  if (!includeArchived) params.archived_at = 'is.null';
  const rows = await db.select('redemption_codes', params);
  const now = Date.now();
  return rows.map((r) => ({ ...r, problem: codeProblem(r, now) }));
}

/** Stop a code working. Kept, not deleted: redemptions point at it. */
export async function archiveCodes({ ids = [], batch = null, actorId, req = null }) {
  if (!actorId) throw new ValidationError('actorId is required.');
  const patch = { archived_at: new Date().toISOString() };
  let rows = [];
  if (batch) {
    rows = await db.update('redemption_codes', { batch: `eq.${batch}`, archived_at: 'is.null' }, patch);
  } else if (ids.length) {
    rows = await db.update('redemption_codes', { id: `in.(${ids.join(',')})` }, patch);
  } else {
    throw new ValidationError('Give ids or a batch to archive.');
  }
  await writeAudit({
    actorId,
    action: 'code.archive',
    payload: { batch: batch || null, count: rows.length },
    req
  });
  return rows;
}
