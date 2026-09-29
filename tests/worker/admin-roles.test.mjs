import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest } from '../../worker/src/index.js';
import { hashPin, verifyPin } from '../../worker/src/pin.js';
import { createTestD1, createTestKv } from '../helpers/cloudflare-bindings.mjs';

const ORIGIN = 'https://app.example.test';
const SUPER = 'recSuperAdmin0001';
const ADMIN = 'recPlainAdmin0002';
const NOPIN = 'recAdminNoPin0003';
const MEMBER = 'recMemberOnly0004';
const EVENT = 'recEventSched0001';

async function setup() {
  const DB = await createTestD1();
  const superPin = await hashPin('1111');
  const adminPin = await hashPin('2222');
  DB.sqlite.exec(`
    INSERT INTO members (id, full_name, last_name, cell, email, member_number, in_directory, role, pin_hash) VALUES
      ('${SUPER}', 'SAM SUPER', 'SUPER', '412-555-0001', 'sam@example.test', '501', 1, 'super_admin', '${superPin}'),
      ('${ADMIN}', 'ANN ADMIN', 'ADMIN', '412-555-0002', 'ann@example.test', '502', 1, 'admin', '${adminPin}'),
      ('${NOPIN}', 'NED NOPIN', 'NOPIN', '', '', '503', 1, 'admin', NULL),
      ('${MEMBER}', 'MAX MEMBER', 'MEMBER', '412-555-0004', 'max@example.test', '504', 1, 'member', NULL);
    INSERT INTO member_event_fields (name, type, choices_json) VALUES
      ('OCT SPEAKER RSVP', 'singleSelect', '["YES","NO","MAYBE"]'), ('GUESTS-OCT', 'number', '[]');
    INSERT INTO member_event_values (member_id, field_name, value) VALUES
      ('${MEMBER}', 'OCT SPEAKER RSVP', '"YES"'), ('${MEMBER}', 'GUESTS-OCT', '2'),
      ('${ADMIN}', 'OCT SPEAKER RSVP', '"NO"');
    INSERT INTO events (id, name, date, status, rsvp_field, guest_field, setup_state) VALUES
      ('${EVENT}', 'Oct Speaker', '2026-10-20', 'Scheduled', 'OCT SPEAKER RSVP', 'GUESTS-OCT', 'ready');
  `);
  const env = {
    ADMIN_LOGIN: 'shared-admin-password',
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_RATE_LIMITER: { async limit() { return { success: true }; } },
    GUEST_LOGIN: 'guest-phrase',
    MEMBER_REQUEST_RATE_LIMITER: { async limit() { return { success: true }; } },
    SESSION_SECRET: 'admin-roles-test-session-secret-32chars',
    DB,
    PHOTOS: createTestKv()
  };

  async function call(path, { method = 'GET', token, body } = {}) {
    const headers = { Origin: ORIGIN };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleRequest(new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }), env, {});
    return { status: response.status, body: await response.json() };
  }

  async function login(memberNumber, pin) {
    const result = await call('/api/login/member', {
      method: 'POST',
      body: pin === undefined ? { memberNumber } : { memberNumber, pin }
    });
    return { ...result, token: result.body.token };
  }

  return { DB, call, login };
}

const NEW_MEMBER = {
  name: 'PAT NEWMAN',
  phone: '412-555-0099',
  email: 'pat@example.test',
  memberNumber: 599,
  inDirectory: true,
  homeAddress: '12 Private Lane, Pittsburgh PA',
  notes: 'Prefers aisle seat'
};

test('PIN hashes verify only the original PIN', async () => {
  const stored = await hashPin('482913');
  assert.equal(await verifyPin('482913', stored), true);
  assert.equal(await verifyPin('482914', stored), false);
  assert.equal(await verifyPin('4829', 'not-a-hash'), false);
});

test('an admin with a PIN must supply it, and a wrong PIN is refused', async () => {
  const { login, call } = await setup();
  assert.equal((await login(502)).body.error.code, 'PIN_REQUIRED');
  assert.equal((await login(502, '9999')).body.error.code, 'PIN_INCORRECT');
  const ok = await login(502, '2222');
  assert.equal(ok.status, 200);
  const session = await call('/api/session', { token: ok.token });
  assert.deepEqual(session.body, { role: 'admin', hasMemberIdentity: true, adminLevel: 'admin' });
});

test('a super admin session reports its level', async () => {
  const { login, call } = await setup();
  const { token } = await login(501, '1111');
  assert.equal((await call('/api/session', { token })).body.adminLevel, 'super_admin');
});

test('an admin without a PIN and a regular member both get member sessions', async () => {
  const { login, call } = await setup();
  for (const number of [503, 504]) {
    const { token, status } = await login(number);
    assert.equal(status, 200);
    assert.equal((await call('/api/session', { token })).body.role, 'member');
    assert.equal((await call('/api/admin/roster', { token })).status, 403);
  }
});

test('five wrong PINs lock the admin login for 15 minutes', async () => {
  const { login } = await setup();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login(502, '0000')).body.error.code, 'PIN_INCORRECT');
  }
  const locked = await login(502, '2222');
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'PIN_LOCKED');
});

