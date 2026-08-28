// ---------------------------------------------------------------------------
// server/account/routes.js
// /api/me, /api/account/* and /api/trials/*.
//
// /api/me is the client's single source of entitlement truth. It is small and
// cheap on purpose: the trainer needs it too, and the trainer has no reason to
// pull the whole replay library status just to find out whether this account
// may save a custom routine.
//
// Nothing the client learns here is load-bearing. Every capability is enforced
// again on whichever surface actually serves its data; this endpoint exists so
// the UI can show a locked state instead of a failed request.
// ---------------------------------------------------------------------------

import { CAPABILITIES, UNLIMITED } from '../../shared/entitlements/catalogue.js';
import { guardImpersonation } from '../admin/guard.js';
import { peek } from '../entitlements/quota.js';
import { quotaSubjectFor } from '../entitlements/enforce.js';
import { ensureEffectiveEntitlements } from '../entitlements/load.js';
import { whoami } from '../replays/identity.js';
import {
  activeSubscription,
  cancelSubscription,
  cancelTrial,
  resumeSubscription,
  seatsHeldBy,
  startTrial,
  trialDays,
  trialEligibility,
  trialPlan,
  trialsEnabled
} from '../entitlements/subscriptions.js';
import { billingConfigured, provider } from '../billing/provider.js';
import { ValidationError } from '../entitlements/grants.js';
import { db } from '../entitlements/service.js';
import { passwordLogin } from './login.js';
import { registerAccount } from './register.js';
import { completeLink, startUrl } from './steam.js';
import {
  cancelDeletion,
  deleteAccount,
  exportAccount,
  readExport,
  retentionState
} from './data.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Aim4-Impersonate',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ValidationError('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ValidationError('Invalid JSON body.');
  }
}

/**
 * Current usage for every quota the caller is actually metered on.
 *
 * Unlimited and unavailable capabilities are skipped rather than queried: on a
 * paid tier that is all eight of them, and eight round trips to learn "no
 * limit" on every page load is a waste of the database.
 */
async function quotaState(me) {
  const out = {};
  if (!me.signedIn) return out;
  const entries = Object.entries(CAPABILITIES).filter(([, def]) => def.shape === 'quota');
  await Promise.all(
    entries.map(async ([key, def]) => {
      const limit = Number(me.entitlements?.capabilities?.[key]);
      if (!Number.isFinite(limit) || limit === UNLIMITED || limit <= 0) return;
      // Shared quotas are counted against the subscription, so the meter has to
      // read the same row consumeQuota writes. Reading it per user would show a
      // Tier 3 seat "1 left today" while a teammate had already spent it.
      out[key] = { ...(await peek(quotaSubjectFor(me, key), key, limit)), shared: Boolean(def.shared) };
    })
  );
  return out;
}

/**
 * @returns {Promise<boolean>} true when this request was an account route.
 */
export async function handleAccountRequest(req, res, url) {
  const p = url.pathname;
  const owned = p === '/api/me' || p.startsWith('/api/account') || p.startsWith('/api/trials');
  if (!owned) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  const me = await whoami(req);
  const blocked = guardImpersonation(req, url, me);
  if (blocked) {
    json(res, blocked.status, blocked.body);
    return true;
  }

  try {
    return await route(req, res, url, me);
  } catch (err) {
    if (err instanceof ValidationError || err?.status === 400) {
      json(res, 400, { error: err.message, reason: err.reason || null });
      return true;
    }
    console.error('[account]', err);
    json(res, 500, { error: err.message || 'Server error' });
    return true;
  }
}

