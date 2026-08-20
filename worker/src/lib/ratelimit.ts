// Fixed-window rate limiting, counters in D1 (`login_attempts`, kept under its
// original name so migrations stay append-only). Keys are namespaced by
// purpose: "user:<username>" and "ip:<digest>" for login, "temp:<digest>" for
// guest account creation, "upload:<user id>" for presign requests.
//
// Every key derived from an address is a salted digest, never the address. A
// counter only has to be countable, and this table lives in the same database
// the owner console reads — "who tried to sign in, from where, in the last
// hour" is not something it should be able to answer.
//
// Login uses two independent keys per attempt: per-account and per-IP. The
// per-IP limit is looser so one flatmate fat-fingering a password doesn't lock
// the house. Everything else goes through consumeQuota.
//
// The per-account counter has a cost of its own: usernames are discoverable by
// search, so anybody can keep five failures rolling against one account and
// hold that person out of their own instance. The exemption closes that without
// weakening the counter for an attacker — an address that has *successfully*
// signed in to this account before is not blocked by the account counter (the
// per-IP one still applies to it). Password guessing from a new address is
// throttled exactly as before; the victim, signing in from the phone or laptop
// they always use, is not collateral.
//
// The trust row is salted by the username on top, so one account's row cannot
// be correlated with another's for the same address.

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_ACCOUNT = 5
const MAX_PER_IP = 20

/**
 * How long one successful sign-in vouches for an address. Long enough to cover
 * "I log in from home every few weeks", short enough that a device that stopped
 * being used stops carrying the exemption. Rows past it are swept by the cron
 * (lib/cleanup.ts) like every other counter.
 */
export const LOGIN_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Prefix of the trust rows inside `login_attempts` — the sweep needs it. */
export const TRUSTED_KEY_PREFIX = 'trusted:'

/** Presign requests one account may make per hour (routes/media.ts). */
export const UPLOAD_QUOTA_PER_HOUR = 60

/**
 * Username searches per account per hour (routes/users.ts). The search box is
 * debounced, so a person typing all day does not approach this; a script
 * walking the alphabet does it in seconds.
 */
export const LOOKUP_QUOTA_PER_HOUR = 200

/**
 * Conversation-list reads per account per hour (routes/conversations.ts). One
 * call fans out to every conversation's Durable Object, so a loop here is the
 * cheapest way to spend somebody else's compute. The list polls at 15s while
 * the tab is visible and backs off to 60s, which is 240/hour per tab — the
 * ceiling is set to leave room for several tabs and still stop a loop.
 */
export const CONVERSATIONS_QUOTA_PER_HOUR = 900

export const HOUR_MS = 60 * 60 * 1000

export interface RateLimitStatus {
  blocked: boolean
  retryAfterSeconds: number
}

export async function checkLoginAllowed(
  db: D1Database,
  ip: string,
  username: string,
  env: Env,
): Promise<RateLimitStatus> {
  const now = Date.now()
  const windowFloor = now - WINDOW_MS
  const [trusted, address] = await Promise.all([
    trustedKey(username, ip, env),
    ipKey(ip, env),
  ])
  const rows = await db
    .prepare(
      `SELECT key, count, window_start FROM login_attempts
       WHERE key IN (?1, ?2, ?3) AND window_start > ?4`,
    )
    .bind(userKey(username), address, trusted, Math.min(windowFloor, now - LOGIN_TRUST_TTL_MS))
    .all<{ key: string; count: number; window_start: number }>()

  const isTrusted = rows.results.some(
    (row) => row.key === trusted && row.window_start > now - LOGIN_TRUST_TTL_MS,
  )

  let retryAfterMs = 0
  for (const row of rows.results) {
    if (row.key === trusted) continue
    if (row.window_start <= windowFloor) continue
    const perAccount = row.key.startsWith('user:')
    // An address this account has used before is exempt from the account-wide
    // block; it still has to fit under its own per-IP limit.
    if (perAccount && isTrusted) continue
    const limit = perAccount ? MAX_PER_ACCOUNT : MAX_PER_IP
    if (row.count >= limit) {
      retryAfterMs = Math.max(retryAfterMs, row.window_start + WINDOW_MS - now)
    }
  }
  return {
    blocked: retryAfterMs > 0,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  }
}

