import { ApiError } from './errors.js';
import { buildEventFieldMapping, createEventWithAdapter } from './events.js';

// Cloudflare D1 + KV implementation of the data store. It returns the same
// Airtable-shaped records ({ id, fields }) as airtable.js, so routes and pages are unchanged.

const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const ATTACHMENT_ID = /^att[A-Za-z0-9]{14}$/;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const DIRECTORY_ORDER = 'last_name COLLATE NOCASE, full_name COLLATE NOCASE';

const EVENT_COLUMNS = {
  'EVENT NAME': 'name',
  DATE: 'date',
  SPEAKER: 'speaker',
  TIME: 'time',
  ROOM: 'room',
  LOCATION: 'location',
  NOTES: 'notes',
  Status: 'status',
  'RSVP FIELD': 'rsvp_field',
  'GUEST FIELD': 'guest_field',
  'CREATION KEY': 'creation_key',
  'SETUP STATE': 'setup_state'
};

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return prefix + Array.from(bytes, byte => ID_CHARS[byte % ID_CHARS.length]).join('');
}

function requireRecordId(recordId) {
  if (typeof recordId !== 'string' || !RECORD_ID.test(recordId)) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The record identity is not valid.');
  }
  return recordId;
}

function notFound(message = 'The record was not found.') {
  return new ApiError(404, 'NOT_FOUND', message);
}

function easternDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Airtable omits empty values from record fields; mirror that so page logic sees the same shapes.
function compact(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => (
    value !== null && value !== undefined && value !== '' && value !== false
    && !(Array.isArray(value) && value.length === 0)
  )));
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function requireBindings(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function' || !env.PHOTOS || typeof env.PHOTOS.put !== 'function') {
    throw new ApiError(500, 'CONFIGURATION_ERROR', 'The app data service is not configured.');
  }
}

