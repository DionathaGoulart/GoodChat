// Shared helpers for the admin CLI scripts. Runs on plain Node ≥24 (native
// type stripping) — no build step. Reuses src/lib/password.ts so CLI-created
// hashes match exactly what the Worker verifies, and src/lib/users.ts so the
// CLI and the owner panel enforce the same account rules.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { hashPassword } from '../src/lib/password.ts'
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

  const hash = await hashPassword(password)
  const conflict = ignoreExisting ? 'OR IGNORE ' : ''
  d1Execute(
    `INSERT ${conflict}INTO users (id, username, display_name, avatar_url, password_hash, created_at, role) ` +
      `VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(canonical)}, ${sqlString(displayName)}, NULL, ${sqlString(hash)}, ${Date.now()}, ${sqlString(role)});`,
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
