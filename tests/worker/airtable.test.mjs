import assert from 'node:assert/strict';
import test from 'node:test';

import { createAirtable } from '../../worker/src/airtable.js';

const ENV = {
  AIRTABLE_TOKEN: 'fixture-airtable-token',
  AIRTABLE_BASE_ID: 'appFixtureBase',
  AIRTABLE_MEMBERS_TABLE_ID: 'tblFixtureMembers',
  AIRTABLE_EVENTS_TABLE_ID: 'tblFixtureEvents',
  AIRTABLE_PHOTOS_TABLE_ID: 'tblFixturePhotos',
  AIRTABLE_ATTENDANCE_TABLE_ID: 'tblFixtureAttendance',
  AIRTABLE_VOTES_TABLE_ID: 'tblFixtureVotes',
  AIRTABLE_MEMBER_REQUESTS_TABLE_ID: 'tblFixtureMemberRequests'
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('missing Airtable configuration fails before a network request', () => {
  let fetchCalls = 0;
  const incomplete = { ...ENV };
  delete incomplete.AIRTABLE_TOKEN;

  assert.throws(
    () => createAirtable(incomplete, async () => {
      fetchCalls += 1;
      return jsonResponse({ records: [] });
    }),
    error => error.code === 'CONFIGURATION_ERROR'
  );
  assert.equal(fetchCalls, 0);
});

test('member lookup uses the configured table and a fixed numeric formula', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init) => {
    requests.push({ url: new URL(url), headers: new Headers(init.headers) });
    return jsonResponse({ records: [{ id: 'rec_fixture', fields: { 'MEMBER #': 42 } }] });
  });

  const member = await airtable.findMemberByNumber(42);

  assert.equal(member.id, 'rec_fixture');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/v0/appFixtureBase/tblFixtureMembers');
  assert.equal(requests[0].url.searchParams.get('filterByFormula'), '{MEMBER #}=42');
  assert.equal(requests[0].url.searchParams.get('maxRecords'), '2');
  assert.deepEqual(requests[0].url.searchParams.getAll('fields[]'), ['MEMBER #', 'FULL NAME', 'IS ADMIN']);
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture-airtable-token');
});

test('duplicate member numbers fail closed instead of selecting the first record', async () => {
  const airtable = createAirtable(ENV, async () => jsonResponse({
    records: [{ id: 'rec_first' }, { id: 'rec_second' }]
  }));

  assert.equal(await airtable.findMemberByNumber(42), null);
});

test('member request approval accepts Airtable text values for member numbers', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init = {}) => {
    const request = { url: new URL(url), init };
    requests.push(request);
    if (request.url.pathname.endsWith('/recFixtureRequest')) {
      return jsonResponse({
        id: 'recFixtureRequest',
        fields: { STATUS: 'Pending', 'SUBMITTED MEMBER #': 900003 }
      });
    }
    if (request.url.pathname.endsWith('/recFixtureMember1')) {
      const fields = JSON.parse(init.body).fields;
      if (typeof fields['MEMBER #'] !== 'string') {
        return jsonResponse({ error: { type: 'INVALID_VALUE_FOR_COLUMN' } }, 422);
      }
      return jsonResponse({
        id: 'recFixtureMember1',
        fields
      });
    }
    return jsonResponse({
      id: 'recFixtureRequest',
      fields: { STATUS: 'Approved', 'LINKED MEMBER ID': 'recFixtureMember1' }
    });
  });

  assert.deepEqual(
    await airtable.approveMemberRequest('recFixtureRequest', 'recFixtureMember1'),
    { id: 'recFixtureRequest', status: 'Approved', memberId: 'recFixtureMember1' }
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    fields: { 'MEMBER #': '900003' }
  });
});

test('member number diagnostics count numeric text from the live Airtable schema', async () => {
  const airtable = createAirtable(ENV, async () => jsonResponse({
    records: [
      { id: 'recFixtureMember1', fields: { 'MEMBER #': '900001', 'IN DIRECTORY': true } },
      { id: 'recFixtureMember2', fields: { 'MEMBER #': 900002, 'IN DIRECTORY': true } },
      { id: 'recFixtureMember3', fields: { 'IN DIRECTORY': true } }
    ]
  }));

  assert.deepEqual(await airtable.getMemberNumberDiagnostics(), {
    totalInDirectory: 3,
    withNumber: 2,
    missingNumber: 1
  });
});

