import { z } from 'zod'
import {
  createTempAccount,
  deleteAccountKeepingPeers,
  liveTempAccounts,
  tempAccountConfig,
} from '../lib/accounts'
import {
  AccountKeySchema,
  accountKeyShapeError,
  readAccountKey,
  type PublishedAccountKey,
} from './accountKey'
import { apiError, json } from '../lib/http'
import { KDF_ITERATIONS, decoyKdfSalt } from '../lib/kdf'
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
import {
  HOUR_MS,
  addressQuotaKey,
  checkLoginAllowed,
  clearLoginFailures,
  consumeQuota,
  recordLoginFailure,
} from '../lib/ratelimit'

/**
 * One of `auth_token` or `password`, never both, and the server does not care
 * which: `password_hash` is PBKDF2 of whatever the client sent when the
 * account was written, so verification is the same call either way
 * (lib/password.ts is untouched by all of this — it just gets a different
 * string).
 *
 * Two fields rather than one, even though the server treats them alike,
 * because they are not alike on the wire: `password` is the plaintext, and a
 * request carrying it is a request that has to be justified. Naming it
 * separately is what makes it possible to grep for the paths that still do.
 */
const LoginSchema = z
  .object({
    username: z.string().min(1).max(64),
    /** base64url of 32 bytes — app/src/lib/kdf.ts. */
    auth_token: z.string().min(1).max(128).optional(),
    /**
     * The legacy path, for an account that has not rotated (migration 0013).
     * The client only reaches for it after the derived attempt was refused,
     * which means the typed password is already known not to open this account
     * the new way — see the note on `login` below.
     */
    password: z.string().min(1).max(256).optional(),
  })
  .refine(
    (body) => (body.auth_token === undefined) !== (body.password === undefined),
    { message: 'exactly one of auth_token or password' },
  )

const KdfSchema = z.object({ username: z.string().min(1).max(64) })

/**
 * POST /api/auth/kdf — the salt and iteration count the browser needs before
 * it can derive anything.
 *
 * Answers for every username, real or not: a rotated account gets its stored
 * salt, anything else gets a deterministic decoy (lib/kdf.ts). Without that
 * this is an account-enumeration oracle with no rate limit in front of it,
 * which is the same reason `burnPasswordTime` exists a few lines down.
 *
 * Not quota-counted, and that is deliberate rather than an omission. It costs
 * one indexed read and returns a value that is public by construction; every
 * counter in this codebase is a D1 *write*, so metering this would spend more
 * than it protects. What it fronts — the login attempt — is already limited on
 * two keys.
 */
export async function kdfParams(request: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = KdfSchema.safeParse(body)
  if (!parsed.success) return apiError('invalid_request', 400, 'username is required')

  const username = parsed.data.username.trim().toLowerCase()
  const row = await env.DB.prepare(
    `SELECT kdf_salt, kdf_iterations FROM users
     WHERE username = ?1
       AND disabled_at IS NULL
       AND deleted_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?2)`,
  )
    .bind(username, Date.now())
    .first<{ kdf_salt: string | null; kdf_iterations: number | null }>()

  // `kdf_salt IS NULL` covers three cases on purpose — no such account, a
  // disabled or expired one, and one that has not rotated yet — and answers
  // all three identically.
  if (row?.kdf_salt) {
    return json({ salt: row.kdf_salt, iterations: row.kdf_iterations ?? KDF_ITERATIONS })
  }
  return json({ salt: await decoyKdfSalt(username, env), iterations: KDF_ITERATIONS })
}

interface UserRow extends Omit<SessionUser, 'is_temp' | 'must_rotate'> {
  is_temp: number
  must_rotate: number
  password_hash: string | null
  account_public_key: string | null
  account_key_wrapped: string | null
  account_key_iv: string | null
}

/**
 * POST /api/auth/login.
 *
 * The client derives `authToken` from the salt `/kdf` handed it and sends
 * that. For an account that has not rotated, `password_hash` is a hash of the
 * *plaintext*, so the derived token cannot match and the attempt is refused
 * like any other — at which point the client tries again with the password
 * itself, and that one lands.
 *
 * That fallback is what keeps this endpoint from being an enumeration oracle:
 * an unknown username and a rotated account with a wrong password both take
 * the same two refusals, so nothing distinguishes "no such account" from "not
 * that password". The price is that a *failed* derived attempt is followed by
 * the plaintext going over the wire — which is acceptable precisely because it
 * failed: a password that does not open this account tells the server nothing
 * about the account. The one case where it does cost something is somebody
 * typing *another* account's password on this instance by mistake, which is
 * the argument against reusing one, and is written down here rather than left
 * to be discovered.
 *
 * One more cost of the same ordering: a sign-in to an unrotated account spends
 * a failure slot on the derived attempt before the plaintext one succeeds, and
 * success clears the counters — so it nets to nothing except for an account
 * already sitting at four failures, which would lock itself out one attempt
 * early. Not worth special-casing: skipping the record when the account is
 * unrotated would make the *rate limiter* answer a question the responses
 * carefully do not (probe six times with a token; a 429 means "a rotated
 * account by this name exists"). It ends when the account rotates, which is
 * once.
 */
