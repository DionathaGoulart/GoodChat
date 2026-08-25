-- Migration 0013: the password stops arriving.
--
-- Until now `password_hash` was PBKDF2 of the password the browser posted. The
-- browser now does the expensive derivation itself (app/src/lib/kdf.ts) and
-- posts only `authToken`, a value the server can verify and cannot walk back:
--
--   masterKey = PBKDF2-SHA256(password, kdf_salt, kdf_iterations)   browser
--   authToken = PBKDF2-SHA256(masterKey, password, 1)               on the wire
--   wrapKey   = HKDF(masterKey, "goodchat/wrap/v1")                 browser
--
-- So `password_hash` keeps its exact meaning and format — PBKDF2 of whatever
-- the client sent — and src/lib/password.ts is untouched. What changed is what
-- the client sends. The reason it matters is migration 0014: the account key
-- is wrapped under `wrapKey`, and an operator who could see the password could
-- derive it and read everything. Now nothing that reaches this database, or
-- crosses the wire on the way to it, leads there.
--
-- `kdf_salt` is also the answer to POST /api/auth/kdf, which is public by
-- construction: the browser needs it before it can derive anything, and a salt
-- is not a secret. It is random per account so one derivation never covers two.
--
-- 600_000 iterations, which the Worker could not have run: crypto.subtle
-- PBKDF2 is capped at 100k there. Stored per account rather than assumed, so
-- the number can be raised later without locking out anybody who has not
-- signed in since.
ALTER TABLE users ADD COLUMN kdf_salt TEXT;
ALTER TABLE users ADD COLUMN kdf_iterations INTEGER;

-- The account still holds a hash of a *plaintext* password, so the client
-- cannot sign in the new way and the server cannot fix that on its own: it
-- would have to know the password to derive the new hash, which is the whole
-- thing this migration exists to stop.
--
-- The way through is one last legacy sign-in per account. The session comes
-- back with this flag, the app demands a new password on the spot, derives
-- everything locally, and POST /api/auth/rotate writes `kdf_salt` and clears
-- this. Until then the account works exactly as it did.
--
-- Set again by any write that puts a server-known password on an account —
-- the owner console's reset, and only that (src/routes/admin.ts). An account
-- with this flag set always has `kdf_salt IS NULL`; the pair is the invariant.
ALTER TABLE users ADD COLUMN must_rotate INTEGER NOT NULL DEFAULT 0;

-- Everything that exists right now. Guests are skipped because they have no
-- password at all (migration 0004 + the no-password guest change): there is
-- nothing to rotate and nothing to sign back in with.
UPDATE users SET must_rotate = 1 WHERE password_hash IS NOT NULL;