test('self-service member reads request only member-visible fields', async () => {
  let capturedUrl;
  const airtable = createAirtable(ENV, async url => {
    capturedUrl = new URL(url);
    return jsonResponse({
      records: [{ id: 'rec12345678901234', fields: { 'FULL NAME': 'Fixture Member' } }]
    });
  });

  const member = await airtable.getMember('rec12345678901234');

  assert.equal(member.id, 'rec12345678901234');
  assert.equal(capturedUrl.pathname, '/v0/appFixtureBase/tblFixtureMembers');
  assert.equal(capturedUrl.searchParams.get('filterByFormula'), "RECORD_ID()='rec12345678901234'");
  assert.equal(capturedUrl.searchParams.get('maxRecords'), '1');
  assert.deepEqual(capturedUrl.searchParams.getAll('fields[]').sort(), [
    'CELL #',
    'E-MAIL ADDRESS',
    'FULL NAME',
    'IN DIRECTORY',
    'MEMBER #',
    'PHOTO'
  ]);
  assert.equal(capturedUrl.searchParams.getAll('fields[]').includes('IS ADMIN'), false);
  assert.equal(capturedUrl.searchParams.getAll('fields[]').includes('REQUESTED CHANGES'), false);
});

test('an invalid signed member subject fails before an Airtable request', async () => {
  let fetchCalls = 0;
  const airtable = createAirtable(ENV, async () => {
    fetchCalls += 1;
    return jsonResponse({ records: [] });
  });

  await assert.rejects(() => airtable.getMember('rec_not-an-airtable-id'), error => (
    error.code === 'VALIDATION_FAILED'
  ));
  assert.equal(fetchCalls, 0);
});

test('profile writes map only allowlisted client fields to Airtable fields', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init) => {
    requests.push({ url: new URL(url), init });
    return jsonResponse({
      id: 'rec12345678901234',
      fields: {
        'FULL NAME': 'Updated Fixture',
        'CELL #': '412-555-0100',
        'E-MAIL ADDRESS': 'updated@example.test'
      }
    });
  });

  const result = await airtable.updateMemberProfile('rec12345678901234', {
    name: 'Updated Fixture',
    phone: '412-555-0100',
    email: 'updated@example.test'
  });

  assert.equal(result.id, 'rec12345678901234');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    fields: {
      'FULL NAME': 'Updated Fixture',
      'CELL #': '412-555-0100',
      'E-MAIL ADDRESS': 'updated@example.test'
    }
  });
});

test('administrator member updates serialize member numbers for the Airtable text field', async () => {
  let capturedBody;
  const airtable = createAirtable(ENV, async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    if (typeof capturedBody.fields['MEMBER #'] !== 'string') {
      return jsonResponse({ error: { type: 'INVALID_VALUE_FOR_COLUMN' } }, 422);
    }
    return jsonResponse({ id: 'rec12345678901234', fields: capturedBody.fields });
  });

  const result = await airtable.updateMember('rec12345678901234', {
    name: 'Updated Fixture',
    phone: '412-555-0100',
    email: 'updated@example.test',
    memberNumber: 900004
  });

  assert.equal(result.fields['MEMBER #'], '900004');
  assert.deepEqual(capturedBody.fields, {
    'FULL NAME': 'Updated Fixture',
    'CELL #': '412-555-0100',
    'E-MAIL ADDRESS': 'updated@example.test',
    'MEMBER #': '900004'
  });
});

test('RSVP writes resolve exact event mappings before patching the signed member', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init) => {
    requests.push({ url: new URL(url), init });
    if (requests.length === 1) {
      return jsonResponse({
        id: 'recFixtureEvent01',
        fields: {
          Status: 'Scheduled',
          'SETUP STATE': 'ready',
          'RSVP FIELD': 'SEP12-FIXTURE-1A2B3C4D RSVP',
          'GUEST FIELD': 'GUESTS-SEP12-FIXTURE-1A2B3C4D'
        }
      });
    }
    return jsonResponse({ id: 'rec12345678901234', fields: {} });
  });

  await airtable.setRsvp('rec12345678901234', 'recFixtureEvent01', {
    response: 'YES', guests: 2
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.pathname, '/v0/appFixtureBase/tblFixtureEvents/recFixtureEvent01');
  assert.equal(requests[1].url.pathname, '/v0/appFixtureBase/tblFixtureMembers/rec12345678901234');
  assert.equal(requests[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    fields: {
      'SEP12-FIXTURE-1A2B3C4D RSVP': 'YES',
      'GUESTS-SEP12-FIXTURE-1A2B3C4D': 2
    }
  });
});

