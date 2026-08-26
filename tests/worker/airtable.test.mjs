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
  assert.deepEqual(requests[0].url.searchParams.getAll('fields[]'), ['MEMBER #', 'FULL NAME']);
  assert.equal(requests[0].headers.get('Authorization'), 'Bearer fixture-airtable-token');
});

test('duplicate member numbers fail closed instead of selecting the first record', async () => {
  const airtable = createAirtable(ENV, async () => jsonResponse({
    records: [{ id: 'rec_first' }, { id: 'rec_second' }]
  }));

  assert.equal(await airtable.findMemberByNumber(42), null);
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
  assert.equal(result.photos[0].id, 'rec_tblFixturePhotos');
  assert.equal(result.attendance[0].id, 'rec_tblFixtureAttendance');
  assert.equal(result.votes[0].id, 'rec_tblFixtureVotes');
  assert.deepEqual(requests.map(value => value.pathname).sort(), [
    '/v0/appFixtureBase/tblFixtureAttendance',
    '/v0/appFixtureBase/tblFixtureEvents',
    '/v0/appFixtureBase/tblFixtureMembers',
    '/v0/appFixtureBase/tblFixturePhotos',
    '/v0/appFixtureBase/tblFixtureVotes',
    '/v0/meta/bases/appFixtureBase/tables'
  ]);

  const memberRequest = requests.find(value => value.pathname.endsWith('/tblFixtureMembers'));
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('DINNER RSVP'), true);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('GUESTS-DINNER'), true);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('REQUESTED CHANGES'), false);
  assert.equal(memberRequest.searchParams.getAll('fields[]').includes('MEMBER #'), false);
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
    if (init.method === undefined) {
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
  assert.equal(requests[0].url.searchParams.get('filterByFormula'), "{EVENT RECORD ID}='recFixtureEvent01'");
  assert.equal(requests[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
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
  assert.equal(requests[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[2].init.body), {
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
  const airtable = createAirtable(ENV, async () => {
    requestCount += 1;
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
  assert.equal(requestCount, 1);
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
