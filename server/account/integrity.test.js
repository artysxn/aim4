// Run: node server/account/integrity.test.js
//
// sharingFlag() decides whether a paying user gets accused of sharing, so the
// cases below are chosen adversarially in both directions: every legitimate
// pattern (travel, VPN, own second device, unknown data) must stay quiet, and
// the one pattern that defines sharing must fire. Pure: no database, `now` is
// passed.

import { classifyDevice, normalizeDeviceId, sharingFlag, FLAG_WINDOW_MS } from './integrity.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const NOW = Date.parse('2026-08-29T12:00:00Z');
const HOUR = 60 * 60 * 1000;

/** The canonical guilty pair: same device class, new id, new country, 2h apart. */
function prevSession(extra = {}) {
  return {
    country: 'RU',
    deviceId: 'a'.repeat(32),
    deviceType: 'iphone',
    lastSeenAtMs: NOW - 2 * HOUR,
    ...extra
  };
}

function nextSession(extra = {}) {
  return {
    country: 'JP',
    deviceId: 'b'.repeat(32),
    deviceType: 'iphone',
    ...extra
  };
}

// ---- device classification --------------------------------------------------

{
  const cases = [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', 'iphone'],
    ['Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15', 'ipad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari', 'android-phone'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 Safari', 'android-tablet'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'windows-pc'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'mac'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'linux-pc'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36', 'chromebook'],
    ['', 'other'],
    ['curl/8.4.0', 'other']
  ];
  for (const [ua, expected] of cases) {
    const got = classifyDevice(ua);
    assert(got === expected, `${ua || '(empty)'} → ${got}, expected ${expected}`);
  }
  // An Android UA contains "Linux"; the phone must never classify as a PC.
  assert(classifyDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile') !== 'linux-pc');
  console.log('  user agents classify into device types, Android never reads as a PC');
}

// ---- the flag fires on the defining pattern ----------------------------------

{
  assert(
    sharingFlag(prevSession(), nextSession(), NOW),
    'RU iPhone → JP different-iPhone inside 6h must flag'
  );
  assert(
    sharingFlag(
      prevSession({ deviceType: 'windows-pc' }),
      nextSession({ deviceType: 'windows-pc' }),
      NOW
    ),
    'two different Windows PCs across countries inside 6h must flag'
  );
  console.log('  same device type, different device, different country, inside 6h → flag');
}

// ---- every legitimate pattern stays quiet ------------------------------------

{
  assert(
    !sharingFlag(prevSession(), nextSession({ deviceId: prevSession().deviceId }), NOW),
    'identical device id is one machine travelling or on a VPN — never a flag'
  );
  console.log('  the same hardware id is always fine, whatever the country did');
}

{
  assert(
    !sharingFlag(prevSession({ deviceType: 'windows-pc' }), nextSession({ deviceType: 'mac' }), NOW),
    'PC → MacBook is one person with two computers'
  );
  assert(
    !sharingFlag(prevSession({ deviceType: 'iphone' }), nextSession({ deviceType: 'windows-pc' }), NOW),
    'phone → PC is one person switching devices'
  );
  console.log('  a different device TYPE never flags: owning two kinds of device is normal');
}

{
  assert(
    !sharingFlag(prevSession({ country: 'JP' }), nextSession(), NOW),
    'same country must not flag, whatever the hardware'
  );
  console.log('  a device change inside one country never flags');
}

{
  assert(
    !sharingFlag(prevSession({ lastSeenAtMs: NOW - FLAG_WINDOW_MS - 1 }), nextSession(), NOW),
    'outside the 6 hour window is not "at the same time"'
  );
  assert(
    sharingFlag(prevSession({ lastSeenAtMs: NOW - FLAG_WINDOW_MS }), nextSession(), NOW),
    'exactly at the window edge still counts'
  );
  console.log('  the 6 hour window is enforced, inclusive at the edge');
}

{
  // Unknown data can never establish a difference. This is what keeps local
  // dev (no GeoIP, private IPs) and blocked-storage browsers flag-free.
  assert(!sharingFlag(null, nextSession(), NOW), 'no previous session, nothing to compare');
  assert(!sharingFlag(prevSession({ country: null }), nextSession(), NOW), 'unknown prev country');
  assert(!sharingFlag(prevSession(), nextSession({ country: null }), NOW), 'unknown next country');
  assert(!sharingFlag(prevSession({ deviceId: null }), nextSession(), NOW), 'missing prev device');
  assert(!sharingFlag(prevSession(), nextSession({ deviceId: null }), NOW), 'missing next device');
  assert(
    !sharingFlag(
      prevSession({ deviceType: 'other' }),
      nextSession({ deviceType: 'other' }),
      NOW
    ),
    "'other' matches nothing, itself included"
  );
  assert(
    !sharingFlag(prevSession({ lastSeenAtMs: NaN }), nextSession(), NOW),
    'an unparsable timestamp never flags'
  );
  console.log('  unknown country, device or time always resolves to no flag');
}

// ---- device id normalisation --------------------------------------------------

{
  assert(normalizeDeviceId('A'.repeat(32)) === 'a'.repeat(32), 'ids lowercase');
  assert(normalizeDeviceId('a'.repeat(16)) === 'a'.repeat(16), '16 hex chars is the floor');
  assert(normalizeDeviceId('a'.repeat(15)) === null, 'too short is rejected');
  assert(normalizeDeviceId('a'.repeat(65)) === null, 'too long is rejected');
  assert(normalizeDeviceId('not-hex-at-all!') === null, 'non-hex is rejected');
  assert(normalizeDeviceId(undefined) === null, 'absent is null, never a string "undefined"');
  console.log('  device ids are hex tokens or nothing');
}

console.log('integrity: all assertions passed');
