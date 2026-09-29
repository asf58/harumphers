import { hashPin } from '../../worker/src/pin.js';
import { createTestD1, createTestKv } from '../helpers/cloudflare-bindings.mjs';

// Sign-ins for the D1-backed local model: member number, and PIN where the member is an admin.
export const D1_FIXTURE = Object.freeze({
  superAdmin: { memberNumber: 90001, pin: '1111' },
  admin: { memberNumber: 90002, pin: '2222' },
  member: { memberNumber: 90003 }
});

export async function createSeededD1() {
  const DB = await createTestD1();
  DB.sqlite.exec(`
    INSERT INTO members (id, full_name, last_name, cell, email, member_number, in_directory, role, pin_hash) VALUES
      ('recFixtureSuper01', 'SAM SUPERVISOR', 'SUPERVISOR', '(412) 555-0001', 'sam@example.test', '90001', 1, 'super_admin', '${await hashPin(D1_FIXTURE.superAdmin.pin)}'),
      ('recFixtureAdmin02', 'ANN ORGANIZER', 'ORGANIZER', '(412) 555-0002', 'ann@example.test', '90002', 1, 'admin', '${await hashPin(D1_FIXTURE.admin.pin)}'),
      ('recFixtureMembr03', 'MAX MEMBER', 'MEMBER', '(412) 555-0003', 'max@example.test', '90003', 1, 'member', NULL),
      ('recFixtureMembr04', 'NATE NORESPONSE', 'NORESPONSE', '(412) 555-0004', 'nate@example.test', '90004', 1, 'member', NULL),
      ('recFixtureHidden5', 'HANK HIDDEN', 'HIDDEN', '', '', NULL, 0, 'member', NULL);
    INSERT INTO member_private (member_id, home_address, notes) VALUES
      ('recFixtureMembr03', '1 Fixture Way, Pittsburgh PA', 'Brings two guests most nights');
    INSERT INTO member_event_fields (name, type, choices_json) VALUES
      ('OCT-SPEAKER RSVP', 'singleSelect', '["YES","NO","MAYBE"]'), ('GUESTS-OCT-SPEAKER', 'number', '[]');
    INSERT INTO member_event_values (member_id, field_name, value) VALUES
      ('recFixtureMembr03', 'OCT-SPEAKER RSVP', '"YES"'), ('recFixtureMembr03', 'GUESTS-OCT-SPEAKER', '2'),
      ('recFixtureAdmin02', 'OCT-SPEAKER RSVP', '"MAYBE"');
    INSERT INTO events (id, name, date, status, rsvp_field, guest_field, setup_state) VALUES
      ('recFixtureEvent01', 'October Speaker', '2026-10-20', 'Scheduled', 'OCT-SPEAKER RSVP', 'GUESTS-OCT-SPEAKER', 'ready');
  `);
  return { DB, PHOTOS: createTestKv() };
}
