import assert from 'node:assert/strict';
import test from 'node:test';

import { issueSession } from '../../worker/src/auth.js';
import { createD1Store } from '../../worker/src/d1.js';
import { handleRequest } from '../../worker/src/index.js';
import { createTestD1, createTestKv } from '../helpers/cloudflare-bindings.mjs';

const ORIGIN = 'https://app.example.test';
const ALICE = 'recMemberAlice001';
const BOB = 'recMemberBobby002';
const HIDDEN = 'recMemberHidden03';
const SCHEDULED = 'recEventSched0001';
const SUGGESTED = 'recEventSugges002';
const COMPLETED = 'recEventComplet03';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seededStore() {
  const DB = await createTestD1();
  const PHOTOS = createTestKv();
  DB.sqlite.exec(`
    INSERT INTO members (id, full_name, last_name, cell, email, member_number, in_directory, role) VALUES
      ('${BOB}', 'AARON ZED', 'ZED', '412-555-0102', 'bob@example.test', '1002', 1, 'admin'),
      ('${ALICE}', 'ALICE ADAMS', 'ADAMS', '412-555-0101', 'alice@example.test', ' 1001 ', 1, 'member'),
      ('${HIDDEN}', 'HIDDEN HOLT', 'HOLT', '', '', '1003', 0, 'member');
    INSERT INTO member_event_fields (name, type, choices_json) VALUES
      ('SEP29 SPEAKER RSVP', 'singleSelect', '["YES","NO","MAYBE"]'),
      ('GUESTS-SEP29', 'number', '[]');
    INSERT INTO member_event_values (member_id, field_name, value) VALUES
      ('${ALICE}', 'SEP29 SPEAKER RSVP', '"YES"'),
      ('${ALICE}', 'GUESTS-SEP29', '2');
    INSERT INTO events (id, name, date, status, rsvp_field, guest_field, creation_key, setup_state, created_at) VALUES
      ('${SCHEDULED}', 'Sept Speaker', '2026-09-29', 'Scheduled', 'SEP29 SPEAKER RSVP', 'GUESTS-SEP29', 'key-1', 'ready', '2026-01-01'),
      ('${SUGGESTED}', 'Suggested Speaker', NULL, 'Suggested', NULL, NULL, 'key-2', 'ready', '2026-01-02'),
      ('${COMPLETED}', 'Past Dinner', '2026-06-01', 'Completed', 'SEP29 SPEAKER RSVP', NULL, 'key-3', 'ready', '2026-01-03');
  `);
  return { DB, PHOTOS, store: createD1Store({ DB, PHOTOS }, { origin: ORIGIN }) };
}

test('directory lists only directory members in last-name order with role-scoped member numbers', async () => {
  const { store } = await seededStore();
  const member = await store.getDirectory('member');
  assert.deepEqual(member.records.map(record => record.id), [ALICE, BOB]);
  assert.equal(member.records[0].fields['MEMBER #'], undefined);
  assert.equal(member.records[0].fields['FULL NAME'], 'ALICE ADAMS');
  const admin = await store.getDirectory('admin');
  assert.equal(admin.records[1].fields['MEMBER #'], '1002');
});

test('member-number login matches trimmed numeric text and exposes the admin flag', async () => {
  const { store } = await seededStore();
  assert.equal((await store.findMemberByNumber(1001)).id, ALICE);
  assert.equal((await store.findMemberByNumber(1002)).fields['IS ADMIN'], true);
  assert.equal(await store.findMemberByNumber(9999), null);
});

test('member-number login refuses an ambiguous duplicate', async () => {
  const { DB, store } = await seededStore();
  DB.sqlite.exec(`UPDATE members SET member_number = '1001' WHERE id = '${BOB}'`);
  assert.equal(await store.findMemberByNumber(1001), null);
});

test('events bootstrap projects RSVP columns, field metadata, and tallies in Airtable shape', async () => {
  const { store } = await seededStore();
  const bootstrap = await store.getEventsBootstrap('member');
  assert.deepEqual(bootstrap.events.map(event => event.id), [SCHEDULED, SUGGESTED, COMPLETED]);
  assert.equal(bootstrap.events[0].fields['RSVP FIELD'], 'SEP29 SPEAKER RSVP');
  assert.equal(bootstrap.events[1].fields.DATE, undefined);
  const alice = bootstrap.members.find(record => record.id === ALICE);
  assert.equal(alice.fields['SEP29 SPEAKER RSVP'], 'YES');
  assert.equal(alice.fields['GUESTS-SEP29'], 2);
  assert.equal(alice.fields['IN DIRECTORY'], true);
  assert.equal(alice.fields['MEMBER #'], undefined);
  assert.deepEqual(bootstrap.memberFields.map(field => [field.name, field.type]), [
    ['GUESTS-SEP29', 'number'],
    ['SEP29 SPEAKER RSVP', 'singleSelect']
  ]);
  assert.deepEqual(bootstrap.attendance, []);
  assert.deepEqual(bootstrap.votes, []);
});