test('directory reads combine bounded Airtable pages without losing the filter', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (!parsed.searchParams.has('offset')) {
      return jsonResponse({ records: [{ id: 'rec_first' }], offset: 'next-page' });
    }
    return jsonResponse({ records: [{ id: 'rec_second' }] });
  });

  assert.deepEqual(await airtable.getDirectory('guest'), {
    records: [{ id: 'rec_first' }, { id: 'rec_second' }]
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('filterByFormula'), '{IN DIRECTORY}=TRUE()');
  assert.equal(requests[1].searchParams.get('filterByFormula'), '{IN DIRECTORY}=TRUE()');
  assert.equal(requests[1].searchParams.get('offset'), 'next-page');
  assert.equal(requests[1].searchParams.get('pageSize'), '100');
  for (const request of requests) {
    assert.equal(request.searchParams.get('sort[0][field]'), 'LAST NAME');
    assert.equal(request.searchParams.get('sort[0][direction]'), 'asc');
    assert.equal(request.searchParams.get('sort[1][field]'), 'FULL NAME');
    assert.equal(request.searchParams.get('sort[1][direction]'), 'asc');
  }
  assert.deepEqual(requests[0].searchParams.getAll('fields[]').sort(), [
    'CELL #',
    'E-MAIL ADDRESS',
    'FULL NAME',
    'PHOTO'
  ]);
});

test('events bootstrap uses only the configured named resources', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async url => {
    const parsed = new URL(url);
    const { pathname } = parsed;
    requests.push(parsed);
    if (pathname === '/v0/meta/bases/appFixtureBase/tables') {
      return jsonResponse({
        tables: [{
          id: 'tblFixtureMembers',
          fields: [
            { id: 'fld_rsvp', name: 'DINNER RSVP' },
            { id: 'fld_guest', name: 'GUESTS-DINNER' },
            { id: 'fld_internal', name: 'REQUESTED CHANGES' }
          ]
        }]
      });
    }
    return jsonResponse({ records: [{ id: `rec_${pathname.split('/').at(-1)}` }] });
  });

  const result = await airtable.getEventsBootstrap('guest');

  assert.deepEqual(result.memberFields, [
    { id: 'fld_rsvp', name: 'DINNER RSVP' },
    { id: 'fld_guest', name: 'GUESTS-DINNER' }
  ]);
  assert.equal(result.events[0].id, 'rec_tblFixtureEvents');
  assert.equal(result.members[0].id, 'rec_tblFixtureMembers');
  assert.equal(result.photos[0].id, undefined);
  assert.deepEqual(result.attendance, []);
  assert.deepEqual(result.votes, []);
  assert.deepEqual(requests.map(value => value.pathname).sort(), [
    '/v0/appFixtureBase/tblFixtureAttendance',
    '/v0/appFixtureBase/tblFixtureEvents',
    '/v0/appFixtureBase/tblFixtureMembers',
    '/v0/appFixtureBase/tblFixturePhotos',
    '/v0/appFixtureBase/tblFixtureVotes',
    '/v0/meta/bases/appFixtureBase/tables'
  ]);

  const memberRequest = requests.find(value => value.pathname.endsWith('/tblFixtureMembers'));
  assert.equal(memberRequest.searchParams.get('sort[0][field]'), 'LAST NAME');
  assert.equal(memberRequest.searchParams.get('sort[0][direction]'), 'asc');
  assert.equal(memberRequest.searchParams.get('sort[1][field]'), 'FULL NAME');
  assert.equal(memberRequest.searchParams.get('sort[1][direction]'), 'asc');
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('DINNER RSVP'), true);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('GUESTS-DINNER'), true);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('REQUESTED CHANGES'), false);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('MEMBER #'), false);
});

