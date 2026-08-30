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
import { archiveCodes, listCodes, mintCodes } from '../entitlements/codes.js';
import { archivePromoCode, createPromoCode, listPromoCodes } from '../billing/promoCodes.js';
import { listAffiliates, updateAffiliate } from '../affiliates/codes.js';
import {
  HOLD_DAYS,
  affiliateStats,
  approveDueCommissions,
  listCommissions,
  recordPayout,
  reverseCommission
} from '../affiliates/commissions.js';
import * as ingest from '../ingest/hltv/service.js';
import { cancelProbe, probeState, startProbe } from '../ingest/hltv/probe.js';
import { loadConfig as loadIngestConfig } from '../ingest/hltv/config.js';
import { resetPerf, snapshot } from '../perf.js';
import {
  proxyStatus,
  startProxyRefresh,
  writeProxySettings
} from '../ingest/hltv/proxyPool.js';
import { deleteIngestDisk, listIngestDisk } from '../ingest/hltv/disk.js';
import * as gdriveQueue from '../ingest/gdrive/queue.js';
import { countOpenTickets, listTickets, replyToTicket, setTicketStatus } from '../support/store.js';
import { pistolFixStatus, startPistolFixRun } from '../replays/pistolFixRunner.js';
import { dupeScanStatus, startDupeScan } from '../replays/dupeScan.js';
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
import { adminIntegrityDetail, liftProbation } from '../account/integrity.js';
import {
  listDemos,
  readRoundMeta,
  readRoundTicks,
  userDir
} from '../replays/demoStore.js';
import { SHARED_LIBRARY } from '../replays/auth.js';
import {
  normalizeStatsFields,
  refreshLibraryFields,
  refreshLibraryPositions,
  refreshLibraryRatings,
  refreshLibraryRoundTags,
  refreshLibraryStats,
  STATS_FIELD_GROUPS
} from '../replays/statsIndex.js';
import { rescanPlayerNames } from './rescanPlayerNames.js';
import { getZones } from '../zonesStore.js';
import {
  start as startTraining,
  status as trainingStatus,
  stop as stopTraining
} from '../training/service.js';
import { modelWeights } from '../training/weights.js';
import {
  getCoachSmokes,
  listCoachSmokeMaps,
  saveCoachSmokes
} from '../coachSmokesStore.js';
import { countPitchEdits, getPitchText, savePitchText } from '../pitchStore.js';
import {
  aimScanStatus,
  setAimScanPauseWhen,
  startAimScan,
  stopAimScan
} from '../replays/aimScan.js';

const statsIo = {
  userDir,
  readRoundMeta,
  readRoundTicks,
  getZones,
  getCoachUtilities: getCoachSmokes
};

/** Only one full-library stats rebuild at a time. */
let statsRefreshJob = null;
/** Selective field patch across stored stats indexes. */
let fieldsRefreshJob = null;
/** Positions/roles-only tick walk (separate from full stats rebuild). */
let positionsRefreshJob = null;
/** Round library re-tag: rewatches every round against the round definitions. */
let roundScanJob = null;
/** Rating 3.0 recompute across the shared library. */
let ratingsJob = null;
/** Steam-id display-name merge across the shared library. */
let playerNamesJob = null;

function jobStatus(job) {
  if (!job) return { running: false };
  const finishedAt = job.finishedAt || null;
  const ageMs = finishedAt ? Date.now() - finishedAt : Date.now() - job.startedAt;
  return {
    running: !job.finished,
    finished: Boolean(job.finished),
    stale: Boolean(job.finished && ageMs > 15 * 60 * 1000),
    startedAt: job.startedAt,
    finishedAt,
    startedBy: job.startedBy,
    force: job.force,
    kind: job.kind || null,
    done: job.done || 0,
    total: job.total || 0,
    percent: job.percent || 0,
    current: job.current || null,
    ms: job.finished && finishedAt ? finishedAt - job.startedAt : Date.now() - job.startedAt,
    report: job.report || null,
    error: job.error || null
  };
}

function statsRefreshStatus() {
  return jobStatus(statsRefreshJob);
}

function fieldsRefreshStatus() {
  const base = jobStatus(fieldsRefreshJob);
  return {
    ...base,
    fields: fieldsRefreshJob?.fields || base.report?.fields || [],
    fieldGroups: STATS_FIELD_GROUPS
  };
}

function positionsRefreshStatus() {
  return jobStatus(positionsRefreshJob);
}

function roundScanStatus() {
  return jobStatus(roundScanJob);
}

function ratingsStatus() {
  return jobStatus(ratingsJob);
}

function playerNamesStatus() {
  return jobStatus(playerNamesJob);
}

/**
 * The aim rescan stands aside for every job below.
 *
 * It is deliberately NOT one of them: it runs beside ordinary traffic for as
 * long as the library takes, so gating the admin tools on it would lock them
 * out for hours. What it must not do is write an entry while a full rebuild is
 * writing the same one, and that is what the pause is for.
 */
setAimScanPauseWhen(() => libraryJobBusy());