test('members may RSVP only to scheduled events; administrators may manage any mapped event', async () => {
  const { store } = await seededStore();
  const saved = await store.setRsvp(BOB, SCHEDULED, { response: 'MAYBE', guests: 3 });
  assert.equal(saved.fields['SEP29 SPEAKER RSVP'], 'MAYBE');
  assert.equal(saved.fields['GUESTS-SEP29'], 3);

  const cleared = await store.setRsvp(ALICE, SCHEDULED, { response: null, guests: 0 });
  assert.equal(cleared.fields['SEP29 SPEAKER RSVP'], undefined);

  await assert.rejects(store.setRsvp(BOB, COMPLETED, { response: 'YES', guests: 0 }), { code: 'EVENT_NOT_OPEN' });
  const override = await store.setRsvp(BOB, COMPLETED, { response: 'NO', guests: 0 }, { admin: true });
  assert.equal(override.fields['SEP29 SPEAKER RSVP'], 'NO');
  await assert.rejects(
    store.setRsvp(BOB, COMPLETED, { response: 'YES', guests: 2 }, { admin: true }),
    { code: 'VALIDATION_FAILED' }
  );
  await assert.rejects(store.setRsvp(BOB, SUGGESTED, { response: 'YES', guests: 0 }, { admin: true }), { code: 'EVENT_MAPPING_MISSING' });
});

test('votes upsert, clear, and tally for suggested events only', async () => {
  const { store } = await seededStore();
  const created = await store.setVote(ALICE, SUGGESTED, 'UP');
  assert.match(created.id, /^rec[A-Za-z0-9]{14}$/);
  await store.setVote(BOB, SUGGESTED, 'DOWN');
  await store.setVote(BOB, SUGGESTED, 'UP');
  assert.deepEqual((await store.getEventsBootstrap('guest')).voteTallies, { [SUGGESTED]: { up: 2, down: 0 } });
  assert.deepEqual(await store.setVote(ALICE, SUGGESTED, null), { id: created.id, deleted: true });
  assert.deepEqual((await store.getMemberVotes(BOB)).votes, [{ eventId: SUGGESTED, vote: 'UP' }]);
  await assert.rejects(store.setVote(ALICE, SCHEDULED, 'UP'), { code: 'VOTING_CLOSED' });
});

test('creating a scheduled event sets up RSVP and guest fields once', async () => {
  const { store } = await seededStore();
  const input = {
    idempotencyKey: '5b3c1d2e-0f4a-4b6c-8d7e-9f0a1b2c3d4e',
    name: 'October Dinner', date: '2026-10-20', speaker: '', time: '6 PM', room: '', location: 'Club',
    notes: '', status: 'Scheduled', enableGuests: true
  };
  const result = await store.createEvent(input);
  assert.equal(result.setupState, 'ready');
  assert.equal(result.resumed, false);
  assert.deepEqual(await store.createEvent(input), { eventId: result.eventId, setupState: 'ready', resumed: true });

  const bootstrap = await store.getEventsBootstrap('admin');
  const event = bootstrap.events.find(item => item.id === result.eventId);
  assert.equal(event.fields.LOCATION, 'Club');
  assert.ok(bootstrap.memberFields.some(field => field.name === event.fields['RSVP FIELD'] && field.type === 'singleSelect'));
  assert.ok(bootstrap.memberFields.some(field => field.name === event.fields['GUEST FIELD'] && field.type === 'number'));
  const saved = await store.setRsvp(ALICE, result.eventId, { response: 'YES', guests: 1 });
  assert.equal(saved.fields[event.fields['RSVP FIELD']], 'YES');
});

test('scheduling a suggested event through an edit creates its RSVP mapping', async () => {
  const { store } = await seededStore();
  const updated = await store.updateEvent(SUGGESTED, {
    name: 'Suggested Speaker', date: '2026-11-05', speaker: 'Guest', time: '', room: '', notes: '', status: 'Scheduled'
  });
  assert.equal(updated.fields['SETUP STATE'], 'ready');
  assert.match(updated.fields['RSVP FIELD'], / RSVP$/);
  assert.equal((await store.setRsvp(BOB, SUGGESTED, { response: 'YES', guests: 0 })).fields[updated.fields['RSVP FIELD']], 'YES');
});

test('attendance is saved only for completed events and directory members', async () => {
  const { store } = await seededStore();
  await store.saveAttendance(COMPLETED, [{ memberId: ALICE, attended: true, actualGuests: 1 }]);
  await store.saveAttendance(COMPLETED, [{ memberId: ALICE, attended: false, actualGuests: 0 }]);
  const bootstrap = await store.getEventsBootstrap('admin');
  assert.equal(bootstrap.attendance.length, 1);
  assert.deepEqual(bootstrap.attendanceSummary, [{ eventId: COMPLETED, memberName: 'ALICE ADAMS', attended: false, actualGuests: 0 }]);
  await assert.rejects(store.saveAttendance(SCHEDULED, []), { code: 'EVENT_NOT_COMPLETED' });
  await assert.rejects(
    store.saveAttendance(COMPLETED, [{ memberId: HIDDEN, attended: true, actualGuests: 0 }]),
    { code: 'VALIDATION_FAILED' }
  );
});

