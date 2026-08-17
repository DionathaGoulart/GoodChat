// Account rules shared by the Worker (routes/admin.ts) and the admin CLI
// (scripts/lib.ts), so a user created from the owner panel is byte-for-byte
// the same row as one created from the terminal.
//
// Usernames are case-insensitive everywhere (the column is COLLATE NOCASE and
// login/lookup lowercase their input), so they are stored canonically in
// lowercase — "GOOD", "Good" and "good" are one account.

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const MIN_PASSWORD_LENGTH = 8
export const ROLES = ['owner', 'user'] as const
export type Role = (typeof ROLES)[number]

export function canonicalUsername(username: string): string {
  return username.trim().toLowerCase()
}

/** Human-readable reason, or null when the pair is acceptable. */
export function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_RE.test(canonicalUsername(username))) {
    return 'username must be 3-20 chars of a-z, 0-9 or _'
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must have at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}
