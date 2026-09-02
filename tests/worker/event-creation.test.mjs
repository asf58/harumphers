import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventWithAdapter } from '../../worker/src/events.js';

const INPUT = {
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  name: 'Fixture Event',
  date: '2026-09-12',
  speaker: 'Fixture Speaker',
  time: '6:00 PM',
  room: 'Fixture Hall',
  notes: '',
  status: 'Scheduled',
  enableGuests: true
};

function makeAdapter({ failRsvpOnce = false } = {}) {
  const events = [];
  const fields = new Map();
  const calls = [];
  let shouldFailRsvp = failRsvpOnce;
  return {
    calls,
    events,
    async findEventByCreationKey(key) {
      calls.push(['find', key]);
      return events.find(event => event.fields['CREATION KEY'] === key) ?? null;
    },
    async createEventRecord(value) {
      calls.push(['create', value]);
      const event = { id: 'recFixtureEvent01', fields: structuredClone(value) };
      events.push(event);
      return structuredClone(event);
    },
    async ensureMemberField(name, type) {
      calls.push(['field', name, type]);
      if (shouldFailRsvp && type === 'singleSelect') {
        shouldFailRsvp = false;
        const error = new Error('fixture field failure');
        error.code = 'UPSTREAM_FAILED';
        throw error;
      }
      const existing = fields.get(name);
      if (existing && existing !== type) {
        const error = new Error('fixture conflict');
        error.code = 'FIELD_TYPE_CONFLICT';
        throw error;
      }
      fields.set(name, type);
    },
    async patchEventRecord(id, value) {
      calls.push(['patch', id, value]);
      const event = events.find(item => item.id === id);
      Object.assign(event.fields, value);
      return structuredClone(event);
    }
  };
}

test('duplicate event creation requests return one ready event', async () => {
  const adapter = makeAdapter();
  const first = await createEventWithAdapter(adapter, INPUT);
  const second = await createEventWithAdapter(adapter, INPUT);

  assert.deepEqual(first, { eventId: 'recFixtureEvent01', setupState: 'ready', resumed: false });
  assert.deepEqual(second, { eventId: 'recFixtureEvent01', setupState: 'ready', resumed: true });
  assert.equal(adapter.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(adapter.events[0].fields['SETUP STATE'], 'ready');
});

test('a retry resumes the same event after a field-creation failure', async () => {
  const adapter = makeAdapter({ failRsvpOnce: true });

  await assert.rejects(
    () => createEventWithAdapter(adapter, INPUT),
    error => error.code === 'SETUP_FAILED'
  );
  assert.match(adapter.events[0].fields['SETUP STATE'], /^failed:/);

  const resumed = await createEventWithAdapter(adapter, INPUT);
  assert.deepEqual(resumed, { eventId: 'recFixtureEvent01', setupState: 'ready', resumed: true });
  assert.equal(adapter.calls.filter(call => call[0] === 'create').length, 1);
});

test('incompatible existing fields fail closed and never mark the event ready', async () => {
  const adapter = makeAdapter();
  const first = await createEventWithAdapter(adapter, { ...INPUT, enableGuests: false });
  assert.equal(first.setupState, 'ready');

  const conflicting = makeAdapter();
  const originalEnsure = conflicting.ensureMemberField;
  conflicting.ensureMemberField = async (name, type) => {
    if (type === 'singleSelect') {
      const error = new Error('fixture conflict');
      error.code = 'FIELD_TYPE_CONFLICT';
      throw error;
    }
    return originalEnsure(name, type);
  };
  await assert.rejects(
    () => createEventWithAdapter(conflicting, INPUT),
    error => error.code === 'SETUP_FAILED'
  );
  assert.notEqual(conflicting.events[0].fields['SETUP STATE'], 'ready');
});