test('member requests can be submitted once, approved onto a member, or rejected', async () => {
  const { store } = await seededStore();
  const first = await store.submitMemberRequest({ name: 'ALICE', memberNumber: 5555 });
  await assert.rejects(store.submitMemberRequest({ name: 'ALICE', memberNumber: 5555 }), { code: 'ALREADY_PENDING' });
  const pending = await store.getMemberRequests();
  assert.equal(pending.requests[0].fields['SUBMITTED MEMBER #'], 5555);
  assert.deepEqual(await store.approveMemberRequest(first.id, ALICE), { id: first.id, status: 'Approved', memberId: ALICE });
  assert.equal((await store.findMemberByNumber(5555)).id, ALICE);
  await assert.rejects(store.rejectMemberRequest(first.id), { code: 'REQUEST_NOT_PENDING' });
  assert.deepEqual(await store.getMemberNumberDiagnostics(), { totalInDirectory: 2, withNumber: 2, missingNumber: 0 });
});

test('a new member photo replaces the old image and is served from KV', async () => {
  const { PHOTOS, store } = await seededStore();
  const photo = { filename: 'a.png', contentType: 'image/png', base64: PNG };
  const firstUpload = await store.uploadMemberPhoto(ALICE, photo);
  const firstId = firstUpload.fields.PHOTO[0].id;
  const second = await store.uploadMemberPhoto(ALICE, { ...photo, filename: 'b.png' });
  assert.equal(second.fields.PHOTO.length, 1);
  assert.equal(second.fields.PHOTO[0].filename, 'b.png');
  assert.equal(second.fields.PHOTO[0].thumbnails.large.url, `${ORIGIN}/api/files/${second.fields.PHOTO[0].id}`);
  assert.equal(PHOTOS.entries.has(firstId), false);
  const file = await store.getFile(second.fields.PHOTO[0].id);
  assert.equal(file.contentType, 'image/png');
  assert.equal(Buffer.from(file.body).toString('base64'), PNG);
  await assert.rejects(store.getFile(firstId), { code: 'NOT_FOUND' });
});

test('event gallery photos hide the uploader id from non-administrators and delete cleanly', async () => {
  const { PHOTOS, store } = await seededStore();
  const created = await store.addEventPhoto({ sub: ALICE, role: 'member' }, COMPLETED, {
    filename: 'dinner.png', contentType: 'image/png', base64: PNG, caption: 'Dinner'
  });
  assert.equal(created.fields['MEMBER NAME'], 'ALICE ADAMS');
  const guestView = await store.getEventsBootstrap('guest');
  assert.equal(guestView.photos[0].id, undefined);
  assert.equal(guestView.photos[0].fields['MEMBER RECORD ID'], undefined);
  assert.equal(guestView.photos[0].fields.CAPTION, 'Dinner');
  assert.equal((await store.updatePhotoCaption(created.id, 'Dinner 2026')).fields.CAPTION, 'Dinner 2026');
  assert.deepEqual(await store.deletePhoto(created.id), { id: created.id, deleted: true });
  assert.equal(PHOTOS.entries.size, 0);
});

test('the Worker serves logins, data, and images from D1 when the binding is configured', async () => {
  const { DB, PHOTOS, store } = await seededStore();
  const env = {
    ADMIN_LOGIN: 'fixture-admin-password',
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_RATE_LIMITER: { async limit() { return { success: true }; } },
    GUEST_LOGIN: 'fixture-guest-phrase',
    MEMBER_REQUEST_RATE_LIMITER: { async limit() { return { success: true }; } },
    SESSION_SECRET: 'fixture-session-secret-32-characters',
    DB,
    PHOTOS
  };
  const call = (path, init = {}) => handleRequest(new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', ...init.headers }
  }), env, {});

  const login = await call('/api/login/member', { method: 'POST', body: JSON.stringify({ memberNumber: 1001 }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const events = await call('/api/events', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(events.status, 200);
  assert.equal((await events.json()).members.find(record => record.id === ALICE).fields['SEP29 SPEAKER RSVP'], 'YES');

  const uploaded = await store.uploadMemberPhoto(ALICE, { filename: 'a.png', contentType: 'image/png', base64: PNG });
  const image = await handleRequest(new Request(`${ORIGIN}/api/files/${uploaded.fields.PHOTO[0].id}`), env, {});
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.match(image.headers.get('Cache-Control'), /immutable/);

  const missing = await handleRequest(new Request(`${ORIGIN}/api/files/attDoesNotExist01`), env, {});
  assert.equal(missing.status, 404);

  const adminToken = await issueSession({ sub: 'admin', role: 'admin' }, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
  const refresh = await call('/api/admin/cache/refresh', {
    method: 'POST', body: '{}', headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(refresh.status, 200);
});
