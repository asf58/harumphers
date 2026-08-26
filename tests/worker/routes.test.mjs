import assert from 'node:assert/strict';
import test from 'node:test';

import { issueSession, verifySession } from '../../worker/src/auth.js';
import { handleRequest } from '../../worker/src/index.js';

const ENV = {
  ADMIN_LOGIN: 'fixture-admin-password',
  ALLOWED_ORIGINS: 'https://app.example.test,https://preview.example.test',
  GUEST_LOGIN: 'fixture-guest-phrase',
  SESSION_SECRET: 'fixture-session-secret-32-characters'
};

function makeAirtable() {
  const calls = [];
  return {
    calls,
    async findMemberByNumber(memberNumber) {
      calls.push(['findMemberByNumber', memberNumber]);
      if (memberNumber !== 42) return null;
      return { id: 'rec_member', fields: { 'FULL NAME': 'Fixture Member', 'IS ADMIN': true } };
    },
    async getDirectory(role) {
      calls.push(['getDirectory', role]);
      return { records: [{ id: 'rec_directory', fields: { 'FULL NAME': 'Directory Fixture' } }] };
    },
    async getEventsBootstrap(role) {
      calls.push(['getEventsBootstrap', role]);
      return { events: [{ id: 'rec_event', fields: { NAME: 'Event Fixture' } }], members: [] };
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
    async setRsvp(recordId, eventId, value) {
      calls.push(['setRsvp', recordId, eventId, value]);
      return { ok: true };
    },
    async createEvent(value) {
      calls.push(['createEvent', value]);
      return { eventId: 'recFixtureEvent01', setupState: 'ready', resumed: false };
    }
  };
}

function request(path, { method = 'GET', token, body, origin = 'https://app.example.test' } = {}) {
  const headers = new Headers({ Origin: origin });
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
  const token = await issueSession({ sub: 'rec_member', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const airtable = makeAirtable();

  const { body, response } = await call(request('/api/me?recordId=rec_other', { token }), airtable);

  assert.equal(response.status, 200);
  assert.equal(body.id, 'rec_member');
  assert.deepEqual(airtable.calls, [['getMember', 'rec_member']]);
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
  const value = { name: 'Admin Updated Fixture', phone: '', email: '', memberNumber: 42002, isAdmin: false };

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
    'setRsvp', 'recFixtureMember1', eventId, { response: 'YES', guests: 2 }
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

test('member-number login always issues a member session for the matched record', async () => {
  const airtable = makeAirtable();
  const { body, response } = await call(request('/api/login/member', {
    method: 'POST',
    body: { memberNumber: 42 }
  }), airtable);

  assert.equal(response.status, 200);
  assert.deepEqual(await verifySession(body.token, ENV.SESSION_SECRET, 1000), {
    sub: 'rec_member',
    role: 'member',
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

test('the session route returns the verified role without exposing its subject', async () => {
  const token = await issueSession({ sub: 'rec_member', role: 'member' }, ENV.SESSION_SECRET, 1000);
  const { body, response } = await call(request('/api/session', { token }));

  assert.equal(response.status, 200);
  assert.deepEqual(body, { role: 'member' });
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
