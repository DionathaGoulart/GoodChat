// Fixed-window rate limiting, counters in D1 (`login_attempts`, kept under its
// original name so migrations stay append-only). Keys are namespaced by
// purpose: "user:<username>" and "ip:<ip>" for login, "temp:<ip>" for guest
// account creation, "upload:<user id>" for presign requests.
//
// Login uses two independent keys per attempt: per-account and per-IP. The
// per-IP limit is looser so one flatmate fat-fingering a password doesn't lock
// the house. Everything else goes through consumeQuota.

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_ACCOUNT = 5
const MAX_PER_IP = 20

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
  const rows = await db
    .prepare(
      'SELECT key, count, window_start FROM login_attempts WHERE key IN (?, ?) AND window_start > ?',
    )
    .bind(userKey(username), ipKey(ip), windowFloor)
    .all<{ key: string; count: number; window_start: number }>()

  let retryAfterMs = 0
  for (const row of rows.results) {
    const limit = row.key.startsWith('user:') ? MAX_PER_ACCOUNT : MAX_PER_IP
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

export async function clearLoginFailures(db: D1Database, username: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(userKey(username)).run()
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
