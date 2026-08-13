// ---------------------------------------------------------------------------
// src/site/simApi.js
// Client for /api/sim/*.
//
// The view renders nothing until me() returns 200, which is a convenience and
// not a control: the server answers 404 to everyone else, so hiding the UI only
// saves a non-admin from looking at a broken page.
//
// Kept deliberately free of the admin client's imports so the sim chunk does
// not drag the admin panel into the bundle with it.
// ---------------------------------------------------------------------------

import { accessToken } from '../replays/api.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

async function headers(extra = {}) {
  const token = await accessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function post(path, body) {
  return asJson(
    await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify(body || {})
    })
  );
}

export const simApi = {
  me: () => get('/api/sim/me'),

  // Matches are queued work, not a blocking call: run() answers with a job id
  // and the panel watches it (SIM-PLAN 9.2b).
  run: (params) => post('/api/sim/run', params),
  runStatus: () => get('/api/sim/run'),
  matches: () => get('/api/sim/matches'),
  maps: () => get('/api/sim/maps'),

  /** The model registry: which brains this host can put on the map (9.9). */
  models: () => get('/api/sim/models'),

  // Jobs: start, list, watch, stop.
  startJob: (kind, params) => post('/api/sim/jobs', { kind, params }),
  jobs: () => get('/api/sim/jobs'),
  job: (id) => get(`/api/sim/jobs/${encodeURIComponent(id)}`),
  stopJob: (id) => post(`/api/sim/jobs/${encodeURIComponent(id)}/stop`, {}),

  /** A stored round: the parser's own tick buffer, plus its meta. */
  roundMeta: (matchId, round) =>
    get(`/api/sim/matches/${encodeURIComponent(matchId)}/round/${round}/meta`),
  /** The round's decision log ({A, B} motive arrays), 404 when brainless. */
  roundMotives: (matchId, round) =>
    get(`/api/sim/matches/${encodeURIComponent(matchId)}/round/${round}/motives`),
  roundTicks: async (matchId, round) => {
    const res = await fetch(
      `${API_BASE}/api/sim/matches/${encodeURIComponent(matchId)}/round/${round}/ticks`,
      { headers: await headers() }
    );
    if (!res.ok) {
      const err = new Error(`Round unavailable (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return new Uint8Array(await res.arrayBuffer());
  },

  // Dataset export: list what the library holds, then download a selection
  // one .aim4replay at a time. Downloads go through fetch rather than a plain
  // link because the guard reads the Authorization header, and an <a href>
  // cannot carry one.
  exportList: () => get('/api/sim/export/list'),
  experience: () => get('/api/sim/experience'),
  exportDownload: async (id) => {
    const res = await fetch(`${API_BASE}/api/sim/export/demo?id=${encodeURIComponent(id)}`, {
      headers: await headers()
    });
    if (!res.ok) {
      const err = new Error(`Export failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const dispo = res.headers.get('Content-Disposition') || '';
    const name = /filename="([^"]+)"/.exec(dispo)?.[1] || `${id}.aim4replay`;
    return { filename: name, blob: await res.blob() };
  }
};
