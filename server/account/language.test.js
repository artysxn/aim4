// Run: node --test --experimental-test-module-mocks server/account/language.test.js
//
// The interface language is the first column on public.profiles that the owner
// of the row is allowed to change, so the route around it is the whole of the
// protection. The check constraint in 0022 is a second net, not the first one:
// a request that reaches the database with a bad value has already gone wrong.
//
// The signed-in path is the half that cannot be seen from outside. Hitting the
// running server only ever shows "Sign in first.", which proves the guard and
// nothing else, so whoami and the database client are replaced here and the
// real handler is driven end to end against them.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const USER = {
  signedIn: true,
  id: 'user-1',
  username: 'tester',
  admin: false,
  email: 't@example.com'
};

/** What the handler asked the database to do, in order. */
const writes = [];
let profileRow = { username: 'tester', display_name: '', language: 'en' };

// Both modules are replaced whole, so every export they have has to be here:
// other modules import isConfigured and demoUploadIdentity from these same
// files, and a mock that omits them fails at load rather than at assert time.
const real = {
  identity: await import('../replays/identity.js'),
  service: await import('../entitlements/service.js')
};

mock.module('../replays/identity.js', {
  namedExports: {
    ...real.identity,
    whoami: async () => USER,
    invalidateUserIdentity: () => {}
  }
});

mock.module('../entitlements/service.js', {
  namedExports: {
    ...real.service,
    db: {
      selectOne: async () => profileRow,
      select: async () => [],
      update: async (table, match, patch) => {
        writes.push({ table, match, patch });
        if (table === 'profiles' && patch.language) profileRow.language = patch.language;
        return [profileRow];
      },
      insert: async () => [{}]
    }
  }
});

const { handleAccountRequest } = await import('./routes.js');

/** A request/response pair good enough for one route. */
function call(method, path, body) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    on(event, fn) {
      if (event === 'data') for (const c of chunks) fn(c);
      if (event === 'end') fn();
      return req;
    }
  };
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code) {
      status = code;
      return res;
    },
    setHeader() {},
    end(text) {
      payload = text || '';
    }
  };
  return handleAccountRequest(req, res, new URL(`http://x${path}`)).then(() => ({
    status,
    body: payload ? JSON.parse(payload) : null
  }));
}

test('a signed-in account can set its language, and the write lands on its own row', async () => {
  writes.length = 0;
  profileRow = { username: 'tester', display_name: '', language: 'en' };

  const res = await call('POST', '/api/account/language', { language: 'ru' });

  assert.equal(res.status, 200, 'the route accepts a language the site has');
  assert.deepEqual(res.body, { language: 'ru' }, 'and echoes back the value it stored');

  assert.equal(writes.length, 1, 'exactly one write');
  assert.equal(writes[0].table, 'profiles');
  assert.deepEqual(writes[0].patch, { language: 'ru' }, 'nothing but the language is touched');
  assert.deepEqual(
    writes[0].match,
    { id: `eq.${USER.id}` },
    'scoped to the caller, so one account cannot set another account language'
  );
});

test('a language the site does not have is refused before it reaches the database', async () => {
  writes.length = 0;

  const res = await call('POST', '/api/account/language', { language: 'klingon' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a language/i, 'the reason is readable, since the UI shows it raw');
  assert.equal(writes.length, 0, 'and nothing was written');
});

test('a tag with a region is normalised rather than rejected', async () => {
  writes.length = 0;

  // A client sending pt-BR means Portuguese, which the site has. Refusing that
  // would be pedantry; storing pt-BR would break the check constraint.
  const res = await call('POST', '/api/account/language', { language: 'pt-BR' });

  assert.equal(res.status, 200);
  assert.equal(res.body.language, 'pt');
  assert.deepEqual(writes[0].patch, { language: 'pt' });
});

test('an empty or missing language does not silently reset the account to English', async () => {
  writes.length = 0;

  const res = await call('POST', '/api/account/language', {});

  assert.equal(res.status, 400, 'a missing value is a bad request, not a reset');
  assert.equal(writes.length, 0);
});

test('/api/me serves the language from the profile, not from auth metadata', async () => {
  profileRow = { username: 'tester', display_name: 'Test', language: 'fi' };

  const res = await call('GET', '/api/me');

  assert.equal(res.status, 200);
  assert.equal(res.body.account.language, 'fi');
});

test('/api/me falls back to English when the column holds something unknown', async () => {
  // Belt and braces: the constraint should make this impossible, but a value
  // the browser cannot load a catalogue for must not reach it.
  profileRow = { username: 'tester', display_name: '', language: 'klingon' };

  const res = await call('GET', '/api/me');

  assert.equal(res.body.account.language, 'en');
});
