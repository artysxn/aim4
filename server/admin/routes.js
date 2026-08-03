// ---------------------------------------------------------------------------
// server/admin/routes.js
// /api/admin/* — the dev and support panel.
//
// Every route calls requireAdmin() as its first statement. The client hides the
// /admin link from non-admins, but that is cosmetic: this file is the boundary.
//
// Three things here differ deliberately from the rest of the API:
//
//  1. No wildcard CORS. server/index.js answers everything else with
//     Access-Control-Allow-Origin: *, which is fine for a public demo library
//     and wrong for an endpoint that can grant subscriptions. Only configured
//     origins are echoed back.
//  2. Cache-Control: no-store on every response, so an admin view of someone
//     else's account cannot be served to anyone from an intermediary.
//  3. A rate limit, and an optional shared-secret header, so that an auth bug
//     alone is not sufficient to reach this surface.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { whoami } from '../replays/identity.js';
import { PLAN_IDS } from '../../shared/entitlements/catalogue.js';
import { listAudit, writeAudit } from '../entitlements/audit.js';
import { ValidationError, createGrant, listGrants, revokeGrant } from '../entitlements/grants.js';
import { invalidateUser, loadEntitlements } from '../entitlements/load.js';
import { recomputeUser } from '../entitlements/recompute.js';
import { invalidateAdmin, isSiteAdmin, siteAdmin } from '../entitlements/service.js';
import * as ingest from '../ingest/hltv/service.js';
import {
  assignSeat,
  cancelSubscription,
  createSubscription,
  listSeats,
  releaseSeat,
  startTrial
} from '../entitlements/subscriptions.js';
import { flushImpersonationAudit } from '../entitlements/audit.js';
import { mintTicket, revokeTicket, verifyTicket } from './impersonation.js';
import { applyContentOp, contentOps } from './content.js';
import { findByUsername, listUsers, userContent, userDetail } from './users.js';
import {
  listDemos,
  readRoundMeta,
  readRoundTicks,
  userDir
} from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';
import { refreshLibraryStats } from '../replays/statsIndex.js';
import { getZones } from '../zonesStore.js';

const statsIo = { userDir, readRoundMeta, readRoundTicks, getZones };

/** Only one full-library stats rebuild at a time. */
let statsRefreshRunning = null;

const MAX_BODY = 256 * 1024;

/** Origins allowed to call the admin API. Never `*`. */
function allowedOrigins() {
  const raw =
    process.env.AIM4_ADMIN_ORIGINS || 'https://aim4.io,https://www.aim4.io,http://localhost:5173';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function corsHeaders(req) {
  const origin = String(req.headers?.origin || '');
  const headers = {
    Vary: 'Origin',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Aim4-Impersonate, X-Aim4-Admin-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  };
  if (origin && allowedOrigins().has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(res, req, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ValidationError('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ValidationError('Invalid JSON body.');
  }
}

// ---------------------------------------------------------------------------
// Rate limiting. Fixed window per account, and per IP for callers who never get
// as far as being identified.
// ---------------------------------------------------------------------------

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.AIM4_ADMIN_RATE_LIMIT || 240);
const buckets = new Map();

function rateLimited(key) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_PER_WINDOW;
}

/**
 * Optional second factor for the whole prefix. When set, a request without the
 * matching header does not even reach the admin check, so a token bug alone
 * does not expose the panel.
 */
function secretOk(req) {
  const expected = process.env.AIM4_ADMIN_SECRET || '';
  if (!expected) return true;
  const given = String(req.headers['x-aim4-admin-secret'] || '');
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<boolean>} true when this request was an admin route.
 */
export async function handleAdminRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/admin')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return true;
  }

  const ip = req.socket?.remoteAddress || 'unknown';
  if (rateLimited(`ip:${ip}`)) {
    json(res, req, 429, { error: 'Too many requests.' });
    return true;
  }

  if (!secretOk(req)) {
    // Deliberately the same answer as "not an admin": a wrong secret must not
    // be distinguishable from an insufficiently privileged account.
    json(res, req, 404, { error: 'Not found' });
    return true;
  }

  const me = await whoami(req);

  // Impersonation is not a way to reach the admin API. whoami() already strips
  // admin while a ticket is active, so this is belt and braces.
  if (me.impersonating || !me.signedIn || !(await isSiteAdmin(me.id))) {
    json(res, req, 404, { error: 'Not found' });
    return true;
  }
  if (rateLimited(`admin:${me.id}`)) {
    json(res, req, 429, { error: 'Too many requests.' });
    return true;
  }

  try {
    return await route(req, res, url, me);
  } catch (err) {
    if (err instanceof ValidationError || err?.status === 400) {
      json(res, req, 400, { error: err.message });
      return true;
    }
    console.error('[admin]', err);
    json(res, req, 500, { error: err.message || 'Server error' });
    return true;
  }
}

