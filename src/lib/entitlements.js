// ---------------------------------------------------------------------------
// src/lib/entitlements.js
// The client's mirror of what the server decided.
//
// Nothing here is a security boundary. Every capability is enforced again on
// whichever surface serves its data, and this exists so the UI can render a
// locked state instead of firing a request that comes back 402. If this file
// and the server ever disagree, the server is right.
//
// Three UI treatments fall out of the four value shapes:
//
//   Locked  the tier does not have it. Show it, disabled, with an upgrade
//           affordance. Never hide it: users cannot want what they cannot see.
//   Quota'd show the remaining uses inline, e.g. "Auto coach (3 left today)".
//   Capped  show the count against the cap next to the create button.
// ---------------------------------------------------------------------------

import {
  PLAN_NAMES,
  UNLIMITED,
  capabilitiesForPlan,
  capabilityDef,
  compareValues,
  isCapability,
  isEnabled,
  requiredPlanFor
} from '../../shared/entitlements/catalogue.js';
import { accessToken } from '../replays/api.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
const TICKET_KEY = 'aim4.impersonate';

/**
 * The "view as" ticket, kept in sessionStorage so it dies with the tab rather
 * than following an admin around for a week.
 */
export function impersonationTicket() {
  try {
    return sessionStorage.getItem(TICKET_KEY) || '';
  } catch {
    return '';
  }
}

export function setImpersonationTicket(ticket) {
  try {
    if (ticket) sessionStorage.setItem(TICKET_KEY, ticket);
    else sessionStorage.removeItem(TICKET_KEY);
  } catch {
    /* private browsing */
  }
}

export class EntitlementManager {
  /**
   * @param {import('../core/AuthManager.js').AuthManager} auth
   */
  constructor(auth) {
    this.auth = auth;
    this.state = null;
    this.loading = null;
    this.listeners = new Set();

    // Entitlements are a property of the session, so they are re-read whenever
    // the session changes. Without this, signing in leaves every gate showing
    // the signed-out answer until a reload.
    auth?.onChange?.(() => {
      this.refresh();
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch {
        /* one broken listener must not stop the others */
      }
    }
  }

  async _headers() {
    const headers = {};
    const token = await accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const ticket = impersonationTicket();
    if (ticket) headers['X-Aim4-Impersonate'] = ticket;
    return headers;
  }

  /** Read /api/me. Coalesced, so ten gates rendering at once cost one request. */
  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/me`, { headers: await this._headers() });
        this.state = res.ok ? await res.json() : null;
      } catch {
        // Offline or backend down. Fall back to free rather than to a page of
        // spinners: a signed-in user briefly seeing locked features is
        // recoverable, a blank app is not.
        this.state = null;
      }
      this.loading = null;
      this._emit();
      return this.state;
    })();
    return this.loading;
  }

  async ready() {
    if (this.state) return this.state;
    return this.refresh();
  }

  get tier() {
    return this.state?.entitlements?.tier || 'free';
  }

  get tierName() {
    return PLAN_NAMES[this.tier] || this.tier;
  }

  get source() {
    return this.state?.entitlements?.source || 'free';
  }

  get isAdmin() {
    return Boolean(this.state?.account?.admin);
  }

  get impersonating() {
    return this.state?.impersonating || null;
  }

  get trial() {
    return this.state?.entitlements?.trial || null;
  }

  get subscription() {
    return this.state?.subscription || null;
  }

  /** True when a trial is on offer. Hidden entirely when not, never disabled. */
  get trialOffer() {
    const trial = this.state?.trial;
    return trial?.enabled && trial?.eligible ? trial : null;
  }

  /** Raw value. Falls back to the free tier's value before /api/me lands. */
  value(key) {
    if (!isCapability(key)) throw new Error(`Unknown capability: ${key}`);
    const resolved = this.state?.entitlements?.capabilities?.[key];
    return resolved === undefined ? capabilitiesForPlan('free')[key] : resolved;
  }

  /** May this account use the feature at all? */
  can(key) {
    return isEnabled(key, this.value(key));
  }

  /** For enum capabilities: does it reach at least `level`? */
  atLeast(key, level) {
    return compareValues(key, this.value(key), level) >= 0;
  }

  /** For limits: `{ limit, unlimited, remaining, atCap }` given a current count. */
  limit(key, current = 0) {
    const limit = Number(this.value(key));
    const unlimited = limit === UNLIMITED;
    return {
      limit,
      unlimited,
      current,
      remaining: unlimited ? Infinity : Math.max(0, limit - current),
      atCap: !unlimited && current >= limit
    };
  }

  /** For quotas: live counter state from /api/me. */
  quota(key) {
    const limit = Number(this.value(key));
    if (limit === UNLIMITED) return { limit: UNLIMITED, unlimited: true, remaining: Infinity, used: 0 };
    const live = this.state?.quotas?.[key];
    const used = Number(live?.used || 0);
    return {
      limit,
      unlimited: false,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: live?.resetsAt || null,
      spent: limit > 0 && used >= limit
    };
  }

  /** The cheapest plan that would unlock a key. For upgrade copy. */
  requiredPlan(key, level = undefined) {
    return requiredPlanFor(key, level);
  }

  label(key) {
    return capabilityDef(key).label;
  }
}

let singleton = null;

/** One manager per page. The gates all read the same state. */
export function getEntitlements(auth = null) {
  if (!singleton && auth) singleton = new EntitlementManager(auth);
  return singleton;
}
