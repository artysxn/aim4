// ---------------------------------------------------------------------------
// src/site/account/accountApi.js
// Client for /api/me, /api/account/* and /api/trials/*.
// ---------------------------------------------------------------------------

import { accessToken } from '../../replays/api.js';
import { impersonationTicket } from '../../lib/entitlements.js';
import { storedReferral } from '../../lib/referral.js';

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

  /** Change the @ tag. Unique, lowercase, no spaces. */
  setUsername: async (username) =>
    asJson(
      await fetch(`${API_BASE}/api/account/username`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ username })
      })
    ),

  /** Drop the server's cached identity for this account. */
  refreshIdentity: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/identity/refresh`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  /** Change the display name. Empty clears it back to the tag. */
  setDisplayName: async (displayName) =>
    asJson(
      await fetch(`${API_BASE}/api/account/display-name`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ displayName })
      })
    ),

  /** Change the interface language. One of LANG_IDS in src/i18n/langs.js. */
  setLanguage: async (language) =>
    asJson(
      await fetch(`${API_BASE}/api/account/language`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ language })
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

  cancelSubscription: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/subscription/cancel`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  resumeSubscription: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/subscription/resume`, {
        method: 'POST',
        headers: await headers()
      })
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

  steamStart: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/steam/start`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  steamUnlink: async () =>
    asJson(
      await fetch(`${API_BASE}/api/account/steam/unlink`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  /**
   * Opens a checkout. `ref` is whatever affiliate link brought this visitor in,
   * if any, carried from localStorage rather than asked for: the person paying
   * should not have to remember a code they clicked a fortnight ago.
   *
   * The server validates it and decides what it is worth. A stale, unknown or
   * self-owned code changes nothing about the sale.
   */
  checkout: async (planId, term) =>
    asJson(
      await fetch(`${API_BASE}/api/billing/checkout`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ planId, term, ref: storedReferral() || undefined })
      })
    ),

  /**
   * Applies a plan change to the subscription the customer already has, and
   * bills the difference. `confirm` is not optional: the server refuses without
   * it, so an accidental call cannot charge anyone.
   */
  changePlan: async (planId, term) =>
    asJson(
      await fetch(`${API_BASE}/api/billing/change-plan`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ planId, term, confirm: true })
      })
    ),

  /** Redeem a trial code. The server decides everything; this only carries it. */
  redeemCode: async (code) =>
    asJson(
      await fetch(`${API_BASE}/api/account/redeem-code`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ code })
      })
    ),

  /** This account's affiliate code, what it has earned, and recent payments. */
  affiliate: async () =>
    asJson(await fetch(`${API_BASE}/api/account/affiliate`, { headers: await headers() })),

  /** Claim a code. One per account, and it cannot be changed afterwards. */
  claimAffiliateCode: async (code) =>
    asJson(
      await fetch(`${API_BASE}/api/account/affiliate`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ code })
      })
    ),

  billingPortal: async () =>
    asJson(
      await fetch(`${API_BASE}/api/billing/portal`, {
        method: 'POST',
        headers: await headers()
      })
    ),

  exportUrl: (path) => `${API_BASE}${path}`
};
