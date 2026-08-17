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

export interface SessionUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  created_at: number
}

export interface AuthContext {
  user: SessionUser
  /** Present when the sliding expiration advanced — forward it as Set-Cookie. */
  refreshedCookie?: string
}

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ cookie: string }> {
  const token = generateToken()
  const now = Date.now()
  const expiresAt = now + IDLE_TTL_MS
  await db
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await hashToken(token), userId, now, expiresAt)
    .run()
  return { cookie: buildCookie(token, expiresAt - now) }
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await hashToken(token)).run()
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

  const tokenHash = await hashToken(token)
  const row = await db
    .prepare(
      `SELECT s.created_at AS session_created_at, s.expires_at,
              u.id, u.username, u.display_name, u.avatar_url, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .bind(tokenHash)
    .first<SessionUser & { session_created_at: number; expires_at: number }>()

  const now = Date.now()
  if (!row || row.expires_at <= now) {
    if (row) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run()
    return apiError('unauthorized', 401, undefined, {
      'Set-Cookie': clearCookie(),
    })
  }

  const { session_created_at, expires_at, ...user } = row
  const context: AuthContext = { user }

  const newExpiresAt = Math.min(now + IDLE_TTL_MS, session_created_at + MAX_TTL_MS)
  if (newExpiresAt - expires_at >= REFRESH_MIN_GAIN_MS) {
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
