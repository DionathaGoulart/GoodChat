import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { burnPasswordTime, verifyPassword } from '../lib/password'
import {
  clearCookie,
  createSession,
  readSessionCookie,
  requireSession,
  revokeSession,
  sessionHeaders,
  type SessionUser,
} from '../lib/session'
import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from '../lib/ratelimit'

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

interface UserRow extends SessionUser {
  password_hash: string | null
}

export async function login(request: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'username and password are required')
  }

  const username = parsed.data.username.trim().toLowerCase()
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

  const rate = await checkLoginAllowed(env.DB, ip, username)
  if (rate.blocked) {
    return apiError('rate_limited', 429, 'too many login attempts, try again later', {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const user = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, created_at, role, theme, password_hash
     FROM users WHERE username = ? AND disabled_at IS NULL`,
  )
    .bind(username)
    .first<UserRow>()

  // Always pay the KDF cost, even for an unknown or password-less account:
  // a fast 401 vs a slow one is a user-enumeration oracle that the rate limit
  // does not close (five probes are enough to classify a username).
  const valid = user?.password_hash
    ? await verifyPassword(parsed.data.password, user.password_hash)
    : await burnPasswordTime(parsed.data.password).then(() => false)
  if (!user || !valid) {
    await recordLoginFailure(env.DB, ip, username)
    return apiError('invalid_credentials', 401)
  }

  await clearLoginFailures(env.DB, username)
  const { password_hash, ...publicUser } = user
  const { cookie } = await createSession(env.DB, user.id)
  return json({ user: publicUser }, 200, { 'Set-Cookie': cookie })
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = readSessionCookie(request)
  if (token) await revokeSession(env.DB, token)
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() })
}

export async function me(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth
  return json({ user: auth.user }, 200, sessionHeaders(auth))
}