test('a demotion takes effect on the demoted admin existing session', async () => {
  const { login, call } = await setup();
  const admin = await login(502, '2222');
  assert.equal((await call('/api/admin/roster', { token: admin.token })).status, 200);
  const superAdmin = await login(501, '1111');
  const demoted = await call(`/api/admin/roster/${ADMIN}/role`, { method: 'PUT', token: superAdmin.token, body: { role: 'member' } });
  assert.equal(demoted.status, 200);
  assert.equal((await call('/api/admin/roster', { token: admin.token })).status, 403);
  assert.equal((await call('/api/session', { token: admin.token })).body.role, 'member');
});

test('only super admins change roles and PINs', async () => {
  const { login, call } = await setup();
  const admin = await login(502, '2222');
  assert.equal((await call(`/api/admin/roster/${MEMBER}/role`, { method: 'PUT', token: admin.token, body: { role: 'admin' } })).status, 403);
  assert.equal((await call(`/api/admin/roster/${MEMBER}/pin`, { method: 'PUT', token: admin.token, body: { pin: '1234' } })).status, 403);

  const superAdmin = await login(501, '1111');
  assert.equal((await call(`/api/admin/roster/${MEMBER}/role`, { method: 'PUT', token: superAdmin.token, body: { role: 'admin' } })).status, 200);
  assert.equal((await call(`/api/admin/roster/${MEMBER}/pin`, { method: 'PUT', token: superAdmin.token, body: { pin: '4321' } })).status, 200);
  assert.equal((await login(504)).body.error.code, 'PIN_REQUIRED');
  assert.equal((await login(504, '4321')).status, 200);
});

test('the last super admin cannot be demoted', async () => {
  const { login, call } = await setup();
  const { token } = await login(501, '1111');
  const result = await call(`/api/admin/roster/${SUPER}/role`, { method: 'PUT', token, body: { role: 'admin' } });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'LAST_SUPER_ADMIN');
});

test('an admin can change their own PIN only with the current PIN', async () => {
  const { login, call } = await setup();
  const { token } = await login(502, '2222');
  assert.equal((await call('/api/me/pin', { method: 'PUT', token, body: { currentPin: '0000', newPin: '5555' } })).status, 403);
  assert.equal((await call('/api/me/pin', { method: 'PUT', token, body: { currentPin: '2222', newPin: '5555' } })).status, 200);
  assert.equal((await login(502, '5555')).status, 200);
});

test('private notes and home address stay out of the directory and events data', async () => {
  const { login, call } = await setup();
  const { token } = await login(502, '2222');
  const created = await call('/api/admin/roster', { method: 'POST', token, body: NEW_MEMBER });
  assert.equal(created.status, 201);
  assert.equal(created.body.homeAddress, NEW_MEMBER.homeAddress);
  assert.equal(created.body.notes, NEW_MEMBER.notes);

  const member = await login(504);
  for (const sessionToken of [token, member.token]) {
    for (const path of ['/api/directory', '/api/events']) {
      const text = JSON.stringify((await call(path, { token: sessionToken })).body);
      assert.equal(text.includes('Private Lane'), false, path);
      assert.equal(text.includes('aisle seat'), false, path);
    }
  }
  const roster = await call('/api/admin/roster', { token });
  assert.equal(roster.body.members.find(row => row.id === created.body.id).notes, NEW_MEMBER.notes);
});

test('roster edits reject a duplicate member number and keep last name in step', async () => {
  const { login, call } = await setup();
  const { token } = await login(502, '2222');
  const clash = await call(`/api/admin/roster/${MEMBER}`, { method: 'PATCH', token, body: { ...NEW_MEMBER, memberNumber: 501 } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'MEMBER_NUMBER_TAKEN');
  const edited = await call(`/api/admin/roster/${MEMBER}`, {
    method: 'PATCH', token, body: { ...NEW_MEMBER, name: 'MAX ZIMMER', memberNumber: 504 }
  });
  assert.equal(edited.status, 200);
  const directory = await call('/api/directory', { token });
  assert.equal(directory.body.records.at(-1).fields['FULL NAME'], 'MAX ZIMMER');
});

test('the event roster reports each member response, guests, and attendance', async () => {
  const { login, call } = await setup();
  const { token } = await login(502, '2222');
  const roster = await call(`/api/admin/events/${EVENT}/roster`, { token });
  assert.equal(roster.status, 200);
  const byId = Object.fromEntries(roster.body.rows.map(row => [row.id, row]));
  assert.equal(byId[MEMBER].response, 'YES');
  assert.equal(byId[MEMBER].guests, 2);
  assert.equal(byId[ADMIN].response, 'NO');
  assert.equal(byId[SUPER].response, null);
  assert.equal(roster.body.event.hasRsvp, true);
});

test('admin writes are recorded in the audit log with the acting member', async () => {
  const { login, call } = await setup();
  const { token } = await login(501, '1111');
  await call(`/api/admin/roster/${MEMBER}/role`, { method: 'PUT', token, body: { role: 'admin' } });
  const log = await call('/api/admin/audit', { token });
  assert.equal(log.status, 200);
  assert.equal(log.body.entries[0].actorName, 'SAM SUPER');
  assert.equal(log.body.entries[0].action, 'admin-roster-role PUT');
  assert.deepEqual(log.body.entries[0].detail.to, 'admin');
});
