// Session management: opaque 256-bit tokens in an HttpOnly cookie, rows in D1.
// The DB stores only SHA-256(token) so a leaked database cannot mint sessions.
// Sliding expiration (idle TTL) with a hard cap counted from creation.

import { apiError } from './http'

const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // refreshed on activity
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000 // hard cap regardless of activity
// Only persist a sliding refresh when it gains at least this much, to avoid
// one D1 write per authenticated request.
const REFRESH_MIN_GAIN_MS = 60 * 60 * 1000

const COOKIE_NAME = 'session'

export type UserRole = 'owner' | 'user'

/** The account as its own session sees it (role and theme are private). */
export interface SessionUser {
  id: string
  username: string
  display_name: string | null
  /**
   * Profile picture as a bucket object key (migration 0006), never a URL: the
   * bucket is private, so the bytes come back through /api/media/<key> and the
   * client is the side that knows which origin serves that path.
   */
  avatar_key: string | null
  created_at: number
  role: UserRole
  /** Account-level mode (migration 0005); null follows the OS preference. */
  theme_mode: string | null
  /** Palette per mode; null means "never chose", the client uses its default. */
  theme_light: string | null
  theme_dark: string | null
  /**
   * Skin id (migration 0007) — the geometry the palette is painted on, from
   * app/src/lib/skins.ts. null means "never chose": the client resolves it to
   * the default skin, the same way it resolves a null palette.
   */
  skin: string | null
  /**
   * How much of a message this account allows in a device notification
   * (migration 0010): 'generic' | 'full'. null means "never chose", which
   * lib/push.ts resolves to the private default.
   */
  push_preview: string | null
  /** Guest account (migration 0004): dies at `expires_at`, taking its data. */
  is_temp: boolean
  /** When this account stops existing; null for permanent accounts. */
  expires_at: number | null
  /**
   * This account still holds a hash of a password the server was told
   * (migration 0013). Everything works, but the account key cannot exist until
   * it is replaced by one derived in the browser — so the app demands a new
   * password before it shows anything else. Cleared by POST /api/auth/rotate.
   */
  must_rotate: boolean
}

/** The subset other accounts are allowed to see (search results, peers). */
export interface PublicUser {
  id: string
  username: string
  display_name: string | null
  /** Object key, as in SessionUser — readable by any session once adopted. */
  avatar_key: string | null
  created_at: number
  /**
   * Last heartbeat (migration 0007), and whether it is recent enough to call
   * this account online — `lib/presence.ts` owns that window. Optional because
   * only the surfaces that render presence pay for computing it.
   */
  last_seen_at?: number | null
  online?: boolean
  /**
   * The account behind this row is gone and only its tombstone remains
   * (migration 0004). Absent in contexts that never return one, like search.
   */
  deleted?: boolean
}

export const PUBLIC_USER_COLUMNS =
  'id, username, display_name, avatar_key, created_at, last_seen_at'

export interface AuthContext {
  user: SessionUser
  /** Present when the sliding expiration advanced — forward it as Set-Cookie. */
  refreshedCookie?: string
}

/**
 * `maxExpiresAt` caps the session at the account's own lifetime: a guest
 * account's cookie must not outlive the account it authenticates.
 */
export async function createSession(
  db: D1Database,
  userId: string,
  maxExpiresAt?: number | null,
): Promise<{ cookie: string }> {
  const token = generateToken()
  const now = Date.now()
  const expiresAt = Math.min(now + IDLE_TTL_MS, maxExpiresAt ?? Number.POSITIVE_INFINITY)
  await db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), userId, now, expiresAt)
    .run()
  return { cookie: buildCookie(token, expiresAt - now) }
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run()
}

/** Every device of one account: password reset, admin disable, account delete. */
export async function revokeAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
}

/** Forwards the sliding-expiration refresh, when requireSession produced one. */
export function sessionHeaders(auth: AuthContext): HeadersInit | undefined {
  return auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined
}

/**
 * Validates the session cookie on `request`. Returns the authenticated user
 * or a ready-to-return 401 Response. Works for REST and (later) WS upgrades —
 * anything carrying the Cookie header.
 */
export async function requireSession(
  request: Request,
  db: D1Database,
): Promise<AuthContext | Response> {
  const token = readSessionCookie(request)
  if (!token) return apiError('unauthorized', 401)

  const now = Date.now()
  const tokenHash = await hashToken(token)
  // `u.disabled_at IS NULL`: disabling an account revokes every live session at
  // once, without a sweep over the sessions table. `u.deleted_at IS NULL` and
  // the `expires_at` check do the same for guest accounts — access ends exactly
  // when the clock says so, hours before the sweep gets around to the data.
  const row = await db
    .prepare(
      `SELECT s.created_at AS session_created_at, s.expires_at AS session_expires_at,
              u.id, u.username, u.display_name, u.avatar_key, u.created_at,
              u.role, u.theme_mode, u.theme_light, u.theme_dark, u.skin,
              u.push_preview, u.is_temp, u.expires_at AS account_expires_at,
              u.must_rotate
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?1
         AND u.disabled_at IS NULL
         AND u.deleted_at IS NULL
         AND (u.expires_at IS NULL OR u.expires_at > ?2)`,
    )
    .bind(tokenHash, now)
    .first<{
      session_created_at: number
      session_expires_at: number
      id: string
      username: string
      display_name: string | null
      avatar_key: string | null
      created_at: number
      role: UserRole
      theme_mode: string | null
      theme_light: string | null
      theme_dark: string | null
      skin: string | null
      push_preview: string | null
      is_temp: number
      account_expires_at: number | null
      must_rotate: number
    }>()

  if (!row || row.session_expires_at <= now) {
    if (row) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run()
    return apiError('unauthorized', 401, undefined, {
      'Set-Cookie': clearCookie(),
    })
  }

  const context: AuthContext = {
    user: {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_key: row.avatar_key,
      created_at: row.created_at,
      role: row.role,
      theme_mode: row.theme_mode,
      theme_light: row.theme_light,
      theme_dark: row.theme_dark,
      skin: row.skin,
      push_preview: row.push_preview,
      is_temp: row.is_temp === 1,
      expires_at: row.account_expires_at,
      must_rotate: row.must_rotate === 1,
    },
  }

  const newExpiresAt = Math.min(
    now + IDLE_TTL_MS,
    row.session_created_at + MAX_TTL_MS,
    row.account_expires_at ?? Number.POSITIVE_INFINITY,
  )
  if (newExpiresAt - row.session_expires_at >= REFRESH_MIN_GAIN_MS) {
    await db
      .prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
      .bind(newExpiresAt, tokenHash)
      .run()
    context.refreshedCookie = buildCookie(token, newExpiresAt - now)
  }

  return context
}

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE_NAME) return rest.join('=') || null
  }
  return null
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
}

function buildCookie(token: string, maxAgeMs: number): string {
  const maxAge = Math.floor(maxAgeMs / 1000)
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return toHex(bytes)
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
