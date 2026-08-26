import { ApiError } from './errors.js';
import { createEventWithAdapter } from './events.js';

const AIRTABLE_API = 'https://api.airtable.com/v0';
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

const REQUIRED_BINDINGS = [
  'AIRTABLE_TOKEN',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_MEMBERS_TABLE_ID',
  'AIRTABLE_EVENTS_TABLE_ID',
  'AIRTABLE_PHOTOS_TABLE_ID',
  'AIRTABLE_ATTENDANCE_TABLE_ID',
  'AIRTABLE_VOTES_TABLE_ID'
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
