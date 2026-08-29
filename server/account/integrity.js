// ---------------------------------------------------------------------------
// server/account/integrity.js
// Account-sharing detection and the probation ladder.
//
// The client pings POST /api/account/session on every page load and on tab
// refocus, carrying a device id it keeps in localStorage. Each ping becomes a
// login_events row when anything about (device, ip) changed; consecutive pings
// from the same place just touch last_seen_at.
//
// The flag deliberately requires ALL of the following at once, comparing the
// new session against the previous one:
//
//   - within SIX HOURS of the last session, and
//   - a DIFFERENT COUNTRY (both resolvable — unknown never flags), and
//   - a DIFFERENT DEVICE ID (an identical device id is always fine: that is
//     one machine travelling or hopping VPN exits), and
//   - the SAME DEVICE TYPE (iPhone → iPhone flags; PC → MacBook does not,
//     because one person owning both is normal and sharing pairs usually run
//     the same class of machine).
//
// First offense: a pending warning the client renders as a 60 second cooldown
// overlay (refresh restarts it — the cooldown is per page load by design).
// Second offense: probation. resolve.js serves the account as Free until an
// admin lifts it from the panel, after the user proves themselves via a
// ticket. Everything is deliberately reversible: nothing is deleted, the
// subscription itself is untouched.
//
// Admins are never flagged, and impersonated requests never record events —
// an admin "viewing as" a user from the admin's own IP is exactly the pattern
// this would otherwise punish the user for.
// ---------------------------------------------------------------------------

import { db, isConfigured } from '../entitlements/service.js';
import { writeAudit } from '../entitlements/audit.js';
import { recomputeUser } from '../entitlements/recompute.js';
import { countryForRequest } from './geo.js';

export const FLAG_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Same-place pings only rewrite last_seen_at this often. */
const TOUCH_MS = 5 * 60 * 1000;
/** Sessions shown on the probation notice. */
const SESSIONS_SHOWN = 5;

/**
 * Device class from the user agent, server-side so the client cannot lie
 * about it independently of everything else it sends.
 *
 * 'other' never matches anything, itself included: an unclassifiable agent is
 * not evidence of a same-type device pair, so it cannot contribute to a flag.
 * Mobile checks run first — an Android UA also contains "Linux", and a
 * desktop check running first would classify every phone as a PC.
 */
export function classifyDevice(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone/i.test(ua)) return 'iphone';
  if (/iPad/i.test(ua)) return 'ipad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'android-phone' : 'android-tablet';
  if (/CrOS/i.test(ua)) return 'chromebook';
  if (/Windows NT/i.test(ua)) return 'windows-pc';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux-pc';
  return 'other';
}

/**
 * Does this transition look like sharing? Pure, no I/O; the test drives it.
 *
 * @param {{country: string|null, deviceId: string|null, deviceType: string|null, lastSeenAtMs: number}|null} prev
 * @param {{country: string|null, deviceId: string|null, deviceType: string|null}} next
 * @param {number} nowMs
 */
export function sharingFlag(prev, next, nowMs) {
  if (!prev) return false;
  if (!Number.isFinite(prev.lastSeenAtMs) || nowMs - prev.lastSeenAtMs > FLAG_WINDOW_MS) {
    return false;
  }
  // Identical hardware id is always fine, whatever moved. Missing ids never
  // flag either: absence of evidence is not a different device.
  if (!prev.deviceId || !next.deviceId || prev.deviceId === next.deviceId) return false;
  // Matching type required, and 'other' matches nothing.
  if (!next.deviceType || next.deviceType === 'other' || prev.deviceType !== next.deviceType) {
    return false;
  }
  // Both countries must be known and differ. Unknown (dev, GeoIP off,
  // private range) can never establish "a different country".
  if (!prev.country || !next.country || prev.country === next.country) return false;
  return true;
}

/** localStorage token from the client. Anything else becomes null. */
export function normalizeDeviceId(value) {
  const id = String(value || '').toLowerCase();
  return /^[a-f0-9]{16,64}$/.test(id) ? id : null;
}

const flagSide = (event) => ({
  country: event.country || null,
  deviceType: event.device_type || null,
  ip: event.ip || null,
  at: event.last_seen_at || event.first_seen_at || null
});

async function latestEvent(userId) {
  return db.selectOne('login_events', {
    select: '*',
    user_id: `eq.${userId}`,
    order: 'last_seen_at.desc'
  });
}

/**
 * Record one session ping and run detection. Never throws: a database blip
 * must not take page loads down with it.
 *
 * @param {{me: object, req: import('http').IncomingMessage, deviceId: any, ip: string|null}} input
 * @returns {Promise<object|null>} the caller's integrity state (see integrityState)
 */
