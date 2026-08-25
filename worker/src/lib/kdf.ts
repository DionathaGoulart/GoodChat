// The server's one job in the client-side KDF: hand out a salt, including for
// accounts that do not exist.
//
// `POST /api/auth/kdf` has to answer before anybody has proven anything — the
// browser cannot derive `authToken` without the salt, and it cannot log in
// without `authToken`. So the endpoint is unauthenticated and takes a bare
// username, which makes it the most obvious account-enumeration oracle this
// instance could grow: answer for `alice` and 404 for `alicf`, and the whole
// user list falls out in an afternoon.
//
// The fix is the same one `burnPasswordTime` applies to login (lib/password.ts)
// — make both branches indistinguishable — but the shape is different here,
// because a salt is a *value* and not a timing. It has to look real, and it has
// to be the same value every time: a random one would be worse than a 404,
// since two calls for the same unknown username returning two different salts
// says "no row" out loud.
//
// So the decoy is HMAC-SHA-256(instance secret, username), truncated to the
// same 16 bytes a real salt has. Deterministic, indistinguishable from random
// without the secret, and unforgeable — nobody outside the instance can tell
// which of two salts came from a real row.
//
// A *legacy* account (migration 0013, `kdf_salt IS NULL`) gets the decoy too,
// and that is the part worth being explicit about: this endpoint answers
// "here is a salt" for a rotated account, an unrotated one and a name that was
// never taken, in one shape. What separates them is what happens next, at the
// login route, which has always ended in the same 401 either way.

/**
 * The instance secret behind the decoy. Falls back to `RATE_LIMIT_SALT` — an
 * operator who already set that one gets this for free — and then to a
 * constant, which keeps a fresh instance working while being, honestly,
 * public: with the constant in force anyone can recompute a decoy and tell it
 * from a real salt. That is the same trade lib/ratelimit.ts documents, and the
 * same fix:
 *
 *   wrangler secret put KDF_DECOY_SALT
 */
const DEFAULT_DECOY_SECRET = 'goodchat-kdf-decoy'

/** Must match KDF_SALT_BYTES in app/src/lib/kdf.ts, or the decoy is spottable. */
const SALT_BYTES = 16

/**
 * Must match KDF_ITERATIONS in app/src/lib/kdf.ts. A decoy that quoted a
 * different cost than every real account would name itself.
 */
export const KDF_ITERATIONS = 600_000

function secretOf(env: Env): string {
  const configured = env.KDF_DECOY_SALT?.trim() || env.RATE_LIMIT_SALT?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_DECOY_SECRET
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * A salt for a username with no row behind it — or with a row that has not
 * rotated yet. Stable for as long as the secret is.
 */
export async function decoyKdfSalt(username: string, env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretOf(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`kdf-salt:${username.toLowerCase()}`),
  )
  return base64url(new Uint8Array(mac).slice(0, SALT_BYTES))
}
