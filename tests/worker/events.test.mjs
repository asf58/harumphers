import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEventFieldMapping, classifyRsvp, resolveEventFields } from '../../worker/src/events.js';

test('RSVP values use exact normalized classification', () => {
  const cases = new Map([
    ['YES', 'yes'],
    [' yes ', 'yes'],
    ['NO', 'no'],
    ['MAYBE', 'maybe'],
    ['NO RESPONSE', 'pending'],
    ['', 'pending'],
    [null, 'pending'],
    ['NOT ATTENDING', 'unknown']
  ]);

  for (const [input, expected] of cases) {
    assert.equal(classifyRsvp(input), expected, String(input));
  }
});

test('event field mappings are deterministic, bounded, and collision-resistant', async () => {
  const first = await buildEventFieldMapping({
    date: '2026-09-12',
    name: 'Pirates & Community Leadership!',
    idempotencyKey: '00000000-0000-4000-8000-000000000001'
  });
  const repeat = await buildEventFieldMapping({
    date: '2026-09-12',
    name: 'Pirates & Community Leadership!',
    idempotencyKey: '00000000-0000-4000-8000-000000000001'
  });
  const collision = await buildEventFieldMapping({
    date: '2026-09-12',
    name: 'Pirates & Community Leadership!',
    idempotencyKey: '00000000-0000-4000-8000-000000000002'
  });

  assert.deepEqual(first, repeat);
  assert.notDeepEqual(first, collision);
  assert.match(first.rsvpField, /^[A-Z0-9-]+ RSVP$/);
  assert.match(first.guestField, /^GUESTS-[A-Z0-9-]+$/);
  assert.ok(first.rsvpField.length <= 64);
  assert.ok(first.guestField.length <= 64);
});

test('event mappings resolve only exact compatible field metadata', () => {
  const event = {
    fields: {
      'RSVP FIELD': 'SEP12-FIXTURE-1A2B3C4D RSVP',
      'GUEST FIELD': 'GUESTS-SEP12-FIXTURE-1A2B3C4D'
    }
  };
  const metadata = [
    { id: 'fldRsvp', name: 'SEP12-FIXTURE-1A2B3C4D RSVP', type: 'singleSelect' },
    { id: 'fldGuest', name: 'GUESTS-SEP12-FIXTURE-1A2B3C4D', type: 'number' }
  ];

  assert.deepEqual(resolveEventFields(event, metadata), {
    rsvpField: metadata[0],
    guestField: metadata[1]
  });
  assert.throws(
    () => resolveEventFields(event, [{ ...metadata[0], type: 'multilineText' }, metadata[1]]),
    error => error.code === 'FIELD_TYPE_CONFLICT'
  );
});
