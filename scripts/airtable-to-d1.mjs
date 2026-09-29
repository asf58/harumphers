// One-time Airtable → Cloudflare D1/KV migration.
//
//   AIRTABLE_TOKEN=… node scripts/airtable-to-d1.mjs export --base=appXXXX --out=/private/dir
//   node scripts/airtable-to-d1.mjs build --out=/private/dir
//
// export writes snapshot.json plus every attachment file (a complete, restorable copy of the base).
// build writes import.sql (replaces all D1 rows) and kv-bulk.json (images for `wrangler kv bulk put`).
// The output holds member contact data: keep it outside the repository.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api.airtable.com/v0';
const TABLES = {
  members: 'tbltzPyERz9wGE0zd',
  events: 'tblzPscL5Q2a2SZk1',
  photos: 'tblTQM3DY7BAqs9BL',
  attendance: 'tbloa1qulpNHKkFNk',
  votes: 'tblnpBxZ7N6X7004t',
  memberRequests: 'tblz8NLFYE7XsOhrR'
};
const COMPUTED_TYPES = new Set(['formula', 'rollup', 'count', 'lookup', 'multipleLookupValues', 'aiText', 'autoNumber', 'createdTime', 'lastModifiedTime', 'button']);
const MEMBER_COLUMNS = ['FULL NAME', 'LAST NAME', 'CELL #', 'E-MAIL ADDRESS', 'MEMBER #', 'IN DIRECTORY', 'IS ADMIN', 'PHOTO'];
const EVENT_COLUMNS = {
  'EVENT NAME': 'name', DATE: 'date', SPEAKER: 'speaker', TIME: 'time', ROOM: 'room', LOCATION: 'location',
  NOTES: 'notes', Status: 'status', 'RSVP FIELD': 'rsvp_field', 'GUEST FIELD': 'guest_field',
  'CREATION KEY': 'creation_key', 'SETUP STATE': 'setup_state'
};
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const ATTACHMENT_ID = /^att[A-Za-z0-9]{14}$/;

const args = Object.fromEntries(process.argv.slice(3).map(value => {
  const [name, ...rest] = value.replace(/^--/, '').split('=');
  return [name, rest.join('=')];
}));
const outDir = path.resolve(args.out ?? '');
if (!args.out) throw new Error('--out=<directory> is required.');

const isRsvpField = name => name.toUpperCase().endsWith(' RSVP');
const isGuestField = name => name.toUpperCase().startsWith('GUESTS-');

