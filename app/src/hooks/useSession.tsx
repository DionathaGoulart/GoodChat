// Session context: checks GET /api/auth/me on load (persistent cookie
// session), exposes login/logout and the account-level theme preference.
// `status` drives the App's screen switch.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import type { SessionUser } from '../lib/api'
import { disablePush } from '../lib/push'
import { applyTheme, type ThemePreference } from './useTheme'

type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

interface SessionContextValue {
  status: SessionStatus
  user: SessionUser | null
  isOwner: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Persists the theme on the account; the DOM is updated immediately. */
  setTheme: (preference: ThemePreference) => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)

  // The account preference is the source of truth: it overwrites whatever the
  // boot-time local copy pinned, including unpinning it back to "system".
  const adopt = useCallback((next: SessionUser) => {
    setUser(next)
    applyTheme(next.theme)
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
        if (!cancelled) setStatus('anonymous')
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

  const logout = useCallback(async () => {
    try {
      // Push subscriptions are per-account: drop this browser's one on logout
      // so the next account on this device doesn't receive my notifications.
      // Before api.logout() — the unsubscribe call still needs the session.
      await disablePush()
      await api.logout()
    } finally {
      // Cookie is gone (or was already invalid) — drop local state either way.
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const setTheme = useCallback(async (preference: ThemePreference) => {
    // Optimistic: the switch has to feel instant, and a failed write only
    // costs the cross-device sync, which the next successful one repairs.
    applyTheme(preference)
    setUser((current) => (current ? { ...current, theme: preference } : current))
    await api.updateSettings(preference)
  }, [])

  const value = useMemo(
    () => ({
      status,
      user,
      isOwner: user?.role === 'owner',
      login,
      logout,
      setTheme,
    }),
    [status, user, login, logout, setTheme],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
