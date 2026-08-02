// ---------------------------------------------------------------------------
// server/admin/guard.js
// The two things every route must do while a request is impersonated.
//
// Called from the replay and team dispatchers rather than from whoami(),
// because whoami() answers "who is this" and should not also be deciding
// whether a request may proceed.
// ---------------------------------------------------------------------------

import { auditImpersonatedRequest } from '../entitlements/audit.js';
import { readOnlyBlocked } from '../replays/identity.js';

/**
 * Record the request, and refuse it when a read-only ticket is being used to
 * write.
 *
 * Read-only is the default for impersonation because the alternative is that
 * "let me look at what they are seeing" and "let me change their data" are the
 * same action. Write-mode impersonation exists, but it is chosen explicitly at
 * mint time and audited as its own event.
 *
 * @returns {{status: number, body: object}|null} a refusal, or null to proceed
 */
export function guardImpersonation(req, url, me) {
  if (!me?.impersonating) return null;

  auditImpersonatedRequest({
    actorId: me.impersonating.actorId,
    targetId: me.impersonating.targetId,
    jti: me.impersonating.jti,
    path: url?.pathname || '',
    method: req?.method || 'GET',
    req
  });

  if (readOnlyBlocked(req, me)) {
    return {
      status: 403,
      body: {
        error: 'impersonation_read_only',
        message: 'This is a read-only session. Exit it to make changes.'
      }
    };
  }
  return null;
}