export function createD1Store(env, { origin = '' } = {}) {
  requireBindings(env);
  const db = env.DB;
  const files = env.PHOTOS;

  const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results ?? [];
  const first = (sql, ...params) => db.prepare(sql).bind(...params).first();
  const statement = (sql, ...params) => db.prepare(sql).bind(...params);

  function fileUrl(id) {
    return `${origin}/api/files/${id}`;
  }

  function projectAttachment(row) {
    const url = fileUrl(row.id);
    return {
      id: row.id,
      url,
      filename: row.filename,
      type: row.content_type,
      size: row.size,
      thumbnails: { small: { url }, large: { url }, full: { url } }
    };
  }

  async function attachmentsFor(kind, ownerIds) {
    const byOwner = new Map();
    if (ownerIds.length === 0) return byOwner;
    const rows = ownerIds.length === 1
      ? await all('SELECT * FROM attachments WHERE owner_kind = ? AND owner_id = ? ORDER BY position', kind, ownerIds[0])
      : await all('SELECT * FROM attachments WHERE owner_kind = ? ORDER BY position', kind);
    const wanted = new Set(ownerIds);
    for (const row of rows) {
      if (!wanted.has(row.owner_id)) continue;
      if (!byOwner.has(row.owner_id)) byOwner.set(row.owner_id, []);
      byOwner.get(row.owner_id).push(projectAttachment(row));
    }
    return byOwner;
  }

  async function eventValuesFor(memberIds) {
    const byMember = new Map();
    if (memberIds.length === 0) return byMember;
    const rows = memberIds.length === 1
      ? await all('SELECT * FROM member_event_values WHERE member_id = ?', memberIds[0])
      : await all('SELECT * FROM member_event_values');
    for (const row of rows) {
      if (!byMember.has(row.member_id)) byMember.set(row.member_id, {});
      byMember.get(row.member_id)[row.field_name] = JSON.parse(row.value);
    }
    return byMember;
  }

  const MEMBER_FIELD_BUILDERS = {
    'FULL NAME': row => row.full_name,
    'LAST NAME': row => row.last_name,
    'CELL #': row => row.cell,
    'E-MAIL ADDRESS': row => row.email,
    'MEMBER #': row => row.member_number,
    'IN DIRECTORY': row => row.in_directory === 1,
    'IS ADMIN': row => row.is_admin === 1
  };

  // names: which Airtable field names to include; photos/eventValues: optional per-member maps.
  function projectMember(row, names, { photos, eventValues } = {}) {
    const fields = {};
    for (const name of names) {
      if (name === 'PHOTO') fields.PHOTO = photos?.get(row.id) ?? [];
      else fields[name] = MEMBER_FIELD_BUILDERS[name](row);
    }
    return { id: row.id, fields: compact({ ...fields, ...(eventValues?.get(row.id) ?? {}) }) };
  }

  async function memberRecords(rows, names, { includeEventValues = false } = {}) {
    const ids = rows.map(row => row.id);
    const photos = names.includes('PHOTO') ? await attachmentsFor('member', ids) : undefined;
    const eventValues = includeEventValues ? await eventValuesFor(ids) : undefined;
    return rows.map(row => projectMember(row, names, { photos, eventValues }));
  }

  async function fullMember(memberId) {
    const row = await first('SELECT * FROM members WHERE id = ?', memberId);
    if (!row) throw notFound('The member record was not found.');
    const [record] = await memberRecords(row ? [row] : [], [
      'FULL NAME', 'LAST NAME', 'CELL #', 'E-MAIL ADDRESS', 'PHOTO', 'MEMBER #', 'IN DIRECTORY', 'IS ADMIN'
    ], { includeEventValues: true });
    return record;
  }

  function projectEvent(row, speakerPhotos) {
    const fields = {};
    for (const [name, column] of Object.entries(EVENT_COLUMNS)) fields[name] = row[column];
    fields['SPEAKER PHOTO'] = speakerPhotos?.get(row.id) ?? [];
    return { id: row.id, fields: compact(fields) };
  }

  async function getEventRow(eventId) {
    requireRecordId(eventId);
    const row = await first('SELECT * FROM events WHERE id = ?', eventId);
    if (!row) throw notFound('The event was not found.');
    return row;
  }

  async function eventRecord(eventId) {
    const row = await getEventRow(eventId);
    return projectEvent(row, await attachmentsFor('speaker', [row.id]));
  }

  async function patchEvent(eventId, fields) {
    const assignments = [];
    const params = [];
    for (const [name, value] of Object.entries(fields)) {
      const column = EVENT_COLUMNS[name];
      if (!column) throw new ApiError(400, 'VALIDATION_FAILED', 'The submitted event is not valid.');
      assignments.push(`${column} = ?`);
      params.push(value === '' || value === undefined ? null : value);
    }
    if (assignments.length > 0) {
      const result = await statement(
        `UPDATE events SET ${assignments.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ...params,
        eventId
      ).run();
      if (result.meta?.changes === 0) throw notFound('The event was not found.');
    }
    return eventRecord(eventId);
  }

  async function ensureMemberField(name, type) {
    const existing = await first('SELECT name, type FROM member_event_fields WHERE name = ?', name);
    if (existing) {
      if (existing.type !== type) {
        throw new ApiError(409, 'FIELD_TYPE_CONFLICT', 'An event field has an incompatible type.');
      }
      return existing;
    }
    const choices = type === 'singleSelect' ? ['YES', 'NO', 'MAYBE'] : [];
    await statement(
      'INSERT INTO member_event_fields (name, type, choices_json) VALUES (?, ?, ?)',
      name, type, JSON.stringify(choices)
    ).run();
    return { name, type };
  }

  // Member and speaker photos hold one image; a new upload replaces the old one.
  async function replaceAttachment(kind, ownerId, value) {
    const bytes = decodeBase64(value.base64);
    const id = newId('att');
    await files.put(id, bytes, { metadata: { contentType: value.contentType } });
    const previous = await all('SELECT id FROM attachments WHERE owner_kind = ? AND owner_id = ?', kind, ownerId);
    await db.batch([
      statement('DELETE FROM attachments WHERE owner_kind = ? AND owner_id = ?', kind, ownerId),
      statement(
        'INSERT INTO attachments (id, owner_kind, owner_id, filename, content_type, size, position) VALUES (?, ?, ?, ?, ?, ?, 0)',
        id, kind, ownerId, value.filename, value.contentType, bytes.length
      )
    ]);
    await Promise.all(previous.map(row => files.delete(row.id)));
  }

  async function deleteAttachments(kind, ownerId) {
    const rows = await all('SELECT id FROM attachments WHERE owner_kind = ? AND owner_id = ?', kind, ownerId);
    await statement('DELETE FROM attachments WHERE owner_kind = ? AND owner_id = ?', kind, ownerId).run();
    await Promise.all(rows.map(row => files.delete(row.id)));
  }

  async function photoRecord(photoId, { includeMemberId = true } = {}) {
    const row = await first('SELECT * FROM photos WHERE id = ?', photoId);
    if (!row) throw notFound('The photo was not found.');
    const attachments = await attachmentsFor('event_photo', [row.id]);
    return projectPhoto(row, attachments, includeMemberId);
  }

  function projectPhoto(row, attachments, includeMemberId) {
    return {
      id: row.id,
      fields: compact({
        'EVENT RECORD ID': row.event_id,
        ...(includeMemberId ? { 'MEMBER RECORD ID': row.member_id } : {}),
        'MEMBER NAME': row.member_name,
        PHOTO: attachments.get(row.id) ?? [],
        CAPTION: row.caption,
        SUBMITTED: row.submitted
      })
    };
  }

  function voteRecord(row) {
    return {
      id: row.id,
      fields: { 'MEMBER RECORD ID': row.member_id, 'EVENT RECORD ID': row.event_id, VOTE: row.vote }
    };
  }

  function attendanceRecord(row) {
    return {
      id: row.id,
      fields: compact({
        'EVENT RECORD ID': row.event_id,
        'MEMBER RECORD ID': row.member_id,
        ATTENDED: row.attended === 1,
        'ACTUAL GUESTS': row.actual_guests
      })
    };
  }

  function requestRecord(row) {
    return {
      id: row.id,
      fields: compact({
        'SUBMITTED NAME': row.submitted_name,
        'SUBMITTED MEMBER #': row.submitted_member_number,
        STATUS: row.status,
        'SUBMITTED DATE': row.submitted_date,
        'LINKED MEMBER ID': row.linked_member_id
      })
    };
  }

  const eventCreationAdapter = {
    async findEventByCreationKey(key) {
      const row = await first('SELECT * FROM events WHERE creation_key = ?', key);
      return row ? projectEvent(row) : null;
    },

    async createEventRecord(fields) {
      const id = newId('rec');
      await statement('INSERT INTO events (id) VALUES (?)', id).run();
      return patchEvent(id, fields);
    },

    patchEventRecord(recordId, fields) {
      return patchEvent(recordId, fields);
    },

    ensureMemberField
  };

  return {
    async findMemberByNumber(memberNumber) {
      const rows = await all(
        `SELECT * FROM members
         WHERE trim(member_number) != '' AND trim(member_number) NOT GLOB '*[^0-9]*'
           AND CAST(trim(member_number) AS INTEGER) = ?
         LIMIT 2`,
        memberNumber
      );
      if (rows.length !== 1) return null;
      return projectMember(rows[0], ['MEMBER #', 'FULL NAME', 'IS ADMIN']);
    },

    async getMember(recordId) {
      requireRecordId(recordId);
      const row = await first('SELECT * FROM members WHERE id = ?', recordId);
      if (!row) throw notFound('The member record was not found.');
      const [record] = await memberRecords([row], [
        'FULL NAME', 'CELL #', 'E-MAIL ADDRESS', 'PHOTO', 'IN DIRECTORY', 'MEMBER #'
      ]);
      return record;
    },

    async updateMemberProfile(recordId, value) {
      requireRecordId(recordId);
      const result = await statement(
        `UPDATE members SET full_name = ?, cell = ?, email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        value.name, value.phone, value.email, recordId
      ).run();
      if (result.meta?.changes === 0) throw notFound('The member record was not found.');
      return fullMember(recordId);
    },

    async updateMember(recordId, value) {
      requireRecordId(recordId);
      const result = await statement(
        `UPDATE members SET full_name = ?, cell = ?, email = ?, member_number = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
        value.name, value.phone, value.email, String(value.memberNumber), recordId
      ).run();
      if (result.meta?.changes === 0) throw notFound('The member record was not found.');
      return fullMember(recordId);
    },

    async setRsvp(recordId, eventId, value, { admin = false } = {}) {
      requireRecordId(recordId);
      const event = await getEventRow(eventId);
      const rsvpField = event.rsvp_field;
      const guestField = event.guest_field ?? undefined;
      if (!admin && event.status !== 'Scheduled') {
        throw new ApiError(409, 'EVENT_NOT_OPEN', 'This event is not open for RSVP changes.');
      }
      const knownFields = new Set((await all('SELECT name FROM member_event_fields')).map(row => row.name));
      if (
        event.setup_state !== 'ready'
        || typeof rsvpField !== 'string'
        || !rsvpField.toUpperCase().endsWith(' RSVP')
        || !knownFields.has(rsvpField)
        || (guestField !== undefined && (!guestField.startsWith('GUESTS-') || !knownFields.has(guestField)))
      ) {
        throw new ApiError(409, 'EVENT_MAPPING_MISSING', 'RSVP setup is incomplete. Ask an administrator to check this event.');
      }
      if (!guestField && value.guests !== 0) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'This event does not accept guest counts.');
      }
      if (!await first('SELECT id FROM members WHERE id = ?', recordId)) {
        throw notFound('The member record was not found.');
      }
      const writes = [
        value.response === null
          ? statement('DELETE FROM member_event_values WHERE member_id = ? AND field_name = ?', recordId, rsvpField)
          : statement(
            `INSERT INTO member_event_values (member_id, field_name, value) VALUES (?, ?, ?)
             ON CONFLICT (member_id, field_name) DO UPDATE SET value = excluded.value,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
            recordId, rsvpField, JSON.stringify(value.response)
          )
      ];
      if (guestField) {
        writes.push(statement(
          `INSERT INTO member_event_values (member_id, field_name, value) VALUES (?, ?, ?)
           ON CONFLICT (member_id, field_name) DO UPDATE SET value = excluded.value,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          recordId, guestField, JSON.stringify(value.guests)
        ));
      }
      await db.batch(writes);
      return fullMember(recordId);
    },

    async setVote(recordId, eventId, vote) {
      requireRecordId(recordId);
      const event = await getEventRow(eventId);
      if (event.status !== 'Suggested' || event.setup_state !== 'ready') {
        throw new ApiError(409, 'VOTING_CLOSED', 'Voting is not open for this event.');
      }
      const existing = await first('SELECT * FROM votes WHERE member_id = ? AND event_id = ?', recordId, eventId);
      if (vote === null) {
        if (!existing) return { deleted: false };
        await statement('DELETE FROM votes WHERE id = ?', existing.id).run();
        return { id: existing.id, deleted: true };
      }
      if (existing) {
        await statement('UPDATE votes SET vote = ? WHERE id = ?', vote, existing.id).run();
        return voteRecord({ ...existing, vote });
      }
      const created = { id: newId('rec'), member_id: recordId, event_id: eventId, vote };
      await statement(
        'INSERT INTO votes (id, event_id, member_id, vote) VALUES (?, ?, ?, ?)',
        created.id, eventId, recordId, vote
      ).run();
      return voteRecord(created);
    },

    async getMemberVotes(recordId) {
      requireRecordId(recordId);
      const rows = await all('SELECT event_id, vote FROM votes WHERE member_id = ?', recordId);
      return { votes: rows.map(row => ({ eventId: row.event_id, vote: row.vote })) };
    },

    async submitMemberRequest(value) {
      const existing = await first(
        "SELECT id FROM member_requests WHERE submitted_member_number = ? AND status = 'Pending'",
        value.memberNumber
      );
      if (existing) {
        throw new ApiError(409, 'ALREADY_PENDING', 'This member number already has a pending request.');
      }
      const id = newId('rec');
      await statement(
        `INSERT INTO member_requests (id, submitted_name, submitted_member_number, status, submitted_date)
         VALUES (?, ?, ?, 'Pending', ?)`,
        id, value.name, value.memberNumber, easternDate()
      ).run();
      return { id, status: 'Pending' };
    },

    async getMemberRequests() {
      const [requests, members] = await Promise.all([
        all("SELECT * FROM member_requests WHERE status = 'Pending' ORDER BY submitted_date, id"),
        all(`SELECT * FROM members WHERE in_directory = 1 ORDER BY ${DIRECTORY_ORDER}`)
      ]);
      return {
        requests: requests.map(requestRecord),
        members: members.map(row => projectMember(row, ['FULL NAME', 'MEMBER #', 'IN DIRECTORY']))
      };
    },

    async approveMemberRequest(requestId, memberId) {
      requireRecordId(requestId);
      requireRecordId(memberId);
      const request = await first('SELECT * FROM member_requests WHERE id = ?', requestId);
      if (!request) throw notFound('The member request was not found.');
      if (request.status !== 'Pending' || !Number.isSafeInteger(request.submitted_member_number)) {
        throw new ApiError(409, 'REQUEST_NOT_PENDING', 'This request is no longer pending.');
      }
      if (!await first('SELECT id FROM members WHERE id = ?', memberId)) {
        throw notFound('The member record was not found.');
      }
      await db.batch([
        statement(
          `UPDATE members SET member_number = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
          String(request.submitted_member_number), memberId
        ),
        statement(
          "UPDATE member_requests SET status = 'Approved', linked_member_id = ? WHERE id = ?",
          memberId, requestId
        )
      ]);
      return { id: requestId, status: 'Approved', memberId };
    },

    async rejectMemberRequest(requestId) {
      requireRecordId(requestId);
      const request = await first('SELECT status FROM member_requests WHERE id = ?', requestId);
      if (!request) throw notFound('The member request was not found.');
      if (request.status !== 'Pending') {
        throw new ApiError(409, 'REQUEST_NOT_PENDING', 'This request is no longer pending.');
      }
      await statement("UPDATE member_requests SET status = 'Rejected' WHERE id = ?", requestId).run();
      return { id: requestId, status: 'Rejected' };
    },

    async getMemberNumberDiagnostics() {
      const rows = await all('SELECT member_number FROM members WHERE in_directory = 1');
      const withNumber = rows.filter(row => (
        typeof row.member_number === 'string'
        && row.member_number.trim() !== ''
        && Number.isSafeInteger(Number(row.member_number))
      )).length;
      return { totalInDirectory: rows.length, withNumber, missingNumber: rows.length - withNumber };
    },

    async updateEvent(eventId, value) {
      const existing = await getEventRow(eventId);
      const fields = {
        'EVENT NAME': value.name,
        DATE: value.date || null,
        SPEAKER: value.speaker,
        TIME: value.time,
        ROOM: value.room,
        ...(value.location !== undefined ? { LOCATION: value.location } : {}),
        NOTES: value.notes,
        Status: value.status
      };
      const needsScheduledSetup = value.status === 'Scheduled' && (
        existing.setup_state !== 'ready' || typeof existing.rsvp_field !== 'string'
      );
      if (!needsScheduledSetup) return patchEvent(eventId, fields);

      const mapping = await buildEventFieldMapping({ date: value.date, name: value.name, idempotencyKey: eventId });
      await ensureMemberField(mapping.rsvpField, 'singleSelect');
      await ensureMemberField(mapping.guestField, 'number');
      return patchEvent(eventId, {
        ...fields,
        'RSVP FIELD': mapping.rsvpField,
        'GUEST FIELD': mapping.guestField,
        'SETUP STATE': 'ready'
      });
    },

    async saveAttendance(eventId, entries) {
      requireRecordId(eventId);
      const submittedMemberIds = new Set();
      for (const entry of entries) {
        requireRecordId(entry.memberId);
        if (submittedMemberIds.has(entry.memberId)) {
          throw new ApiError(400, 'VALIDATION_FAILED', 'Each member may appear only once in attendance.');
        }
        submittedMemberIds.add(entry.memberId);
      }
      const event = await getEventRow(eventId);
      if (String(event.status ?? '').trim().toLowerCase() !== 'completed') {
        throw new ApiError(409, 'EVENT_NOT_COMPLETED', 'Attendance can be recorded only for a completed event.');
      }
      const validMemberIds = new Set((await all('SELECT id FROM members WHERE in_directory = 1')).map(row => row.id));
      if ([...submittedMemberIds].some(memberId => !validMemberIds.has(memberId))) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'Attendance includes a member who is not in the directory.');
      }
      if (entries.length > 0) {
        await db.batch(entries.map(entry => statement(
          `INSERT INTO attendance (id, event_id, member_id, attended, actual_guests) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (event_id, member_id) DO UPDATE SET attended = excluded.attended,
             actual_guests = excluded.actual_guests`,
          newId('rec'), eventId, entry.memberId, entry.attended ? 1 : 0, entry.actualGuests
        )));
      }
      return { saved: entries.length };
    },

    async uploadMemberPhoto(memberId, value) {
      requireRecordId(memberId);
      if (!await first('SELECT id FROM members WHERE id = ?', memberId)) {
        throw notFound('The member record was not found.');
      }
      await replaceAttachment('member', memberId, value);
      return fullMember(memberId);
    },

    async uploadEventPhoto(eventId, value) {
      await getEventRow(eventId);
      await replaceAttachment('speaker', eventId, value);
      return eventRecord(eventId);
    },

    async clearEventPhoto(eventId) {
      await getEventRow(eventId);
      await deleteAttachments('speaker', eventId);
      return eventRecord(eventId);
    },

    async addEventPhoto(session, eventId, value) {
      await getEventRow(eventId);
      let memberName = 'ADMIN';
      let memberId = null;
      if (RECORD_ID.test(session.sub)) {
        const member = await first('SELECT full_name FROM members WHERE id = ?', session.sub);
        if (!member) throw notFound('The member record was not found.');
        memberName = String(member.full_name ?? '').slice(0, 160);
        memberId = session.sub;
      }
      const bytes = decodeBase64(value.base64);
      const photoId = newId('rec');
      const attachmentId = newId('att');
      await files.put(attachmentId, bytes, { metadata: { contentType: value.contentType } });
      try {
        await db.batch([
          statement(
            'INSERT INTO photos (id, event_id, member_id, member_name, caption, submitted) VALUES (?, ?, ?, ?, ?, ?)',
            photoId, eventId, memberId, memberName, value.caption, easternDate()
          ),
          statement(
            `INSERT INTO attachments (id, owner_kind, owner_id, filename, content_type, size, position)
             VALUES (?, 'event_photo', ?, ?, ?, ?, 0)`,
            attachmentId, photoId, value.filename, value.contentType, bytes.length
          )
        ]);
      } catch (error) {
        await files.delete(attachmentId);
        throw error;
      }
      return photoRecord(photoId);
    },

    async deletePhoto(photoId) {
      requireRecordId(photoId);
      const result = await statement('DELETE FROM photos WHERE id = ?', photoId).run();
      if (result.meta?.changes === 0) throw notFound('The photo was not found.');
      await deleteAttachments('event_photo', photoId);
      return { id: photoId, deleted: true };
    },

    async updatePhotoCaption(photoId, caption) {
      requireRecordId(photoId);
      const result = await statement('UPDATE photos SET caption = ? WHERE id = ?', caption, photoId).run();
      if (result.meta?.changes === 0) throw notFound('The photo was not found.');
      return photoRecord(photoId);
    },

    createEvent(value) {
      return createEventWithAdapter(eventCreationAdapter, value);
    },

    async getDirectory(role) {
      const rows = await all(`SELECT * FROM members WHERE in_directory = 1 ORDER BY ${DIRECTORY_ORDER}`);
      const names = ['FULL NAME', 'CELL #', 'E-MAIL ADDRESS', 'PHOTO', ...(role === 'admin' ? ['MEMBER #'] : [])];
      return { records: await memberRecords(rows, names) };
    },

    async getEventsBootstrap(role) {
      const [eventRows, fieldRows, memberRows, photoRows, attendanceRows, voteRows] = await Promise.all([
        all('SELECT * FROM events ORDER BY created_at, id'),
        all('SELECT * FROM member_event_fields ORDER BY created_at, name'),
        all(`SELECT * FROM members WHERE in_directory = 1 ORDER BY ${DIRECTORY_ORDER}`),
        all('SELECT * FROM photos ORDER BY created_at, id'),
        all('SELECT * FROM attendance'),
        all('SELECT * FROM votes')
      ]);
      const [speakerPhotos, eventPhotos] = await Promise.all([
        attachmentsFor('speaker', eventRows.map(row => row.id)),
        attachmentsFor('event_photo', photoRows.map(row => row.id))
      ]);

      const memberNames = ['FULL NAME', 'CELL #', 'E-MAIL ADDRESS', 'PHOTO', 'IN DIRECTORY', ...(role === 'admin' ? ['MEMBER #'] : [])];
      const members = await memberRecords(memberRows, memberNames, { includeEventValues: true });
      const memberFields = fieldRows.map(row => ({
        name: row.name,
        type: row.type,
        ...(row.type === 'singleSelect'
          ? { options: { choices: JSON.parse(row.choices_json).map(name => ({ name })) } }
          : { options: { precision: 0 } })
      }));

      const nameById = new Map(memberRows.map(row => [row.id, String(row.full_name ?? '').slice(0, 160)]));
      const attendanceSummary = attendanceRows.flatMap(row => {
        const memberName = nameById.get(row.member_id);
        return memberName
          ? [{ eventId: row.event_id, memberName, attended: row.attended === 1, actualGuests: row.actual_guests ?? 0 }]
          : [];
      });
      const voteTallies = {};
      for (const row of voteRows) {
        voteTallies[row.event_id] ??= { up: 0, down: 0 };
        voteTallies[row.event_id][row.vote === 'UP' ? 'up' : 'down'] += 1;
      }
      const isAdmin = role === 'admin';

      return {
        events: eventRows.map(row => projectEvent(row, speakerPhotos)),
        members,
        memberFields,
        photos: photoRows.map(row => {
          const record = projectPhoto(row, eventPhotos, isAdmin);
          return isAdmin ? record : { fields: record.fields };
        }),
        attendance: isAdmin ? attendanceRows.map(attendanceRecord) : [],
        attendanceSummary,
        votes: isAdmin ? voteRows.map(voteRecord) : [],
        voteTallies
      };
    },

    async getFile(fileId) {
      if (typeof fileId !== 'string' || !ATTACHMENT_ID.test(fileId)) throw notFound();
      const stored = await files.getWithMetadata(fileId, { type: 'arrayBuffer' });
      if (!stored?.value) throw notFound();
      return { body: stored.value, contentType: stored.metadata?.contentType ?? 'application/octet-stream' };
    },

    async refreshCaches() {
      return { refreshed: true };
    }
  };
}
