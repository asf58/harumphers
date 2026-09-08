import { buildEventFieldMapping } from '../../worker/src/events.js';

export const FIXTURE_LOGIN = Object.freeze({
  adminPassword: 'fixture-admin-password',
  guestPhrase: 'fixture-guest-phrase',
  memberNumber: 42001
});

const MEMBER_ID = 'recFixtureMember1';
const LONG_MEMBER_ID = 'recFixtureMember2';
const THIRD_MEMBER_ID = 'recFixtureMember3';

const DIRECTORY_RECORDS = [
  {
    id: MEMBER_ID,
    fields: {
      'FULL NAME': 'ALEX FIXTURE',
      'LAST NAME': 'FIXTURE',
      'CELL #': '(412) 555-0101',
      'E-MAIL ADDRESS': 'alex.fixture@example.test',
      'IN DIRECTORY': true,
      'MEMBER #': FIXTURE_LOGIN.memberNumber,
      'IS ADMIN': false,
      'SEP12-COMMUNITY-SPEAKER-1A2B3C4D RSVP': 'YES',
      'GUESTS-SEP12-COMMUNITY-SPEAKER-1A2B3C4D': 2
    }
  },
  {
    id: LONG_MEMBER_ID,
    fields: {
      'FULL NAME': 'CHRISTOPHER-JONATHAN MOBILE-REFLOW FIXTURE',
      'LAST NAME': 'MOBILE-REFLOW',
      'CELL #': '(412) 555-0102',
      'E-MAIL ADDRESS': 'christopher-jonathan.mobile-reflow+fixture@example.test',
      'IN DIRECTORY': true,
      'MEMBER #': 42002,
      'IS ADMIN': true,
      'SEP12-COMMUNITY-SPEAKER-1A2B3C4D RSVP': 'NO RESPONSE',
      'GUESTS-SEP12-COMMUNITY-SPEAKER-1A2B3C4D': 0
    }
  },
  {
    id: THIRD_MEMBER_ID,
    fields: {
      'FULL NAME': 'MORGAN ACCESSIBILITY FIXTURE',
      'LAST NAME': 'ACCESSIBILITY',
      'CELL #': '(412) 555-0103',
      'E-MAIL ADDRESS': 'morgan.accessibility@example.test',
      'IN DIRECTORY': true,
      'MEMBER #': 42003,
      'IS ADMIN': false,
      'SEP12-COMMUNITY-SPEAKER-1A2B3C4D RSVP': 'MAYBE',
      'GUESTS-SEP12-COMMUNITY-SPEAKER-1A2B3C4D': 1
    }
  }
];

const MEMBER_FIELDS = [
  { id: 'fldFixtureRsvp1', name: 'SEP12-COMMUNITY-SPEAKER-1A2B3C4D RSVP', type: 'singleSelect' },
  { id: 'fldFixtureGuest1', name: 'GUESTS-SEP12-COMMUNITY-SPEAKER-1A2B3C4D', type: 'number' }
];

const EVENTS = [
  {
    id: 'recFixtureEvent01',
    fields: {
      'EVENT NAME': 'Community Leadership with a Very Long Fixture Speaker Name',
      DATE: '2026-09-12',
      SPEAKER: 'Jordan Fixture',
      TIME: '6:00 PM',
      ROOM: 'Fixture Hall',
      NOTES: 'Synthetic event used only for local and automated acceptance testing.',
      Status: 'Scheduled',
      'RSVP FIELD': 'SEP12-COMMUNITY-SPEAKER-1A2B3C4D RSVP',
      'GUEST FIELD': 'GUESTS-SEP12-COMMUNITY-SPEAKER-1A2B3C4D',
      'CREATION KEY': 'fixture-event-scheduled',
      'SETUP STATE': 'ready'
    }
  },
  {
    id: 'recFixtureEvent02',
    fields: {
      'EVENT NAME': 'Suggested Fixture Speaker',
      SPEAKER: 'Taylor Fixture',
      NOTES: 'A deterministic suggested-event fixture.',
      Status: 'Suggested',
      'CREATION KEY': 'fixture-event-suggested',
      'SETUP STATE': 'ready'
    }
  }
];