async function route(req, res, url, me) {
  const p = url.pathname;

  // ---- password sign-in ----------------------------------------------------
  // Public by definition: the caller has no session yet, which is the point.
  // Rate limiting and the uniform failure message live in login.js.
  if (req.method === 'POST' && p === '/api/account/login') {
    const body = await readJson(req, 4 * 1024);
    const { status, body: out } = await passwordLogin(req, {
      identifier: body.identifier ?? body.username ?? body.email,
      password: body.password
    });
    json(res, status, out);
    return true;
  }

  // ---- registration --------------------------------------------------------
  // Public like login: the caller has no session yet. Rate limits, the
  // internal login email, and the link-before-upload rule are in register.js.
  if (req.method === 'POST' && p === '/api/account/register') {
    const body = await readJson(req, 4 * 1024);
    const { status, body: out } = await registerAccount(req, {
      username: body.username,
      password: body.password
    });
    json(res, status, out);
    return true;
  }

  // ---- Steam link ----------------------------------------------------------
  // /start is a POST answered with the Steam URL rather than a 302: the
  // session lives in the Authorization header, and a top-level navigation
  // carries no header. The client fetches the URL, then navigates to it; the
  // signed state inside it is what ties the return leg back to this account.
  if (req.method === 'POST' && p === '/api/account/steam/start') {
    if (!me.signedIn) {
      json(res, 401, { error: 'Sign in first.' });
      return true;
    }
    const to = startUrl(req, me.id);
    if (!to) {
      json(res, 503, { error: 'Steam linking is not configured on this deployment.' });
      return true;
    }
    json(res, 200, { url: to });
    return true;
  }

  if (req.method === 'GET' && p === '/api/account/steam/return') {
    // No session required here: the state token IS the tie to the account.
    // Steam redirects the top-level browser, and some setups drop the
    // Authorization-carrying fetch layer entirely on that navigation.
    const result = await completeLink(url.searchParams);
    const to = result.ok ? '/account?steam=linked' : `/account?steam=${result.error}`;
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  if (req.method === 'POST' && p === '/api/account/steam/unlink') {
    if (!me.signedIn) {
      json(res, 401, { error: 'Sign in first.' });
      return true;
    }
    await db.update('profiles', { id: `eq.${me.id}` }, { steam_id: null });
    json(res, 200, { ok: true });
    return true;
  }

  // ---- who am I, and what may I do ----------------------------------------
  if (req.method === 'GET' && p === '/api/me') {
    if (me.signedIn) {
      // Best-effort: keep profiles.effective_* filled for RLS readers.
      await ensureEffectiveEntitlements(me.id).catch(() => null);
    }
    const [quotas, subscription, seats, eligibility] = await Promise.all([
      quotaState(me),
      me.signedIn ? activeSubscription(me.id) : null,
      me.signedIn ? seatsHeldBy(me.id) : [],
      me.signedIn ? trialEligibility(me.id, me.entitlements) : { eligible: false, reason: null }
    ]);

    json(res, 200, {
      account: {
        signedIn: me.signedIn,
        id: me.id,
        username: me.username,
        admin: me.admin,
        email: me.email || '',
        provider: me.provider || '',
        createdAt: me.createdAt || '',
        // What actually anchors the account, for the Connections section and
        // the upload gate's UI: uploads need google or steam to be true.
        linked: {
          google: me.provider === 'google' || (me.providers || []).includes('google'),
          steam: Boolean(me.steamId),
          steamId: me.steamId || ''
        }
      },
      entitlements: me.entitlements,
      impersonating: me.impersonating,
      quotas,
      subscription: subscription
        ? {
            id: subscription.id,
            planId: subscription.plan_id,
            status: subscription.status,
            term: subscription.term,
            currentPeriodEnd: subscription.current_period_end,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            trialEndsAt: subscription.trial_ends_at,
            source: subscription.source
          }
        : null,
      seats: (seats || []).map((s) => ({
        id: s.id,
        teamId: s.team_id,
        planId: s.subscription?.plan_id || null
      })),
      trial: {
        enabled: trialsEnabled(),
        days: trialDays(),
        planId: trialPlan(),
        eligible: eligibility.eligible,
        reason: eligibility.reason
      }
    });
    return true;
  }

  const requireUser = () => {
    if (me.signedIn) return true;
    json(res, 401, { error: 'Sign in first.' });
    return false;
  };

  // ---- trials --------------------------------------------------------------
  if (req.method === 'POST' && p === '/api/trials/start') {
    if (!requireUser()) return true;
    const row = await startTrial({ userId: me.id, source: 'trial', req });
    json(res, 201, {
      subscription: { id: row.id, planId: row.plan_id, trialEndsAt: row.trial_ends_at }
    });
    return true;
  }

  // ---- own subscription ----------------------------------------------------
  // Cancellation works before payments do: an admin-granted or migrated
  // subscription can be wound down by its owner, and when a billing provider
  // lands the same route also tells it, so the customer stops being charged.
  if (req.method === 'POST' && p === '/api/account/subscription/cancel') {
    if (!requireUser()) return true;
    const row = await cancelSubscription({ userId: me.id, actorId: me.id, req });
    if (billingConfigured() && row?.provider_subscription_id) {
      await provider
        .cancelSubscription({ subscriptionId: row.provider_subscription_id, atPeriodEnd: true })
        .catch((err) => console.warn('[billing] provider cancel failed:', err?.message || err));
    }
    json(res, 200, {
      subscription: { id: row.id, cancelAtPeriodEnd: row.cancel_at_period_end },
      accessUntil: row.current_period_end || row.trial_ends_at || null
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/account/subscription/resume') {
    if (!requireUser()) return true;
    const row = await resumeSubscription({ userId: me.id, actorId: me.id, req });
    json(res, 200, {
      subscription: { id: row.id, cancelAtPeriodEnd: row.cancel_at_period_end }
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/trials/cancel') {
    if (!requireUser()) return true;
    const row = await cancelTrial({ userId: me.id, req });
    json(res, 200, {
      subscription: { id: row.id, cancelAtPeriodEnd: row.cancel_at_period_end },
      // Access is not revoked now. Saying so explicitly is what stops the
      // "cancel" button from reading as "lose it immediately".
      accessUntil: row.trial_ends_at || row.current_period_end
    });
    return true;
  }

  // ---- profile -------------------------------------------------------------
  //
  // The display name is the one thing about an account the owner can change,
  // and it is what every other surface shows: uploads are attributed by it,
  // rosters list it, leaderboards rank it. Taken names are refused rather than
  // silently suffixed, because two players with one name is a worse outcome
  // than being told to pick another.
  if (req.method === 'POST' && p === '/api/account/username') {
    if (!requireUser()) return true;
    const body = await readJson(req);
    const next = String(body?.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,24}$/.test(next)) {
      json(res, 400, {
        error: 'Use 3 to 24 characters: letters, numbers, dot, dash or underscore.'
      });
      return true;
    }
    const taken = await db.selectOne('profiles', {
      select: 'id',
      username: `eq.${next}`
    });
    if (taken && taken.id !== me.id) {
      json(res, 409, { error: 'That name is taken.' });
      return true;
    }
    await db.update('profiles', { id: `eq.${me.id}` }, { username: next });
    json(res, 200, { username: next });
    return true;
  }

  // ---- data ----------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/account/retention') {
    if (!requireUser()) return true;
    json(res, 200, await retentionState(me));
    return true;
  }

  if (req.method === 'POST' && p === '/api/account/export') {
    if (!requireUser()) return true;
    json(res, 202, await exportAccount(me, req));
    return true;
  }

  const exportMatch = p.match(/^\/api\/account\/export\/([A-Za-z0-9_-]{20,64})$/);
  if (req.method === 'GET' && exportMatch) {
    // The token is the authorisation. It is 32 random bytes, single purpose and
    // expiring, so a share link works without a session while a guessed one
    // does not exist.
    const body = await readExport(exportMatch[1]);
    if (!body) {
      json(res, 404, { error: 'That export has expired.' });
      return true;
    }
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="aim4-export.json"',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return true;
  }

  if (req.method === 'POST' && p === '/api/account/delete') {
    if (!requireUser()) return true;
    const body = await readJson(req);
    json(res, 200, await deleteAccount(me, body, req));
    return true;
  }

  if (req.method === 'POST' && p === '/api/account/delete/cancel') {
    if (!requireUser()) return true;
    json(res, 200, await cancelDeletion(me, req));
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