async function route(req, res, url, me) {
  const p = url.pathname;
  const q = url.searchParams;

  // ---- who am I -----------------------------------------------------------
  if (req.method === 'GET' && p === '/api/admin/me') {
    const row = await siteAdmin(me.id);
    json(res, req, 200, {
      id: me.id,
      username: me.username,
      canImpersonate: row?.can_impersonate !== false,
      canGrant: row?.can_grant !== false,
      plans: PLAN_IDS,
      contentOps: contentOps()
    });
    return true;
  }

  // ---- users --------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/admin/users') {
    json(
      res,
      req,
      200,
      await listUsers({
        q: q.get('q') || '',
        tier: q.get('tier') || '',
        status: q.get('status') || '',
        page: Number(q.get('page') || 0),
        sort: q.get('sort') || 'created_at'
      })
    );
    return true;
  }

  if (req.method === 'GET' && p === '/api/admin/lookup') {
    const row = await findByUsername(String(q.get('username') || '').replace(/^@/, ''));
    json(res, req, row ? 200 : 404, row || { error: 'No such account.' });
    return true;
  }

  const userMatch = p.match(/^\/api\/admin\/users\/([0-9a-fA-F-]{36})(\/content)?$/);
  if (req.method === 'GET' && userMatch) {
    const userId = userMatch[1];
    if (userMatch[2]) {
      json(res, req, 200, await userContent(userId));
    } else {
      json(res, req, 200, await userDetail(userId));
    }
    return true;
  }

  // ---- grants -------------------------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/grants') {
    const body = await readJson(req);
    const row = await createGrant({ ...body, grantedBy: me.id, req });
    json(res, req, 201, { grant: row, grants: await listGrants(body.userId) });
    return true;
  }

  const grantMatch = p.match(/^\/api\/admin\/grants\/([0-9a-fA-F-]{36})$/);
  if (req.method === 'DELETE' && grantMatch) {
    const row = await revokeGrant({ grantId: grantMatch[1], actorId: me.id, req });
    json(res, req, 200, { grant: row });
    return true;
  }

  // ---- subscriptions ------------------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/subscriptions') {
    const body = await readJson(req);
    const row = await createSubscription({ ...body, actorId: me.id, source: 'admin', req });
    json(res, req, 201, { subscription: row });
    return true;
  }

  if (req.method === 'DELETE' && p.startsWith('/api/admin/subscriptions/')) {
    const id = p.slice('/api/admin/subscriptions/'.length);
    const atPeriodEnd = q.get('immediate') !== '1';
    const row = await cancelSubscription({ subscriptionId: id, atPeriodEnd, actorId: me.id, req });
    json(res, req, 200, { subscription: row });
    return true;
  }

  /**
   * One click, because during development this is used constantly: an
   * unexpiring Team Elite subscription with no billing attached.
   */
  if (req.method === 'POST' && p === '/api/admin/grant-elite') {
    const body = await readJson(req);
    if (!body.userId) throw new ValidationError('userId is required.');
    const row = await createSubscription({
      userId: body.userId,
      planId: 'team_elite',
      term: 'lifetime',
      periodEnd: null,
      source: 'admin',
      actorId: me.id,
      notes: body.reason || 'Infinite Elite, granted from the admin panel.',
      req
    });
    json(res, req, 201, { subscription: row });
    return true;
  }

  // ---- trials -------------------------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/trials') {
    const body = await readJson(req);
    const row = await startTrial({
      userId: body.userId,
      planId: body.planId,
      days: body.days,
      // Admin-granted trials bypass eligibility but stay distinguishable in
      // reporting, so a support gift is never mistaken for organic conversion.
      source: 'admin',
      skipEligibility: true,
      actorId: me.id,
      req
    });
    json(res, req, 201, { subscription: row });
    return true;
  }

  // ---- seats --------------------------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/seats') {
    const body = await readJson(req);
    const row = await assignSeat({ ...body, actorId: me.id, req });
    json(res, req, 201, { seat: row, seats: await listSeats(body.subscriptionId) });
    return true;
  }

  const seatMatch = p.match(/^\/api\/admin\/seats\/([0-9a-fA-F-]{36})$/);
  if (req.method === 'DELETE' && seatMatch) {
    const row = await releaseSeat({ seatId: seatMatch[1], actorId: me.id, req });
    json(res, req, 200, { seat: row });
    return true;
  }

  // ---- impersonation ------------------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/impersonate') {
    const admin = await siteAdmin(me.id);
    if (admin?.can_impersonate === false) {
      json(res, req, 403, { error: 'This admin account cannot impersonate.' });
      return true;
    }
    const body = await readJson(req);
    const targetId = String(body.targetId || '');
    if (!targetId) throw new ValidationError('targetId is required.');
    if (targetId === me.id) throw new ValidationError('You are already yourself.');
    if (await isSiteAdmin(targetId)) {
      // One admin laundering actions through another defeats the audit log.
      json(res, req, 403, { error: 'Admins cannot be impersonated.' });
      return true;
    }

    const readOnly = body.readOnly !== false;
    const ticket = await mintTicket({
      actorId: me.id,
      targetId,
      readOnly,
      ttlSeconds: Math.min(3600, Math.max(60, Number(body.ttlSeconds) || 1800))
    });

    await writeAudit({
      actorId: me.id,
      // Write-mode impersonation is its own action, because "I broke a
      // customer's stratbook while looking at it" needs to be searchable.
      action: readOnly ? 'impersonate.start' : 'impersonate.start.write',
      targetUser: targetId,
      payload: { jti: ticket.jti, expiresAt: ticket.expiresAt, readOnly },
      req
    });
    json(res, req, 201, { ...ticket, targetId, readOnly });
    return true;
  }

  if (req.method === 'DELETE' && p.startsWith('/api/admin/impersonate/')) {
    const ticket = decodeURIComponent(p.slice('/api/admin/impersonate/'.length));
    const claims = await verifyTicket(ticket);
    if (claims) {
      revokeTicket(claims.jti, claims.exp);
      await flushImpersonationAudit(claims.jti, req);
      await writeAudit({
        actorId: me.id,
        action: 'impersonate.end',
        targetUser: claims.targetId,
        payload: { jti: claims.jti },
        req
      });
    }
    json(res, req, 200, { ok: true });
    return true;
  }

  // ---- entitlement maintenance -------------------------------------------
  if (req.method === 'POST' && p === '/api/admin/recompute') {
    const body = await readJson(req);
    if (!body.userId) throw new ValidationError('userId is required.');
    invalidateUser(body.userId);
    invalidateAdmin(body.userId);
    const resolved = await recomputeUser(body.userId);
    json(res, req, 200, { entitlements: resolved });
    return true;
  }

  if (req.method === 'GET' && p === '/api/admin/entitlements') {
    const userId = q.get('userId') || '';
    if (!userId) throw new ValidationError('userId is required.');
    json(res, req, 200, { entitlements: await loadEntitlements(userId, { fresh: true }) });
    return true;
  }

  // ---- content ------------------------------------------------------------
  const contentMatch = p.match(/^\/api\/admin\/content\/([a-z]+)\/([a-zA-Z]+)$/);
  if (req.method === 'POST' && contentMatch) {
    const body = await readJson(req);
    const result = await applyContentOp({
      store: contentMatch[1],
      op: contentMatch[2],
      payload: body,
      actorId: me.id,
      req
    });
    json(res, req, 200, result);
    return true;
  }

  // ---- demo ingest --------------------------------------------------------
  //
  // Start/stop a long-running backfill. The ingester is a separate process, so
  // these only ever spawn it or signal it: a parser OOM must not be able to
  // take the API server down with it.
  if (req.method === 'GET' && p === '/api/admin/ingest') {
    json(res, req, 200, await ingest.status());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/start') {
    const result = await ingest.start();
    await writeAudit({
      actorId: me.id,
      action: 'ingest.start',
      payload: result,
      req
    });
    json(res, req, result.started ? 200 : 409, { ...result, ...(await ingest.status()) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/stop') {
    const result = await ingest.stop();
    await writeAudit({
      actorId: me.id,
      action: 'ingest.stop',
      payload: result,
      req
    });
    json(res, req, 200, { ...result, ...(await ingest.status()) });
    return true;
  }

  // ---- replay stats indexes -----------------------------------------------
  // Force-rebuild every ready demo's compact stats index from parsed round
  // data (PRW, possession, swing, …). Can take a long time on a large library.
  if (req.method === 'POST' && p === '/api/admin/stats/refresh') {
    if (statsRefreshRunning) {
      json(res, req, 409, {
        error: 'A statistics recalculation is already running.',
        startedAt: statsRefreshRunning.startedAt,
        startedBy: statsRefreshRunning.startedBy
      });
      return true;
    }
    const body = await readJson(req).catch(() => ({}));
    const force = body.force !== false;
    const startedAt = Date.now();
    statsRefreshRunning = { startedAt, startedBy: me.id };
    try {
      const records = await listDemos(SHARED_LIBRARY);
      const report = await refreshLibraryStats(statsIo, SHARED_LIBRARY, records, { force });
      await writeAudit({
        actorId: me.id,
        targetUser: null,
        action: 'stats.refresh',
        payload: {
          force,
          total: report.total,
          ready: report.ready,
          built: report.built,
          enriched: report.enriched,
          current: report.current,
          failed: report.failed,
          ms: Date.now() - startedAt
        },
        req
      });
      json(res, req, 200, { ok: true, force, ...report, ms: Date.now() - startedAt });
    } finally {
      statsRefreshRunning = null;
    }
    return true;
  }

  // ---- audit --------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/admin/audit') {
    json(res, req, 200, {
      entries: await listAudit({
        actorId: q.get('actorId') || '',
        targetUser: q.get('targetUser') || '',
        action: q.get('action') || '',
        limit: Number(q.get('limit') || 100),
        offset: Number(q.get('offset') || 0)
      })
    });
    return true;
  }

  json(res, req, 404, { error: 'Not found' });
  return true;
}
