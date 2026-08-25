import { z } from 'zod'
import {
  createTempAccount,
  deleteAccountKeepingPeers,
  liveTempAccounts,
  tempAccountConfig,
} from '../lib/accounts'
import { apiError, json } from '../lib/http'
import { burnPasswordTime, hashPassword, verifyPassword } from '../lib/password'
import {
  clearCookie,
  createSession,
  readSessionCookie,
  requireSession,
  revokeAllSessions,
  revokeSession,
  sessionHeaders,
  type SessionUser,
} from '../lib/session'
import { validateCredentials } from '../lib/users'
import {
  HOUR_MS,
  addressQuotaKey,
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

  const rate = await checkLoginAllowed(env.DB, ip, username, env)
  if (rate.blocked) {
    return apiError('rate_limited', 429, 'too many login attempts, try again later', {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  // An expired guest account is already gone as far as anyone can tell, even
  // if the sweep has not reached its data yet.
  const user = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_key, created_at, role,
            theme_mode, theme_light, theme_dark, skin, push_preview,
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
    await recordLoginFailure(env.DB, ip, username, env)
    return apiError('invalid_credentials', 401)
  }

  await clearLoginFailures(env.DB, username, env, ip)
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
 * No password comes back, because none was minted. A guest is the tab that
 * created it: `password_hash` is NULL, login refuses the account, and there is
 * nothing to write down, nothing to leak, and nothing to relogin with. It also
 * makes this the one account on the instance whose encryption key the server
 * has no wrapped copy of — see lib/accounts.ts.
 */
export async function createTempSession(request: Request, env: Env): Promise<Response> {
  const config = tempAccountConfig(env)
  if (!config.enabled) {
    return apiError('temp_accounts_disabled', 403, 'guest accounts are disabled on this instance')
  }

  const now = Date.now()
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const quota = await consumeQuota(
    env.DB,
    await addressQuotaKey('temp:', ip, env),
    config.perIpPerHour,
    HOUR_MS,
    now,
  )
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
    avatar_key: null,
    created_at: now,
    role: 'user',
    theme_mode: null,
    theme_light: null,
    theme_dark: null,
    skin: null,
    push_preview: null,
    is_temp: true,
    expires_at: account.expiresAt,
  }
  return json({ user }, 201, { 'Set-Cookie': cookie })
}

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(1).max(256),
})

/**
 * PATCH /api/auth/password — the account's own password, changed by the person
 * who holds it.
 *
 * Until now the only way to change a password was for the owner to reset it,
 * which means the one thing a person could not do about a credential they think
 * has leaked is replace it — they had to ask the operator, who ends up knowing
 * the new one. For a product whose premise is that the operator sees as little
 * as possible, that is the wrong shape.
 *
 * The current password is required and verified, so a stolen *session* cannot
 * be escalated into a stolen *account*. Every other session is revoked on
 * success, which is the point of changing it: if someone else was signed in,
 * they are not anymore. The caller gets a fresh cookie so the tab doing the
 * change stays signed in.
 *
 * Rate-limited on the same counters as login (the account key, the address
 * key), because verifying `current_password` here is the same oracle the login
 * form is — without it, this route is a way to brute-force a password from
 * inside a session that only had read access to a shared browser.
 */
export async function changePassword(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = ChangePasswordSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'current_password and new_password are required')
  }

  const invalid = validateCredentials(auth.user.username, parsed.data.new_password)
  if (invalid) return apiError('invalid_request', 400, invalid)

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rate = await checkLoginAllowed(env.DB, ip, auth.user.username, env)
  if (rate.blocked) {
    return apiError('rate_limited', 429, 'too many attempts, try again later', {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(auth.user.id)
    .first<{ password_hash: string | null }>()
  const valid = row?.password_hash
    ? await verifyPassword(parsed.data.current_password, row.password_hash)
    : false
  if (!valid) {
    await recordLoginFailure(env.DB, ip, auth.user.username, env)
    return apiError('invalid_credentials', 401, 'senha atual incorreta')
  }

  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(parsed.data.new_password), auth.user.id)
    .run()
  await clearLoginFailures(env.DB, auth.user.username, env, ip)

  // Every device, including this one — then a new cookie for the tab that asked,
  // so changing the password does not read as being kicked out.
  await revokeAllSessions(env.DB, auth.user.id)
  const { cookie } = await createSession(env.DB, auth.user.id, auth.user.expires_at)
  return json({ ok: true }, 200, { 'Set-Cookie': cookie })
}

/**
 * POST /api/auth/logout — end the session, and for a guest end the account.
 *
 * A guest has no password, so a session that ends is an account nobody can
 * ever open again: leaving the row until its TTL would keep a few hours of
 * data alive with no reader. Deleting now is the same call the expiry sweep
 * makes, with the same rule about the other side's history — a conversation
 * whose peer is still alive is kept, with a tombstone in place of the guest
 * (lib/accounts.ts).
 *
 * The session is looked up before it is revoked, and the deletion runs after:
 * a failure in either half must still clear the cookie, or the browser would
 * be left holding a token for an account in an unknown state.
 */
export async function logout(request: Request, env: Env): Promise<Response> {
  const token = readSessionCookie(request)
  const auth = await requireSession(request, env.DB)
  if (token) await revokeSession(env.DB, token)
  if (!(auth instanceof Response) && auth.user.is_temp) {
    try {
      await deleteAccountKeepingPeers(env, auth.user.id)
    } catch (error) {
      // The TTL sweep is the backstop. Signing out must not fail because the
      // cleanup did.
      console.error('guest deletion on logout failed', auth.user.id, error)
    }
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() })
}

export async function me(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth
  return json({ user: auth.user }, 200, sessionHeaders(auth))
}