export async function login(request: Request, env: Env): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'username and one credential are required')
  }
  const secret = parsed.data.auth_token ?? (parsed.data.password as string)

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
            is_temp, expires_at, must_rotate, password_hash,
            account_public_key, account_key_wrapped, account_key_iv
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
    ? await verifyPassword(secret, user.password_hash)
    : await burnPasswordTime(secret).then(() => false)
  if (!user || !valid) {
    await recordLoginFailure(env.DB, ip, username, env)
    return apiError('invalid_credentials', 401)
  }

  await clearLoginFailures(env.DB, username, env, ip)
  const {
    password_hash,
    is_temp,
    must_rotate,
    account_public_key,
    account_key_wrapped,
    account_key_iv,
    ...rest
  } = user
  const publicUser: SessionUser = {
    ...rest,
    is_temp: is_temp === 1,
    must_rotate: must_rotate === 1,
  }
  const { cookie } = await createSession(env.DB, user.id, user.expires_at)
  // The wrapped key rides back with the session, and only here.
  //
  // This is the one moment the browser holds `wrapKey` — it was derived from
  // the password a few hundred milliseconds ago and is not written down
  // anywhere — so it is the one moment the blob can be opened. /api/auth/me
  // deliberately does not carry it: a reload has no password and nothing to
  // unwrap with, and the key is already in IndexedDB by then.
  const accountKey: PublishedAccountKey | null = readAccountKey({
    account_public_key,
    account_key_wrapped,
    account_key_iv,
  })
  return json({ user: publicUser, account_key: accountKey }, 200, { 'Set-Cookie': cookie })
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
    // A guest has no password, so there is nothing to rotate into anything.
    must_rotate: false,
  }
  // No key yet, and no password to wrap one under. The browser mints one and
  // publishes the public half through PUT /api/account/key, keeping the
  // private half to itself — which is the correct model for an account that
  // has exactly one device by definition (lib/accounts.ts).
  return json({ user, account_key: null }, 201, { 'Set-Cookie': cookie })
}

const RotateSchema = z.object({
  /** The password this account still has. Verified against the legacy hash. */
  current_password: z.string().min(1).max(256),
  /** Derived from the *new* password, client-side (app/src/lib/kdf.ts). */
  auth_token: z.string().min(1).max(128),
  kdf_salt: z.string().min(16).max(64),
  kdf_iterations: z.number().int().min(100_000).max(5_000_000),
  /**
   * The account key, sealed under the *new* `wrapKey` (migration 0014). A
   * rotating account is either getting its first one or replacing one it can
   * no longer open, so this is a whole key rather than a rewrap — and it has
   * to arrive in the same request as the salt it was wrapped against.
   */
  account_key: AccountKeySchema,
})

/**
 * POST /api/auth/rotate — the one-time move off a server-known password.
 *
 * Only reachable on an account carrying `must_rotate` (migration 0013), which
 * is every account that existed before this shipped and every one the owner
 * console has reset since. The flag is cleared here and nothing sets it again
 * except a reset, so this route is a door that closes behind each account.
 *
 * A *new* password, not a re-encoding of the old one. The old one reached the
 * server in the clear — twice by the time this runs, once on the legacy login
 * and once in `current_password` below — so it is spent. The client picks the
 * new one, derives everything from it locally, and only `auth_token` arrives.
 *
 * `current_password` is required even though the session is already
 * authenticated: without it, a stolen cookie on an unrotated account is enough
 * to set a new password and lock the owner out. With it, this route is exactly
 * as strong as `changePassword`, which is the one it becomes afterwards.
 *
 * The new password's *length* is not checked here and cannot be — the server
 * sees `auth_token` and nothing else. MIN_PASSWORD_LENGTH in app/src/lib/kdf.ts
 * is the whole of that rule on this path, which is the honest cost of the
 * server not knowing the password.
 */
