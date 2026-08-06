// ---------------------------------------------------------------------------
// src/site/account/accountApi.js
// Client for /api/me, /api/account/* and /api/trials/*.
// ---------------------------------------------------------------------------

import { accessToken } from '../../replays/api.js';
import { impersonationTicket } from '../../lib/entitlements.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');

async function headers() {
  const token = await accessToken();
  const ticket = impersonationTicket();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(ticket ? { 'X-Aim4-Impersonate': ticket } : {})
  };
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const accountApi = {
  me: async () => asJson(await fetch(`${API_BASE}/api/me`, { headers: await headers() })),

  setUsername: async (username) =>
    asJson(
      await fetch(`${API_BASE}/api/account/username`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ username })
      })
    ),

  retention: async () =>
    asJson(await fetch(`${API_BASE}/api/account/retention`, { headers: await headers() })),

  startTrial: async () =>
    asJson(
      await fetch(`${API_BASE}/api/trials/start`, { method: 'POST', headers: await headers() })
    ),

  cancelTrial: async () =>
    asJson(
      await fetch(`${API_BASE}/api/trials/cancel`, { method: 'POST', headers: await headers() })
    ),

  exportData: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/export`, { method: 'POST', headers: await headers() })
    ),

  deleteAccount: async (confirm) =>
    asJson(
      await fetch(`${API_BASE}/api/account/delete`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ confirm })
      })
    ),

  cancelDeletion: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/delete/cancel`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  billingStatus: async () => asJson(await fetch(`${API_BASE}/api/billing/status`)),

  exportUrl: (path) => `${API_BASE}${path}`
};
