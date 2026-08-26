import { ApiError } from './errors.js';
import { buildEventFieldMapping, createEventWithAdapter } from './events.js';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const AIRTABLE_CONTENT_API = 'https://content.airtable.com/v0';
const MAX_PAGES = 10;

const DIRECTORY_FIELDS = ['FULL NAME', 'CELL #', 'E-MAIL ADDRESS', 'PHOTO'];
const SELF_FIELDS = [...DIRECTORY_FIELDS, 'IN DIRECTORY', 'MEMBER #'];
const EVENT_FIELDS = [
  'EVENT NAME', 'DATE', 'SPEAKER', 'TIME', 'ROOM', 'SPEAKER PHOTO', 'NOTES', 'Status',
  'RSVP FIELD', 'GUEST FIELD', 'CREATION KEY', 'SETUP STATE'
];
const PHOTO_FIELDS = ['EVENT RECORD ID', 'MEMBER RECORD ID', 'MEMBER NAME', 'PHOTO', 'CAPTION'];
const ATTENDANCE_FIELDS = ['EVENT RECORD ID', 'MEMBER RECORD ID', 'ATTENDED', 'ACTUAL GUESTS'];
const VOTE_FIELDS = ['EVENT RECORD ID', 'MEMBER RECORD ID', 'VOTE'];
const MEMBER_REQUEST_FIELDS = [
  'SUBMITTED NAME', 'SUBMITTED MEMBER #', 'STATUS', 'SUBMITTED DATE', 'LINKED MEMBER ID'
];

const REQUIRED_BINDINGS = [
  'AIRTABLE_TOKEN',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_MEMBERS_TABLE_ID',
  'AIRTABLE_EVENTS_TABLE_ID',
  'AIRTABLE_PHOTOS_TABLE_ID',
  'AIRTABLE_ATTENDANCE_TABLE_ID',
  'AIRTABLE_VOTES_TABLE_ID',
  'AIRTABLE_MEMBER_REQUESTS_TABLE_ID'
];

function upstreamError() {
  return new ApiError(502, 'UPSTREAM_FAILED', 'The data service did not complete the request.');
}

function requireBindings(env) {
  for (const name of REQUIRED_BINDINGS) {
    if (typeof env[name] !== 'string' || env[name] === '') {
      throw new ApiError(500, 'CONFIGURATION_ERROR', 'The app data service is not configured.');
    }
  }
}