export async function recordLoginFailure(
  db: D1Database,
  ip: string,
  username: string,
  env: Env,
): Promise<void> {
  const now = Date.now()
  const windowFloor = now - WINDOW_MS
  const upsert = db.prepare(
    `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`,
  )
  await db.batch([
    upsert.bind(userKey(username), now, windowFloor),
    upsert.bind(await ipKey(ip, env), now, windowFloor),
  ])
}

/**
 * A successful sign-in: the account's failure counter is dropped, and this
 * address is vouched for (see the note at the top). The trust row reuses the
 * counters table so it is swept by the same job — `count` is meaningless here,
 * `window_start` is the moment the trust was last renewed.
 */
export async function clearLoginFailures(
  db: D1Database,
  username: string,
  env: Env,
  ip?: string,
): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(userKey(username)).run()
  if (!ip) return
  await db
    .prepare(
      `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET window_start = ?2`,
    )
    .bind(await trustedKey(username, ip, env), Date.now())
    .run()
}

export interface QuotaStatus {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * Counts one use of `key` and says whether it fit under `limit` within the
 * current window. Unlike the login counters this charges on success too — the
 * endpoints it guards (guest signup, upload presign) are expensive when they
 * work, not when they fail.
 *
 * Upsert and read in one statement (RETURNING): two round-trips would let
 * concurrent requests read the same count and both pass.
 */
export async function consumeQuota(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<QuotaStatus> {
  const windowFloor = now - windowMs
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING count, window_start`,
    )
    .bind(key, now, windowFloor)
    .first<{ count: number; window_start: number }>()

  if (!row || row.count <= limit) return { allowed: true, retryAfterSeconds: 0 }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)),
  }
}

function userKey(username: string): string {
  return `user:${username.toLowerCase()}`
}

/**
 * Salt for every key derived from an address. `RATE_LIMIT_SALT` is what makes
 * the digest actually one-way: the IPv4 space is 2^32 wide, so an unsalted
 * SHA-256 of an address is a lookup table, not a hash. The constant fallback
 * keeps a fresh instance working — the address still never lands in the table
 * in the clear — but an operator who wants the counters to be unreadable to
 * whoever can read D1 sets the secret:
 *
 *   wrangler secret put RATE_LIMIT_SALT
 */
const DEFAULT_RATE_LIMIT_SALT = 'goodchat-rate-limit'

function saltOf(env: Env): string {
  const configured = env.RATE_LIMIT_SALT?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_RATE_LIMIT_SALT
}

async function digestKey(prefix: string, value: string, env: Env): Promise<string> {
  const data = new TextEncoder().encode(`${saltOf(env)}:${value}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${prefix}${hex}`
}

/**
 * Counter key for one address. Hashed for the same reason the trust row below
 * is: a failure counter is a record of who tried to sign in and from where, and
 * it sits in the same database the owner console queries. The counting works
 * identically on a digest — nothing ever needs to read the address back.
 */
function ipKey(ip: string, env: Env): Promise<string> {
  return digestKey('ip:', ip, env)
}

/**
 * The same, for a quota keyed by address rather than by account — guest signups
 * (`temp:`). Exported because the caller is the route that owns that quota.
 */
export function addressQuotaKey(prefix: string, ip: string, env: Env): Promise<string> {
  return digestKey(prefix, ip, env)
}

/**
 * Key of the "this address has signed in to this account" row. Salted by the
 * username as well, so one row cannot be correlated with another account's.
 */
function trustedKey(username: string, ip: string, env: Env): Promise<string> {
  return digestKey(TRUSTED_KEY_PREFIX, `${username.toLowerCase()}:${ip}`, env)
}
