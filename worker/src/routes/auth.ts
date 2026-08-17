import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { verifyPassword } from '../lib/password'
import {
  clearCookie,
  createSession,
  readSessionCookie,
  requireSession,
  revokeSession,
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
    'SELECT id, username, display_name, avatar_url, created_at, password_hash FROM users WHERE username = ?',
  )
    .bind(username)
    .first<UserRow>()

  const valid = user?.password_hash
    ? await verifyPassword(parsed.data.password, user.password_hash)
    : false
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
  return json(
    { user: auth.user },
    200,
    auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined,
  )
}
