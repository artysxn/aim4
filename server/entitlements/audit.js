// ---------------------------------------------------------------------------
// server/entitlements/audit.js
// Every admin action, written down.
//
// This is what makes impersonation defensible. If a user ever asks "did someone
// look at my account, and what did they do", the answer has to be a query, not
// a shrug. Writes are best-effort so a logging failure cannot block the action
// itself, but a failure is logged loudly rather than swallowed.
// ---------------------------------------------------------------------------

import { db, isConfigured } from './service.js';

/**
 * Trust the socket, not the header, unless a proxy is explicitly configured.
 * Exported because sharing detection (account/integrity.js) must read the SAME
 * address as the audit trail: two IP readers that disagree about the proxy is
 * how a spoofed X-Forwarded-For gets believed by exactly one of them.
 */
export function clientIp(req) {
  if (!req) return null;
  if (process.env.AIM4_TRUST_PROXY === '1') {
    // Behind Cloudflare there are TWO proxies (CF then Traefik), and
    // X-Forwarded-For's first entry is whatever the client typed before CF
    // appended the truth. CF-Connecting-IP carries exactly the address that
    // connected to Cloudflare's edge and passes through Traefik untouched, so
    // it wins whenever present.
    const cf = String(req.headers?.['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  const raw = req.socket?.remoteAddress || '';
  // Postgres `inet` rejects IPv4-mapped IPv6 in this form, and a malformed
  // value would fail the insert and lose the audit row entirely.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw || null;
}

/**
 * @param {{actorId: string, action: string, targetUser?: string|null, payload?: object, req?: object}} entry
 */
export async function writeAudit({ actorId, action, targetUser = null, payload = null, req = null }) {
  if (!actorId || !action) return null;
  if (!isConfigured()) return null;
  try {
    return await db.insert(
      'admin_audit_log',
      {
        actor_id: actorId,
        action,
        target_user: targetUser,
        payload,
        ip: clientIp(req),
        user_agent: String(req?.headers?.['user-agent'] || '').slice(0, 500) || null
      },
      { returning: false }
    );
  } catch (err) {
    console.error(`[audit] failed to record ${action} by ${actorId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Impersonated reads are coalesced.
//
// Every request served under a ticket is auditable, but browsing a busy account
// fires hundreds of GETs and writing a row for each would bury the interesting
// entries under noise and cost a write per request. One row per ticket per
// minute, carrying a count and the paths touched, keeps the trail useful.
// ---------------------------------------------------------------------------

const COALESCE_MS = 60 * 1000;
const MAX_PATHS = 25;
const pending = new Map();

export async function auditImpersonatedRequest({ actorId, targetId, jti, path, method, req }) {
  if (!jti) return;
  const existing = pending.get(jti);
  if (existing) {
    existing.count += 1;
    if (existing.paths.size < MAX_PATHS) existing.paths.add(`${method} ${path}`);
    return;
  }

  const entry = {
    actorId,
    targetId,
    count: 1,
    paths: new Set([`${method} ${path}`]),
    startedAt: new Date().toISOString()
  };
  pending.set(jti, entry);

  const timer = setTimeout(async () => {
    pending.delete(jti);
    await writeAudit({
      actorId: entry.actorId,
      action: 'impersonate.activity',
      targetUser: entry.targetId,
      payload: {
        jti,
        requests: entry.count,
        paths: [...entry.paths],
        from: entry.startedAt,
        to: new Date().toISOString()
      },
      req
    });
  }, COALESCE_MS);
  // A pending audit flush must never hold the process open at shutdown.
  timer.unref?.();
}

/** Flush any coalesced entries now, e.g. when a session ends. */
export async function flushImpersonationAudit(jti, req = null) {
  const entry = pending.get(jti);
  if (!entry) return;
  pending.delete(jti);
  await writeAudit({
    actorId: entry.actorId,
    action: 'impersonate.activity',
    targetUser: entry.targetId,
    payload: {
      jti,
      requests: entry.count,
      paths: [...entry.paths],
      from: entry.startedAt,
      to: new Date().toISOString()
    },
    req
  });
}

/** Read the log, newest first. Admin panel only. */
export async function listAudit({ actorId, targetUser, action, limit = 100, offset = 0 } = {}) {
  const params = {
    select: '*',
    order: 'created_at.desc',
    limit: Math.min(500, Math.max(1, Number(limit) || 100)),
    offset: Math.max(0, Number(offset) || 0)
  };
  if (actorId) params.actor_id = `eq.${actorId}`;
  if (targetUser) params.target_user = `eq.${targetUser}`;
  if (action) params.action = `eq.${action}`;
  return db.select('admin_audit_log', params);
}
