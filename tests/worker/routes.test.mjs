import assert from 'node:assert/strict';
import test from 'node:test';

import { issueSession, verifySession } from '../../worker/src/auth.js';
import { handleRequest } from '../../worker/src/index.js';

const ENV = {
  ADMIN_LOGIN: 'fixture-admin-password',
  ALLOWED_ORIGINS: 'https://app.example.test,https://preview.example.test',
  AUTH_RATE_LIMITER: { async limit() { return { success: true }; } },
  GUEST_LOGIN: 'fixture-guest-phrase',
  MEMBER_REQUEST_RATE_LIMITER: { async limit() { return { success: true }; } },
  SESSION_SECRET: 'fixture-session-secret-32-characters'
};

function makeAirtable() {
  const calls = [];
  return {
    calls,
    async findMemberByNumber(memberNumber) {
      calls.push(['findMemberByNumber', memberNumber]);
      if (memberNumber !== 42) return null;
      return { id: 'recFixtureMember1', fields: { 'FULL NAME': 'Fixture Member', 'IS ADMIN': false } };
    },
    async getDirectory(role) {
      calls.push(['getDirectory', role]);
      return { records: [{ id: 'rec_directory', fields: { 'FULL NAME': 'Directory Fixture' } }] };
    },
    async getEventsBootstrap(role) {
      calls.push(['getEventsBootstrap', role]);
      return { events: [{ id: 'rec_event', fields: { NAME: 'Event Fixture' } }], members: [] };
    },
    async getMemberVotes(recordId) {
      calls.push(['getMemberVotes', recordId]);
      return { votes: [{ eventId: 'recFixtureEvent02', vote: 'UP' }] };
    },
    async getMember(recordId) {
      calls.push(['getMember', recordId]);
      return { id: recordId, fields: { 'FULL NAME': 'Fixture Member' } };
    },
    async updateMemberProfile(recordId, fields) {
      calls.push(['updateMemberProfile', recordId, fields]);
      return { id: recordId, fields };
    },
    async updateMember(recordId, fields) {
      calls.push(['updateMember', recordId, fields]);
      return { id: recordId, fields };
    },
    async setRsvp(recordId, eventId, value, options) {
      calls.push(['setRsvp', recordId, eventId, value, options]);
      return { ok: true };
    },
    async createEvent(value) {
      calls.push(['createEvent', value]);
      return { eventId: 'recFixtureEvent01', setupState: 'ready', resumed: false };
    }
  };
}

function request(path, { method = 'GET', token, body, origin = 'https://app.example.test' } = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': '192.0.2.1', Origin: origin });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  return new Request(`https://api.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function call(requestValue, airtable = makeAirtable()) {
  const response = await handleRequest(requestValue, ENV, {}, {
    airtable,
    nowSeconds: () => 1000,
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  return { airtable, body: await response.json(), response };
}

test('unknown routes and unsupported methods cannot reach Airtable', async () => {
  const cases = [
    ['/v0/base/table', 'GET', 404],
    ['/api/metadata', 'GET', 404],
    ['/api/base', 'GET', 404],
    ['/api/tables/members', 'GET', 404],
    ['/api/directory/rec_fixture', 'GET', 404],
    ['/api/directory', 'POST', 405]
  ];

  for (const [path, method, expectedStatus] of cases) {
    const airtable = makeAirtable();
    const { response } = await call(request(path, { method }), airtable);
    assert.equal(response.status, expectedStatus, `${method} ${path}`);
    assert.deepEqual(airtable.calls, [], `${method} ${path} reached Airtable`);
  }
});

test('health reports readiness without authentication, Airtable access, or configuration values', async () => {
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/health'), airtable);

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, service: 'harumphers-api' });
  assert.deepEqual(airtable.calls, []);
  assert.equal(JSON.stringify(body).includes(ENV.SESSION_SECRET), false);
});

test('directory and events reads require a signed session', async () => {
  for (const path of ['/api/directory', '/api/events']) {
    const airtable = makeAirtable();
    const { body, response } = await call(request(path), airtable);
    assert.equal(response.status, 401, path);
    assert.equal(body.error.code, 'SESSION_REQUIRED', path);
    assert.equal(body.error.requestId, '00000000-0000-4000-8000-000000000001', path);
    assert.deepEqual(airtable.calls, [], `${path} reached Airtable without a session`);
  }
});

