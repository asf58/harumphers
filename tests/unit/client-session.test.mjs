import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { readSource } from '../helpers/read-source.mjs';

async function loadClient(fetchImpl) {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
  const context = {
    console,
    document: {
      currentScript: { dataset: { apiOrigin: 'https://api.example.test' } }
    },
    fetch: fetchImpl,
    Headers,
    localStorage: storage,
    Response,
    URL
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(await readSource('assets/harumphers-client.js'), context, {
    filename: 'assets/harumphers-client.js'
  });

  return { Harumphers: context.Harumphers, values };
}

test('guest login sends the phrase only in an HTTPS body and stores only the signed token', async () => {
  const requests = [];
  const { Harumphers, values } = await loadClient(async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ token: 'fixture.signed.token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  await Harumphers.loginGuest('fixture guest phrase');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example.test/api/login/guest');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { phrase: 'fixture guest phrase' });
  assert.equal(new Headers(requests[0].init.headers).has('Authorization'), false);
  assert.deepEqual([...values], [['harumphers_session', 'fixture.signed.token']]);
});

test('member and administrator login use distinct explicit session endpoints', async () => {
  const requests = [];
  const { Harumphers } = await loadClient(async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ token: `fixture.token.${requests.length}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });

  await Harumphers.loginMember(42);
  await Harumphers.loginAdmin('fixture admin password');

  assert.deepEqual(requests, [
    { url: 'https://api.example.test/api/login/member', body: { memberNumber: 42 } },
    { url: 'https://api.example.test/api/login/admin', body: { password: 'fixture admin password' } }
  ]);
});

test('authenticated API calls use the bearer session and reject non-API paths', async () => {
  const requests = [];
  const { Harumphers, values } = await loadClient(async (url, init) => {
    requests.push({ url, headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  values.set('harumphers_session', 'fixture.signed.token');

  await Harumphers.api('/api/directory');

  assert.equal(requests[0].url, 'https://api.example.test/api/directory');
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture.signed.token');
  assert.equal(requests[0].headers.has('X-Harumphers-Key'), false);
  await assert.rejects(() => Harumphers.api('/v0/base/table'), /explicit API path/);
  await assert.rejects(() => Harumphers.api('https://unapproved.example.test/api/directory'), /explicit API path/);
});

test('a 401 response clears the signed session and legacy display-only state', async () => {
  const { Harumphers, values } = await loadClient(async () => new Response(JSON.stringify({
    error: { code: 'SESSION_REQUIRED', message: 'Please sign in again.', requestId: 'fixture-request-id' }
  }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  }));
  values.set('harumphers_session', 'fixture.signed.token');
  values.set('harumphers_auth', 'admin');
  values.set('harumphers_duq_id', '42');
  values.set('harumphers_role', 'admin');
  values.set('harumphers_member_name', 'Legacy Display Name');

  await assert.rejects(() => Harumphers.api('/api/session'), error => (
    error.code === 'SESSION_REQUIRED' && error.requestId === 'fixture-request-id'
  ));

  assert.deepEqual([...values], []);
});

test('session state comes from the Worker response rather than a local role value', async () => {
  const { Harumphers, values } = await loadClient(async () => new Response(JSON.stringify({ role: 'member' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  }));
  values.set('harumphers_session', 'fixture.signed.token');
  values.set('harumphers_role', 'admin');

  assert.deepEqual(await Harumphers.getSession(), { role: 'member' });
});