export async function rotatePassword(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = RotateSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, parsed.error.issues[0]?.message ?? 'invalid body')
  }
  const shape = accountKeyShapeError(parsed.data.account_key)
  if (shape) return apiError('invalid_request', 400, shape)
  // Only a guest may publish an unwrapped key, and a guest has no password to
  // rotate. Reaching here with `wrapped: null` is a client that would have
  // locked itself out of every browser but this one.
  if (parsed.data.account_key.wrapped === null) {
    return apiError('invalid_request', 400, 'a rotated account must wrap its key')
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rate = await checkLoginAllowed(env.DB, ip, auth.user.username, env)
  if (rate.blocked) {
    return apiError('rate_limited', 429, 'too many attempts, try again later', {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const row = await env.DB.prepare(
    'SELECT password_hash, must_rotate FROM users WHERE id = ?',
  )
    .bind(auth.user.id)
    .first<{ password_hash: string | null; must_rotate: number }>()
  if (!row || row.must_rotate !== 1) {
    return apiError('rotation_not_required', 409, 'esta conta já usa o formato novo')
  }

  const valid = row.password_hash
    ? await verifyPassword(parsed.data.current_password, row.password_hash)
    : false
  if (!valid) {
    await recordLoginFailure(env.DB, ip, auth.user.username, env)
    return apiError('invalid_credentials', 401, 'senha atual incorreta')
  }

  // One statement, so an account can never be left holding a new hash with the
  // old salt — or with `must_rotate` cleared and no salt to derive against,
  // which would be an account nobody can sign in to. The key goes in the same
  // one, and for the stronger version of the same reason: a key wrapped under
  // a `wrapKey` the stored salt no longer produces is unopenable by everyone,
  // including the person who just wrapped it.
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?1, kdf_salt = ?2, kdf_iterations = ?3, must_rotate = 0,
                      account_public_key = ?4, account_key_wrapped = ?5, account_key_iv = ?6
     WHERE id = ?7`,
  )
    .bind(
      await hashPassword(parsed.data.auth_token),
      parsed.data.kdf_salt,
      parsed.data.kdf_iterations,
      parsed.data.account_key.public_key,
      parsed.data.account_key.wrapped,
      parsed.data.account_key.iv,
      auth.user.id,
    )
    .run()
  await clearLoginFailures(env.DB, auth.user.username, env, ip)

  // Same reasoning as changePassword: the password really did change, so every
  // other session goes, and this tab gets a fresh cookie rather than being
  // signed out in the middle of the thing it just did.
  await revokeAllSessions(env.DB, auth.user.id)
  const { cookie } = await createSession(env.DB, auth.user.id, auth.user.expires_at)
  return json({ ok: true }, 200, { 'Set-Cookie': cookie })
}

const ChangePasswordSchema = z.object({
  /** Derived from the current password against the account's stored salt. */
  current_auth_token: z.string().min(1).max(128),
  /** Derived from the new one, against `kdf_salt` below. */
  auth_token: z.string().min(1).max(128),
  kdf_salt: z.string().min(16).max(64),
  kdf_iterations: z.number().int().min(100_000).max(5_000_000),
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
 * Neither password arrives. The browser derives `current_auth_token` against
 * the account's stored salt and `auth_token` against a fresh one, exactly as
 * the login form does (app/src/lib/kdf.ts), and both of those are one-way away
 * from anything that unwraps a message. The new salt travels with the token it
 * belongs to and is written in the same statement, because a hash stored
 * against the wrong salt is an account nobody can sign in to.
 *
 * The current token is required and verified, so a stolen *session* cannot be
 * escalated into a stolen *account*. Every other session is revoked on
 * success, which is the point of changing it: if someone else was signed in,
 * they are not anymore. The caller gets a fresh cookie so the tab doing the
 * change stays signed in.
 *
 * Rate-limited on the same counters as login (the account key, the address
 * key), because verifying `current_auth_token` here is the same oracle the
 * login form is — without it, this route is a way to brute-force a password
 * from inside a session that only had read access to a shared browser.
 *
 * The new password's length is checked in the browser and nowhere else: what
 * reaches here is a fixed-length token with nothing to measure. See
 * MIN_PASSWORD_LENGTH in app/src/lib/kdf.ts.
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
    return apiError('invalid_request', 400, parsed.error.issues[0]?.message ?? 'invalid body')
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rate = await checkLoginAllowed(env.DB, ip, auth.user.username, env)
  if (rate.blocked) {
    return apiError('rate_limited', 429, 'too many attempts, try again later', {
      'Retry-After': String(rate.retryAfterSeconds),
    })
  }

  const row = await env.DB.prepare(
    'SELECT password_hash, must_rotate, account_public_key FROM users WHERE id = ?',
  )
    .bind(auth.user.id)
    .first<{
      password_hash: string | null
      must_rotate: number
      account_public_key: string | null
    }>()
  // An account still on the legacy hash cannot be changed from here: the
  // browser has no salt to have derived `current_auth_token` against, so it
  // could only ever fail. /api/auth/rotate is the door for that one, and
  // saying so beats a 401 that reads as "wrong password".
  if (row?.must_rotate === 1) {
    return apiError('rotation_required', 409, 'esta conta precisa migrar a senha primeiro')
  }
  // A new password is a new `wrapKey`, and the account key is wrapped under the
  // old one. Writing the hash without the rewrap would leave a blob nobody can
  // open — the history gone, silently, as a side effect of a routine password
  // change. Refused until the client sends it (see the rewrap change).
  if (row?.account_public_key) {
    return apiError(
      'rewrap_required',
      409,
      'este build ainda não reembrulha a chave da conta ao trocar a senha',
    )
  }
  const valid = row?.password_hash
    ? await verifyPassword(parsed.data.current_auth_token, row.password_hash)
    : false
  if (!valid) {
    await recordLoginFailure(env.DB, ip, auth.user.username, env)
    return apiError('invalid_credentials', 401, 'senha atual incorreta')
  }

  await env.DB.prepare(
    'UPDATE users SET password_hash = ?1, kdf_salt = ?2, kdf_iterations = ?3 WHERE id = ?4',
  )
    .bind(
      await hashPassword(parsed.data.auth_token),
      parsed.data.kdf_salt,
      parsed.data.kdf_iterations,
      auth.user.id,
    )
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
