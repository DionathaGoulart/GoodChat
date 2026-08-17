-- Migration 0001: core schema (PRD §4.3) + login rate limiting.
-- users / sessions / conversations exactly as the PRD data model;
-- conversations is created here but only used from phase 3 onwards.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  avatar_url    TEXT,
  password_hash TEXT,
  created_at    INTEGER
);

CREATE TABLE sessions (
  -- SHA-256 hex of the opaque cookie token, never the raw token.
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE conversations (
  -- Deterministic hash of the ordered user id pair (algorithm lands in phase 3).
  id              TEXT PRIMARY KEY,
  user_a          TEXT NOT NULL REFERENCES users(id),
  user_b          TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER,
  last_message_at INTEGER,
  CHECK (user_a < user_b)
);

CREATE UNIQUE INDEX idx_conversations_pair ON conversations(user_a, user_b);
CREATE INDEX idx_conversations_user_b ON conversations(user_b);

CREATE TABLE login_attempts (
  -- "user:<username>" or "ip:<ip>"
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
