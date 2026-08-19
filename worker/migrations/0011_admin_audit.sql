-- Migration 0011: an audit trail for owner actions.
--
-- The owner role is powerful by design (PRD §3.6): it can reset any non-owner
-- account's password and then sign in as that person, reading every live
-- conversation they have. That is a documented property of a self-hosted
-- instance — the operator has access — but until now it left no trace at all,
-- which makes a stolen owner session indistinguishable from the owner working.
--
-- Every mutating /api/admin/* call writes one row here. Reads do not: this is a
-- record of what changed, not of what was looked at.
--
-- `details` is a small JSON object (the fields a PATCH touched, the counts a
-- purge returned) — never message content, never a password, never a hash.
CREATE TABLE admin_audit (
  id         TEXT PRIMARY KEY,
  -- The account that performed it. Kept even if that account is later deleted:
  -- a trail that disappears with the actor is not a trail, hence no FK.
  actor_id   TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  -- Machine code: 'user.password_reset', 'user.delete', 'conversation.purge'…
  action     TEXT NOT NULL,
  -- What it was done to (an account id, a conversation id), when applicable.
  target_id  TEXT,
  target_name TEXT,
  details    TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_audit_created_at ON admin_audit(created_at);
CREATE INDEX idx_admin_audit_target ON admin_audit(target_id);