function clone(value) {
  return structuredClone(value);
}

export function createFixtureAirtable() {
  const records = clone(DIRECTORY_RECORDS);
  const events = clone(EVENTS);
  const memberFields = clone(MEMBER_FIELDS);
  const photos = [];
  const attendance = [];
  const votes = [];
  const memberRequests = [];

  function attachment(filename) {
    return [{
      id: 'attFixtureImage1',
      filename,
      url: '/apple-touch-icon.png',
      thumbnails: { large: { url: '/apple-touch-icon.png' } }
    }];
  }

  return {
    async findMemberByNumber(memberNumber) {
      const record = records.find(item => item.fields['MEMBER #'] === memberNumber);
      return record ? clone(record) : null;
    },

    async getDirectory(role) {
      const visibleRecords = records.map(record => {
        const fields = {
          'FULL NAME': record.fields['FULL NAME'],
          'LAST NAME': record.fields['LAST NAME'],
          'CELL #': record.fields['CELL #'],
          'E-MAIL ADDRESS': record.fields['E-MAIL ADDRESS'],
          PHOTO: []
        };
        if (role === 'admin') {
          fields['MEMBER #'] = record.fields['MEMBER #'];
        }
        return { id: record.id, fields };
      });
      return { records: clone(visibleRecords) };
    },

    async getEventsBootstrap(role) {
      const members = records.map(record => {
        const fields = clone(record.fields);
        if (role !== 'admin') {
          delete fields['MEMBER #'];
          delete fields['IS ADMIN'];
        }
        return { id: record.id, fields };
      });
      const memberNames = new Map(members.map(record => [record.id, record.fields['FULL NAME']]));
      const attendanceSummary = attendance.map(record => ({
        eventId: record.fields['EVENT RECORD ID'],
        memberName: memberNames.get(record.fields['MEMBER RECORD ID']) || 'Member',
        attended: record.fields.ATTENDED === true,
        actualGuests: record.fields['ACTUAL GUESTS'] || 0
      }));
      const voteTallies = {};
      for (const record of votes) {
        const eventId = record.fields['EVENT RECORD ID'];
        voteTallies[eventId] ??= { up: 0, down: 0 };
        voteTallies[eventId][record.fields.VOTE === 'UP' ? 'up' : 'down'] += 1;
      }
      return {
        events: clone(events),
        members,
        memberFields: clone(memberFields),
        photos: role === 'admin' ? clone(photos) : clone(photos).map(record => ({
          fields: Object.fromEntries(Object.entries(record.fields).filter(([name]) => name !== 'MEMBER RECORD ID'))
        })),
        attendance: role === 'admin' ? clone(attendance) : [],
        attendanceSummary: clone(attendanceSummary),
        votes: role === 'admin' ? clone(votes) : [],
        voteTallies: clone(voteTallies)
      };
    },

    async getMemberVotes(recordId) {
      return {
        votes: clone(votes)
          .filter(record => record.fields['MEMBER RECORD ID'] === recordId)
          .map(record => ({
            eventId: record.fields['EVENT RECORD ID'],
            vote: record.fields.VOTE
          }))
      };
    },

    async getMember(recordId) {
      const record = records.find(item => item.id === recordId);
      return record ? clone(record) : null;
    },

    async updateMemberProfile(recordId, value) {
      const record = records.find(item => item.id === recordId);
      if (!record) return null;
      record.fields['FULL NAME'] = value.name;
      record.fields['CELL #'] = value.phone;
      record.fields['E-MAIL ADDRESS'] = value.email;
      return clone(record);
    },

    async updateMember(recordId, value) {
      const record = records.find(item => item.id === recordId);
      if (!record) return null;
      record.fields['FULL NAME'] = value.name;
      record.fields['CELL #'] = value.phone;
      record.fields['E-MAIL ADDRESS'] = value.email;
      record.fields['MEMBER #'] = value.memberNumber;
      return clone(record);
    },

    async setRsvp(recordId, eventId, value) {
      const record = records.find(item => item.id === recordId);
      const event = events.find(item => item.id === eventId);
      if (!record || !event) return null;
      record.fields[event.fields['RSVP FIELD']] = value.response;
      if (event.fields['GUEST FIELD']) record.fields[event.fields['GUEST FIELD']] = value.guests;
      return clone(record);
    },

    async setVote(recordId, eventId, vote) {
      const event = events.find(item => item.id === eventId);
      if (!event || event.fields.Status !== 'Suggested') return null;
      const existingIndex = votes.findIndex(item => (
        item.fields['MEMBER RECORD ID'] === recordId
        && item.fields['EVENT RECORD ID'] === eventId
      ));
      if (vote === null) {
        if (existingIndex >= 0) votes.splice(existingIndex, 1);
        return { deleted: existingIndex >= 0 };
      }
      if (existingIndex >= 0) {
        votes[existingIndex].fields.VOTE = vote;
        return clone(votes[existingIndex]);
      }
      const created = {
        id: `recFixtureVote${String(votes.length + 1).padStart(3, '0')}`,
        fields: {
          'MEMBER RECORD ID': recordId,
          'EVENT RECORD ID': eventId,
          VOTE: vote
        }
      };
      votes.push(created);
      return clone(created);
    },

    async submitMemberRequest(value) {
      const existing = memberRequests.find(item => (
        item.fields['SUBMITTED MEMBER #'] === value.memberNumber
        && item.fields.STATUS === 'Pending'
      ));
      if (existing) return { id: existing.id, status: 'Pending' };
      const created = {
        id: `recFixtureReqst${String(memberRequests.length + 1).padStart(2, '0')}`,
        fields: {
          'SUBMITTED NAME': value.name,
          'SUBMITTED MEMBER #': value.memberNumber,
          STATUS: 'Pending',
          'SUBMITTED DATE': '2026-08-26'
        }
      };
      memberRequests.push(created);
      return { id: created.id, status: 'Pending' };
    },

    async getMemberRequests() {
      return {
        requests: clone(memberRequests.filter(item => item.fields.STATUS === 'Pending')),
        members: clone(records)
      };
    },

    async approveMemberRequest(requestId, memberId) {
      const request = memberRequests.find(item => item.id === requestId);
      const member = records.find(item => item.id === memberId);
      if (!request || !member) return null;
      member.fields['MEMBER #'] = request.fields['SUBMITTED MEMBER #'];
      request.fields.STATUS = 'Approved';
      request.fields['LINKED MEMBER ID'] = memberId;
      return { id: requestId, status: 'Approved', memberId };
    },

    async rejectMemberRequest(requestId) {
      const request = memberRequests.find(item => item.id === requestId);
      if (!request) return null;
      request.fields.STATUS = 'Rejected';
      return { id: requestId, status: 'Rejected' };
    },

    async getMemberNumberDiagnostics() {
      const withNumber = records.filter(item => Number.isSafeInteger(item.fields['MEMBER #'])).length;
      return {
        totalInDirectory: records.length,
        withNumber,
        missingNumber: records.length - withNumber
      };
    },

    async updateEvent(eventId, value) {
      const event = events.find(item => item.id === eventId);
      if (!event) return null;
      event.fields['EVENT NAME'] = value.name;
      event.fields.DATE = value.date || null;
      event.fields.SPEAKER = value.speaker;
      event.fields.TIME = value.time;
      event.fields.ROOM = value.room;
      if (value.location !== undefined) event.fields.LOCATION = value.location;
      event.fields.NOTES = value.notes;
      if (value.status === 'Scheduled' && typeof event.fields['RSVP FIELD'] !== 'string') {
        const mapping = await buildEventFieldMapping({
          date: value.date,
          name: value.name,
          idempotencyKey: eventId
        });
        event.fields['RSVP FIELD'] = mapping.rsvpField;
        event.fields['GUEST FIELD'] = mapping.guestField;
        memberFields.push({ id: `fldFixtureRsvp${memberFields.length + 1}`, name: mapping.rsvpField, type: 'singleSelect' });
        memberFields.push({ id: `fldFixtureGuest${memberFields.length + 1}`, name: mapping.guestField, type: 'number' });
        for (const record of records) {
          record.fields[mapping.rsvpField] = 'NO RESPONSE';
          record.fields[mapping.guestField] = 0;
        }
      }
      event.fields.Status = value.status;
      event.fields['SETUP STATE'] = 'ready';
      return clone(event);
    },

    async uploadMemberPhoto(memberId, value) {
      const member = records.find(item => item.id === memberId);
      if (!member) return null;
      member.fields.PHOTO = attachment(value.filename);
      return clone(member);
    },

    async uploadEventPhoto(eventId, value) {
      const event = events.find(item => item.id === eventId);
      if (!event) return null;
      event.fields['SPEAKER PHOTO'] = attachment(value.filename);
      return clone(event);
    },

    async clearEventPhoto(eventId) {
      const event = events.find(item => item.id === eventId);
      if (!event) return null;
      event.fields['SPEAKER PHOTO'] = [];
      return clone(event);
    },

    async addEventPhoto(session, eventId, value) {
      const member = records.find(item => item.id === session.sub);
      const created = {
        id: `recFixturePhoto${String(photos.length + 1).padStart(2, '0')}`,
        fields: {
          'EVENT RECORD ID': eventId,
          'MEMBER RECORD ID': member ? session.sub : '',
          'MEMBER NAME': member?.fields['FULL NAME'] || 'ADMIN',
          PHOTO: attachment(value.filename),
          CAPTION: value.caption
        }
      };
      photos.push(created);
      return clone(created);
    },

    async deletePhoto(photoId) {
      const index = photos.findIndex(item => item.id === photoId);
      if (index >= 0) photos.splice(index, 1);
      return { id: photoId, deleted: index >= 0 };
    },

    async updatePhotoCaption(photoId, caption) {
      const photo = photos.find(item => item.id === photoId);
      if (!photo) return null;
      photo.fields.CAPTION = caption;
      return clone(photo);
    },

    async saveAttendance(eventId, entries) {
      for (const entry of entries) {
        let record = attendance.find(item => (
          item.fields['EVENT RECORD ID'] === eventId
          && item.fields['MEMBER RECORD ID'] === entry.memberId
        ));
        if (!record) {
          record = {
            id: `recFixtureAttnd${String(attendance.length + 1).padStart(2, '0')}`,
            fields: { 'EVENT RECORD ID': eventId, 'MEMBER RECORD ID': entry.memberId }
          };
          attendance.push(record);
        }
        record.fields.ATTENDED = entry.attended;
        record.fields['ACTUAL GUESTS'] = entry.actualGuests;
      }
      return { saved: entries.length };
    },

    async createEvent(value) {
      const existing = events.find(item => item.fields['CREATION KEY'] === value.idempotencyKey);
      if (existing) return { eventId: existing.id, setupState: 'ready', resumed: true };
      const mapping = await buildEventFieldMapping(value);
      const eventId = `recFixtureEvent${String(events.length + 1).padStart(2, '0')}`;
      const fields = {
        'EVENT NAME': value.name,
        DATE: value.date,
        SPEAKER: value.speaker,
        TIME: value.time,
        ROOM: value.room,
        LOCATION: value.location,
        NOTES: value.notes,
        Status: value.status,
        'CREATION KEY': value.idempotencyKey,
        'SETUP STATE': 'ready'
      };
      if (value.status === 'Scheduled') {
        fields['RSVP FIELD'] = mapping.rsvpField;
        memberFields.push({ id: `fldFixtureRsvp${events.length + 1}`, name: mapping.rsvpField, type: 'singleSelect' });
        for (const record of records) record.fields[mapping.rsvpField] = 'NO RESPONSE';
        if (value.enableGuests) {
          fields['GUEST FIELD'] = mapping.guestField;
          memberFields.push({ id: `fldFixtureGuest${events.length + 1}`, name: mapping.guestField, type: 'number' });
          for (const record of records) record.fields[mapping.guestField] = 0;
        }
      }
      events.push({ id: eventId, fields });
      return { eventId, setupState: 'ready', resumed: false };
    }
  };
}
