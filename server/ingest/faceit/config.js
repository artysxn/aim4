// ---------------------------------------------------------------------------
// server/ingest/faceit/config.js
// FACEIT credentials and targets, resolved in one place.
//
// Separate from ingest/hltv/config.js because these are read by two different
// processes: the API server (webhook receiver) needs the secret and the spool
// directory, the ingester needs the API key and the championship list. Sharing
// one loader would mean the web server importing the ingester's config, and the
// ingester importing the web server's.
//
// Read at call time, not at import, so a test can set process.env and so a
// rotated secret takes effect on the next request rather than the next deploy.
// ---------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** "a, b ,c" -> ["a","b","c"]. Blank-tolerant: a trailing comma is not an id. */
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadFaceitConfig() {
  const env = process.env;
  return {
    /**
     * Server-side API key from App Studio. Bearer for both the Data API and,
     * once the Downloads application is approved, the demo URL exchange.
     */
    apiKey: env.AIM4_FACEIT_API_KEY || '',

    /**
     * Our own secret, echoed by FACEIT on every delivery. Not issued by them:
     * we choose it and paste it into the subscription. See webhookRoutes.js.
     */
    webhookSecret: env.AIM4_FACEIT_WEBHOOK_SECRET || '',
    webhookHeaderName: env.AIM4_FACEIT_WEBHOOK_HEADER || 'x-aim4-webhook-secret',
    /** Only if the deployment cannot use a header. Empty disables the check. */
    webhookQueryName: env.AIM4_FACEIT_WEBHOOK_QUERY || '',

    /** Where the receiver drops envelopes and the ingester picks them up. */
    spoolDir:
      env.AIM4_FACEIT_SPOOL_DIR || path.join(ROOT, 'server', 'data', 'faceit-ingest', 'spool'),

    /**
     * Which events to act on. Subscriptions are organizer-scoped, so this is
     * the only place a specific tournament can be selected. Both empty means
     * "everything the subscription delivers".
     */
    championships: list(env.AIM4_FACEIT_CHAMPIONSHIPS),
    organizers: list(env.AIM4_FACEIT_ORGANIZERS),

    /** Safety net for missed or unsubscribable events. 0 disables. */
    pollMinutes: Number(env.AIM4_FACEIT_POLL_MINUTES ?? 15) || 0
  };
}

/**
 * What is missing before this can do anything, in plain words.
 *
 * Used by the startup banner and the admin panel, so a half-configured
 * deployment says so on boot instead of silently dropping every delivery.
 */
export function faceitConfigProblems(cfg = loadFaceitConfig()) {
  const problems = [];
  if (!cfg.apiKey) problems.push('AIM4_FACEIT_API_KEY is unset (Data API and demo download)');
  if (!cfg.webhookSecret) {
    problems.push('AIM4_FACEIT_WEBHOOK_SECRET is unset (every webhook delivery will be rejected)');
  }
  return problems;
}
