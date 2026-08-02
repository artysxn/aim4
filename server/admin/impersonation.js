// ---------------------------------------------------------------------------
// server/admin/impersonation.js
// "View as" tickets.
//
// The tempting implementation is to mint a real Supabase session for the target
// user through the admin API. That is rejected here: it produces a token
// indistinguishable from the user's own, it shows up in their session list, and
// it cannot be scoped read-only or revoked without killing their real sessions.
//
// Instead the admin keeps their own bearer token and adds a second header:
//
//   Authorization: Bearer <the admin's own Supabase token>
//   X-Aim4-Impersonate: <ticket>
//
// Both are checked on every request. A leaked ticket is useless without the
// admin's live session, and a stolen admin session cannot impersonate without
// also minting a ticket, which is audited.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

export const IMPERSONATE_HEADER = 'x-aim4-impersonate';
const ISSUER = 'aim4:impersonation';
const DEFAULT_TTL_SECONDS = 30 * 60;

/**
 * HMAC key. An explicit secret is preferred, but deriving one from the service
 * role key keeps the feature working without a second variable to forget. Both
 * are server-only; neither is ever sent to a browser. Hashing rather than using
 * the key directly means a ticket cannot leak key material even in principle.
 */
function signingKey() {
  const explicit = process.env.AIM4_IMPERSONATION_SECRET || '';
  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const material = explicit || fallback;
  if (!material) return null;
  return crypto.createHash('sha256').update(`aim4:impersonation:${material}`).digest();
}

/**
 * Revoked ticket ids, so ending a session takes effect immediately rather than
 * at expiry. In memory, which is correct for a single backend process; a
 * multi-instance deploy needs this in Postgres, and until then a revoked ticket
 * on instance A still works on instance B for up to its 30 minute TTL.
 */
const revoked = new Map();

function sweepRevoked() {
  const now = Date.now();
  for (const [jti, expiresAt] of revoked) {
    if (expiresAt <= now) revoked.delete(jti);
  }
}

export function isEnabled() {
  return signingKey() !== null;
}

/**
 * @param {{actorId: string, targetId: string, ttlSeconds?: number, readOnly?: boolean}} opts
 * @returns {Promise<{ticket: string, jti: string, expiresAt: string}>}
 */
export async function mintTicket({
  actorId,
  targetId,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  readOnly = true
}) {
  const key = signingKey();
  if (!key) throw new Error('impersonation_not_configured');
  if (!actorId || !targetId) throw new Error('actorId and targetId are required');
  if (actorId === targetId) throw new Error('cannot impersonate yourself');

  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const ticket = await new SignJWT({ act: actorId, tgt: targetId, ro: Boolean(readOnly) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);

  return { ticket, jti, expiresAt: expiresAt.toISOString() };
}

/**
 * @returns {Promise<{actorId: string, targetId: string, readOnly: boolean, jti: string, exp: number}|null>}
 */
export async function verifyTicket(ticket) {
  const key = signingKey();
  if (!key || !ticket) return null;
  try {
    const { payload } = await jwtVerify(ticket, key, {
      issuer: ISSUER,
      algorithms: ['HS256']
    });
    if (!payload.act || !payload.tgt || !payload.jti) return null;
    sweepRevoked();
    if (revoked.has(payload.jti)) return null;
    return {
      actorId: String(payload.act),
      targetId: String(payload.tgt),
      readOnly: payload.ro !== false,
      jti: String(payload.jti),
      exp: Number(payload.exp) || 0
    };
  } catch {
    // Expired, tampered with, or signed by a different secret. All the same
    // answer: not impersonating.
    return null;
  }
}

export function revokeTicket(jti, expSeconds) {
  if (!jti) return;
  const expiresAt = expSeconds ? expSeconds * 1000 : Date.now() + DEFAULT_TTL_SECONDS * 1000;
  revoked.set(jti, expiresAt);
  sweepRevoked();
}

/** Test seam. */
export function _resetRevoked() {
  revoked.clear();
}

export function readTicketHeader(req) {
  const raw = req?.headers?.[IMPERSONATE_HEADER];
  return typeof raw === 'string' ? raw.trim() : '';
}
