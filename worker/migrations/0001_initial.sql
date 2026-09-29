-- Harumphers D1 schema. Record ids keep the Airtable format (rec + 14 characters)
-- so migrated ids, API routes, and client state carry over unchanged.

CREATE TABLE members (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  full_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  cell TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  member_number TEXT,
  in_directory INTEGER NOT NULL DEFAULT 0 CHECK (in_directory IN (0, 1)),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  -- Airtable columns the app does not use, preserved verbatim from the import.
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX members_directory_order ON members (in_directory, last_name, full_name);
CREATE INDEX members_member_number ON members (member_number);

CREATE TABLE events (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  name TEXT NOT NULL DEFAULT '',
  date TEXT,
  speaker TEXT,
  time TEXT,
  room TEXT,
  location TEXT,
  notes TEXT,
  status TEXT,
  rsvp_field TEXT,
  guest_field TEXT,
  creation_key TEXT UNIQUE,
  setup_state TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-event RSVP and guest-count columns, as Airtable modelled them on the member table.
-- Several legacy events share one guest column, so values are keyed by column name.
CREATE TABLE member_event_fields (
  name TEXT PRIMARY KEY,
  -- Airtable's field type, kept verbatim: a few legacy " RSVP" columns are numbers or text.
  type TEXT NOT NULL,
  choices_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE member_event_values (
  member_id TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  field_name TEXT NOT NULL REFERENCES member_event_fields (name) ON DELETE CASCADE,
  value TEXT NOT NULL, -- JSON: "YES", 2, or a legacy formula result
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (member_id, field_name)
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  event_id TEXT NOT NULL,
  member_id TEXT,
  member_name TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  submitted TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX photos_event ON photos (event_id);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  event_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  attended INTEGER NOT NULL DEFAULT 0 CHECK (attended IN (0, 1)),
  actual_guests INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, member_id)
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  event_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('UP', 'DOWN')),
  UNIQUE (event_id, member_id)
);

CREATE TABLE member_requests (
  id TEXT PRIMARY KEY CHECK (id GLOB 'rec[A-Za-z0-9]*' AND length(id) = 17),
  submitted_name TEXT NOT NULL,
  submitted_member_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected')),
  submitted_date TEXT,
  linked_member_id TEXT
);
CREATE INDEX member_requests_pending ON member_requests (status, submitted_member_number);

-- Image metadata; the bytes live in the PHOTOS KV namespace under the same id.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY CHECK (id GLOB 'att[A-Za-z0-9]*' AND length(id) = 17),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('member', 'speaker', 'event_photo')),
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX attachments_owner ON attachments (owner_kind, owner_id, position);

