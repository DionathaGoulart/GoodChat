// Account rules shared by the Worker (routes/admin.ts) and the admin CLI
// (scripts/lib.ts), so a user created from the owner panel is byte-for-byte
// the same row as one created from the terminal.
//
// Usernames are case-insensitive everywhere (the column is COLLATE NOCASE and
// login/lookup lowercase their input), so they are stored canonically in
// lowercase — "GOOD", "Good" and "good" are one account.

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/

/**
 * Mirrors MIN_PASSWORD_LENGTH in app/src/lib/kdf.ts, and only applies where the
 * server still sees a password at all: the owner console and the CLI. On the
 * paths where the browser derives (`/api/auth/rotate`, `/api/auth/password`)
 * the worker receives a fixed-length token and has nothing to measure — the
 * client constant is the whole of the rule there.
 *
 * Twelve rather than eight because of what a password now protects. It used to
 * buy a login, which a rate limiter defends. It now also wraps the account key
 * (migration 0014), against somebody holding a copy of D1 and no rate limiter
 * — offline, at whatever rate their hardware runs.
 */
export const MIN_PASSWORD_LENGTH = 12
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
