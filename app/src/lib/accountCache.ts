// Local copy of the signed-in account, so a reload paints the app instead of a
// boot screen.
//
// The session itself lives in an HttpOnly cookie the JS never sees, and
// /api/auth/me is one round trip away — with nothing cached, every reload shows
// a spinner before the first pixel of content. This module keeps the last known
// account row in localStorage and the provider treats it as
// stale-while-revalidate: paint from the copy, then let the server's answer
// overwrite it (or, on 401, drop straight to the login screen).
//
// It is not a credential and it is not authority. Nothing here grants access —
// every request still has to carry the cookie, and a stale copy can at worst
// show the wrong name for one round trip. Which is also why logout clears it:
// the next person on this device must not see the previous one's name.
//
// Theme preferences keep their own copy (hooks/useTheme), because they are
// applied before React mounts and that path must not depend on this one.

import type { SessionUser } from './api'

const STORAGE_KEY = 'goodchat-account'

/** The stored copy, or null when there is none (or it is unreadable). */
export function readCachedAccount(): SessionUser | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<SessionUser>
    // Shape check, not validation: a copy written by an older build can be
    // missing fields the screens index into.
    if (typeof parsed.id !== 'string' || typeof parsed.username !== 'string') return null
    return parsed as SessionUser
  } catch {
    return null
  }
}

export function writeCachedAccount(user: SessionUser): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  } catch {
    // Private mode / quota: boot just goes back to waiting for the server.
  }
}

export function clearCachedAccount(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do — the copy is a cache, not state.
  }
}
