// Run: node server/account/steamAuth.test.js
//
// Signing IN through Steam, without steamcommunity.com or Supabase in the room.
//
// What must hold: a sign-in state cannot be swapped for a link state (or the
// reverse), because either swap crosses "prove who you are" with "write this
// account's profile"; the return path cannot be pointed off-site; nothing is
// trusted before Steam confirms the assertion; and the session reaches the
// browser as a single-use code rather than as a refresh token in a URL.

process.env.AIM4_STEAM_STATE_SECRET = 'test-secret';
process.env.AIM4_PUBLIC_URL = 'https://api.aim4.example';
process.env.AIM4_SITE_URL = 'https://www.aim4.example';

const { makeState, readState, safeNext, siteUrl } = await import('./steam.js');
const {
  issueCode,
  makeSigninState,
  readSigninState,
  redeemCode,
  resetCodes,
  signinUrl,
  usernameSuggestion
} = await import('./steamAuth.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the state token ---------------------------------------------------------
{
  const state = makeSigninState('/replays');
  const read = readSigninState(state);
  assert(read.ok, 'round-trips');
  assert(read.next === '/replays', 'carries where to come back to');
  assert(!readSigninState(state, Date.now() + 11 * 60 * 1000).ok, 'expires after ten minutes');
  assert(!readSigninState(`${state}x`).ok, 'a lengthened signature fails');
  assert(!readSigninState('').ok, 'empty fails');

  // Two states signed for the same path must still differ: the nonce is what
  // stops one redirect being replayed as another.
  assert(makeSigninState('/') !== makeSigninState('/'), 'each start is unique');

  // A path with dots in it survives, because the path is everything after the
  // expiry rather than one dot-delimited field.
  assert(readSigninState(makeSigninState('/docs/v1.2.3')).next === '/docs/v1.2.3', 'dotted path');
}

// ---- the two flows cannot be crossed -----------------------------------------
{
  const link = makeState('uuid-1234');
  const signin = makeSigninState('/');

  assert(!readSigninState(link).ok, 'a link state is not a sign-in state');
  assert(readState(signin) === '', 'a sign-in state is not a link state');

  // Specifically: a sign-in state must never read back as a user id, which is
  // what the link flow would then write a steam_id onto.
  assert(readState(signin) !== 'signin', 'and does not resolve to a user id');
}

// ---- the return path cannot leave the site -----------------------------------
{
  assert(safeNext('/replays') === '/replays', 'a rooted path is kept');
  assert(safeNext('//evil.example') === '/', 'protocol-relative is refused');
  assert(safeNext('https://evil.example') === '/', 'absolute is refused');
  assert(safeNext('/\\evil.example') === '/', 'a backslash is refused');
  assert(safeNext('') === '/', 'empty falls back');
  assert(safeNext(undefined) === '/', 'missing falls back');

  // And the same through a full round trip, so a forged `next` cannot ride in
  // on a state this server signed for something else.
  assert(readSigninState(makeSigninState('//evil.example')).next === '/', 'sanitised at both ends');
}

// ---- the outbound URL --------------------------------------------------------
{
  const url = new URL(signinUrl({ headers: {} }, '/replays'));
  assert(url.origin === 'https://steamcommunity.com', 'goes to Steam');
  assert(url.searchParams.get('openid.mode') === 'checkid_setup');
  assert(url.searchParams.get('openid.realm') === 'https://api.aim4.example', 'realm is the API');
  const returnTo = new URL(url.searchParams.get('openid.return_to'));
  assert(returnTo.pathname === '/api/auth/steam/callback', 'returns to the callback');
  assert(returnTo.origin === 'https://api.aim4.example', 'on the API, which verifies it');
  assert(readSigninState(returnTo.searchParams.get('state')).ok, 'carrying the signed state');
}

// ---- the site is where the browser ends up ------------------------------------
{
  // The whole point of AIM4_SITE_URL: the last hop must not be the API host,
  // which serves a JSON 404 for /account and every other site path.
  assert(siteUrl({ headers: {} }) === 'https://www.aim4.example', 'configured site wins');
}

// ---- one-time codes ----------------------------------------------------------
{
  resetCodes();
  const session = { access_token: 'a', refresh_token: 'r' };
  const code = issueCode({ session, persona: 's1mple' });

  assert(redeemCode('nope') === null, 'an unknown code redeems to nothing');
  assert(redeemCode('') === null, 'so does an empty one');

  const first = redeemCode(code);
  assert(first?.session?.access_token === 'a', 'the right session comes back');
  assert(first?.persona === 's1mple', 'along with the username suggestion');

  // The single-use property is the whole reason a code travels in the URL
  // instead of the refresh token: a code someone else reads off a log or a
  // Referer header has already been spent by the browser that earned it.
  assert(redeemCode(code) === null, 'a second redemption gets nothing');

  // And it is worthless once stale, even on its first use.
  const stale = issueCode({ session });
  assert(redeemCode(stale, Date.now() + 3 * 60 * 1000) === null, 'expires after two minutes');
  assert(redeemCode(stale) === null, 'and is consumed by the attempt either way');

  // Two codes are never the same string.
  resetCodes();
  assert(issueCode({ session }) !== issueCode({ session }), 'each code is unique');
}

// ---- refusals before anything is trusted --------------------------------------
{
  const { completeSignin } = await import('./steamAuth.js');
  const never = () => {
    throw new Error('must not call Steam');
  };

  const expired = await completeSignin(new URLSearchParams({ state: 'garbage' }), {
    fetchImpl: never
  });
  assert(!expired.ok && expired.error === 'expired', 'a bad state is refused first');

  const state = makeSigninState('/');
  const cancelled = await completeSignin(
    new URLSearchParams({ state, 'openid.mode': 'cancel' }),
    { fetchImpl: never }
  );
  assert(!cancelled.ok && cancelled.error === 'cancelled', 'a cancelled sign-in is refused');

  // A claimed id that is not Steam's one legal shape never reaches the network.
  const bogus = await completeSignin(
    new URLSearchParams({
      state,
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://evil.example/openid/id/76561198000000000'
    }),
    { fetchImpl: never }
  );
  assert(!bogus.ok && bogus.error === 'invalid', 'a foreign claimed id is refused');

  // Steam saying no is final, even for a well-formed claim.
  const denied = await completeSignin(
    new URLSearchParams({
      state,
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000000'
    }),
    { fetchImpl: async () => ({ ok: true, text: async () => 'is_valid:false' }) }
  );
  assert(!denied.ok && denied.error === 'invalid', 'an unconfirmed assertion is refused');
}

// ---- username suggestion -----------------------------------------------------
{
  assert(usernameSuggestion('s1mple') === 's1mple', 'a clean persona passes through');
  assert(usernameSuggestion('Big Daddy') === 'big_daddy', 'spaces become underscores');
  assert(usernameSuggestion('  ~zywOo~  ') === 'zywoo', 'edges are trimmed');
  assert(usernameSuggestion('日本語') === '', 'nothing usable yields nothing');
  assert(usernameSuggestion('') === '', 'empty yields nothing');
  assert(usernameSuggestion('ab') === '', 'under three characters yields nothing');
  assert(usernameSuggestion('x'.repeat(40)).length === 20, 'clamped to twenty');
  // The picker validates too, but a suggestion that could never be accepted is
  // worse than none: it prefills a field that then refuses to submit.
  assert(/^[a-z0-9_]{3,20}$/.test(usernameSuggestion('Ünicode Name')), 'always legal if non-empty');
}

console.log('steamAuth: all assertions passed');