test('non-admin event bootstrap aggregates identity-bearing rows and member vote history stays private', async () => {
  const airtable = createAirtable(ENV, async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v0/meta/bases/appFixtureBase/tables') {
      return jsonResponse({ tables: [{ id: 'tblFixtureMembers', fields: [] }] });
    }
    if (pathname.endsWith('/tblFixtureMembers')) {
      return jsonResponse({ records: [{
        id: 'recFixtureMember1',
        fields: { 'FULL NAME': 'Fixture Member', 'IN DIRECTORY': true }
      }] });
    }
    if (pathname.endsWith('/tblFixtureAttendance')) {
      return jsonResponse({ records: [{
        id: 'recAttendance0001',
        fields: {
          'EVENT RECORD ID': 'recFixtureEvent02',
          'MEMBER RECORD ID': 'recFixtureMember1',
          ATTENDED: true,
          'ACTUAL GUESTS': 1
        }
      }] });
    }
    if (pathname.endsWith('/tblFixtureVotes')) {
      return jsonResponse({ records: [{
        id: 'recFixtureVote001',
        fields: {
          'EVENT RECORD ID': 'recFixtureEvent02',
          'MEMBER RECORD ID': 'recFixtureMember1',
          VOTE: 'UP'
        }
      }] });
    }
    if (pathname.endsWith('/tblFixturePhotos')) {
      return jsonResponse({ records: [{
        id: 'recFixturePhoto01',
        fields: {
          'EVENT RECORD ID': 'recFixtureEvent02',
          'MEMBER RECORD ID': 'recFixtureMember1',
          'MEMBER NAME': 'Fixture Member',
          PHOTO: []
        }
      }] });
    }
    return jsonResponse({ records: [{ id: 'recFixtureEvent02', fields: { Status: 'Suggested' } }] });
  });

  const guest = await airtable.getEventsBootstrap('guest');
  assert.deepEqual(guest.votes, []);
  assert.deepEqual(guest.voteTallies, { recFixtureEvent02: { up: 1, down: 0 } });
  assert.deepEqual(guest.attendance, []);
  assert.deepEqual(guest.attendanceSummary, [{
    eventId: 'recFixtureEvent02',
    memberName: 'Fixture Member',
    attended: true,
    actualGuests: 1
  }]);
  assert.equal(guest.photos[0].id, undefined);
  assert.equal('MEMBER RECORD ID' in guest.photos[0].fields, false);

  assert.deepEqual(await airtable.getMemberVotes('recFixtureMember1'), {
    votes: [{ eventId: 'recFixtureEvent02', vote: 'UP' }]
  });
});

test('upstream failures return a bounded error without exposing the response body', async () => {
  const airtable = createAirtable(ENV, async () => new Response('fixture-sensitive-upstream-body', { status: 429 }));

  await assert.rejects(
    () => airtable.getDirectory(),
    error => (
      error.code === 'UPSTREAM_FAILED'
      && error.status === 502
      && !error.message.includes('fixture-sensitive-upstream-body')
    )
  );
});

test('rate-limited Airtable reads retry within a bounded attempt count', async () => {
  let fetchCalls = 0;
  const airtable = createAirtable(ENV, async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response('rate limited fixture', { status: 429, headers: { 'Retry-After': '0' } });
    }
    return jsonResponse({ records: [] });
  });

  assert.deepEqual(await airtable.getDirectory('guest'), { records: [] });
  assert.equal(fetchCalls, 2);
});

test('pagination stops after ten pages instead of following an unbounded offset chain', async () => {
  let fetchCalls = 0;
  const airtable = createAirtable(ENV, async () => {
    fetchCalls += 1;
    return jsonResponse({ records: [], offset: `page-${fetchCalls + 1}` });
  });

  await assert.rejects(() => airtable.getDirectory('guest'), error => error.code === 'UPSTREAM_FAILED');
  assert.equal(fetchCalls, 10);
});

