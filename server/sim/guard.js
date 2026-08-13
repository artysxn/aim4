// ---------------------------------------------------------------------------
// server/sim/guard.js
// Who may reach /sim and /api/sim/*.
//
// One person: the site admin. No new env var and no new UUID list, because the
// site already knows who he is. Usernames are renameable, so the check is the
// site_admins table, never the string 'artysan'.
//
// Every denial is a 404, copying the admin API: the existence of the endpoint
// is never confirmed to someone probing for it. A 403 would say "there is
// something here and you cannot have it", which is exactly the sentence this
// page must not say.
//
// The decision is a pure function of (identity, adminness) so it can be tested
// without a Supabase stub. simGuard() is the wiring, and it takes its two
// lookups as injectable deps for the same reason.
// ---------------------------------------------------------------------------

import { whoami as realWhoami } from '../replays/identity.js';
import { isSiteAdmin as realIsSiteAdmin } from '../entitlements/service.js';

/**
 * @typedef {{allowed: boolean, reason: 'ok'|'anonymous'|'impersonating'|'not-admin'}} SimAccess
 */

/**
 * The whole access rule, with no I/O in it.
 *
 * Impersonation is denied even when the underlying account is an admin.
 * whoami() already strips admin while a ticket is live, so this is belt and
 * braces, but it is the belt that matters: an admin using "view as" is looking
 * at the site through someone else's session, and a hidden page must not be
 * visible through that window.
 *
 * @param {{signedIn?: boolean, impersonating?: unknown}|null|undefined} me
 * @param {boolean} isAdmin
 * @returns {SimAccess}
 */
export function decideSimAccess(me, isAdmin) {
  if (!me || !me.signedIn) return { allowed: false, reason: 'anonymous' };
  if (me.impersonating) return { allowed: false, reason: 'impersonating' };
  if (!isAdmin) return { allowed: false, reason: 'not-admin' };
  return { allowed: true, reason: 'ok' };
}

/**
 * Resolve the caller and apply the rule.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{whoami?: Function, isSiteAdmin?: Function}} [deps]
 * @returns {Promise<SimAccess & {me: object|null}>}
 */
export async function simGuard(req, deps = {}) {
  const whoami = deps.whoami || realWhoami;
  const isSiteAdmin = deps.isSiteAdmin || realIsSiteAdmin;

  let me = null;
  try {
    me = await whoami(req);
  } catch {
    // An identity provider outage must not open the page. Fail closed.
    return { allowed: false, reason: 'anonymous', me: null };
  }

  // Only ask the admin table once the cheap checks have passed, so an anonymous
  // prober cannot make us hit the database at all.
  const cheap = decideSimAccess(me, true);
  if (!cheap.allowed) return { ...cheap, me };

  let isAdmin = false;
  try {
    isAdmin = await isSiteAdmin(me.id);
  } catch {
    isAdmin = false;
  }
  return { ...decideSimAccess(me, isAdmin), me };
}
