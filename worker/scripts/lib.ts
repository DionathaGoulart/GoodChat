// Shared helpers for the admin CLI scripts. Runs on plain Node ≥24 (native
// type stripping) — no build step. Reuses src/lib/password.ts so CLI-created
// hashes match exactly what the Worker verifies, and src/lib/users.ts so the
// CLI and the owner panel enforce the same account rules.
//
// It also imports the *app's* KDF module, across the workspace boundary, and
// that is the interesting import. Since migration 0013 an account's stored
// hash is a hash of `authToken`, which only a client can compute — so a CLI
// that hashed the password the old way would create a row nobody can sign in
// to. Deriving it here with the same code the browser runs is what makes
// `npm run user:create` produce an account that is already on the new format,
// with no rotation prompt on first sign-in. Two implementations that agreed
// nearly would be an instance where nobody can log in, so there is one.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { hashPassword } from '../src/lib/password.ts'
import { deriveAccountSecrets, newKdfParams } from '../../app/src/lib/kdf.ts'
import {
  ROLES,
  canonicalUsername,
  validateCredentials,
  type Role,
} from '../src/lib/users.ts'

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export { ROLES, canonicalUsername, type Role }

export function d1Execute(sql: string, { remote = false } = {}): void {
  const target = remote ? '--remote' : '--local'
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'goodchat', target, '--command', sql], {
    cwd: WORKER_DIR,
    stdio: 'inherit',
  })
}

/**
 * Same as d1Execute, but hands the rows back instead of printing them — what a
 * smoke test needs when the thing under test is a value in D1 rather than an
 * API response. Stderr is dropped so wrangler's banner does not land in the
 * JSON.
 */
export function d1Query<T = Record<string, unknown>>(
  sql: string,
  { remote = false } = {},
): T[] {
  const output = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'goodchat', remote ? '--remote' : '--local', '--json', '--command', sql],
    { cwd: WORKER_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const parsed = JSON.parse(output) as { results?: T[] }[]
  return parsed[0]?.results ?? []
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function insertUser(
  username: string,
  password: string,
  displayName: string,
  { ignoreExisting = false, remote = false, role = 'user' as Role } = {},
): Promise<void> {
  const canonical = canonicalUsername(username)
  const invalid = validateCredentials(canonical, password)
  if (invalid) throw new Error(invalid)
  if (!ROLES.includes(role)) throw new Error(`invalid role "${role}" (expected ${ROLES.join('|')})`)

  // The same three lines a browser runs at sign-in, in the same order, from
  // the same module. ~600ms of PBKDF2 per account created from the terminal.
  const kdf = newKdfParams()
  const { authToken } = await deriveAccountSecrets(password, kdf)
  const hash = await hashPassword(authToken)
  const conflict = ignoreExisting ? 'OR IGNORE ' : ''
  d1Execute(
    `INSERT ${conflict}INTO users (id, username, display_name, avatar_key, password_hash, created_at, role, kdf_salt, kdf_iterations, must_rotate) ` +
      `VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(canonical)}, ${sqlString(displayName)}, NULL, ${sqlString(hash)}, ${Date.now()}, ${sqlString(role)}, ${sqlString(kdf.salt)}, ${kdf.iterations}, 0);`,
    { remote },
  )
}

/** Promote or demote an existing account. */
export function setUserRole(username: string, role: Role, { remote = false } = {}): void {
  const canonical = canonicalUsername(username)
  if (!ROLES.includes(role)) throw new Error(`invalid role "${role}" (expected ${ROLES.join('|')})`)
  d1Execute(
    `UPDATE users SET role = ${sqlString(role)} WHERE username = ${sqlString(canonical)};`,
    { remote },
  )
}

/**
 * The cookie for a signed-in account, the way a browser gets one: ask
 * /api/auth/kdf for the salt, derive `authToken` from the password locally, and
 * post that (app/src/lib/kdf.ts). The password itself never goes.
 *
 * Every smoke test needs this and none of them should reimplement it — a test
 * that signed in a way the app does not would be testing a path nobody uses.
 * ~600ms of PBKDF2 per call, which is why callers hold the cookie rather than
 * calling again.
 *
 * Returns null when the credentials are refused, so a test can assert a
 * failure without a special case.
 */
export async function signIn(
  apiUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  const kdf = await fetch(`${apiUrl}/api/auth/kdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })
  if (!kdf.ok) return null
  const params = (await kdf.json()) as { salt: string; iterations: number }
  const { authToken } = await deriveAccountSecrets(password, params)

  const derived = await post({ username, auth_token: authToken })
  if (derived) return derived

  // The same fallback the app makes, in the same order and for the same
  // reason: an account the owner console created (or reset) still holds a hash
  // of the plaintext, so no derived token can match it. Mirroring the client
  // here is the point — a helper that signed in a way the app cannot would be
  // testing a path nobody uses.
  return post({ username, password })

  async function post(body: Record<string, string>): Promise<string | null> {
    const response = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status !== 200) return null
    const setCookie = response.headers.get('Set-Cookie')
    return setCookie ? (setCookie.split(';')[0] as string) : null
  }
}