test('a guest session can read only the explicit directory and events resources', async () => {
  const token = await issueSession({ sub: 'guest', role: 'guest' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();

  const directory = await call(request('/api/directory', { token }), airtable);
  assert.equal(directory.response.status, 200);
  assert.deepEqual(directory.body, {
    records: [{ id: 'rec_directory', fields: { 'FULL NAME': 'Directory Fixture' } }]
  });

  const events = await call(request('/api/events', { token }), airtable);
  assert.equal(events.response.status, 200);
  assert.deepEqual(events.body, {
    events: [{ id: 'rec_event', fields: { NAME: 'Event Fixture' } }],
    members: []
  });
  assert.deepEqual(airtable.calls, [['getDirectory', 'guest'], ['getEventsBootstrap', 'guest']]);
});

test('the me route derives the member record from the signed subject', async () => {
  const token = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();

  const { body, response } = await call(request('/api/me?recordId=rec_other', { token }), airtable);

  assert.equal(response.status, 200);
  assert.equal(body.id, 'recFixtureMember1');
  assert.deepEqual(airtable.calls, [['getMember', 'recFixtureMember1']]);
});

test('only a record-backed admin session retains member identity', async () => {
  const airtable = makeAirtable();
  const memberAdminToken = await issueSession({
    sub: 'recFixtureAdmin01',
    role: 'admin'
  }, ENV.SESSION_SECRET, 1000);
  const passwordAdminToken = await issueSession({ sub: 'admin', role: 'admin' }, ENV.SESSION_SECRET, 1000);

  const memberAdminSession = await call(request('/api/session', { token: memberAdminToken }), airtable);
  assert.deepEqual(memberAdminSession.body, { role: 'admin', hasMemberIdentity: true });

  const memberAdminProfile = await call(request('/api/me', { token: memberAdminToken }), airtable);
  assert.equal(memberAdminProfile.response.status, 200);
  assert.equal(memberAdminProfile.body.id, 'recFixtureAdmin01');

  const passwordAdminSession = await call(request('/api/session', { token: passwordAdminToken }), airtable);
  assert.deepEqual(passwordAdminSession.body, { role: 'admin', hasMemberIdentity: false });

  const passwordAdminProfile = await call(request('/api/me', { token: passwordAdminToken }), airtable);
  assert.equal(passwordAdminProfile.response.status, 403);
  assert.equal(passwordAdminProfile.body.error.code, 'FORBIDDEN');
  assert.deepEqual(airtable.calls, [['getMember', 'recFixtureAdmin01']]);
});

test('member vote history exposes only the signed member own event choices', async () => {
  const memberToken = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const guestToken = await issueSession({ sub: 'guest', role: 'guest' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();

  const denied = await call(request('/api/me/votes', { token: guestToken }), airtable);
  assert.equal(denied.response.status, 403);
  assert.deepEqual(airtable.calls, []);

  const allowed = await call(request('/api/me/votes', { token: memberToken }), airtable);
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(allowed.body, { votes: [{ eventId: 'recFixtureEvent02', vote: 'UP' }] });
  assert.deepEqual(airtable.calls, [['getMemberVotes', 'recFixtureMember1']]);
});

test('member profile writes are limited to the signed subject and allowlisted fields', async () => {
  const token = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/me', {
    method: 'PATCH',
    token,
    body: { name: 'Updated Fixture', phone: '412-555-0100', email: 'updated@example.test' }
  }), airtable);

  assert.equal(response.status, 200);
  assert.equal(body.id, 'recFixtureMember1');
  assert.deepEqual(airtable.calls, [[
    'updateMemberProfile',
    'recFixtureMember1',
    { name: 'Updated Fixture', phone: '412-555-0100', email: 'updated@example.test' }
  ]]);

  const extraField = await call(request('/api/me', {
    method: 'PATCH',
    token,
    body: { name: 'Updated Fixture', role: 'admin' }
  }), airtable);
  assert.equal(extraField.response.status, 400);
  assert.equal(extraField.body.error.code, 'VALIDATION_FAILED');
  assert.equal(airtable.calls.length, 1);
});

test('administrator member writes require an administrator session', async () => {
  const memberToken = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const adminToken = await issueSession({ sub: 'admin', role: 'admin' }, ENV.SESSION_SECRET, 1000);
  const targetId = 'recFixtureMember2';
  const airtable = makeAirtable();
  const value = { name: 'Admin Updated Fixture', phone: '', email: '', memberNumber: 42002 };

  const denied = await call(request(`/api/admin/members/${targetId}`, {
    method: 'PATCH', token: memberToken, body: value
  }), airtable);
  assert.equal(denied.response.status, 403);
  assert.deepEqual(airtable.calls, []);

  const allowed = await call(request(`/api/admin/members/${targetId}`, {
    method: 'PATCH', token: adminToken, body: value
  }), airtable);
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(airtable.calls, [['updateMember', targetId, value]]);

  const misleadingRoleWrite = await call(request(`/api/admin/members/${targetId}`, {
    method: 'PATCH', token: adminToken, body: { ...value, isAdmin: true }
  }), airtable);
  assert.equal(misleadingRoleWrite.response.status, 400);
  assert.equal(airtable.calls.length, 1);
});

test('RSVP writes derive the member target from the signed session', async () => {
  const token = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();
  const eventId = 'recFixtureEvent01';
  const { response } = await call(request(`/api/events/${eventId}/rsvp`, {
    method: 'PUT', token, body: { response: 'YES', guests: 2 }
  }), airtable);

  assert.equal(response.status, 200);
  assert.deepEqual(airtable.calls, [[
    'setRsvp', 'recFixtureMember1', eventId, { response: 'YES', guests: 2 }, { admin: false }
  ]]);
});

test('event creation is administrator-only and rejects unknown input before Airtable', async () => {
  const adminToken = await issueSession({ sub: 'admin', role: 'admin' }, ENV.SESSION_SECRET, 1000);
  const memberToken = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();
  const event = {
    idempotencyKey: '00000000-0000-4000-8000-000000000001',
    name: 'Fixture Event',
    date: '2026-09-12',
    speaker: 'Fixture Speaker',
    time: '6:00 PM',
    room: 'Fixture Hall',
    notes: '',
    status: 'Scheduled',
    enableGuests: true
  };

  const denied = await call(request('/api/admin/events', {
    method: 'POST', token: memberToken, body: event
  }), airtable);
  assert.equal(denied.response.status, 403);
  assert.deepEqual(airtable.calls, []);

  const invalid = await call(request('/api/admin/events', {
    method: 'POST', token: adminToken, body: { ...event, tableId: 'fixture' }
  }), airtable);
  assert.equal(invalid.response.status, 400);
  assert.deepEqual(airtable.calls, []);

  const allowed = await call(request('/api/admin/events', {
    method: 'POST', token: adminToken, body: event
  }), airtable);
  assert.equal(allowed.response.status, 200);
  assert.deepEqual(airtable.calls, [['createEvent', event]]);
});

test('member-number login issues a member session when the Airtable admin flag is false', async () => {
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/login/member', {
    method: 'POST',
    body: { memberNumber: 42 }
  }), airtable);

  assert.equal(response.status, 200);
  assert.deepEqual(await verifySession(body.token, ENV.SESSION_SECRET, 1000), {
    sub: 'recFixtureMember1',
    role: 'member',
    iat: 1000,
    exp: 44200
  });
  assert.deepEqual(airtable.calls, [['findMemberByNumber', 42]]);
});

