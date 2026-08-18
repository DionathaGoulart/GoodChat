-- Migration 0008: per-conversation message retention.
--
-- The product is privacy, not an archive: every message dies on its own clock.
-- `retention_ms` is how long a message in this conversation is allowed to live,
-- counted from its own created_at — not from the conversation's activity. Both
-- participants share one value and either of them can change it (PRD §3.9).
--
-- The Durable Object is the source of truth (it holds the messages and runs the
-- alarm that deletes them). This column is the D1 mirror, and it exists for the
-- two things that happen outside the DO: the resolve endpoint, which has to
-- tell the client the window before a socket is even open, and the scheduled
-- cleanup, which sweeps bucket objects whose conversation nobody has opened in
-- a while (lib/cleanup.ts).
--
-- Default = maximum = 7 days. Anything shorter is a deliberate choice made in
-- the conversation; nothing may be kept longer.
ALTER TABLE conversations ADD COLUMN retention_ms INTEGER NOT NULL DEFAULT 604800000;

-- When the backstop last made this conversation empty itself. It exists so the
-- sweep does not re-poke the same idle conversations on every tick: a row whose
-- `swept_at` is newer than its `last_message_at` has nothing left to delete.
ALTER TABLE conversations ADD COLUMN swept_at INTEGER;

-- The backstop scans "conversations whose newest message is already past the
-- window", which is a comparison against last_message_at.
CREATE INDEX idx_conversations_retention ON conversations(last_message_at);
