-- Migration 0012: the device key registry, which is what end-to-end
-- encryption is built on.
--
-- Identity in GoodChat is per *device*, not per account. Each browser
-- generates an ECDH P-256 keypair whose private half never leaves it (a
-- non-extractable CryptoKey in IndexedDB), and publishes only the public half
-- here. A message is encrypted once under a random content key, and that key
-- is wrapped separately for every device that is allowed to read it — the
-- peer's devices plus the sender's own other devices, so the desktop can read
-- what the phone sent.
--
-- The id is not random: it is SHA-256 of the raw public key, truncated. That
-- makes the id a commitment to the key, so a key that was swapped is a
-- different device rather than the same device with new bytes — which is what
-- lets the client notice, and what the safety-number check compares.
--
-- There is no key escrow and no backup, by design. Retention caps a message's
-- life at seven days (migration 0008), so a device that loses its key loses at
-- most a week — which is what makes "no recovery phrase, no server-side
-- wrapped blob" an acceptable answer instead of a data-loss bug. A new device
-- simply starts reading from the moment it registers.
CREATE TABLE devices (
  -- SHA-256(raw public key), truncated to 32 hex chars.
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Raw P-256 public key (65 bytes, uncompressed), base64url.
  public_key  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  -- Refreshed whenever the device proves it still exists. The cleanup sweep
  -- collects the ones that stopped: a browser whose storage was cleared never
  -- comes back, and encrypting to it forever would be waste plus a key nobody
  -- holds sitting in the directory.
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_devices_user ON devices(user_id);
-- Drives the staleness sweep (lib/cleanup.ts).
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);

-- A push notification goes to one subscription, which is one device, and the
-- payload has to carry the content key wrapped for *that* device — otherwise
-- the service worker has nothing it can decrypt (see lib/push.ts). Nullable:
-- subscriptions written before this migration have no device, and they keep
-- working with the generic notification body.
ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT;
