// ---------------------------------------------------------------------------
// src/site/admin/adminApi.js
// Client for /api/admin/*.
//
// The panel renders nothing until me() returns 200. That is a convenience, not
// a control: the server answers 404 to anyone who is not an admin, so hiding
// the UI only saves a non-admin from seeing a broken page.
// ---------------------------------------------------------------------------

import { accessToken } from '../../replays/api.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

async function headers(extra = {}) {
  const token = await accessToken();
  const secret = import.meta.env?.VITE_ADMIN_SECRET || '';
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(secret ? { 'X-Aim4-Admin-Secret': secret } : {}),
    ...extra
  };
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function get(path) {
  return asJson(await fetch(`${API_BASE}${path}`, { headers: await headers() }));
}

async function send(method, path, body) {
  return asJson(
    await fetch(`${API_BASE}${path}`, {
      method,
      headers: await headers(),
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
}

export const adminApi = {
  me: () => get('/api/admin/me'),

  // Demo ingest. start/stop only signal the separate ingester process; the
  // status they return is the same shape as ingestStatus so the panel can
  // redraw from the response without a second round trip.
  ingestStatus: () => get('/api/admin/ingest'),
  ingestLog: (tail = 999) => get(`/api/admin/ingest/log?tail=${encodeURIComponent(tail)}`),
  ingestLogClear: () => send('DELETE', '/api/admin/ingest/log'),
  ingestStart: () => send('POST', '/api/admin/ingest/start'),
  ingestStop: () => send('POST', '/api/admin/ingest/stop'),
  ingestHardStop: () => send('POST', '/api/admin/ingest/hard-stop'),
  ingestHardRestart: () => send('POST', '/api/admin/ingest/restart'),
  ingestSeek: (nextId) => send('POST', '/api/admin/ingest/cursor', { nextId }),

  // Download probe: one URL, one attempt, a step log to read back.
  ingestProbeStatus: () => get('/api/admin/ingest/probe'),
  ingestProbeStart: (url) => send('POST', '/api/admin/ingest/probe', { url }),
  ingestProbeCancel: () => send('POST', '/api/admin/ingest/probe/cancel'),

  // CloakBrowser proxy pool (public list + verified working set).
  ingestProxies: () => get('/api/admin/ingest/proxies'),
  ingestProxiesSave: (body) => send('POST', '/api/admin/ingest/proxies', body),
  ingestProxiesRefresh: () => send('POST', '/api/admin/ingest/proxies/refresh'),

  // Scratch downloads under the ingest work / probe dirs.
  ingestDisk: () => get('/api/admin/ingest/disk'),
  ingestDiskDelete: (ids) => send('DELETE', '/api/admin/ingest/disk', { ids }),

  uploads: ({ unnamed = false, limit = 200 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (unnamed) params.set('unnamed', '1');
    return get(`/api/admin/uploads?${params}`);
  },
  renameUploadTeams: (demoId, team1, team2) =>
    send('POST', `/api/admin/uploads/${encodeURIComponent(demoId)}/teams`, { team1, team2 }),

  users: ({ q = '', tier = '', status = '', page = 0, sort = 'created_at' } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tier) params.set('tier', tier);
    if (status) params.set('status', status);
    if (page) params.set('page', String(page));
    if (sort) params.set('sort', sort);
    return get(`/api/admin/users?${params}`);
  },

  user: (id) => get(`/api/admin/users/${id}`),
  userContent: (id) => get(`/api/admin/users/${id}/content`),
  lookup: (username) => get(`/api/admin/lookup?username=${encodeURIComponent(username)}`),

  createGrant: (payload) => send('POST', '/api/admin/grants', payload),
  revokeGrant: (id) => send('DELETE', `/api/admin/grants/${id}`),

  createSubscription: (payload) => send('POST', '/api/admin/subscriptions', payload),
  cancelSubscription: (id, immediate = false) =>
    send('DELETE', `/api/admin/subscriptions/${id}${immediate ? '?immediate=1' : ''}`),
  grantElite: (userId, reason) => send('POST', '/api/admin/grant-elite', { userId, reason }),

  startTrial: (payload) => send('POST', '/api/admin/trials', payload),

  assignSeat: (payload) => send('POST', '/api/admin/seats', payload),
  releaseSeat: (id) => send('DELETE', `/api/admin/seats/${id}`),

  impersonate: (targetId, { readOnly = true, ttlSeconds = 1800 } = {}) =>
    send('POST', '/api/admin/impersonate', { targetId, readOnly, ttlSeconds }),
  endImpersonation: (ticket) =>
    send('DELETE', `/api/admin/impersonate/${encodeURIComponent(ticket)}`),

  recompute: (userId) => send('POST', '/api/admin/recompute', { userId }),
  entitlements: (userId) => get(`/api/admin/entitlements?userId=${encodeURIComponent(userId)}`),

  /** Force-rebuild compact stats indexes for the whole demo library. */
  refreshStats: ({ force = true } = {}) =>
    send('POST', '/api/admin/stats/refresh', { force }),

  /** Progress for an in-flight (or just-finished) stats rebuild. */
  refreshStatsStatus: () => get('/api/admin/stats/refresh'),

  /**
   * Rewrite only the chosen field groups on stored stats indexes (round
   * meta/ticks already on disk). Prefer this when one statistic changes.
   */
  refreshFields: (fields = []) =>
    send('POST', '/api/admin/stats/refresh-fields', { fields }),

  /** Progress / available field groups for a selective stats patch. */
  refreshFieldsStatus: () => get('/api/admin/stats/refresh-fields'),

  /** Recompute roles from tick player positions only (no full stats rebuild). */
  refreshPositions: () => send('POST', '/api/admin/stats/refresh-positions', {}),

  /** Progress for an in-flight (or just-finished) positions/roles scan. */
  refreshPositionsStatus: () => get('/api/admin/stats/refresh-positions'),

  /** Rewatch every round and re-tag it against the round library. */
  rescanRounds: () => send('POST', '/api/admin/stats/rescan-rounds', {}),

  /** Progress for an in-flight (or just-finished) round library scan. */
  rescanRoundsStatus: () => get('/api/admin/stats/rescan-rounds'),

  /** Re-derive Rating 3.0 for every demo and re-stamp the cached card rating. */
  refreshRatings: () => send('POST', '/api/admin/stats/refresh-ratings', {}),

  /** Progress for an in-flight (or just-finished) rating recalculation. */
  refreshRatingsStatus: () => get('/api/admin/stats/refresh-ratings'),

  /** Merge player display names by Steam ID (most-used name wins) + rebuild stats. */
  rescanPlayerNames: () => send('POST', '/api/admin/players/rescan-names', {}),

  /** Progress for an in-flight (or just-finished) player-name rescan. */
  rescanPlayerNamesStatus: () => get('/api/admin/players/rescan-names'),

  /** Model training. `kind` is 'duel' or 'round'. */
  trainingStatus: (kind) => get(`/api/admin/training/${kind}`),
  trainingWeights: (kind) => get(`/api/admin/training/${kind}/weights`),
  trainingStart: (kind, { generations, seed, workers, force = false } = {}) =>
    send('POST', `/api/admin/training/${kind}/start`, { generations, seed, workers, force }),
  trainingStop: (kind) => send('POST', `/api/admin/training/${kind}/stop`, {}),

  content: (store, op, payload) => send('POST', `/api/admin/content/${store}/${op}`, payload),

  /** Live pitch-deck wording. The deck itself reads the public GET /api/pitch. */
  pitch: () => get('/api/admin/pitch'),
  savePitch: (text) => send('POST', '/api/admin/pitch', { text }),

  /** Private Autocoach smoke landing spots (per map). */
  coachSmokeMaps: () => get('/api/admin/coach-smokes'),
  coachSmokes: async (map) => {
    const body = await get(`/api/admin/coach-smokes/${encodeURIComponent(map)}`);
    return body.archive || null;
  },
  saveCoachSmokes: async (map, archive) => {
    const body = await send('POST', `/api/admin/coach-smokes/${encodeURIComponent(map)}`, {
      archive
    });
    return body.archive || null;
  },

  audit: ({ actorId = '', targetUser = '', action = '', limit = 100, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (actorId) params.set('actorId', actorId);
    if (targetUser) params.set('targetUser', targetUser);
    if (action) params.set('action', action);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return get(`/api/admin/audit?${params}`);
  },

  perf: () => get('/api/admin/perf'),
  /** The sim registry, read only (6.5). Served by the sim routes, not admin. */
  simModels: () => get('/api/sim/models'),
  resetPerf: () => send('POST', '/api/admin/perf/reset', {})
};