export async function recordSession({ me, req, deviceId, ip }) {
  if (!isConfigured() || !me?.signedIn || me.impersonating) return null;
  try {
    const userId = me.id;
    const device = normalizeDeviceId(deviceId);
    const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 500) || null;
    const deviceType = classifyDevice(userAgent);
    const country = await countryForRequest(req, ip);
    const nowIso = new Date().toISOString();

    const prev = await latestEvent(userId);

    // Same device, same address: touch and leave. The throttle keeps a busy
    // tab from turning every refocus into a write.
    if (prev && prev.device_id === device && prev.ip === (ip || null)) {
      const lastMs = Date.parse(prev.last_seen_at) || 0;
      if (Date.now() - lastMs > TOUCH_MS) {
        await db.update(
          'login_events',
          { id: `eq.${prev.id}` },
          { last_seen_at: nowIso },
          { returning: false }
        );
      }
      return integrityState(userId);
    }

    const next = await db.insert('login_events', {
      user_id: userId,
      ip: ip || null,
      country,
      device_id: device,
      device_type: deviceType,
      user_agent: userAgent,
      first_seen_at: nowIso,
      last_seen_at: nowIso
    });

    // Admins keep their history but are never flagged.
    if (me.admin) return integrityState(userId);

    const flagged = sharingFlag(
      prev && {
        country: prev.country,
        deviceId: prev.device_id,
        deviceType: prev.device_type,
        lastSeenAtMs: Date.parse(prev.last_seen_at)
      },
      { country, deviceId: device, deviceType },
      Date.now()
    );
    if (flagged) await raiseOffense({ userId, prev, next: next || {} });

    return integrityState(userId);
  } catch (err) {
    console.warn(`[integrity] recordSession failed: ${err.message}`);
    return null;
  }
}

async function raiseOffense({ userId, prev, next }) {
  const profile = await db.selectOne('profiles', {
    select: 'integrity_offenses,probation_at',
    id: `eq.${userId}`
  });
  // Already on probation: the state cannot get worse, so don't stack rows the
  // user will read as new accusations.
  if (profile?.probation_at) return;

  const offenses = (Number(profile?.integrity_offenses) || 0) + 1;
  const nowIso = new Date().toISOString();

  await db.insert(
    'integrity_flags',
    {
      user_id: userId,
      offense_no: offenses,
      payload: { prev: flagSide(prev), next: flagSide(next) }
    },
    { returning: false }
  );

  const patch = { integrity_offenses: offenses };
  if (offenses === 1) patch.integrity_warning_at = nowIso;
  else patch.probation_at = nowIso;
  await db.update('profiles', { id: `eq.${userId}` }, patch, { returning: false });

  if (offenses >= 2) {
    // Probation is read by resolve.js, so the caches and the denormalised
    // effective_* copy all have to move now, not within a minute.
    await recomputeUser(userId);
    console.warn(`[integrity] account ${userId} placed on probation (offense ${offenses})`);
  }
}

/**
 * What /api/me tells the client. Null when the feature is dormant (tables not
 * migrated yet, Supabase unconfigured) — the read is defensively caught so a
 * deploy ahead of the 0013 migration degrades to "no integrity block" rather
 * than breaking the account payload.
 */
export async function integrityState(userId) {
  if (!userId || !isConfigured()) return null;
  try {
    const profile = await db.selectOne('profiles', {
      select: 'integrity_offenses,integrity_warning_at,probation_at',
      id: `eq.${userId}`
    });
    if (!profile) return null;

    const offenses = Number(profile.integrity_offenses) || 0;
    const state = { offenses, warning: null, probation: null };
    if (!offenses && !profile.probation_at) return state;

    const flag = await db.selectOne('integrity_flags', {
      select: 'payload,created_at,offense_no',
      user_id: `eq.${userId}`,
      order: 'created_at.desc'
    });

    if (profile.probation_at) {
      const events = await db.select('login_events', {
        select: 'country,device_type,last_seen_at',
        user_id: `eq.${userId}`,
        order: 'last_seen_at.desc',
        limit: SESSIONS_SHOWN
      });
      state.probation = {
        at: profile.probation_at,
        from: flag?.payload?.prev || null,
        to: flag?.payload?.next || null,
        sessions: (events || []).map((e) => ({
          at: e.last_seen_at,
          country: e.country || null,
          deviceType: e.device_type || null
        }))
      };
    } else if (profile.integrity_warning_at) {
      state.warning = {
        at: profile.integrity_warning_at,
        from: flag?.payload?.prev || null,
        to: flag?.payload?.next || null
      };
    }
    return state;
  } catch (err) {
    console.warn(`[integrity] state read failed: ${err.message}`);
    return null;
  }
}

/**
 * The user sat out the 60 seconds and clicked through. Clears the pending
 * warning; the offense count and the flag row stay, because the second
 * offense builds on them.
 */
export async function ackWarning(userId) {
  if (!userId || !isConfigured()) return false;
  await db.update(
    'profiles',
    { id: `eq.${userId}`, integrity_warning_at: 'not.is.null' },
    { integrity_warning_at: null },
    { returning: false }
  );
  return true;
}

/**
 * Admin lifts probation after the user proved themselves via a ticket. A full
 * reset: evidence was provided, so the account starts clean rather than one
 * offense from being locked again. The flag rows stay for the record.
 */
export async function liftProbation({ userId, actorId, req = null }) {
  if (!userId || !isConfigured()) return null;
  await db.update(
    'profiles',
    { id: `eq.${userId}` },
    { probation_at: null, integrity_offenses: 0, integrity_warning_at: null },
    { returning: false }
  );
  await writeAudit({ actorId, action: 'integrity.lift', targetUser: userId, req });
  await recomputeUser(userId);
  return integrityState(userId);
}

/** The admin panel's view of one account: state, flags, recent sessions. */
export async function adminIntegrityDetail(userId) {
  if (!userId || !isConfigured()) return { state: null, flags: [], events: [] };
  const [state, flags, events] = await Promise.all([
    integrityState(userId),
    db.select('integrity_flags', {
      select: '*',
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: 10
    }),
    db.select('login_events', {
      select: 'ip,country,device_type,device_id,first_seen_at,last_seen_at',
      user_id: `eq.${userId}`,
      order: 'last_seen_at.desc',
      limit: 10
    })
  ]);
  return { state, flags, events };
}
