-- Migration 0003: per-account settings, the owner role hierarchy, and the
-- media object index.
--
-- `theme` is the account-level default picked in the settings screen (NULL =
-- follow the OS preference). `role` gates /api/admin/*; `created_by` records
-- who provisioned an account so the owner sees its own hierarchy. Disabling an
-- account is a soft delete: requireSession rejects it, so every live session
-- dies on the next request without touching the sessions table.

ALTER TABLE users ADD COLUMN theme TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

CREATE INDEX idx_users_created_by ON users(created_by);
CREATE INDEX idx_users_role ON users(role);

-- The instance owner. Usernames are canonical lowercase (scripts/lib.ts), and
-- the column is COLLATE NOCASE, so this matches "good" however it was typed.
-- A no-op on instances without that account — grant it with
-- `npm run user:role -- [--remote] <username> owner`.
UPDATE users SET role = 'owner' WHERE username = 'good';

-- Index of every object the Worker ever presigned. Three jobs:
--   1. authorization — /api/media/<key> can check conversation membership
--      instead of trusting an unguessable key (routes/media.ts);
--   2. accounting — bytes per account for the owner panel, without listing
--      the bucket;
--   3. garbage collection — a row with claimed_at IS NULL past the TTL is an
--      upload whose message never landed, so the object is unreachable.
-- `size` is the signed Content-Length: B2 rejects a PUT whose body differs,
-- so the declared size is the stored size.
CREATE TABLE media_objects (
  key             TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Set when the message referencing this key is persisted by the DO.
  conversation_id TEXT,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  claimed_at      INTEGER
);

CREATE INDEX idx_media_objects_user ON media_objects(user_id);
CREATE INDEX idx_media_objects_conversation ON media_objects(conversation_id);
-- Drives the orphan sweep: unclaimed rows ordered by age.
CREATE INDEX idx_media_objects_unclaimed ON media_objects(claimed_at, created_at);
