// Shared helpers for the admin CLI scripts. Runs on plain Node ≥24 (native
// type stripping) — no build step. Reuses src/lib/password.ts so CLI-created
// hashes match exactly what the Worker verifies.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { hashPassword } from '../src/lib/password.ts'

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Usernames are case-insensitive everywhere (the column is COLLATE NOCASE and
// login/lookup lowercase their input), so they are stored canonically in
// lowercase — "GOOD", "Good" and "good" are one account.
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/

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
  { ignoreExisting = false, remote = false } = {},
): Promise<void> {
  const canonical = username.trim().toLowerCase()
  if (!USERNAME_RE.test(canonical)) {
    throw new Error(`invalid username "${username}" (expected ${USERNAME_RE}, case-insensitive)`)
  }
  if (password.length < 8) {
    throw new Error('password must have at least 8 characters')
  }
  const hash = await hashPassword(password)
  const conflict = ignoreExisting ? 'OR IGNORE ' : ''
  d1Execute(
    `INSERT ${conflict}INTO users (id, username, display_name, avatar_url, password_hash, created_at) ` +
      `VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(canonical)}, ${sqlString(displayName)}, NULL, ${sqlString(hash)}, ${Date.now()});`,
    { remote },
  )
}
