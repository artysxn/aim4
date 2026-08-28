// Run: node server/account/steam.test.js
//
// The Steam OpenID link, without steamcommunity.com in the room.
//
// What must hold: the state token is the ONLY thing tying the return leg to
// an account, so it must be unforgeable and expiring; nothing from Steam's
// redirect is trusted before Steam itself confirms the assertion; and the
// SteamID is read from the claimed id's one legal shape, never from anything
// looser.

process.env.AIM4_STEAM_STATE_SECRET = 'test-secret';
process.env.AIM4_PUBLIC_URL = 'https://aim4.example';

const {
  LINK_ERRORS,
  completeLink,
  makeState,
  readState,
  siteOrigin,
  startUrl,
  steamIdFromClaim,
  verifyAssertion
} = await import('./steam.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the state token ---------------------------------------------------------
{
  const state = makeState('uuid-1234');
  assert(readState(state) === 'uuid-1234', 'round-trips the user id');
  assert(readState(state, Date.now() + 11 * 60 * 1000) === '', 'expires after ten minutes');
  assert(readState(`${state}x`) === '', 'a lengthened signature fails');
  assert(readState(state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))) === '', 'a flipped byte fails');
  assert(readState('') === '', 'empty fails');
  assert(readState('a.b.c') === '', 'wrong shape fails');

  // Tampering with the body without re-signing must fail even when the shape
  // stays legal.
  const [, sig] = state.split('.');
  const forged = `${Buffer.from(`uuid-9999.${Date.now() + 60000}`).toString('base64url')}.${sig}`;
  assert(readState(forged) === '', 'a re-addressed body fails its signature');
}

// ---- the outbound URL --------------------------------------------------------
{
  const url = new URL(startUrl({ headers: {} }, 'uuid-1234'));
  assert(url.origin === 'https://steamcommunity.com', 'goes to Steam');
  assert(url.searchParams.get('openid.mode') === 'checkid_setup');
  assert(url.searchParams.get('openid.realm') === 'https://aim4.example', 'realm is this site');
  const returnTo = new URL(url.searchParams.get('openid.return_to'));
  assert(returnTo.origin === 'https://aim4.example', 'and so is the return leg');
  assert(readState(returnTo.searchParams.get('state')) === 'uuid-1234', 'carrying the signed state');
}

// ---- the origin, when not configured ----------------------------------------
{
  const saved = process.env.AIM4_PUBLIC_URL;
  delete process.env.AIM4_PUBLIC_URL;
  const origin = siteOrigin({
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'aim4.io' }
  });
  assert(origin === 'https://aim4.io', `forwarded headers win (got ${origin})`);
  process.env.AIM4_PUBLIC_URL = saved;
}

// ---- the claimed id ----------------------------------------------------------
{
  assert(
    steamIdFromClaim('https://steamcommunity.com/openid/id/76561198000000001') ===
      '76561198000000001',
    'the one legal shape'
  );
  assert(steamIdFromClaim('https://steamcommunity.com/openid/id/nope') === '', 'digits only');
  assert(steamIdFromClaim('https://evil.example/openid/id/76561198000000001') === '', 'right host only');
  assert(steamIdFromClaim('') === '');
}

// ---- verification talks to Steam, not to the query string --------------------
{
  let posted = null;
  const fakeFetch = async (url, init) => {
    posted = { url, body: init.body };
    return { text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' };
  };
  const query = new URLSearchParams({
    'openid.mode': 'id_res',
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
    'openid.sig': 'abc',
    unrelated: 'dropped'
  });
  const ok = await verifyAssertion(query, fakeFetch);
  assert(ok === true, 'a vouched assertion verifies');
  assert(posted.url.startsWith('https://steamcommunity.com/openid/login'), 'replayed to Steam');
  const replay = new URLSearchParams(posted.body);
  assert(replay.get('openid.mode') === 'check_authentication', 'as a check, not a login');
  assert(replay.get('openid.sig') === 'abc', 'with the original signature');
  assert(replay.get('unrelated') === null, 'and nothing that is not openid');

  const no = await verifyAssertion(query, async () => ({ text: async () => 'is_valid:false\n' }));
  assert(no === false, 'an unvouched one does not');
}

// ---- the return leg's refusals -----------------------------------------------
{
  const good = () => {
    const q = new URLSearchParams({
      state: makeState('uuid-1234'),
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001'
    });
    return q;
  };
  const vouch = async () => ({ text: async () => 'is_valid:true\n' });

  let r = await completeLink(new URLSearchParams({ state: 'garbage' }), { fetchImpl: vouch });
  assert(r.error === 'expired', 'no valid state, no link');

  const cancelled = good();
  cancelled.set('openid.mode', 'cancel');
  r = await completeLink(cancelled, { fetchImpl: vouch });
  assert(r.error === 'cancelled', 'a cancelled Steam login is reported as such');

  const badClaim = good();
  badClaim.set('openid.claimed_id', 'https://evil.example/openid/id/123');
  r = await completeLink(badClaim, { fetchImpl: vouch });
  assert(r.error === 'invalid', 'a claim from the wrong host is refused');

  r = await completeLink(good(), { fetchImpl: async () => ({ text: async () => 'is_valid:false\n' }) });
  assert(r.error === 'invalid', 'an assertion Steam disowns is refused');

  r = await completeLink(good(), {
    fetchImpl: async () => {
      throw new Error('boom');
    }
  });
  assert(r.error === 'unreachable', 'Steam being down is not an invalid link');

  // Past every check, the only thing left is the profile write — which throws
  // here because no database is configured. Reaching it proves verification
  // came first.
  let reachedWrite = false;
  try {
    await completeLink(good(), { fetchImpl: vouch });
  } catch {
    reachedWrite = true;
  }
  assert(reachedWrite, 'a fully verified link proceeds to the profile write');

  for (const key of ['expired', 'cancelled', 'invalid', 'unreachable', 'in_use']) {
    assert(LINK_ERRORS[key], `human copy exists for ${key}`);
  }
}

console.log('steam: all assertions passed');