export function createAirtable(env, fetchImpl = fetch) {
  requireBindings(env);

  const baseId = encodeURIComponent(env.AIRTABLE_BASE_ID);
  const tableUrl = tableId => `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`;

  function paramsWithFields(fields, values = {}) {
    const params = new URLSearchParams(values);
    for (const field of fields) params.append('fields[]', field);
    return params;
  }

  async function fetchJson(url, init = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers
        }
      });
    } catch {
      throw upstreamError();
    }

    if (!response.ok) throw upstreamError();

    try {
      return await response.json();
    } catch {
      throw upstreamError();
    }
  }

  async function listAll(tableId, initialParams = new URLSearchParams()) {
    const records = [];
    let offset;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams(initialParams);
      params.set('pageSize', '100');
      if (offset) params.set('offset', offset);

      const data = await fetchJson(`${tableUrl(tableId)}?${params}`);
      if (!Array.isArray(data.records)) throw upstreamError();
      records.push(...data.records);
      offset = data.offset;
      if (!offset) return records;
    }

    throw upstreamError();
  }

  async function getMemberFields() {
    const metadata = await fetchJson(`${AIRTABLE_API}/meta/bases/${baseId}/tables`);
    const memberTable = metadata.tables?.find(table => table.id === env.AIRTABLE_MEMBERS_TABLE_ID);
    if (!memberTable || !Array.isArray(memberTable.fields)) throw upstreamError();
    return memberTable.fields;
  }

  function requireRecordId(recordId) {
    if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'The record identity is not valid.');
    }
    return recordId;
  }

  async function patchRecord(tableId, recordId, fields) {
    requireRecordId(recordId);
    const data = await fetchJson(`${tableUrl(tableId)}/${recordId}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields })
    });
    if (data?.id !== recordId || !data.fields || typeof data.fields !== 'object') throw upstreamError();
    return data;
  }

  async function createRecord(tableId, fields) {
    const data = await fetchJson(tableUrl(tableId), {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
    if (!/^rec[A-Za-z0-9]{14}$/.test(data?.id) || !data.fields) throw upstreamError();
    return data;
  }

  async function deleteRecord(tableId, recordId) {
    requireRecordId(recordId);
    const data = await fetchJson(`${tableUrl(tableId)}/${recordId}`, { method: 'DELETE' });
    if (data?.id !== recordId || data.deleted !== true) throw upstreamError();
    return { id: recordId, deleted: true };
  }

  async function getRecord(tableId, recordId) {
    requireRecordId(recordId);
    const data = await fetchJson(`${tableUrl(tableId)}/${recordId}`);
    if (data?.id !== recordId || !data.fields) throw upstreamError();
    return data;
  }

  async function writeRecordBatches(tableId, method, records) {
    const saved = [];
    for (let index = 0; index < records.length; index += 10) {
      const batch = records.slice(index, index + 10);
      const data = await fetchJson(tableUrl(tableId), {
        method,
        body: JSON.stringify({ records: batch })
      });
      if (!Array.isArray(data.records) || data.records.length !== batch.length) throw upstreamError();
      saved.push(...data.records);
    }
    return saved;
  }

  async function uploadAttachment(tableId, recordId, fieldName, value) {
    requireRecordId(recordId);
    await fetchJson(
      `${AIRTABLE_CONTENT_API}/${baseId}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`,
      {
        method: 'POST',
        body: JSON.stringify({
          contentType: value.contentType,
          file: value.base64,
          filename: value.filename
        })
      }
    );
    const record = await getRecord(tableId, recordId);
    if (!Array.isArray(record.fields?.[fieldName]) || record.fields[fieldName].length === 0) throw upstreamError();
    return record;
  }

  const eventCreationAdapter = {
    async findEventByCreationKey(key) {
      const params = paramsWithFields(EVENT_FIELDS, {
        filterByFormula: `{CREATION KEY}='${key}'`,
        maxRecords: '2'
      });
      const data = await fetchJson(`${tableUrl(env.AIRTABLE_EVENTS_TABLE_ID)}?${params}`);
      if (!Array.isArray(data.records) || data.records.length > 1) throw upstreamError();
      return data.records[0] ?? null;
    },

    async createEventRecord(fields) {
      const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
      const data = await fetchJson(tableUrl(env.AIRTABLE_EVENTS_TABLE_ID), {
        method: 'POST',
        body: JSON.stringify({ typecast: true, fields: cleanFields })
      });
      if (!/^rec[A-Za-z0-9]{14}$/.test(data?.id) || !data.fields) throw upstreamError();
      return data;
    },

    patchEventRecord(recordId, fields) {
      return patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, recordId, fields);
    },

    async ensureMemberField(name, type) {
      const metadata = await getMemberFields();
      const existing = metadata.find(field => field.name === name);
      if (existing) {
        if (existing.type !== type) {
          throw new ApiError(409, 'FIELD_TYPE_CONFLICT', 'An event field has an incompatible type.');
        }
        return existing;
      }
      const options = type === 'singleSelect'
        ? { choices: [{ name: 'YES' }, { name: 'NO' }, { name: 'MAYBE' }] }
        : { precision: 0 };
      const created = await fetchJson(
        `${AIRTABLE_API}/meta/bases/${baseId}/tables/${encodeURIComponent(env.AIRTABLE_MEMBERS_TABLE_ID)}/fields`,
        {
          method: 'POST',
          body: JSON.stringify({ name, type, options })
        }
      );
      if (created?.name !== name || created?.type !== type) throw upstreamError();
      return created;
    }
  };

  return {
    async findMemberByNumber(memberNumber) {
      const params = new URLSearchParams({
        filterByFormula: `{MEMBER #}=${memberNumber}`,
        maxRecords: '2'
      });
      params.append('fields[]', 'MEMBER #');
      params.append('fields[]', 'FULL NAME');
      const data = await fetchJson(`${tableUrl(env.AIRTABLE_MEMBERS_TABLE_ID)}?${params}`);
      if (!Array.isArray(data.records)) throw upstreamError();
      return data.records.length === 1 ? data.records[0] : null;
    },

    async getMember(recordId) {
      requireRecordId(recordId);
      const params = paramsWithFields(SELF_FIELDS, {
        filterByFormula: `RECORD_ID()='${recordId}'`,
        maxRecords: '1'
      });
      const data = await fetchJson(`${tableUrl(env.AIRTABLE_MEMBERS_TABLE_ID)}?${params}`);
      if (!Array.isArray(data.records)) throw upstreamError();
      if (data.records.length !== 1) {
        throw new ApiError(404, 'NOT_FOUND', 'The member record was not found.');
      }
      return data.records[0];
    },

    async updateMemberProfile(recordId, value) {
      return patchRecord(env.AIRTABLE_MEMBERS_TABLE_ID, recordId, {
        'FULL NAME': value.name,
        'CELL #': value.phone,
        'E-MAIL ADDRESS': value.email
      });
    },

    async updateMember(recordId, value) {
      return patchRecord(env.AIRTABLE_MEMBERS_TABLE_ID, recordId, {
        'FULL NAME': value.name,
        'CELL #': value.phone,
        'E-MAIL ADDRESS': value.email,
        'MEMBER #': value.memberNumber,
        'IS ADMIN': value.isAdmin
      });
    },

    async setRsvp(recordId, eventId, value) {
      requireRecordId(recordId);
      requireRecordId(eventId);
      const event = await fetchJson(`${tableUrl(env.AIRTABLE_EVENTS_TABLE_ID)}/${eventId}`);
      const fields = event?.fields;
      const rsvpField = fields?.['RSVP FIELD'];
      const guestField = fields?.['GUEST FIELD'];
      if (
        fields?.Status !== 'Scheduled'
        || fields?.['SETUP STATE'] !== 'ready'
        || typeof rsvpField !== 'string'
        || !rsvpField.toUpperCase().endsWith(' RSVP')
        || rsvpField.length > 64
        || (guestField !== undefined && (typeof guestField !== 'string' || !guestField.startsWith('GUESTS-') || guestField.length > 64))
      ) {
        throw new ApiError(409, 'EVENT_NOT_OPEN', 'This event is not open for RSVP changes.');
      }
      if (!guestField && value.guests !== 0) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'This event does not accept guest counts.');
      }
      return patchRecord(env.AIRTABLE_MEMBERS_TABLE_ID, recordId, {
        [rsvpField]: value.response,
        ...(guestField ? { [guestField]: value.guests } : {})
      });
    },

    async setVote(recordId, eventId, vote) {
      requireRecordId(recordId);
      requireRecordId(eventId);
      const event = await getRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId);
      if (event.fields?.Status !== 'Suggested' || event.fields?.['SETUP STATE'] !== 'ready') {
        throw new ApiError(409, 'VOTING_CLOSED', 'Voting is not open for this event.');
      }
      const params = paramsWithFields(VOTE_FIELDS, {
        filterByFormula: `AND({MEMBER RECORD ID}='${recordId}',{EVENT RECORD ID}='${eventId}')`,
        maxRecords: '2'
      });
      const data = await fetchJson(`${tableUrl(env.AIRTABLE_VOTES_TABLE_ID)}?${params}`);
      if (!Array.isArray(data.records) || data.records.length > 1) throw upstreamError();
      const existing = data.records[0];
      if (vote === null) {
        return existing ? deleteRecord(env.AIRTABLE_VOTES_TABLE_ID, existing.id) : { deleted: false };
      }
      if (existing) return patchRecord(env.AIRTABLE_VOTES_TABLE_ID, existing.id, { VOTE: vote });
      return createRecord(env.AIRTABLE_VOTES_TABLE_ID, {
        'MEMBER RECORD ID': recordId,
        'EVENT RECORD ID': eventId,
        VOTE: vote
      });
    },

    async submitMemberRequest(value) {
      const params = paramsWithFields(MEMBER_REQUEST_FIELDS, {
        filterByFormula: `AND({SUBMITTED MEMBER #}=${value.memberNumber},{STATUS}='Pending')`,
        maxRecords: '1'
      });
      const existing = await fetchJson(`${tableUrl(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID)}?${params}`);
      if (!Array.isArray(existing.records)) throw upstreamError();
      if (existing.records.length > 0) {
        throw new ApiError(409, 'ALREADY_PENDING', 'This member number already has a pending request.');
      }
      const submittedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const created = await createRecord(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, {
        'SUBMITTED NAME': value.name,
        'SUBMITTED MEMBER #': value.memberNumber,
        STATUS: 'Pending',
        'SUBMITTED DATE': submittedDate
      });
      return { id: created.id, status: 'Pending' };
    },

    async getMemberRequests() {
      const requestParams = paramsWithFields(MEMBER_REQUEST_FIELDS, {
        filterByFormula: "{STATUS}='Pending'"
      });
      const memberParams = paramsWithFields(['FULL NAME', 'MEMBER #', 'IN DIRECTORY'], {
        filterByFormula: '{IN DIRECTORY}=TRUE()'
      });
      const [requests, members] = await Promise.all([
        listAll(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, requestParams),
        listAll(env.AIRTABLE_MEMBERS_TABLE_ID, memberParams)
      ]);
      return { requests, members };
    },

    async approveMemberRequest(requestId, memberId) {
      const request = await getRecord(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, requestId);
      if (request.fields?.STATUS !== 'Pending' || !Number.isSafeInteger(request.fields?.['SUBMITTED MEMBER #'])) {
        throw new ApiError(409, 'REQUEST_NOT_PENDING', 'This request is no longer pending.');
      }
      const memberNumber = request.fields['SUBMITTED MEMBER #'];
      const updatedMember = await patchRecord(env.AIRTABLE_MEMBERS_TABLE_ID, memberId, {
        'MEMBER #': memberNumber
      });
      if (updatedMember.fields?.['MEMBER #'] !== memberNumber) throw upstreamError();
      await patchRecord(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, requestId, {
        STATUS: 'Approved',
        'LINKED MEMBER ID': memberId
      });
      return { id: requestId, status: 'Approved', memberId };
    },

    async rejectMemberRequest(requestId) {
      const request = await getRecord(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, requestId);
      if (request.fields?.STATUS !== 'Pending') {
        throw new ApiError(409, 'REQUEST_NOT_PENDING', 'This request is no longer pending.');
      }
      await patchRecord(env.AIRTABLE_MEMBER_REQUESTS_TABLE_ID, requestId, { STATUS: 'Rejected' });
      return { id: requestId, status: 'Rejected' };
    },

    async getMemberNumberDiagnostics() {
      const params = paramsWithFields(['MEMBER #', 'IN DIRECTORY'], {
        filterByFormula: '{IN DIRECTORY}=TRUE()'
      });
      const records = await listAll(env.AIRTABLE_MEMBERS_TABLE_ID, params);
      const withNumber = records.filter(record => Number.isSafeInteger(record.fields?.['MEMBER #'])).length;
      return {
        totalInDirectory: records.length,
        withNumber,
        missingNumber: records.length - withNumber
      };
    },

    async updateEvent(eventId, value) {
      const existing = await getRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId);
      const fields = {
        'EVENT NAME': value.name,
        DATE: value.date || null,
        SPEAKER: value.speaker,
        TIME: value.time,
        ROOM: value.room,
        NOTES: value.notes,
        Status: value.status
      };
      const needsScheduledSetup = value.status === 'Scheduled' && (
        existing.fields?.Status !== 'Scheduled'
        || existing.fields?.['SETUP STATE'] !== 'ready'
        || typeof existing.fields?.['RSVP FIELD'] !== 'string'
      );
      if (!needsScheduledSetup) {
        return patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId, fields);
      }

      const mapping = await buildEventFieldMapping({
        date: value.date,
        name: value.name,
        idempotencyKey: eventId
      });
      try {
        await patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId, {
          ...fields,
          'RSVP FIELD': mapping.rsvpField,
          'GUEST FIELD': mapping.guestField,
          'SETUP STATE': 'creating'
        });
        await eventCreationAdapter.ensureMemberField(mapping.rsvpField, 'singleSelect');
        await eventCreationAdapter.ensureMemberField(mapping.guestField, 'number');
        return patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId, {
          ...fields,
          'RSVP FIELD': mapping.rsvpField,
          'GUEST FIELD': mapping.guestField,
          'SETUP STATE': 'ready'
        });
      } catch {
        try {
          await patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId, { 'SETUP STATE': 'failed:SETUP_FAILED' });
        } catch {
          // Preserve the original bounded setup failure.
        }
        throw new ApiError(502, 'SETUP_FAILED', 'The event setup did not finish. Retry to resume it.');
      }
    },

    async saveAttendance(eventId, entries) {
      requireRecordId(eventId);
      const params = paramsWithFields(ATTENDANCE_FIELDS, {
        filterByFormula: `{EVENT RECORD ID}='${eventId}'`
      });
      const existing = await listAll(env.AIRTABLE_ATTENDANCE_TABLE_ID, params);
      const byMember = new Map();
      for (const record of existing) {
        const memberId = record.fields?.['MEMBER RECORD ID'];
        if (typeof memberId !== 'string' || byMember.has(memberId)) throw upstreamError();
        byMember.set(memberId, record);
      }

      const updates = [];
      const creates = [];
      for (const entry of entries) {
        requireRecordId(entry.memberId);
        const fields = {
          'EVENT RECORD ID': eventId,
          'MEMBER RECORD ID': entry.memberId,
          ATTENDED: entry.attended,
          'ACTUAL GUESTS': entry.actualGuests
        };
        const record = byMember.get(entry.memberId);
        if (record) updates.push({ id: requireRecordId(record.id), fields });
        else creates.push({ fields });
      }
      if (updates.length > 0) await writeRecordBatches(env.AIRTABLE_ATTENDANCE_TABLE_ID, 'PATCH', updates);
      if (creates.length > 0) await writeRecordBatches(env.AIRTABLE_ATTENDANCE_TABLE_ID, 'POST', creates);
      return { saved: entries.length };
    },

    uploadMemberPhoto(memberId, value) {
      return uploadAttachment(env.AIRTABLE_MEMBERS_TABLE_ID, memberId, 'PHOTO', value);
    },

    uploadEventPhoto(eventId, value) {
      return uploadAttachment(env.AIRTABLE_EVENTS_TABLE_ID, eventId, 'SPEAKER PHOTO', value);
    },

    clearEventPhoto(eventId) {
      return patchRecord(env.AIRTABLE_EVENTS_TABLE_ID, eventId, { 'SPEAKER PHOTO': [] });
    },

    async addEventPhoto(session, eventId, value) {
      requireRecordId(eventId);
      let memberName = 'ADMIN';
      let memberId = '';
      if (session.role === 'member') {
        const member = await getRecord(env.AIRTABLE_MEMBERS_TABLE_ID, session.sub);
        memberName = String(member.fields?.['FULL NAME'] ?? '').slice(0, 160);
        memberId = session.sub;
      }
      const submittedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const record = await createRecord(env.AIRTABLE_PHOTOS_TABLE_ID, {
        'EVENT RECORD ID': eventId,
        ...(memberId ? { 'MEMBER RECORD ID': memberId } : {}),
        'MEMBER NAME': memberName,
        CAPTION: value.caption,
        SUBMITTED: submittedDate
      });
      try {
        return await uploadAttachment(env.AIRTABLE_PHOTOS_TABLE_ID, record.id, 'PHOTO', value);
      } catch (error) {
        try {
          await deleteRecord(env.AIRTABLE_PHOTOS_TABLE_ID, record.id);
        } catch {
          // Preserve the original bounded upload error if cleanup also fails.
        }
        throw error;
      }
    },

    deletePhoto(photoId) {
      return deleteRecord(env.AIRTABLE_PHOTOS_TABLE_ID, photoId);
    },

    updatePhotoCaption(photoId, caption) {
      return patchRecord(env.AIRTABLE_PHOTOS_TABLE_ID, photoId, { CAPTION: caption });
    },

    createEvent(value) {
      return createEventWithAdapter(eventCreationAdapter, value);
    },

    async getDirectory(role) {
      const fields = role === 'admin'
        ? [...DIRECTORY_FIELDS, 'IS ADMIN', 'MEMBER #']
        : DIRECTORY_FIELDS;
      const params = paramsWithFields(fields, { filterByFormula: '{IN DIRECTORY}=TRUE()' });
      return { records: await listAll(env.AIRTABLE_MEMBERS_TABLE_ID, params) };
    },

    async getEventsBootstrap(role) {
      const allMemberFields = await getMemberFields();
      const memberFields = allMemberFields.filter(field => (
        typeof field.name === 'string'
        && (field.name.toUpperCase().endsWith(' RSVP') || field.name.toUpperCase().startsWith('GUESTS-'))
      ));
      const memberFieldNames = [
        ...DIRECTORY_FIELDS,
        'IN DIRECTORY',
        ...(role === 'admin' ? ['MEMBER #'] : []),
        ...memberFields.map(field => field.name)
      ];
      const [events, members, photos, attendance, votes] = await Promise.all([
        listAll(env.AIRTABLE_EVENTS_TABLE_ID, paramsWithFields(EVENT_FIELDS)),
        listAll(env.AIRTABLE_MEMBERS_TABLE_ID, paramsWithFields(memberFieldNames, {
          filterByFormula: '{IN DIRECTORY}=TRUE()'
        })),
        listAll(env.AIRTABLE_PHOTOS_TABLE_ID, paramsWithFields(PHOTO_FIELDS)),
        listAll(env.AIRTABLE_ATTENDANCE_TABLE_ID, paramsWithFields(ATTENDANCE_FIELDS)),
        listAll(env.AIRTABLE_VOTES_TABLE_ID, paramsWithFields(VOTE_FIELDS))
      ]);

      return { events, members, memberFields, photos, attendance, votes };
    }
  };
}
