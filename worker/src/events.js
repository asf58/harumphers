import { ApiError } from './errors.js';

const encoder = new TextEncoder();

export function classifyRsvp(value) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'YES') return 'yes';
  if (normalized === 'NO') return 'no';
  if (normalized === 'MAYBE') return 'maybe';
  if (normalized === '' || normalized === 'NO RESPONSE') return 'pending';
  return 'unknown';
}

function asciiSlug(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'EVENT';
}

async function shortHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export async function buildEventFieldMapping({ date, name, idempotencyKey }) {
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
    throw new ApiError(400, 'VALIDATION_FAILED', 'An event creation key is required.');
  }
  const hash = await shortHash(idempotencyKey);
  const dateSlug = asciiSlug(date).replaceAll('-', '').slice(0, 8);
  const nameSlug = asciiSlug(name);
  const suffix = `-${hash}`;
  const maxBaseLength = Math.min(
    64 - ' RSVP'.length,
    64 - 'GUESTS-'.length
  );
  const prefix = `${dateSlug}-${nameSlug}`.slice(0, maxBaseLength - suffix.length).replace(/-+$/, '');
  const base = `${prefix}${suffix}`;
  return {
    rsvpField: `${base} RSVP`,
    guestField: `GUESTS-${base}`
  };
}

export function resolveEventFields(eventRecord, metadata) {
  if (!eventRecord?.fields || !Array.isArray(metadata)) {
    throw new ApiError(409, 'EVENT_MAPPING_MISSING', 'The event field mapping is incomplete.');
  }
  const rsvpName = eventRecord.fields['RSVP FIELD'];
  const guestName = eventRecord.fields['GUEST FIELD'];
  if (typeof rsvpName !== 'string' || rsvpName === '') {
    throw new ApiError(409, 'EVENT_MAPPING_MISSING', 'The event field mapping is incomplete.');
  }
  const rsvpField = metadata.find(field => field.name === rsvpName);
  const guestField = guestName ? metadata.find(field => field.name === guestName) : null;
  if (!rsvpField || (guestName && !guestField)) {
    throw new ApiError(409, 'EVENT_MAPPING_MISSING', 'The event field mapping is incomplete.');
  }
  if (rsvpField.type !== 'singleSelect' || (guestField && guestField.type !== 'number')) {
    throw new ApiError(409, 'FIELD_TYPE_CONFLICT', 'An event field has an incompatible type.');
  }
  return { rsvpField, guestField };
}

function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  return /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

export async function createEventWithAdapter(adapter, input) {
  const mapping = await buildEventFieldMapping(input);
  let event = await adapter.findEventByCreationKey(input.idempotencyKey);
  const resumed = Boolean(event);
  if (event?.fields?.['SETUP STATE'] === 'ready') {
    return { eventId: event.id, setupState: 'ready', resumed: true };
  }

  const baseFields = {
    'EVENT NAME': input.name,
    DATE: input.date || undefined,
    SPEAKER: input.speaker || undefined,
    TIME: input.time || undefined,
    ROOM: input.room || undefined,
    LOCATION: input.location || undefined,
    NOTES: input.notes || undefined,
    Status: input.status,
    'CREATION KEY': input.idempotencyKey,
    'SETUP STATE': 'creating',
    ...(input.status === 'Scheduled' ? {
      'RSVP FIELD': mapping.rsvpField,
      ...(input.enableGuests ? { 'GUEST FIELD': mapping.guestField } : {})
    } : {})
  };

  try {
    if (!event) {
      event = await adapter.createEventRecord(baseFields);
    } else {
      event = await adapter.patchEventRecord(event.id, baseFields);
    }
    if (input.status === 'Scheduled') {
      await adapter.ensureMemberField(mapping.rsvpField, 'singleSelect');
      if (input.enableGuests) await adapter.ensureMemberField(mapping.guestField, 'number');
    }
    await adapter.patchEventRecord(event.id, { 'SETUP STATE': 'ready', Status: input.status });
    return { eventId: event.id, setupState: 'ready', resumed };
  } catch (error) {
    if (event?.id) {
      try {
        await adapter.patchEventRecord(event.id, { 'SETUP STATE': `failed:${failureCode(error)}` });
      } catch {
        // The original bounded setup failure remains the public result.
      }
    }
    throw new ApiError(502, 'SETUP_FAILED', 'The event setup did not finish. Retry to resume it.');
  }
}
