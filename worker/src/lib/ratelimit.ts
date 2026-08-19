// Fixed-window rate limiting, counters in D1 (`login_attempts`, kept under its
// original name so migrations stay append-only). Keys are namespaced by
// purpose: "user:<username>" and "ip:<ip>" for login, "temp:<ip>" for guest
// account creation, "upload:<user id>" for presign requests.
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
// The trust row stores SHA-256(username + IP), never the address itself.

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
export const HOUR_MS = 60 * 60 * 1000

export interface RateLimitStatus {
  blocked: boolean
  retryAfterSeconds: number
}

export async function checkLoginAllowed(
  db: D1Database,
  ip: string,
  username: string,
): Promise<RateLimitStatus> {
  const now = Date.now()
  const windowFloor = now - WINDOW_MS
  const trusted = await trustedKey(username, ip)
  const rows = await db
    .prepare(
      `SELECT key, count, window_start FROM login_attempts
       WHERE key IN (?1, ?2, ?3) AND window_start > ?4`,
    )
    .bind(userKey(username), ipKey(ip), trusted, Math.min(windowFloor, now - LOGIN_TRUST_TTL_MS))
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
    upsert.bind(ipKey(ip), now, windowFloor),
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
  ip?: string,
): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(userKey(username)).run()
  if (!ip) return
  await db
    .prepare(
      `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET window_start = ?2`,
    )
    .bind(await trustedKey(username, ip), Date.now())
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

function ipKey(ip: string): string {
  return `ip:${ip}`
}

/**
 * Key of the "this address has signed in to this account" row. Hashed and
 * salted by the username so the table never stores an address in the clear and
 * one row cannot be correlated with another account's.
 */
async function trustedKey(username: string, ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${username.toLowerCase()}:${ip}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${TRUSTED_KEY_PREFIX}${hex}`
}