test('attendance saves update existing rows and create missing rows without duplicates', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init = {}) => {
    const request = { url: new URL(url), init };
    requests.push(request);
    if (request.url.pathname.endsWith('/recFixtureEvent01')) {
      return jsonResponse({ id: 'recFixtureEvent01', fields: { Status: 'Completed' } });
    }
    if (request.url.pathname.endsWith('/tblFixtureMembers')) {
      return jsonResponse({ records: [
        { id: 'recFixtureMember1', fields: { 'IN DIRECTORY': true } },
        { id: 'recFixtureMember2', fields: { 'IN DIRECTORY': true } }
      ] });
    }
    if (request.url.pathname.endsWith('/tblFixtureAttendance') && init.method === undefined) {
      return jsonResponse({
        records: [{
          id: 'recAttendance0001',
          fields: {
            'EVENT RECORD ID': 'recFixtureEvent01',
            'MEMBER RECORD ID': 'recFixtureMember1'
          }
        }]
      });
    }
    const records = JSON.parse(init.body).records;
    return jsonResponse({
      records: records.map((record, index) => ({
        id: record.id ?? `recAttendance000${index + 2}`,
        fields: record.fields
      }))
    });
  });

  const result = await airtable.saveAttendance('recFixtureEvent01', [
    { memberId: 'recFixtureMember1', attended: true, actualGuests: 2 },
    { memberId: 'recFixtureMember2', attended: false, actualGuests: 0 }
  ]);

  assert.deepEqual(result, { saved: 2 });
  assert.equal(requests[0].url.pathname.endsWith('/recFixtureEvent01'), true);
  assert.equal(requests[1].url.pathname.endsWith('/tblFixtureMembers'), true);
  assert.equal(requests[2].url.searchParams.get('filterByFormula'), "{EVENT RECORD ID}='recFixtureEvent01'");
  assert.equal(requests[3].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[3].init.body), {
    records: [{
      id: 'recAttendance0001',
      fields: {
        'EVENT RECORD ID': 'recFixtureEvent01',
        'MEMBER RECORD ID': 'recFixtureMember1',
        ATTENDED: true,
        'ACTUAL GUESTS': 2
      }
    }]
  });
  assert.equal(requests[4].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[4].init.body), {
    records: [{
      fields: {
        'EVENT RECORD ID': 'recFixtureEvent01',
        'MEMBER RECORD ID': 'recFixtureMember2',
        ATTENDED: false,
        'ACTUAL GUESTS': 0
      }
    }]
  });
});

test('attendance saves fail closed when existing rows contain a duplicate member', async () => {
  let requestCount = 0;
  const airtable = createAirtable(ENV, async url => {
    requestCount += 1;
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/recFixtureEvent01')) {
      return jsonResponse({ id: 'recFixtureEvent01', fields: { Status: 'Completed' } });
    }
    if (pathname.endsWith('/tblFixtureMembers')) {
      return jsonResponse({ records: [{ id: 'recFixtureMember1', fields: { 'IN DIRECTORY': true } }] });
    }
    return jsonResponse({
      records: [
        { id: 'recAttendance0001', fields: { 'MEMBER RECORD ID': 'recFixtureMember1' } },
        { id: 'recAttendance0002', fields: { 'MEMBER RECORD ID': 'recFixtureMember1' } }
      ]
    });
  });

  await assert.rejects(
    () => airtable.saveAttendance('recFixtureEvent01', [
      { memberId: 'recFixtureMember1', attended: true, actualGuests: 0 }
    ]),
    error => error.code === 'UPSTREAM_FAILED'
  );
  assert.equal(requestCount, 3);
});

test('attendance rejects duplicate submitted members before reaching Airtable', async () => {
  let requestCount = 0;
  const airtable = createAirtable(ENV, async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  await assert.rejects(
    () => airtable.saveAttendance('recFixtureEvent01', [
      { memberId: 'recFixtureMember1', attended: true, actualGuests: 0 },
      { memberId: 'recFixtureMember1', attended: false, actualGuests: 0 }
    ]),
    error => error.code === 'VALIDATION_FAILED' && error.status === 400
  );
  assert.equal(requestCount, 0);
});

test('attendance accepts only completed events and current directory members', async () => {
  let eventStatus = 'Scheduled';
  const requests = [];
  const airtable = createAirtable(ENV, async url => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname.endsWith('/recFixtureEvent01')) {
      return jsonResponse({ id: 'recFixtureEvent01', fields: { Status: eventStatus } });
    }
    if (pathname.endsWith('/tblFixtureMembers')) {
      return jsonResponse({ records: [{ id: 'recFixtureMember2', fields: { 'IN DIRECTORY': true } }] });
    }
    return jsonResponse({ records: [] });
  });

  await assert.rejects(
    () => airtable.saveAttendance('recFixtureEvent01', [
      { memberId: 'recFixtureMember1', attended: true, actualGuests: 0 }
    ]),
    error => error.code === 'EVENT_NOT_COMPLETED' && error.status === 409
  );
  assert.equal(requests.length, 1);

  eventStatus = 'Completed';
  await assert.rejects(
    () => airtable.saveAttendance('recFixtureEvent01', [
      { memberId: 'recFixtureMember1', attended: true, actualGuests: 0 }
    ]),
    error => error.code === 'VALIDATION_FAILED' && error.status === 400
  );
  assert.equal(requests.some(pathname => pathname.endsWith('/tblFixtureAttendance')), false);
});

