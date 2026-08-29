// ---------------------------------------------------------------------------
// server/entitlements/service.js
// The privileged database client. Service role, server only.
//
// This key bypasses RLS completely, so it is the one credential in the project
// that must never reach the browser. It is read from SUPABASE_SERVICE_ROLE_KEY
// with no VITE_ fallback, deliberately: a VITE_-prefixed name would be inlined
// into the client bundle by Vite, and a fallback here is exactly how that
// mistake would go unnoticed.
//
// A thin PostgREST wrapper rather than @supabase/supabase-js, matching
// identity.js: the server already speaks to Supabase over plain fetch, and the
// SDK would add a second auth stack on a box that only ever acts as one role.
//
// Unconfigured is a supported state. Reads return empty and writes throw, so a
// deploy missing the key serves the public library as a free tier rather than
// failing every request or, worse, letting everyone through.
// ---------------------------------------------------------------------------

/** Read at call time, not import time: .env and tests both set this late. */
function config() {
  return {
    url: (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  };
}

export function isConfigured() {
  const { url, key } = config();
  return Boolean(url && key);
}

/** Thrown by writes when the key is missing, so callers can 503 rather than 500. */
export class NotConfiguredError extends Error {
  constructor() {
    super('SUPABASE_SERVICE_ROLE_KEY is not set');
    this.name = 'NotConfiguredError';
    this.code = 'not_configured';
  }
}

export class PostgrestError extends Error {
  constructor(status, body) {
    super(body?.message || `PostgREST ${status}`);
    this.name = 'PostgrestError';
    this.status = status;
    this.details = body;
  }
}

let warned = false;
function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    '[entitlements] SUPABASE_SERVICE_ROLE_KEY is not set. Every account resolves ' +
      'to the free tier and admin actions are unavailable.'
  );
}

async function request(pathAndQuery, { method = 'GET', body, prefer, headers = {} } = {}) {
  const { url, key } = config();
  if (!url || !key) {
    warnOnce();
    throw new NotConfiguredError();
  }
  const res = await fetch(`${url}${pathAndQuery}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  if (!res.ok) throw new PostgrestError(res.status, parsed);
  return parsed;
}

/**
 * Build a PostgREST query string.
 * Values are passed through encodeURIComponent, so a username containing a
 * comma or parenthesis cannot break out of a filter and widen the query.
 */
function query(params = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export const db = {
  /** SELECT. Returns [] when the key is missing rather than throwing. */
  async select(table, params = {}) {
    if (!isConfigured()) {
      warnOnce();
      return [];
    }
    try {
      return (await request(`/rest/v1/${table}${query(params)}`)) || [];
    } catch (err) {
      if (err instanceof NotConfiguredError) return [];
      throw err;
    }
  },

  /** SELECT expecting at most one row. */
  async selectOne(table, params = {}) {
    const rows = await db.select(table, { ...params, limit: 1 });
    return rows[0] || null;
  },

  async insert(table, rows, { returning = true } = {}) {
    const result = await request(`/rest/v1/${table}`, {
      method: 'POST',
      body: rows,
      prefer: returning ? 'return=representation' : 'return=minimal'
    });
    return Array.isArray(result) ? result[0] : result;
  },

  async upsert(table, rows, { onConflict, returning = true } = {}) {
    const result = await request(`/rest/v1/${table}${query({ on_conflict: onConflict })}`, {
      method: 'POST',
      body: rows,
      prefer: `resolution=merge-duplicates,${returning ? 'return=representation' : 'return=minimal'}`
    });
    return Array.isArray(result) ? result[0] : result;
  },

  async update(table, params, patch, { returning = true } = {}) {
    const result = await request(`/rest/v1/${table}${query(params)}`, {
      method: 'PATCH',
      body: patch,
      prefer: returning ? 'return=representation' : 'return=minimal'
    });
    return Array.isArray(result) ? result : result ? [result] : [];
  },

  async remove(table, params) {
    return request(`/rest/v1/${table}${query(params)}`, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
  },

  /** Call a Postgres function. Used for the atomic quota consume. */
  async rpc(fn, args = {}) {
    return request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  }
};

/**
 * The GoTrue admin API (/auth/v1/admin/*), same service-role key.
 *
 * Separate from `db` because it is not PostgREST: auth.users is not reachable
 * over /rest/v1 at all, and the one thing the server needs from it — the login
 * email behind a username — has no other source.
 */
export const authAdmin = {
  /** One auth user by id, or null when absent / unconfigured. */
  async getUser(userId) {
    const id = String(userId || '');
    if (!id || !isConfigured()) return null;
    try {
      return await request(`/auth/v1/admin/users/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof NotConfiguredError) return null;
      if (err?.status === 404) return null;
      throw err;
    }
  },

  /**
   * Create an account directly, bypassing sign-up.
   *
   * `email_confirm: true` marks the address verified without sending mail,
   * which is what makes a seeded test account usable immediately.
   */
  async createUser({ email, password, username, fullName = '', emailConfirm = true }) {
    return request('/auth/v1/admin/users', {
      method: 'POST',
      body: {
        email,
        password,
        email_confirm: emailConfirm,
        // handle_new_user() reads both. `username` means "this account arrives
        // with its tag already chosen"; without it the trigger assigns a random
        // one. `full_name` becomes the display name, matching the field Google,
        // Discord and X send.
        user_metadata: {
          ...(username ? { username: String(username).toLowerCase() } : {}),
          ...(fullName ? { full_name: String(fullName).slice(0, 64) } : {})
        }
      }
    });
  },

  /**
   * A single-use token that can be exchanged for a session, without a password.
   *
   * How a provider this box verifies ITSELF — Steam, whose OpenID assertion
   * Supabase knows nothing about — turns into a Supabase session. Nothing is
   * emailed: generate_link only mints, and the hash comes straight back here to
   * be redeemed over /auth/v1/verify.
   *
   * @returns {Promise<string>} the token hash, or '' when GoTrue declined
   */
  async generateLink({ email, type = 'magiclink' }) {
    if (!isConfigured()) throw new NotConfiguredError();
    const body = await request('/auth/v1/admin/generate_link', {
      method: 'POST',
      body: { type, email }
    });
    // GoTrue has moved these between the top level and `properties` across
    // versions, and both shapes are still in the wild.
    return String(body?.hashed_token || body?.properties?.hashed_token || '');
  }
};

