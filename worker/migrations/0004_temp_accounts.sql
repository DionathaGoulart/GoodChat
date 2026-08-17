-- Migration 0004: temporary (guest) accounts and account tombstones.
--
-- A temporary account is a real account with an expiry: `is_temp = 1` and
-- `expires_at` set at creation. Once it passes, requireSession refuses it on
-- the spot and the hourly sweep (lib/cleanup.ts) tears it down.
--
-- Tearing an account down cannot mean `DELETE FROM users`: the other side of a
-- conversation keeps its history, `conversations` has foreign keys into
-- `users`, and the conversation list JOINs the peer row to name the thread.
-- So a deleted account leaves a tombstone — the row stays, stripped of every
-- credential and personal field, with `deleted_at` set. Nothing can log into
-- it, nobody can find it, and it exists only to keep the surviving side's
-- history readable ("conta expirada" in the UI).
--
-- The row is hard-deleted the moment it is unreferenced: no conversations and
-- no media objects left (lib/accounts.ts, and the tombstone sweep for rows
-- that become orphaned later).

ALTER TABLE users ADD COLUMN is_temp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN expires_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;

-- Drives the expiry sweep: temp accounts ordered by when they run out.
CREATE INDEX idx_users_expires_at ON users(expires_at) WHERE expires_at IS NOT NULL;
-- Drives the tombstone sweep and the "is this peer gone?" checks.
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;
