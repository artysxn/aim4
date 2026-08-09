// ---------------------------------------------------------------------------
// server/ingest/faceit/webhookRoutes.js
// POST /api/ingest/faceit/webhook
//
// FACEIT's end of this is configured in App Studio: a callback URL, and
// optionally a header (and/or query string) name and value that FACEIT will
// send with every delivery. FACEIT calls that security section optional and
// implements no signing of its own; their docs say outright that the security
// logic is the developer's to write. That is what this file is.
//
// So the shared secret is not something FACEIT issues. We invent a long random
// value, paste it into the subscription form, and check it here. It is a
// bearer credential in both directions, which is why:
//
//   - the comparison is constant-time (a byte-at-a-time compare leaks the
//     secret to anyone willing to time a few thousand requests),
//   - an unconfigured secret rejects everything rather than accepting
//     everything, since this endpoint is public and a fail-open default would
//     let anyone queue ingest work,
//   - the value is never logged, not even truncated.
//
// The handler stays deliberately tiny: check, filter, spool, 200. It does not
// call the FACEIT API and does not touch the ledger. See spool.js for why.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { readRawBody } from '../../billing/routes.js';
import { HANDLED_EVENTS, writeSpoolFile } from './spool.js';
import { loadFaceitConfig } from './config.js';

/** Envelopes are a few hundred bytes. This is three orders of magnitude of headroom. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/**
 * Constant-time string equality.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak the
 * secret's length, so both sides are hashed to a fixed width first.
 */
export function secretMatches(expected, received) {
  if (!expected || typeof received !== 'string' || !received) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(received).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Is this delivery from FACEIT, carrying our secret?
 *
 * Header and query string are both supported because App Studio offers both,
 * and a deployment may only be able to use one (a proxy that strips unknown
 * headers, a URL that must stay clean). Configuring either is enough;
 * configuring neither is a refusal, not a pass.
 *
 * @returns {{ ok: boolean, reason?: string }}
 */
export function authorizeDelivery(cfg, req, url) {
  const headerConfigured = Boolean(cfg.webhookHeaderName && cfg.webhookSecret);
  const queryConfigured = Boolean(cfg.webhookQueryName && cfg.webhookSecret);

  if (!headerConfigured && !queryConfigured) {
    return {
      ok: false,
      reason:
        'FACEIT webhook secret is not configured. Set AIM4_FACEIT_WEBHOOK_SECRET and ' +
        'AIM4_FACEIT_WEBHOOK_HEADER (or AIM4_FACEIT_WEBHOOK_QUERY) to the same values ' +
        'used in the App Studio subscription.'
    };
  }

  if (headerConfigured) {
    const got = req.headers[cfg.webhookHeaderName.toLowerCase()];
    if (secretMatches(cfg.webhookSecret, Array.isArray(got) ? got[0] : got)) return { ok: true };
  }
  if (queryConfigured) {
    if (secretMatches(cfg.webhookSecret, url.searchParams.get(cfg.webhookQueryName))) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'bad secret' };
}

/**
 * Should this event become ingest work?
 *
 * Anything we decline is still answered 200. A non-2xx tells FACEIT to retry,
 * and retrying an event we have decided to ignore wastes their delivery budget
 * and fills our logs; "received and dropped" is the honest response.
 *
 * @returns {{ handle: boolean, reason?: string }}
 */
export function shouldHandle(cfg, envelope) {
  const event = envelope?.event;
  const payload = envelope?.payload;
  if (!event || !payload?.id) return { handle: false, reason: 'malformed envelope' };
  if (!HANDLED_EVENTS.has(event)) return { handle: false, reason: `unhandled event ${event}` };

  // The parser targets CS2. CSGO-era demos exist on FACEIT and would fail
  // downstream, so they are declined here rather than three stages later.
  const game = payload.game ? String(payload.game).toLowerCase() : '';
  if (game && game !== 'cs2') return { handle: false, reason: `game ${game}` };

  // Subscriptions are organizer-scoped, so a single subscription delivers every
  // championship that organizer runs. This is where we narrow to the events we
  // actually want. Both lists empty means "take everything this subscription
  // sends", which is the right default for an app that only subscribes to its
  // own organizers.
  const entityId = payload.entity?.id;
  const organizerId = payload.organizer_id;
  if (cfg.championships.length && entityId && cfg.championships.includes(entityId)) {
    return { handle: true };
  }
  if (cfg.organizers.length && organizerId && cfg.organizers.includes(organizerId)) {
    return { handle: true };
  }
  if (!cfg.championships.length && !cfg.organizers.length) return { handle: true };
  return { handle: false, reason: 'entity not in the configured championships or organizers' };
}

/**
 * @returns {Promise<boolean>} true when this module answered the request
 */
export async function handleFaceitWebhookRequest(req, res, url) {
  if (url.pathname !== '/api/ingest/faceit/webhook') return false;

  // No CORS headers anywhere in this module on purpose: the only legitimate
  // caller is FACEIT's server, and no browser should ever be able to reach it.
  if (req.method === 'OPTIONS') {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Use POST' });
    return true;
  }

  const cfg = loadFaceitConfig();

  const auth = authorizeDelivery(cfg, req, url);
  if (!auth.ok) {
    // The reason is logged for us and withheld from the caller: an unauthorized
    // client learning "your secret is wrong" versus "no secret is configured"
    // is free reconnaissance.
    console.warn(`[faceit] rejected webhook delivery: ${auth.reason}`);
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  let raw;
  try {
    raw = await readRawBody(req, MAX_WEBHOOK_BYTES);
  } catch (err) {
    json(res, err.status === 413 ? 413 : 400, { error: err.message });
    return true;
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch {
    json(res, 400, { error: 'body is not JSON' });
    return true;
  }

  const decision = shouldHandle(cfg, envelope);
  if (!decision.handle) {
    json(res, 200, { received: true, queued: false, reason: decision.reason });
    return true;
  }

  try {
    await writeSpoolFile(cfg.spoolDir, envelope.event, envelope.payload.id, raw);
  } catch (err) {
    // A spool write that fails is the one case worth a non-2xx: FACEIT's retry
    // is then the thing that saves the demo, and their retry is free.
    console.error(`[faceit] could not spool ${envelope.event}: ${err.message}`);
    json(res, 500, { error: 'could not queue event' });
    return true;
  }

  console.log(
    `[faceit] queued ${envelope.event} for match ${envelope.payload.id}` +
      (envelope.retry_count ? ` (retry ${envelope.retry_count})` : '')
  );
  json(res, 200, { received: true, queued: true });
  return true;
}