test('member-number login issues an admin session when the Airtable admin flag is true', async () => {
  const airtable = makeAirtable();
  airtable.findMemberByNumber = async memberNumber => {
    airtable.calls.push(['findMemberByNumber', memberNumber]);
    return { id: 'recFixtureAdmin01', fields: { 'FULL NAME': 'Fixture Admin', 'IS ADMIN': true } };
  };

  const { body, response } = await call(request('/api/login/member', {
    method: 'POST',
    body: { memberNumber: 42 }
  }), airtable);

  assert.equal(response.status, 200);
  assert.deepEqual(await verifySession(body.token, ENV.SESSION_SECRET, 1000), {
    sub: 'recFixtureAdmin01',
    role: 'admin',
    iat: 1000,
    exp: 44200
  });
  assert.deepEqual(airtable.calls, [['findMemberByNumber', 42]]);
});

test('invalid member-number input fails before an Airtable lookup', async () => {
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/login/member', {
    method: 'POST',
    body: { memberNumber: '42' }
  }), airtable);

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.deepEqual(airtable.calls, []);
});

test('administrator login is verified only against the Worker-held value', async () => {
  const rejected = await call(request('/api/login/admin', {
    method: 'POST',
    body: { password: 'wrong-fixture-password' }
  }));
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.body.error.code, 'LOGIN_FAILED');

  const accepted = await call(request('/api/login/admin', {
    method: 'POST',
    body: { password: ENV.ADMIN_LOGIN }
  }));
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(await verifySession(accepted.body.token, ENV.SESSION_SECRET, 1000), {
    sub: 'admin',
    role: 'admin',
    iat: 1000,
    exp: 44200
  });
  assert.deepEqual(accepted.airtable.calls, []);
});

test('guest login issues a guest session without echoing the phrase', async () => {
  const rejected = await call(request('/api/login/guest', {
    method: 'POST',
    body: { phrase: 'wrong-fixture-phrase' }
  }));
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.body.error.code, 'LOGIN_FAILED');

  const accepted = await call(request('/api/login/guest', {
    method: 'POST',
    body: { phrase: ENV.GUEST_LOGIN }
  }));
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(await verifySession(accepted.body.token, ENV.SESSION_SECRET, 1000), {
    sub: 'guest',
    role: 'guest',
    iat: 1000,
    exp: 44200
  });
  assert.equal(JSON.stringify(accepted.body).includes(ENV.GUEST_LOGIN), false);
  assert.equal(accepted.response.headers.get('Access-Control-Allow-Origin'), 'https://app.example.test');
});

