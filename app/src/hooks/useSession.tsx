// Session context: checks GET /api/auth/me on load (persistent cookie
// session), exposes login/logout, the account-level theme preference and the
// profile (display name + picture). `status` drives the App's screen switch.
//
// Boot is stale-while-revalidate: when localStorage holds a copy of the account
// (lib/accountCache.ts) the app starts on `authenticated` with that copy and the
// screens render their own skeletons for the data they still have to fetch. The
// /api/auth/me answer then replaces it, or sends us to the login screen if the
// cookie is gone. Without a copy, `status` starts at 'loading' as before.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import type { SessionUser } from '../lib/api'
import { clearCachedAccount, readCachedAccount, writeCachedAccount } from '../lib/accountCache'
import { disablePush } from '../lib/push'
import { darkPaletteOr, lightPaletteOr } from '../lib/themes'
import { applyThemePrefs, type ThemePrefs } from './useTheme'

type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

interface SessionContextValue {
  status: SessionStatus
  user: SessionUser | null
  isOwner: boolean
  /** Painting from the local copy while /api/auth/me is still in flight. */
  revalidating: boolean
  login: (username: string, password: string) => Promise<void>
  /** Guest signup: creates a throwaway account and signs in with it. */
  loginAsGuest: () => Promise<void>
  /**
   * The guest password, held in memory for this tab only: the worker returns
   * it once at signup and never again, so the app has one chance to show it.
   */
  guestCredentials: { username: string; password: string } | null
  forgetGuestCredentials: () => void
  logout: () => Promise<void>
  /** Persists mode + palettes on the account; the DOM is updated immediately. */
  setTheme: (prefs: ThemePrefs) => Promise<void>
  /** Persists display name and/or profile picture key on the account. */
  setProfile: (patch: { display_name?: string | null; avatar_key?: string | null }) => Promise<void>
}

/** The account row, as the theme module wants it. */
function prefsOf(user: SessionUser): ThemePrefs {
  return {
    mode: user.theme_mode,
    light: lightPaletteOr(user.theme_light),
    dark: darkPaletteOr(user.theme_dark),
  }
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [cached] = useState(readCachedAccount)
  const [status, setStatus] = useState<SessionStatus>(cached ? 'authenticated' : 'loading')
  const [user, setUser] = useState<SessionUser | null>(cached)
  const [revalidating, setRevalidating] = useState(true)
  const [guestCredentials, setGuestCredentials] = useState<{
    username: string
    password: string
  } | null>(null)

  // The account preference is the source of truth: it overwrites whatever the
  // boot-time local copy pinned, including unpinning it back to "system".
  const adopt = useCallback((next: SessionUser) => {
    setUser(next)
    writeCachedAccount(next)
    applyThemePrefs(prefsOf(next))
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then(({ user }) => {
        if (cancelled) return
        adopt(user)
        setStatus('authenticated')
      })
      .catch(() => {
        if (cancelled) return
        // The cookie is gone or was never there: the local copy is worthless.
        clearCachedAccount()
        setUser(null)
        setStatus('anonymous')
      })
      .finally(() => {
        if (!cancelled) setRevalidating(false)
      })
    return () => {
      cancelled = true
    }
  }, [adopt])

  const login = useCallback(
    async (username: string, password: string) => {
      const { user } = await api.login(username, password)
      adopt(user)
      setStatus('authenticated')
    },
    [adopt],
  )

  const loginAsGuest = useCallback(async () => {
    const { user, password } = await api.createTempAccount()
    setGuestCredentials({ username: user.username, password })
    adopt(user)
    setStatus('authenticated')
  }, [adopt])

  const forgetGuestCredentials = useCallback(() => setGuestCredentials(null), [])

  const logout = useCallback(async () => {
    try {
      // Push subscriptions are per-account: drop this browser's one on logout
      // so the next account on this device doesn't receive my notifications.
      // Before api.logout() — the unsubscribe call still needs the session.
      await disablePush()
      await api.logout()
    } finally {
      // Cookie is gone (or was already invalid) — drop local state either way,
      // including the cached copy: the next account here is someone else.
      clearCachedAccount()
      setUser(null)
      setGuestCredentials(null)
      setStatus('anonymous')
    }
  }, [])

  const setTheme = useCallback(async (prefs: ThemePrefs) => {
    // Optimistic: the switch has to feel instant, and a failed write only
    // costs the cross-device sync, which the next successful one repairs.
    applyThemePrefs(prefs)
    setUser((current) => {
      if (!current) return current
      const next = {
        ...current,
        theme_mode: prefs.mode,
        theme_light: prefs.light,
        theme_dark: prefs.dark,
      }
      writeCachedAccount(next)
      return next
    })
    await api.updateSettings(prefs)
  }, [])

  const setProfile = useCallback(
    async (patch: { display_name?: string | null; avatar_key?: string | null }) => {
      // Not optimistic: the worker is the one that decides whether the avatar
      // key is adoptable, and a name that failed to save must not look saved.
      const { user } = await api.updateProfile(patch)
      adopt(user)
    },
    [adopt],
  )

  const value = useMemo(
    () => ({
      status,
      user,
      isOwner: user?.role === 'owner',
      revalidating,
      login,
      loginAsGuest,
      guestCredentials,
      forgetGuestCredentials,
      logout,
      setTheme,
      setProfile,
    }),
    [
      status,
      user,
      revalidating,
      login,
      loginAsGuest,
      guestCredentials,
      forgetGuestCredentials,
      logout,
      setTheme,
      setProfile,
    ],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
