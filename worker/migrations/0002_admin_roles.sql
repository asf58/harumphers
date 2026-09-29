-- Admin levels, per-admin PINs, private member notes, and an audit trail.
-- members.role replaces is_admin as the source of truth; is_admin is left in place unused.

ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
  CHECK (role IN ('member', 'admin', 'super_admin'));
-- PBKDF2-SHA256 hash of the admin's PIN: pbkdf2$<iterations>$<salt b64url>$<hash b64url>.
ALTER TABLE members ADD COLUMN pin_hash TEXT;
ALTER TABLE members ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN pin_locked_until TEXT;
ALTER TABLE members ADD COLUMN last_login_at TEXT;

UPDATE members SET role = 'admin' WHERE is_admin = 1;

-- Admin-only details that never appear in the directory or events data.
CREATE TABLE member_private (
  member_id TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  home_address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at ON audit_log (at);
