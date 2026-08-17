import { z } from 'zod'
import {
  createTempAccount,
  liveTempAccounts,
  tempAccountConfig,
} from '../lib/accounts'
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
import {
  HOUR_MS,
  checkLoginAllowed,
  clearLoginFailures,
  consumeQuota,
  recordLoginFailure,
} from '../lib/ratelimit'

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

interface UserRow extends Omit<SessionUser, 'is_temp'> {
  is_temp: number
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

  // An expired guest account is already gone as far as anyone can tell, even
  // if the sweep has not reached its data yet.
  const user = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, created_at, role, theme,
            is_temp, expires_at, password_hash
     FROM users
     WHERE username = ?1
       AND disabled_at IS NULL
       AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?2)`,
  )
    .bind(username, Date.now())
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
  const { password_hash, is_temp, ...rest } = user
  const publicUser: SessionUser = { ...rest, is_temp: is_temp === 1 }
  const { cookie } = await createSession(env.DB, user.id, user.expires_at)
  return json({ user: publicUser }, 200, { 'Set-Cookie': cookie })
}

/**
 * POST /api/auth/temp — the one public way into a closed instance: a guest
 * account that exists for TEMP_ACCOUNT_TTL_HOURS and then deletes itself along
 * with everything only it can see (lib/accounts.ts).
 *
 * Unauthenticated by definition, so it is fenced three ways: a per-IP hourly
 * quota, a cap on how many guests can be alive at once, and an off switch.
 * Without them this endpoint is a free account factory pointed at D1.
 *
 * The password is returned once, in the clear, and never again — it exists so
 * the person can get back in from another tab or device before the clock runs
 * out.
 */
export async function createTempSession(request: Request, env: Env): Promise<Response> {
  const config = tempAccountConfig(env)
  if (!config.enabled) {
    return apiError('temp_accounts_disabled', 403, 'guest accounts are disabled on this instance')
  }

  const now = Date.now()
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const quota = await consumeQuota(env.DB, `temp:${ip}`, config.perIpPerHour, HOUR_MS, now)
  if (!quota.allowed) {
    return apiError('rate_limited', 429, 'too many guest accounts from this address', {
      'Retry-After': String(quota.retryAfterSeconds),
    })
  }

  if ((await liveTempAccounts(env.DB, now)) >= config.maxLive) {
    return apiError('temp_accounts_full', 503, 'guest account limit reached, try again later')
  }

  const account = await createTempAccount(env.DB, config.ttlMs, now)
  const { cookie } = await createSession(env.DB, account.id, account.expiresAt)
  const user: SessionUser = {
    id: account.id,
    username: account.username,
    display_name: null,
    avatar_url: null,
    created_at: now,
    role: 'user',
    theme: null,
    is_temp: true,
    expires_at: account.expiresAt,
  }
  return json({ user, password: account.password }, 201, { 'Set-Cookie': cookie })
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
