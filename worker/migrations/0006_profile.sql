-- Migration 0006: the profile picture becomes an object key, not a URL.
--
-- `avatar_url` was declared in 0001 and never written: there was no way to set
-- a picture. Now there is (PATCH /api/profile), and what the row holds is a key
-- in the private bucket — `avatars/<uuid>.<ext>` — exactly like a media message
-- holds `media_key`. It is not a URL: the bucket is private, so the bytes are
-- only reachable through the Worker's proxy, and the client is the side that
-- knows which origin serves it (VITE_MEDIA_URL in dev, same origin in prod).
--
-- Renamed rather than added so there is one column and no dead one, and this is
-- free: every row still has NULL here.

ALTER TABLE users RENAME COLUMN avatar_url TO avatar_key;
