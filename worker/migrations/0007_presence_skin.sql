-- Migration 0007: presence (who is online) and the skin choice.
--
-- `last_seen_at` is the whole presence model: the client heartbeats while the
-- tab is visible (POST /api/presence) and "online" is "seen inside the last
-- window" (lib/presence.ts). No extra table, no Durable Object holding a global
-- socket — a single INTEGER per account answers the question the conversation
-- list and the thread header ask, and an account that stops beating goes
-- offline by itself without anything having to notice it left.
--
-- NULL means "never seen since this column existed", which reads as offline.
--
-- `skin` is the other half of the appearance preference. Until now the account
-- stored only colors (mode + one palette per mode, migration 0005); the skin is
-- the geometry those colors are painted on — 2px frames with a hard offset
-- shadow, or the terminal skin's 1px frames with a CRT glow. It lives next to
-- the palettes for the same reason they do: it should follow the person to
-- every device, not stay in one browser's localStorage.
--
-- NULL means "never chose": the client resolves it to the default skin
-- ('retro', the look the app shipped with), so no screen changes here.

ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
ALTER TABLE users ADD COLUMN skin TEXT;