function libraryJobBusy() {
  return (
    (statsRefreshJob && !statsRefreshJob.finished) ||
    (fieldsRefreshJob && !fieldsRefreshJob.finished) ||
    (positionsRefreshJob && !positionsRefreshJob.finished) ||
    (roundScanJob && !roundScanJob.finished) ||
    (ratingsJob && !ratingsJob.finished) ||
    (playerNamesJob && !playerNamesJob.finished)
  );
}

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

  // ---- account integrity (sharing flags) -----------------------------------
  const integrityMatch = p.match(/^\/api\/admin\/users\/([0-9a-fA-F-]{36})\/integrity(\/lift)?$/);
  if (integrityMatch) {
    const userId = integrityMatch[1];
    if (req.method === 'GET' && !integrityMatch[2]) {
      json(res, req, 200, await adminIntegrityDetail(userId));
      return true;
    }
    // Lifting is the "evidence was provided" path: the user opened a ticket,
    // an admin believed them, the account starts clean.
    if (req.method === 'POST' && integrityMatch[2]) {
      const state = await liftProbation({ userId, actorId: me.id, req });
      json(res, req, 200, { ok: true, state });
      return true;
    }
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

  // ---- trial codes --------------------------------------------------------
  // Minting is a bulk operation on purpose: a batch of 200 single-use codes for
  // a giveaway is the normal case, and one-at-a-time is the same call with
  // count 1.
  if (req.method === 'GET' && p === '/api/admin/codes') {
    const batch = url.searchParams.get('batch') || null;
    const includeArchived = url.searchParams.get('archived') === '1';
    json(res, req, 200, { codes: await listCodes({ batch, includeArchived }) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/codes') {
    const body = await readJson(req);
    const result = await mintCodes({ ...body, createdBy: me.id, req });
    json(res, req, 201, result);
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/codes/archive') {
    const body = await readJson(req);
    const rows = await archiveCodes({ ...body, actorId: me.id, req });
    json(res, req, 200, { archived: rows.length });
    return true;
  }

  // ---- promo codes --------------------------------------------------------
  // These live in Paddle, so this is a proxy rather than a store. Reads go to
  // Paddle every time: a cached discount list is a list that can disagree with
  // what a customer is actually charged.
  if (req.method === 'GET' && p === '/api/admin/promo-codes') {
    json(res, req, 200, { promoCodes: await listPromoCodes({}) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/promo-codes') {
    const body = await readJson(req);
    const row = await createPromoCode(body);
    json(res, req, 201, { promoCode: row });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/promo-codes/archive') {
    const body = await readJson(req);
    const row = await archivePromoCode(body.id);
    json(res, req, 200, { promoCode: row });
    return true;
  }

  // ---- affiliates ---------------------------------------------------------
  // Rates, suspensions and payouts. All of it here rather than on the account
  // page, because every one of these is a money decision and the person it
  // benefits is the one who would otherwise be making it.
  if (req.method === 'GET' && p === '/api/admin/affiliates') {
    const rows = await listAffiliates({ status: url.searchParams.get('status') || null });
    // Each affiliate with what it has earned, so the list can be read without
    // opening every row. One stats query per affiliate is fine at this scale:
    // there are tens of these, not thousands.
    const affiliates = [];
    for (const row of rows) {
      affiliates.push({
        id: row.id,
        userId: row.user_id,
        code: row.code,
        commissionPct: Number(row.commission_pct),
        recurring: row.recurring,
        maxMonths: row.max_months,
        status: row.status,
        note: row.note,
        paddleDiscountId: row.paddle_discount_id,
        createdAt: row.created_at,
        stats: await affiliateStats(row.id)
      });
    }
    json(res, req, 200, { affiliates, holdDays: HOLD_DAYS });
    return true;
  }

  if (req.method === 'GET' && p === '/api/admin/affiliates/commissions') {
    const affiliateId = url.searchParams.get('affiliateId') || null;
    const status = url.searchParams.get('status') || null;
    json(res, req, 200, {
      commissions: await listCommissions({ affiliateId, status, limit: 500 })
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/affiliates/update') {
    const body = await readJson(req);
    const row = await updateAffiliate({
      affiliateId: body.affiliateId,
      patch: body,
      actorId: me.id,
      req
    });
    json(res, req, 200, { affiliate: row });
    return true;
  }

  // Move everything past its hold from pending to approved. Separate from
  // paying, so the amount owed is settled before anyone acts on it.
  if (req.method === 'POST' && p === '/api/admin/affiliates/approve') {
    const rows = await approveDueCommissions({ actorId: me.id, req });
    json(res, req, 200, { approved: rows.length });
    return true;
  }

  // Records a transfer that has ALREADY been made. Paddle pays the seller, not
  // the seller's affiliates, so nothing here can send money; this is the note
  // that says it was sent, and it closes the rows it covers.
  if (req.method === 'POST' && p === '/api/admin/affiliates/payout') {
    const body = await readJson(req);
    const result = await recordPayout({ ...body, actorId: me.id, req });
    json(res, req, 201, result);
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/affiliates/reverse') {
    const body = await readJson(req);
    const row = await reverseCommission({
      commissionId: body.commissionId,
      reason: body.reason,
      actorId: me.id,
      req
    });
    json(res, req, 200, { commission: row });
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
   * unexpiring top-tier subscription with no billing attached.
   */
  if (req.method === 'POST' && p === '/api/admin/grant-elite') {
    const body = await readJson(req);
    if (!body.userId) throw new ValidationError('userId is required.');
    const row = await createSubscription({
      userId: body.userId,
      // The strongest plan there is, read off the ladder rather than typed in,
      // so renaming the top tier again cannot silently break this button.
      planId: PLAN_IDS[PLAN_IDS.length - 1],
      term: 'lifetime',
      periodEnd: null,
      source: 'admin',
      actorId: me.id,
      notes: body.reason || 'Infinite top tier, granted from the admin panel.',
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

  // All library demos across every uploader (not ingest scratch Disk).
  if (req.method === 'GET' && p === '/api/admin/uploads') {
    const { ownerOf } = await import('../replays/visibility.js');
    const { loadStandingTeams } = await import('../replays/teamStandingsDb.js');
    const { resolveDemoTeams } = await import('../../src/replays/shared/teamStandings.js');
    const records = await listDemos(SHARED_LIBRARY, { fresh: true });
    const unnamedOnly = /^(1|true|yes)$/i.test(q.get('unnamed') || '');
    const standings = unnamedOnly ? loadStandingTeams() : null;
    const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 200));

    const mapped = [];
    for (const r of records) {
      const owner = ownerOf(r);
      const team1Name = r.team1?.name || (typeof r.team1 === 'string' ? r.team1 : '') || '';
      const team2Name = r.team2?.name || (typeof r.team2 === 'string' ? r.team2 : '') || '';
      let vrsTeam1 = null;
      let vrsTeam2 = null;
      let lacksVrsName = true;
      if (standings) {
        const resolved = resolveDemoTeams(r.players || [], standings);
        vrsTeam1 = resolved.team1?.name || null;
        vrsTeam2 = resolved.team2?.name || null;
        lacksVrsName = !resolved.team1 || !resolved.team2;
        if (unnamedOnly && !lacksVrsName) continue;
      }
      // Who is actually on each side. The rename dialog names a ROSTER, not a
      // string, and five names is what makes an invented label recognisable.
      const sideNames = (side) =>
        (r.players || [])
          .filter((pl) => (pl?.team === 2 ? 2 : 1) === side)
          .map((pl) => String(pl?.name || '').trim())
          .filter(Boolean)
          .slice(0, 5);
      mapped.push({
        id: r.id,
        map: r.mapName || r.map || '',
        team1: team1Name,
        team2: team2Name,
        team1Players: sideNames(1),
        team2Players: sideNames(2),
        score: r.score || null,
        status: r.status || '',
        source: r.source || '',
        visibility: owner.visibility,
        uploaderId: owner.id,
        uploaderName: owner.username,
        uploaderExplicit: Boolean(r.uploaderId || r.uploaderName),
        uploadedAt: r.uploadedAt || null,
        sizeBytes: r.sizeBytes || 0,
        roundCount: r.roundCount || (r.rounds || []).length || 0,
        lacksVrsName,
        vrsTeam1,
        vrsTeam2
      });
    }
    json(res, req, 200, {
      total: records.length,
      matched: mapped.length,
      unnamed: unnamedOnly,
      items: mapped.slice(0, limit)
    });
    return true;
  }

  const uploadTeamsMatch = p.match(/^\/api\/admin\/uploads\/([^/]+)\/teams$/);
  if (req.method === 'POST' && uploadTeamsMatch) {
    const demoId = decodeURIComponent(uploadTeamsMatch[1] || '');
    const body = await readJson(req);
    if (!demoId) {
      json(res, req, 400, { error: 'demo id required' });
      return true;
    }
    // Not just this demo: every unnamed side sharing the renamed roster's core
    // is the same team under a parser-invented label. See teamRescan.js.
    const { applyTeamRename } = await import('../replays/teamRescan.js');
    const { record, alsoRenamed, capped } = await applyTeamRename(
      statsIo,
      SHARED_LIBRARY,
      demoId,
      body.team1,
      body.team2
    );
    if (!record) {
      json(res, req, 404, { error: 'Replay not found.' });
      return true;
    }
    await writeAudit({
      actorId: me.id,
      action: 'uploads.renameTeams',
      payload: { demoId, team1: body.team1, team2: body.team2, alsoRenamed },
      req
    });
    json(res, req, 200, {
      ok: true,
      id: record.id,
      team1: record.team1,
      team2: record.team2,
      alsoRenamed,
      capped
    });
    return true;
  }

  // ---- team identity rescan -------------------------------------------------
  // Rebuild team identity for the whole library: rosters bind lineups across
  // name changes, filenames name the unnamed sides by elimination, and the
  // placeholder "some player's name" teams collapse into real ones. The job
  // runs detached with its position readable here; see replays/teamRescan.js.
  if (p === '/api/admin/teams/rescan') {
    const { startTeamRescan, teamRescanStatus } = await import('../replays/teamRescan.js');
    if (req.method === 'POST') {
      const started = startTeamRescan(statsIo, SHARED_LIBRARY);
      if (started) {
        await writeAudit({ actorId: me.id, action: 'teams.rescan', payload: {}, req });
      }
      json(res, req, started ? 202 : 409, {
        ok: started,
        ...(started ? {} : { error: 'A rescan is already running.' }),
        status: teamRescanStatus()
      });
      return true;
    }
    if (req.method === 'GET') {
      json(res, req, 200, teamRescanStatus());
      return true;
    }
  }

  // The teams database the last rescan built: identity, aliases, rosters.
  if (req.method === 'GET' && p === '/api/admin/teams') {
    const { readTeamIdentityStore } = await import('../replays/teamRescan.js');
    const store = await readTeamIdentityStore(statsIo, SHARED_LIBRARY);
    json(res, req, 200, store || { v: 0, teams: [], summary: null });
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

  if (req.method === 'GET' && p === '/api/admin/ingest/log') {
    const url = new URL(req.url, 'http://local');
    const tail = Number(url.searchParams.get('tail')) || 999;
    json(res, req, 200, await ingest.readIngestLog({ tail }));
    return true;
  }

  if (req.method === 'DELETE' && p === '/api/admin/ingest/log') {
    const result = await ingest.clearIngestLog();
    await writeAudit({
      actorId: me.id,
      action: 'ingest.log.clear',
      payload: result,
      req
    });
    json(res, req, 200, result);
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

  if (req.method === 'POST' && p === '/api/admin/ingest/hard-stop') {
    const result = await ingest.hardStop();
    await writeAudit({
      actorId: me.id,
      action: 'ingest.hardStop',
      payload: result,
      req
    });
    json(res, req, 200, { ...result, ...(await ingest.status()) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/restart') {
    const result = await ingest.hardRestart();
    await writeAudit({
      actorId: me.id,
      action: 'ingest.hardRestart',
      payload: result,
      req
    });
    json(res, req, 200, { ...result, ...(await ingest.status()) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/cursor') {
    const body = await readJson(req).catch(() => ({}));
    const nextId = Number(body?.nextId);
    if (!Number.isFinite(nextId) || nextId < 1) {
      json(res, req, 400, { error: 'nextId required' });
      return true;
    }
    const result = await ingest.seek(nextId);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.cursor.seek',
      payload: { nextId },
      req
    });
    json(res, req, 200, result);
    return true;
  }

  // One-shot download probe: can this server fetch, parse and package a demo
  // archive from a given URL? Runs in-process (network) plus a capped child
  // (parse); the panel polls GET for the step log.
  if (req.method === 'GET' && p === '/api/admin/ingest/probe') {
    json(res, req, 200, await probeState());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/probe') {
    const body = await readJson(req);
    const result = await startProbe(body.url);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.probe',
      payload: { url: String(body.url || '').slice(0, 500) },
      req
    });
    if (result.busy) {
      json(res, req, 409, { error: 'A probe is already running.', ...result });
      return true;
    }
    if (result.invalid) {
      json(res, req, 400, { error: result.error });
      return true;
    }
    json(res, req, 200, result);
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/probe/cancel') {
    const result = await cancelProbe();
    await writeAudit({ actorId: me.id, action: 'ingest.probe.cancel', payload: result, req });
    json(res, req, 200, { ...result, ...(await probeState()) });
    return true;
  }

  // ---- Google Drive queue --------------------------------------------------
  // Folders the ingest should also pull from: small tournaments hand demos
  // around in shared Drive folders, and this is where those links go when
  // HLTV is fully synced. Runs in-process like the probe; see gdrive/queue.js.
  if (req.method === 'GET' && p === '/api/admin/ingest/gdrive') {
    json(res, req, 200, await gdriveQueue.queueState());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/gdrive') {
    const body = await readJson(req);
    const result = await gdriveQueue.addJob(body.url);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.gdrive.add',
      payload: { url: String(body.url || '').slice(0, 500), added: Boolean(result.added) },
      req
    });
    if (result.invalid) {
      json(res, req, 400, { error: result.error });
      return true;
    }
    if (result.duplicate) {
      json(res, req, 409, { error: 'That folder is already queued.', ...(await gdriveQueue.queueState()) });
      return true;
    }
    json(res, req, 200, await gdriveQueue.queueState());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/gdrive/start') {
    const result = await gdriveQueue.startQueue();
    await writeAudit({ actorId: me.id, action: 'ingest.gdrive.start', payload: result, req });
    json(res, req, 200, { ...result, ...(await gdriveQueue.queueState()) });
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/gdrive/stop') {
    const result = await gdriveQueue.stopQueue();
    await writeAudit({ actorId: me.id, action: 'ingest.gdrive.stop', payload: result, req });
    json(res, req, 200, { ...result, ...(await gdriveQueue.queueState()) });
    return true;
  }

  const gdriveJob = p.match(/^\/api\/admin\/ingest\/gdrive\/jobs\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && gdriveJob) {
    const result = await gdriveQueue.removeJob(gdriveJob[1]);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.gdrive.remove',
      payload: { id: gdriveJob[1], removed: result.removed },
      req
    });
    if (!result.removed && result.reason === 'running') {
      json(res, req, 409, { error: 'Stop the queue before removing the running job.' });
      return true;
    }
    json(res, req, 200, { ...result, ...(await gdriveQueue.queueState()) });
    return true;
  }

  // ---- pistol-round repair -------------------------------------------------
  // One sweep over the stored library: trim glued knife rounds out of round 1
  // and renumber demos whose pistol round is missing. New parses fix
  // themselves in materialize; this is for what was already on disk.
  if (req.method === 'GET' && p === '/api/admin/replays/pistol-fix') {
    json(res, req, 200, pistolFixStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/replays/pistol-fix') {
    const body = await readJson(req).catch(() => ({}));
    const result = startPistolFixRun({ force: Boolean(body.force) });
    await writeAudit({
      actorId: me.id,
      action: 'replays.pistolFix',
      payload: { force: Boolean(body.force), ...result },
      req
    });
    json(res, req, result.busy ? 409 : 200, { ...result, ...pistolFixStatus() });
    return true;
  }

  // ---- duplicate matches ---------------------------------------------------
  // The same game imported twice (HLTV + Drive, a re-upload). Screened by
  // metadata, confirmed by identical round positions, then the copy with the
  // lower parser revision — or the older parse — is deleted.
  if (req.method === 'GET' && p === '/api/admin/replays/dupe-scan') {
    json(res, req, 200, dupeScanStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/replays/dupe-scan') {
    const body = await readJson(req).catch(() => ({}));
    // del defaults ON: the button's whole point is removing the copies.
    const del = body.del !== false;
    const result = startDupeScan({ del });
    await writeAudit({
      actorId: me.id,
      action: 'replays.dupeScan',
      payload: { del, ...result },
      req
    });
    json(res, req, result.busy ? 409 : 200, { ...result, ...dupeScanStatus() });
    return true;
  }

  // ---- support inbox -------------------------------------------------------
  // The admin half of /contact: read every ticket, answer, close. Answers
  // notify the ticket's owner; the store owns that coupling.
  if (req.method === 'GET' && p === '/api/admin/support') {
    const status = String(url.searchParams.get('status') || '');
    json(res, req, 200, {
      tickets: await listTickets({ status }),
      open: await countOpenTickets()
    });
    return true;
  }

  const supportReply = p.match(/^\/api\/admin\/support\/([A-Za-z0-9_-]+)\/reply$/);
  if (req.method === 'POST' && supportReply) {
    const body = await readJson(req);
    const result = await replyToTicket(supportReply[1], {
      text: body.text,
      asAdmin: true,
      by: me.username || 'admin'
    });
    await writeAudit({
      actorId: me.id,
      action: 'support.reply',
      payload: { ticket: supportReply[1] },
      req
    });
    if (result.error) {
      json(res, req, 400, { error: result.error });
      return true;
    }
    json(res, req, 200, result);
    return true;
  }

  const supportStatus = p.match(/^\/api\/admin\/support\/([A-Za-z0-9_-]+)\/status$/);
  if (req.method === 'POST' && supportStatus) {
    const body = await readJson(req);
    const result = await setTicketStatus(supportStatus[1], String(body.status || ''));
    await writeAudit({
      actorId: me.id,
      action: 'support.status',
      payload: { ticket: supportStatus[1], status: body.status },
      req
    });
    if (result.error) {
      json(res, req, 400, { error: result.error });
      return true;
    }
    json(res, req, 200, result);
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/gdrive/forget') {
    const result = await gdriveQueue.clearSeen();
    await writeAudit({ actorId: me.id, action: 'ingest.gdrive.forget', payload: result, req });
    json(res, req, 200, { ...result, ...(await gdriveQueue.queueState()) });
    return true;
  }

  // CloakBrowser proxy pool: admin knobs + refresh from the public list.
  if (req.method === 'GET' && p === '/api/admin/ingest/proxies') {
    json(res, req, 200, await proxyStatus(loadIngestConfig()));
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/proxies') {
    const body = await readJson(req);
    const cfg = loadIngestConfig();
    const settings = await writeProxySettings(cfg, {
      attempts: body.attempts,
      random: body.random
    });
    await writeAudit({
      actorId: me.id,
      action: 'ingest.proxies.settings',
      payload: settings,
      req
    });
    json(res, req, 200, await proxyStatus(cfg));
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/ingest/proxies/refresh') {
    const cfg = loadIngestConfig();
    const result = await startProxyRefresh(cfg);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.proxies.refresh',
      payload: { started: result.started, busy: result.busy },
      req
    });
    json(res, req, result.busy ? 409 : 200, result);
    return true;
  }

  // Scratch downloads: archives, demos, probe packages under workDir / probe/.
  if (req.method === 'GET' && p === '/api/admin/ingest/disk') {
    json(res, req, 200, await listIngestDisk(loadIngestConfig()));
    return true;
  }

  if (req.method === 'DELETE' && p === '/api/admin/ingest/disk') {
    const body = await readJson(req).catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const result = await deleteIngestDisk(loadIngestConfig(), ids);
    await writeAudit({
      actorId: me.id,
      action: 'ingest.disk.delete',
      payload: { deleted: result.deleted, freed: result.freed, errors: result.errors },
      req
    });
    json(res, req, 200, result);
    return true;
  }

  // ---- replay stats indexes -----------------------------------------------
  // Force-rebuild every ready demo's compact stats index from parsed round
  // --- model training ------------------------------------------------------
  // Both fitted models can be trained against the whole replay library from
  // here. A run is a detached child process, so it survives a deploy and cannot
  // take the API server down with it; progress is a file the child rewrites
  // atomically and this endpoint reads.
  const trainMatch = p.match(/^\/api\/admin\/training\/(duel|round)(\/start|\/stop|\/weights)?$/);
  if (trainMatch) {
    const kind = trainMatch[1];
    const action = trainMatch[2] || '';

    if (req.method === 'GET' && !action) {
      json(res, req, 200, await trainingStatus(kind));
      return true;
    }

    if (req.method === 'GET' && action === '/weights') {
      // The full parameter listing: current value, bounds, group, and the
      // scenarios each one is allowed to move. This is what makes the fit
      // inspectable rather than a black box.
      json(res, req, 200, await modelWeights(kind));
      return true;
    }

    if (req.method === 'POST' && action === '/start') {
      const body = await readJson(req).catch(() => ({}));
      const started = await startTraining(kind, {
        generations: body.generations,
        seed: body.seed,
        workers: body.workers,
        force: Boolean(body.force),
        startedBy: me.id
      });
      if (!started.ok) {
        json(res, req, started.error === 'already running' ? 409 : 400, {
          error: started.error,
          ...(started.status || {})
        });
        return true;
      }
      await writeAudit({
        actorId: me.id,
        targetUser: null,
        action: 'training.start',
        payload: { kind, generations: body.generations, seed: body.seed },
        req
      });
      json(res, req, 202, started.status);
      return true;
    }

    if (req.method === 'POST' && action === '/stop') {
      const stopped = await stopTraining(kind);
      if (stopped.ok) {
        await writeAudit({
          actorId: me.id,
          targetUser: null,
          action: 'training.stop',
          payload: { kind },
          req
        });
      }
      json(res, req, stopped.ok ? 200 : 409, {
        ...(stopped.error ? { error: stopped.error } : {}),
        ...(stopped.status || {})
      });
      return true;
    }
  }

  // data (PRW, possession, swing, duels, …). Runs in the background; poll
  // GET for progress. Can take a long time on a large library.
  if (req.method === 'GET' && p === '/api/admin/stats/refresh') {
    json(res, req, 200, statsRefreshStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/refresh') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...statsRefreshStatus(),
        positions: positionsRefreshStatus()
      });
      return true;
    }
    const body = await readJson(req).catch(() => ({}));
    const force = body.force !== false;
    const startedAt = Date.now();
    statsRefreshJob = {
      // Two panel buttons share this job: the full rebuild and the
      // stale-only enrichment. The kind tells the panel which one is live.
      kind: force ? 'stats' : 'stats-stale',
      startedAt,
      startedBy: me.id,
      force,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    // Detach from the request so the panel can poll progress instead of
    // holding one HTTP connection open for the whole library rebuild.
    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await refreshLibraryStats(statsIo, SHARED_LIBRARY, records, {
          force,
          onProgress: (p) => {
            if (!statsRefreshJob || statsRefreshJob.startedAt !== startedAt) return;
            statsRefreshJob.done = p.done;
            statsRefreshJob.total = p.total;
            statsRefreshJob.percent = p.percent;
            statsRefreshJob.current = p.current;
          }
        });
        if (!statsRefreshJob || statsRefreshJob.startedAt !== startedAt) return;
        statsRefreshJob.report = { ...report, ms: Date.now() - startedAt };
        statsRefreshJob.done = report.ready;
        statsRefreshJob.total = report.ready;
        statsRefreshJob.percent = 100;
        statsRefreshJob.current = null;
        statsRefreshJob.finished = true;
        statsRefreshJob.finishedAt = Date.now();
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
          req: null
        });
      } catch (err) {
        if (!statsRefreshJob || statsRefreshJob.startedAt !== startedAt) return;
        statsRefreshJob.error = err?.message || String(err);
        statsRefreshJob.finished = true;
        statsRefreshJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...statsRefreshStatus() });
    return true;
  }

  // Selective field patch: rewrite only chosen columns on stored indexes.
  if (req.method === 'GET' && p === '/api/admin/stats/refresh-fields') {
    json(res, req, 200, fieldsRefreshStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/refresh-fields') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...fieldsRefreshStatus(),
        stats: statsRefreshStatus(),
        positions: positionsRefreshStatus()
      });
      return true;
    }
    const body = await readJson(req).catch(() => ({}));
    const fields = normalizeStatsFields(body.fields);
    if (!fields.length) {
      json(res, req, 400, {
        error: 'Select at least one stats field to patch.',
        fieldGroups: STATS_FIELD_GROUPS
      });
      return true;
    }
    const startedAt = Date.now();
    fieldsRefreshJob = {
      kind: 'fields',
      startedAt,
      startedBy: me.id,
      force: true,
      fields,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await refreshLibraryFields(statsIo, SHARED_LIBRARY, records, {
          fields,
          onProgress: (pr) => {
            if (!fieldsRefreshJob || fieldsRefreshJob.startedAt !== startedAt) return;
            fieldsRefreshJob.done = pr.done;
            fieldsRefreshJob.total = pr.total;
            fieldsRefreshJob.percent = pr.percent;
            fieldsRefreshJob.current = pr.current;
          }
        });
        if (!fieldsRefreshJob || fieldsRefreshJob.startedAt !== startedAt) return;
        fieldsRefreshJob.report = { ...report, ms: Date.now() - startedAt };
        fieldsRefreshJob.done = report.ready;
        fieldsRefreshJob.total = report.ready;
        fieldsRefreshJob.percent = 100;
        fieldsRefreshJob.current = null;
        fieldsRefreshJob.finished = true;
        fieldsRefreshJob.finishedAt = Date.now();
        await writeAudit({
          actorId: me.id,
          targetUser: null,
          action: 'stats.refreshFields',
          payload: {
            fields,
            total: report.total,
            ready: report.ready,
            updated: report.updated,
            built: report.built,
            skipped: report.skipped,
            failed: report.failed,
            ms: Date.now() - startedAt
          },
          req: null
        });
      } catch (err) {
        if (!fieldsRefreshJob || fieldsRefreshJob.startedAt !== startedAt) return;
        fieldsRefreshJob.error = err?.message || String(err);
        fieldsRefreshJob.finished = true;
        fieldsRefreshJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...fieldsRefreshStatus() });
    return true;
  }

  // Positions / roles only: walk tick bins for player x/y samples. Does not
  // rebuild kill bags, PRW, possession, or other stats fields.
  if (req.method === 'GET' && p === '/api/admin/stats/refresh-positions') {
    json(res, req, 200, positionsRefreshStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/refresh-positions') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...positionsRefreshStatus(),
        stats: statsRefreshStatus()
      });
      return true;
    }
    const startedAt = Date.now();
    positionsRefreshJob = {
      kind: 'positions',
      startedAt,
      startedBy: me.id,
      force: true,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await refreshLibraryPositions(statsIo, SHARED_LIBRARY, records, {
          onProgress: (p) => {
            if (!positionsRefreshJob || positionsRefreshJob.startedAt !== startedAt) return;
            positionsRefreshJob.done = p.done;
            positionsRefreshJob.total = p.total;
            positionsRefreshJob.percent = p.percent;
            positionsRefreshJob.current = p.current;
          }
        });
        if (!positionsRefreshJob || positionsRefreshJob.startedAt !== startedAt) return;
        positionsRefreshJob.report = { ...report, ms: Date.now() - startedAt };
        positionsRefreshJob.done = report.ready;
        positionsRefreshJob.total = report.ready;
        positionsRefreshJob.percent = 100;
        positionsRefreshJob.current = null;
        positionsRefreshJob.finished = true;
        positionsRefreshJob.finishedAt = Date.now();
        await writeAudit({
          actorId: me.id,
          targetUser: '',
          action: 'stats.refresh_positions',
          payload: {
            total: report.total,
            ready: report.ready,
            updated: report.updated,
            skipped: report.skipped,
            failed: report.failed,
            ms: Date.now() - startedAt
          },
          req: null
        });
      } catch (err) {
        if (!positionsRefreshJob || positionsRefreshJob.startedAt !== startedAt) return;
        positionsRefreshJob.error = err?.message || String(err);
        positionsRefreshJob.finished = true;
        positionsRefreshJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...positionsRefreshStatus() });
    return true;
  }

  // Aim rating rescan. Unlike every other tool on this page it is a BACKGROUND
  // pass: it returns immediately, runs one demo at a time beside live traffic,
  // pauses while any library job holds the thread, and can be stopped. Opening
  // the Aim chapter for a player promotes that player's demos to the front of
  // the same queue (see /api/replays/aim/progress).
  if (req.method === 'GET' && p === '/api/admin/stats/rescan-aim') {
    json(res, req, 200, aimScanStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/rescan-aim') {
    const body = await readJson(req).catch(() => ({}));
    if (body.stop) {
      json(res, req, 200, stopAimScan());
      return true;
    }
    const force = body.force === true;
    let status;
    try {
      status = await startAimScan({ force, startedBy: me.id });
    } catch (err) {
      json(res, req, 503, { error: err?.message || 'Aim rescan is not available yet.' });
      return true;
    }
    await writeAudit({
      actorId: me.id,
      targetUser: null,
      action: 'stats.rescanAim',
      payload: { force, pending: status.pending },
      req
    });
    json(res, req, 202, { ok: true, started: true, ...status });
    return true;
  }

  // Round library only: rewatch every round and re-tag it against the round
  // type definitions. Drops the stored tags first, so editing a definition or
  // painting a map is picked up without a full stats rebuild.
  if (req.method === 'GET' && p === '/api/admin/stats/rescan-rounds') {
    json(res, req, 200, roundScanStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/rescan-rounds') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...roundScanStatus(),
        stats: statsRefreshStatus(),
        positions: positionsRefreshStatus()
      });
      return true;
    }
    const startedAt = Date.now();
    roundScanJob = {
      kind: 'rounds',
      startedAt,
      startedBy: me.id,
      force: true,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await refreshLibraryRoundTags(statsIo, SHARED_LIBRARY, records, {
          onProgress: (pr) => {
            if (!roundScanJob || roundScanJob.startedAt !== startedAt) return;
            roundScanJob.done = pr.done;
            roundScanJob.total = pr.total;
            roundScanJob.percent = pr.percent;
            roundScanJob.current = pr.current;
          }
        });
        if (!roundScanJob || roundScanJob.startedAt !== startedAt) return;
        roundScanJob.report = { ...report, ms: Date.now() - startedAt };
        roundScanJob.done = report.ready;
        roundScanJob.total = report.ready;
        roundScanJob.percent = 100;
        roundScanJob.current = null;
        roundScanJob.finished = true;
        roundScanJob.finishedAt = Date.now();
        await writeAudit({
          actorId: me.id,
          targetUser: '',
          action: 'stats.rescan_rounds',
          payload: {
            ready: report.ready,
            scanned: report.scanned,
            rounds: report.rounds,
            tagged: report.tagged,
            maps: report.maps,
            failed: report.failed,
            ms: Date.now() - startedAt
          },
          req: null
        });
      } catch (err) {
        if (!roundScanJob || roundScanJob.startedAt !== startedAt) return;
        roundScanJob.error = err?.message || String(err);
        roundScanJob.finished = true;
        roundScanJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...roundScanStatus() });
    return true;
  }

  // Rating 3.0 only: re-derive the rating for every ready demo and re-stamp the
  // figure cached on each demo card. Reads the stats index that is already on
  // disk, so it is far cheaper than a full statistics rebuild.
  if (req.method === 'GET' && p === '/api/admin/stats/refresh-ratings') {
    json(res, req, 200, ratingsStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/stats/refresh-ratings') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...ratingsStatus(),
        stats: statsRefreshStatus(),
        positions: positionsRefreshStatus(),
        rounds: roundScanStatus()
      });
      return true;
    }
    const startedAt = Date.now();
    ratingsJob = {
      kind: 'ratings',
      startedAt,
      startedBy: me.id,
      force: true,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await refreshLibraryRatings(statsIo, SHARED_LIBRARY, records, {
          onProgress: (pr) => {
            if (!ratingsJob || ratingsJob.startedAt !== startedAt) return;
            ratingsJob.done = pr.done;
            ratingsJob.total = pr.total;
            ratingsJob.percent = pr.percent;
            ratingsJob.current = pr.current;
          }
        });
        if (!ratingsJob || ratingsJob.startedAt !== startedAt) return;
        ratingsJob.report = { ...report, ms: Date.now() - startedAt };
        ratingsJob.done = report.ready;
        ratingsJob.total = report.ready;
        ratingsJob.percent = 100;
        ratingsJob.current = null;
        ratingsJob.finished = true;
        ratingsJob.finishedAt = Date.now();
        await writeAudit({
          actorId: me.id,
          targetUser: '',
          action: 'stats.refresh_ratings',
          payload: {
            ready: report.ready,
            rated: report.rated,
            enriched: report.enriched,
            topPlayers: report.topPlayers,
            skipped: report.skipped,
            failed: report.failed,
            ms: Date.now() - startedAt
          },
          req: null
        });
      } catch (err) {
        if (!ratingsJob || ratingsJob.startedAt !== startedAt) return;
        ratingsJob.error = err?.message || String(err);
        ratingsJob.finished = true;
        ratingsJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...ratingsStatus() });
    return true;
  }

  // Merge player display names by Steam ID: most-used name wins, then rewrite
  // every demo/round roster and rebuild stats so Database / profiles match.
  if (req.method === 'GET' && p === '/api/admin/players/rescan-names') {
    json(res, req, 200, playerNamesStatus());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/players/rescan-names') {
    if (libraryJobBusy()) {
      json(res, req, 409, {
        error: 'A library recalculation is already running.',
        ...playerNamesStatus(),
        stats: statsRefreshStatus(),
        positions: positionsRefreshStatus(),
        rounds: roundScanStatus()
      });
      return true;
    }
    const startedAt = Date.now();
    playerNamesJob = {
      kind: 'player-names',
      startedAt,
      startedBy: me.id,
      force: true,
      done: 0,
      total: 0,
      percent: 0,
      current: null,
      finished: false,
      report: null,
      error: null
    };

    setImmediate(async () => {
      try {
        const records = await listDemos(SHARED_LIBRARY);
        const report = await rescanPlayerNames(statsIo, SHARED_LIBRARY, records, {
          onProgress: (pr) => {
            if (!playerNamesJob || playerNamesJob.startedAt !== startedAt) return;
            playerNamesJob.done = pr.done;
            playerNamesJob.total = pr.total;
            playerNamesJob.percent = pr.percent;
            playerNamesJob.current = pr.current;
          }
        });
        if (!playerNamesJob || playerNamesJob.startedAt !== startedAt) return;
        playerNamesJob.report = { ...report, ms: Date.now() - startedAt };
        playerNamesJob.done = report.ready;
        playerNamesJob.total = report.ready;
        playerNamesJob.percent = 100;
        playerNamesJob.current = null;
        playerNamesJob.finished = true;
        playerNamesJob.finishedAt = Date.now();
        await writeAudit({
          actorId: me.id,
          targetUser: '',
          action: 'players.rescan_names',
          payload: {
            ready: report.ready,
            steamIds: report.steamIds,
            withAliases: report.withAliases,
            demosUpdated: report.demosUpdated,
            roundsUpdated: report.roundsUpdated,
            failed: report.failed,
            ms: Date.now() - startedAt
          },
          req: null
        });
      } catch (err) {
        if (!playerNamesJob || playerNamesJob.startedAt !== startedAt) return;
        playerNamesJob.error = err?.message || String(err);
        playerNamesJob.finished = true;
        playerNamesJob.finishedAt = Date.now();
      }
    });

    json(res, req, 202, { ok: true, started: true, ...playerNamesStatus() });
    return true;
  }

  // ---- audit --------------------------------------------------------------
  // What this host is actually spending its time on. Read-only and cheap: it
  // reports counters already in memory and touches no disk.
  if (req.method === 'GET' && p === '/api/admin/perf') {
    json(res, req, 200, snapshot());
    return true;
  }

  // Clearing the counters is how you tell whether a fix worked: reset, use the
  // site, look again. It discards observations, never data.
  if (req.method === 'POST' && p === '/api/admin/perf/reset') {
    resetPerf();
    json(res, req, 200, { ok: true });
    return true;
  }

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

  // ---- pitch deck wording -------------------------------------------------
  // The deck reads its text from GET /api/pitch, which is public. Only the
  // write lives here. The store validates the shape; a saved edit can replace a
  // sentence that already exists and can do nothing else.
  if (req.method === 'GET' && p === '/api/admin/pitch') {
    json(res, req, 200, await getPitchText());
    return true;
  }

  if (req.method === 'POST' && p === '/api/admin/pitch') {
    const body = await readJson(req);
    const record = await savePitchText(body.text ?? body, me.id);
    await writeAudit({
      actorId: me.id,
      action: 'pitch.save',
      targetUser: '',
      payload: {
        slides: Object.keys(record.text).length,
        edits: countPitchEdits(record.text)
      },
      req
    });
    json(res, req, 200, record);
    return true;
  }

  // ---- coach smokes (private basic landing spots for Autocoach) ------------
  if (req.method === 'GET' && p === '/api/admin/coach-smokes') {
    json(res, req, 200, { maps: await listCoachSmokeMaps() });
    return true;
  }
  const coachSmokesMatch = p.match(/^\/api\/admin\/coach-smokes\/([A-Za-z0-9]{2,4})$/i);
  if (coachSmokesMatch) {
    const map = coachSmokesMatch[1];
    if (req.method === 'GET') {
      try {
        json(res, req, 200, { archive: await getCoachSmokes(map) });
      } catch (err) {
        json(res, req, 400, { error: err.message || 'Invalid map.' });
      }
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      try {
        const archive = await saveCoachSmokes(map, body.archive || body);
        await writeAudit({
          actorId: me.id,
          action: 'coach_smokes.save',
          targetUser: '',
          payload: { map: archive.map, count: archive.smokes.length },
          req
        });
        json(res, req, 200, { ok: true, archive });
      } catch (err) {
        json(res, req, 400, { error: err.message || 'Invalid smokes payload.' });
      }
      return true;
    }
  }

  json(res, req, 404, { error: 'Not found' });
  return true;
}
