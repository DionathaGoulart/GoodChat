-- Migration 0009: the D1 mirror of "when does the next message here expire".
--
-- The Durable Object already knows: it arms an alarm for the moment its oldest
-- surviving message ages out (agent.ts). What D1 could not answer until now is
-- the same question from the outside, and the hourly backstop needs it.
--
-- Before this column the backstop selected `last_message_at <= now -
-- retention_ms` — conversations whose *entire* history had aged out. A thread
-- that keeps receiving messages after its alarm was lost (the DO logs
-- `expiry schedule failed` and carries on) therefore held its oldest messages
-- until its newest one expired: on a 3-hour window with activity until 14h, a
-- 9h message could survive to 17h. Nearly twice what the product promises.
--
-- `next_expiry_at` is written by the DO every time it re-arms the alarm, which
-- is every sweep, every window change and every wake. NULL means "nothing left
-- to expire" — an empty conversation, or one that predates this migration and
-- has not woken since; the old whole-history rule still covers the latter, and
-- the first sweep fills the column in.
ALTER TABLE conversations ADD COLUMN next_expiry_at INTEGER;

-- The backstop scans by this column and orders by it.
CREATE INDEX idx_conversations_next_expiry ON conversations(next_expiry_at);
