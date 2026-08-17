// Login rate limiting: fixed 15-minute window, counters in D1.
// Two independent keys per attempt: per-account and per-IP. The per-IP limit
// is looser so one flatmate fat-fingering a password doesn't lock the house.

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_ACCOUNT = 5
const MAX_PER_IP = 20

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

function userKey(username: string): string {
  return `user:${username.toLowerCase()}`
}

function ipKey(ip: string): string {
  return `ip:${ip}`
}