async function airtable(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt === 3) {
      throw new Error(`Airtable ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

async function exportBase() {
  if (!process.env.AIRTABLE_TOKEN || !args.base) throw new Error('AIRTABLE_TOKEN and --base are required.');
  const base = encodeURIComponent(args.base);
  const { tables } = await airtable(`${API}/meta/bases/${base}/tables`);
  const snapshot = { base: args.base, exportedAt: new Date().toISOString(), schema: {}, records: {} };
  let calls = 1;
  for (const [key, tableId] of Object.entries(TABLES)) {
    const table = tables.find(item => item.id === tableId);
    if (!table) throw new Error(`Table ${key} (${tableId}) is missing from the base.`);
    snapshot.schema[key] = table.fields.map(field => ({ name: field.name, type: field.type, options: field.options ?? null }));
    const records = [];
    let offset;
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      if (offset) params.set('offset', offset);
      const page = await airtable(`${API}/${base}/${tableId}?${params}`);
      calls += 1;
      records.push(...page.records);
      offset = page.offset;
    } while (offset);
    snapshot.records[key] = records;
  }

  await mkdir(path.join(outDir, 'files'), { recursive: true });
  let downloaded = 0;
  for (const records of Object.values(snapshot.records)) {
    for (const record of records) {
      for (const value of Object.values(record.fields)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          if (!ATTACHMENT_ID.test(item?.id ?? '') || typeof item.url !== 'string') continue;
          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Attachment ${item.id} download failed: ${response.status}`);
          await writeFile(path.join(outDir, 'files', item.id), Buffer.from(await response.arrayBuffer()));
          downloaded += 1;
        }
      }
    }
  }
  await writeFile(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  const counts = Object.fromEntries(Object.entries(snapshot.records).map(([key, records]) => [key, records.length]));
  console.log(JSON.stringify({ airtableApiCalls: calls, attachmentsDownloaded: downloaded, counts }, null, 2));
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insert(table, row) {
  const columns = Object.keys(row);
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(column => sql(row[column])).join(', ')});`;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value);
  return result === '' ? null : result;
}

async function build() {
  const snapshot = JSON.parse(await readFile(path.join(outDir, 'snapshot.json'), 'utf8'));
  const statements = [
    // Children first so foreign keys never block the replace.
    'DELETE FROM member_event_values;', 'DELETE FROM member_event_fields;', 'DELETE FROM attachments;',
    'DELETE FROM photos;', 'DELETE FROM attendance;', 'DELETE FROM votes;', 'DELETE FROM member_requests;',
    'DELETE FROM events;', 'DELETE FROM members;'
  ];
  const kv = [];
  const skipped = [];
  const attachmentRows = (kind, ownerId, value) => (Array.isArray(value) ? value : []).flatMap((item, position) => {
    if (!ATTACHMENT_ID.test(item?.id ?? '')) return [];
    kv.push(item);
    return [insert('attachments', {
      id: item.id, owner_kind: kind, owner_id: ownerId, filename: String(item.filename ?? item.id).slice(0, 160),
      content_type: item.type ?? 'application/octet-stream', size: item.size ?? 0,
      width: item.width ?? null, height: item.height ?? null, position
    })];
  });
  const extras = (schema, fields, known) => JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([name]) => {
    const field = schema.find(item => item.name === name);
    return !known(name) && field && !COMPUTED_TYPES.has(field.type) && field.type !== 'multipleAttachments';
  })));

  const memberSchema = snapshot.schema.members;
  const eventFields = memberSchema.filter(field => isRsvpField(field.name) || isGuestField(field.name));
  const eventFieldTypes = new Map();
  for (const field of eventFields) {
    const type = field.type;
    eventFieldTypes.set(field.name, type);
    const choices = (field.options?.choices ?? []).map(choice => choice.name);
    statements.push(insert('member_event_fields', {
      name: field.name, type, choices_json: JSON.stringify(type === 'singleSelect' && choices.length === 0 ? ['YES', 'NO', 'MAYBE'] : choices)
    }));
  }

  for (const record of snapshot.records.members) {
    const f = record.fields;
    statements.push(insert('members', {
      id: record.id, full_name: text(f['FULL NAME']) ?? '', last_name: text(f['LAST NAME']) ?? '',
      cell: text(f['CELL #']) ?? '', email: text(f['E-MAIL ADDRESS']) ?? '', member_number: text(f['MEMBER #']),
      in_directory: f['IN DIRECTORY'] === true, is_admin: f['IS ADMIN'] === true,
      extra_json: extras(memberSchema, f, name => MEMBER_COLUMNS.includes(name) || eventFieldTypes.has(name)),
      created_at: record.createdTime
    }));
    statements.push(...attachmentRows('member', record.id, f.PHOTO));
    for (const [name, type] of eventFieldTypes) {
      const value = f[name];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'object' || (type === 'number' && !Number.isFinite(Number(value)))) {
        skipped.push(`member ${record.id} ${name}=${JSON.stringify(value)}`);
        continue;
      }
      statements.push(insert('member_event_values', { member_id: record.id, field_name: name, value: JSON.stringify(value) }));
    }
  }

  const seenCreationKeys = new Set();
  for (const record of snapshot.records.events) {
    const row = { id: record.id, created_at: record.createdTime };
    for (const [name, column] of Object.entries(EVENT_COLUMNS)) row[column] = text(record.fields[name]);
    row.name ??= '';
    if (row.creation_key && seenCreationKeys.has(row.creation_key)) {
      skipped.push(`event ${record.id} duplicate CREATION KEY cleared`);
      row.creation_key = null;
    }
    if (row.creation_key) seenCreationKeys.add(row.creation_key);
    row.extra_json = extras(snapshot.schema.events, record.fields, name => name in EVENT_COLUMNS);
    statements.push(insert('events', row));
    statements.push(...attachmentRows('speaker', record.id, record.fields['SPEAKER PHOTO']));
  }

  for (const record of snapshot.records.photos) {
    const f = record.fields;
    if (!RECORD_ID.test(f['EVENT RECORD ID'] ?? '')) {
      skipped.push(`photo ${record.id} has no event`);
      continue;
    }
    statements.push(insert('photos', {
      id: record.id, event_id: f['EVENT RECORD ID'], member_id: RECORD_ID.test(f['MEMBER RECORD ID'] ?? '') ? f['MEMBER RECORD ID'] : null,
      member_name: text(f['MEMBER NAME']) ?? '', caption: text(f.CAPTION) ?? '', submitted: text(f.SUBMITTED),
      created_at: record.createdTime
    }));
    statements.push(...attachmentRows('event_photo', record.id, f.PHOTO));
  }

  // Later records win when Airtable holds duplicates for one member and event.
  const latestByPair = (records, label) => {
    const byPair = new Map();
    for (const record of [...records].sort((a, b) => a.createdTime.localeCompare(b.createdTime))) {
      const eventId = record.fields['EVENT RECORD ID'];
      const memberId = record.fields['MEMBER RECORD ID'];
      if (!RECORD_ID.test(eventId ?? '') || !RECORD_ID.test(memberId ?? '')) {
        skipped.push(`${label} ${record.id} missing ids`);
        continue;
      }
      if (byPair.has(`${eventId}|${memberId}`)) skipped.push(`${label} ${byPair.get(`${eventId}|${memberId}`).id} superseded by ${record.id}`);
      byPair.set(`${eventId}|${memberId}`, record);
    }
    return [...byPair.values()];
  };
  for (const record of latestByPair(snapshot.records.attendance, 'attendance')) {
    const f = record.fields;
    statements.push(insert('attendance', {
      id: record.id, event_id: f['EVENT RECORD ID'], member_id: f['MEMBER RECORD ID'],
      attended: f.ATTENDED === true, actual_guests: Number.isSafeInteger(f['ACTUAL GUESTS']) ? f['ACTUAL GUESTS'] : 0
    }));
  }
  for (const record of latestByPair(snapshot.records.votes, 'vote')) {
    const vote = record.fields.VOTE;
    if (vote !== 'UP' && vote !== 'DOWN') {
      skipped.push(`vote ${record.id} value ${JSON.stringify(vote)}`);
      continue;
    }
    statements.push(insert('votes', {
      id: record.id, event_id: record.fields['EVENT RECORD ID'], member_id: record.fields['MEMBER RECORD ID'], vote
    }));
  }
  for (const record of snapshot.records.memberRequests) {
    const f = record.fields;
    if (!Number.isSafeInteger(f['SUBMITTED MEMBER #']) || !['Pending', 'Approved', 'Rejected'].includes(f.STATUS)) {
      skipped.push(`member request ${record.id} incomplete`);
      continue;
    }
    statements.push(insert('member_requests', {
      id: record.id, submitted_name: text(f['SUBMITTED NAME']) ?? '', submitted_member_number: f['SUBMITTED MEMBER #'],
      status: f.STATUS, submitted_date: text(f['SUBMITTED DATE']), linked_member_id: text(f['LINKED MEMBER ID'])
    }));
  }

  const bulk = [];
  for (const item of kv) {
    const bytes = await readFile(path.join(outDir, 'files', item.id));
    bulk.push({ key: item.id, value: bytes.toString('base64'), base64: true, metadata: { contentType: item.type ?? 'application/octet-stream' } });
  }
  await writeFile(path.join(outDir, 'import.sql'), `${statements.join('\n')}\n`);
  await writeFile(path.join(outDir, 'kv-bulk.json'), JSON.stringify(bulk));
  console.log(JSON.stringify({
    statements: statements.length,
    images: bulk.length,
    eventFields: eventFieldTypes.size,
    counts: Object.fromEntries(Object.entries(snapshot.records).map(([key, records]) => [key, records.length])),
    skipped
  }, null, 2));
}

const command = process.argv[2];
if (command === 'export') await exportBase();
else if (command === 'build') await build();
else throw new Error('Usage: airtable-to-d1.mjs export|build --out=<dir> [--base=<id>]');