test('promoting a suggested event creates exact RSVP mappings before marking it ready', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init = {}) => {
    const request = { url: new URL(url), init };
    requests.push(request);
    if (requests.length === 1) {
      return jsonResponse({
        id: 'recFixtureEvent02',
        fields: { 'EVENT NAME': 'Suggested Fixture', Status: 'Suggested', 'SETUP STATE': 'ready' }
      });
    }
    if (request.url.pathname === '/v0/meta/bases/appFixtureBase/tables') {
      return jsonResponse({ tables: [{ id: 'tblFixtureMembers', fields: [] }] });
    }
    if (request.url.pathname.endsWith('/fields')) {
      const body = JSON.parse(init.body);
      return jsonResponse({ id: 'fldFixtureCreated', name: body.name, type: body.type });
    }
    const body = JSON.parse(init.body);
    return jsonResponse({ id: 'recFixtureEvent02', fields: body.fields });
  });

  const result = await airtable.updateEvent('recFixtureEvent02', {
    name: 'Promoted Fixture',
    date: '2026-10-17',
    speaker: 'Fixture Speaker',
    time: '6:30 PM',
    room: 'Fixture Hall',
    notes: '',
    status: 'Scheduled'
  });

  assert.equal(result.fields.Status, 'Scheduled');
  assert.equal(result.fields['SETUP STATE'], 'ready');
  assert.match(result.fields['RSVP FIELD'], / RSVP$/);
  assert.match(result.fields['GUEST FIELD'], /^GUESTS-/);
  const fieldCreates = requests.filter(request => request.url.pathname.endsWith('/fields'));
  assert.equal(fieldCreates.length, 2);
  assert.deepEqual(fieldCreates.map(request => JSON.parse(request.init.body).type), ['singleSelect', 'number']);
  const finalPatch = JSON.parse(requests.at(-1).init.body).fields;
  assert.equal(finalPatch.Status, 'Scheduled');
  assert.equal(finalPatch['SETUP STATE'], 'ready');
});

for (const status of ['Upcoming', 'Completed', 'Cancelled']) {
  test(`admins can clear RSVPs for ${status} events while members cannot`, async () => {
    const writes = [];
    const airtable = createAirtable(ENV, async (url, init) => {
      if (init?.method === 'PATCH') {
        writes.push(JSON.parse(init.body).fields);
        return jsonResponse({ id: 'rec12345678901234', fields: writes.at(-1) });
      }
      return jsonResponse({ id: 'recFixtureEvent01', fields: {
        Status: status, 'SETUP STATE': 'ready', 'RSVP FIELD': 'EXISTING RSVP', 'GUEST FIELD': 'GUESTS-EXISTING'
      } });
    });
    await assert.rejects(airtable.setRsvp('rec12345678901234', 'recFixtureEvent01', { response: null, guests: 0 }), { code: 'EVENT_NOT_OPEN' });
    await airtable.setRsvp('rec12345678901234', 'recFixtureEvent01', { response: null, guests: 0 }, { admin: true });
    assert.deepEqual(writes, [{ 'EXISTING RSVP': null, 'GUESTS-EXISTING': 0 }]);
  });
}

test('admin override never bypasses missing event mappings', async () => {
  const airtable = createAirtable(ENV, async () => jsonResponse({ id: 'recFixtureEvent01', fields: { Status: 'Scheduled' } }));
  await assert.rejects(airtable.setRsvp('rec12345678901234', 'recFixtureEvent01', { response: 'YES', guests: 0 }, { admin: true }), { code: 'EVENT_MAPPING_MISSING' });
});

test('reopening a mapped event preserves its existing RSVPs and guest counts', async () => {
  const requests = [];
  const airtable = createAirtable(ENV, async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ id: 'recFixtureEvent01', fields: {
      Status: 'Completed', 'SETUP STATE': 'ready', 'RSVP FIELD': 'LEGACY RSVP', 'GUEST FIELD': 'GUESTS-LEGACY'
    } });
  });
  await airtable.updateEvent('recFixtureEvent01', { name: 'Existing event', date: '2026-09-29', speaker: '', time: '', room: '', notes: '', status: 'Scheduled' });
  assert.equal(requests.length, 2);
  const fields = JSON.parse(requests[1].init.body).fields;
  assert.equal(fields.Status, 'Scheduled');
  assert.equal(Object.hasOwn(fields, 'RSVP FIELD'), false);
  assert.equal(Object.hasOwn(fields, 'GUEST FIELD'), false);
});
