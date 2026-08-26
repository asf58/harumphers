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
  return {
    async findMemberByNumber(memberNumber) {
      const record = DIRECTORY_RECORDS.find(item => item.fields['MEMBER #'] === memberNumber);
      return record ? clone(record) : null;
    },

    async getDirectory(role) {
      const records = DIRECTORY_RECORDS.map(record => {
        const fields = {
          'FULL NAME': record.fields['FULL NAME'],
          'LAST NAME': record.fields['LAST NAME'],
          'CELL #': record.fields['CELL #'],
          'E-MAIL ADDRESS': record.fields['E-MAIL ADDRESS'],
          PHOTO: []
        };
        if (role === 'admin') {
          fields['IS ADMIN'] = record.fields['IS ADMIN'];
          fields['MEMBER #'] = record.fields['MEMBER #'];
        }
        return { id: record.id, fields };
      });
      return { records: clone(records) };
    },

    async getEventsBootstrap(role) {
      const members = DIRECTORY_RECORDS.map(record => {
        const fields = clone(record.fields);
        if (role !== 'admin') {
          delete fields['MEMBER #'];
          delete fields['IS ADMIN'];
        }
        return { id: record.id, fields };
      });
      return {
        events: clone(EVENTS),
        members,
        memberFields: clone(MEMBER_FIELDS),
        photos: [],
        attendance: [],
        votes: []
      };
    },

    async getMember(recordId) {
      const record = DIRECTORY_RECORDS.find(item => item.id === recordId);
      return record ? clone(record) : null;
    }
  };
}