// ---------------------------------------------------------------------------
// Admin identity
//
// Cached with the same 60s TTL as whoami(), and bust-able so a change in the
// admin panel is not invisible for a minute.
// ---------------------------------------------------------------------------

const adminCache = new Map();
const ADMIN_CACHE_MS = 60 * 1000;

/** UUIDs seeded into site_admins at boot. Bootstrap only; the table then rules. */
function bootstrapAdminIds() {
  return String(process.env.AIM4_ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Is this account a site admin?
 *
 * Keyed on auth.users.id, never on username. A username is user-changeable and
 * claimable, which made the previous username-list design a privilege
 * escalation: rename yourself to a listed-but-unregistered admin name and the
 * server agreed you were an admin.
 */
export async function isSiteAdmin(userId) {
  if (!userId) return false;
  const hit = adminCache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value = false;
  try {
    const row = await db.selectOne('site_admins', { select: 'user_id', user_id: `eq.${userId}` });
    value = Boolean(row);
  } catch {
    // A database blip must not hand out admin. Fail closed.
    value = false;
  }

  adminCache.set(userId, { value, expires: Date.now() + ADMIN_CACHE_MS });
  return value;
}

/** Full admin row, for can_impersonate / can_grant. Null when not an admin. */
export async function siteAdmin(userId) {
  if (!userId) return null;
  try {
    return await db.selectOne('site_admins', { select: '*', user_id: `eq.${userId}` });
  } catch {
    return null;
  }
}

export function invalidateAdmin(userId) {
  if (userId) adminCache.delete(userId);
  else adminCache.clear();
}

/**
 * Seed site_admins from AIM4_ADMIN_USER_IDS. Runs once at boot, upserts so a
 * row edited in the panel is not clobbered on restart, and never removes rows:
 * dropping the env var must not silently delete every admin.
 */
export async function seedAdmins() {
  const ids = bootstrapAdminIds();
  if (!ids.length || !isConfigured()) return [];
  const rows = ids.map((id) => ({ user_id: id }));
  try {
    await db.upsert('site_admins', rows, { onConflict: 'user_id', returning: false });
    invalidateAdmin();
    return ids;
  } catch (err) {
    console.warn(`[entitlements] could not seed site_admins: ${err.message}`);
    return [];
  }
}
