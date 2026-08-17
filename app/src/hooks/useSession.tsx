// Session context: checks GET /api/auth/me on load (persistent cookie
// session), exposes login/logout. `status` drives the App's screen switch.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import type { PublicUser } from '../lib/api'
import { disablePush } from '../lib/push'

type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

interface SessionContextValue {
  status: SessionStatus
  user: PublicUser | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [user, setUser] = useState<PublicUser | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then(({ user }) => {
        if (cancelled) return
        setUser(user)
        setStatus('authenticated')
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password)
    setUser(user)
    setStatus('authenticated')
  }, [])

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

  const value = useMemo(
    () => ({ status, user, login, logout }),
    [status, user, login, logout],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