test('public login and member-request routes are rate limited before Airtable writes', async () => {
  const airtable = makeAirtable();
  const limited = { async limit() { return { success: false }; } };
  const env = { ...ENV, AUTH_RATE_LIMITER: limited, MEMBER_REQUEST_RATE_LIMITER: limited };

  for (const [path, body] of [
    ['/api/login/member', { memberNumber: 42 }],
    ['/api/member-requests', { name: 'Fixture Request', memberNumber: 42999 }]
  ]) {
    const response = await handleRequest(request(path, { method: 'POST', body }), env, {}, {
      airtable,
      nowSeconds: () => 1000,
      randomUUID: () => '00000000-0000-4000-8000-000000000001'
    });
    const responseBody = await response.json();
    assert.equal(response.status, 429, path);
    assert.equal(responseBody.error.code, 'RATE_LIMITED', path);
  }
  assert.deepEqual(airtable.calls, []);
});

test('the session route returns the verified role without exposing its subject', async () => {
  const token = await issueSession({ sub: 'recFixtureMember1', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const { body, response } = await call(request('/api/session', { token }));

  assert.equal(response.status, 200);
  assert.deepEqual(body, { role: 'member', hasMemberIdentity: true });
});

test('an unapproved browser origin is rejected without reflecting CORS or reaching Airtable', async () => {
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/login/guest', {
    method: 'POST',
    body: { phrase: ENV.GUEST_LOGIN },
    origin: 'https://unapproved.example.test'
  }), airtable);

  assert.equal(response.status, 403);
  assert.equal(body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
  assert.deepEqual(airtable.calls, []);
});

test('missing authentication bindings fail closed before routing or Airtable', async () => {
  for (const binding of ['SESSION_SECRET', 'GUEST_LOGIN', 'ADMIN_LOGIN']) {
    const env = { ...ENV };
    delete env[binding];
    const airtable = makeAirtable();
    const response = await handleRequest(request('/api/login/guest', {
      method: 'POST',
      body: { phrase: ENV.GUEST_LOGIN }
    }), env, {}, {
      airtable,
      nowSeconds: () => 1000,
      randomUUID: () => '00000000-0000-4000-8000-000000000001'
    });
    const body = await response.json();

    assert.equal(response.status, 500, binding);
    assert.equal(body.error.code, 'CONFIGURATION_ERROR', binding);
    assert.deepEqual(airtable.calls, [], binding);
  }
});

test('a short session-signing secret fails closed before routing', async () => {
  const env = { ...ENV, SESSION_SECRET: 'too-short' };
  const airtable = makeAirtable();
  const response = await handleRequest(request('/api/login/guest', {
    method: 'POST',
    body: { phrase: ENV.GUEST_LOGIN }
  }), env, {}, {
    airtable,
    nowSeconds: () => 1000,
    randomUUID: () => '00000000-0000-4000-8000-000000000001'
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'CONFIGURATION_ERROR');
  assert.deepEqual(airtable.calls, []);
});

for (const role of ['member', 'admin']) {
  test(`RSVP override is derived only from signed ${role} identity`, async () => {
    const token = await issueSession({ sub: 'recFixtureMember1', role }, ENV.SESSION_SECRET, 1000);
    const airtable = makeAirtable();
    const value = { response: null, guests: 0 };
    const own = await call(request('/api/events/recFixtureEvent01/rsvp', { method: 'PUT', token, body: value }), airtable);
    assert.equal(own.response.status, 200);
    assert.deepEqual(airtable.calls[0].at(-1), { admin: role === 'admin' });
    const other = await call(request('/api/admin/events/recFixtureEvent01/rsvps/recFixtureMember2', { method: 'PUT', token, body: value }), airtable);
    assert.equal(other.response.status, role === 'admin' ? 200 : 403);
    if (role === 'admin') assert.deepEqual(airtable.calls[1].at(-1), { admin: true });
    const forged = await call(request('/api/events/recFixtureEvent01/rsvp', { method: 'PUT', token, body: { ...value, admin: true } }), airtable);
    assert.equal(forged.response.status, 400);
  });
}

test('Worker cache namespace comes from the configured Airtable base', async () => {
  const token = await issueSession({ sub: 'admin', role: 'admin' }, ENV.SESSION_SECRET, 1000);
  const values = new Map();
  const cache = {
    async match(key) { return values.get(key.url)?.clone(); },
    async put(key, response) { values.set(key.url, response.clone()); },
    async delete(key) { return values.delete(key.url); }
  };
  for (const base of ['appStaging', 'appProduction', 'appStaging']) {
    const airtable = { async getEventsBootstrap() { return { events: [base] }; } };
    const response = await handleRequest(request('/api/events', { token }), { ...ENV, AIRTABLE_BASE_ID: base }, {}, { airtable, cache, nowSeconds: () => 1000 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: [base] });
  }
});
