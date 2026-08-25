// Session context: checks GET /api/auth/me on load (persistent cookie
// session), exposes login/logout, the account-level theme preference and the
// profile (display name + picture). `status` drives the App's screen switch.
//
// Boot is stale-while-revalidate: when localStorage holds a copy of the account
// (lib/accountCache.ts) the app starts on `authenticated` with that copy and the
// screens render their own skeletons for the data they still have to fetch. The
// /api/auth/me answer then replaces it, or sends us to the login screen if the
// cookie is gone. Without a copy, `status` starts at 'loading' as before.
//
// "The cookie is gone" and "there is no network" are different answers, and only
// the first one is a reason to drop the local copies. A failed fetch (status 0,
// `network_error`) leaves the session where it was: with a cached account the
// app stays usable offline — which is the point of a PWA — and revalidation is
// retried when the browser says the connection is back. Without one there is
// nothing to show either way, so it falls through to the login screen. Only a
// real 401/403 forgets anything.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from '../lib/api'
import type { PushPreview, SessionUser } from '../lib/api'
import { ApiError } from '../lib/api'
import type { LoginResult } from '../lib/api'
import { clearCachedAccount, readCachedAccount, writeCachedAccount } from '../lib/accountCache'
import {
  adoptAccountKey,
  createAccountKey,
  readAccountKey,
  wipeAccountKeys,
} from '../lib/accountKeys'
import { ensureDeviceKey, wipeDeviceKeys } from '../lib/deviceKeys'
import { clearCachedConversations } from '../lib/conversationsCache'
import { clearDrafts } from '../lib/drafts'
import { clearCachedThreads, pruneCachedMessages } from '../lib/threadCache'
import { startHeartbeat } from '../lib/presence'
import { disablePush } from '../lib/push'
import { deriveAccountSecrets, newKdfParams } from '../lib/kdf'
import { skinOr } from '../lib/skins'
import { darkPaletteOr, lightPaletteOr } from '../lib/themes'
import { applyThemePrefs, type ThemePrefs } from './useTheme'

type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

interface SessionContextValue {
  status: SessionStatus
  user: SessionUser | null
  isOwner: boolean
  /** Painting from the local copy while /api/auth/me is still in flight. */
  revalidating: boolean
  /**
   * Signs in without the password ever leaving the browser (lib/kdf.ts). Falls
   * back to sending it for an account that has not rotated yet, and only after
   * the derived attempt was refused — see `login` below.
   */
  login: (username: string, password: string) => Promise<void>
  /**
   * Guest signup: creates a throwaway account and signs in with it. Nothing
   * comes back to show — a guest has no password (worker/src/lib/accounts.ts),
   * so this tab is the only way into that account and logging out ends it.
   */
  loginAsGuest: () => Promise<void>
  logout: () => Promise<void>
  /**
   * The one-time move off a password the worker knows (`user.must_rotate`).
   * Takes the current password, which the worker still has to verify the old
   * way, and a new one, which it only ever sees derived.
   */
  rotatePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** Persists mode, palettes and skin on the account; the DOM updates at once. */
  setTheme: (prefs: ThemePrefs) => Promise<void>
  /** Persists display name and/or profile picture key on the account. */
  setProfile: (patch: { display_name?: string | null; avatar_key?: string | null }) => Promise<void>
  /**
   * How much of a message this account allows in a push notification. Stored on
   * the account, not the browser: the notification lands on whichever device
   * holds a subscription, and the choice is about the person, not the tab.
   */
  setPushPreview: (preview: PushPreview) => Promise<void>
}

/** The account row, as the theme module wants it. */
function prefsOf(user: SessionUser): ThemePrefs {
  return {
    mode: user.theme_mode,
    light: lightPaletteOr(user.theme_light),
    dark: darkPaletteOr(user.theme_dark),
    skin: skinOr(user.skin),
  }
}

/**
 * Everything this browser holds on behalf of the signed-in account. Both ways
 * out of a session call it — a cookie that turned out to be gone, and a real
 * logout — because a copy that survives one of them is a copy the next account
 * on this device can read. One function so the next cache added is wired into
 * both exits or neither.
 */
function forgetLocalState(): void {
  clearCachedAccount()
  clearCachedConversations()
  clearCachedThreads()
  clearDrafts()
  // The encryption identities go with them, and for the same reason: the next
  // account on this browser must not hold the previous one's key. Nothing is
  // lost either — the account key's wrapped copy is on the server, and the
  // next sign-in unwraps it again (lib/accountKeys.ts).
  void wipeDeviceKeys()
  void wipeAccountKeys()
}

/**
 * Puts this account's key in this browser, whatever state it is in.
 *
 * Three cases, and the order is what makes them distinguishable:
 *
 *   - the browser already holds it — a second sign-in on the same machine, or
 *     a tab that raced another one. Nothing to do.
 *   - the server has a wrapped copy — unwrap it with the `wrapKey` derived a
 *     moment ago. This is the case the whole design exists for: a browser that
 *     has never seen this account walks away with the key that opens its
 *     entire history.
 *   - neither — mint one, publish it, keep it. First sign-in of an account
 *     that predates all this, or a guest.
 *
 * Best effort throughout. A browser with no IndexedDB (private mode, or one
 * that refuses it) gets no key and the app keeps working unencrypted for the
 * length of the transition, exactly as it does without a device key.
 *
 * The one failure worth naming: a wrapped copy that does not open. It means
 * the blob was sealed under a `wrapKey` nobody derives anymore, which is what
 * the owner's password reset leaves behind — so a fresh pair is minted, and
 * the history sealed to the old one is gone. `publishAccountKey` is
 * create-only and will refuse that write; replacing a key is the password
 * routes' job, not this one's.
 */
async function installAccountKey(user: SessionUser, result: LoginResult, wrapKey: CryptoKey | null) {
  if (await readAccountKey(user.id)) return
  if (result.account_key && wrapKey) {
    if (await adoptAccountKey(user.id, wrapKey, result.account_key)) return
  }
  if (result.account_key) return
  const created = await createAccountKey(user.id, wrapKey)
  if (!created) return
  try {
    await api.publishAccountKey(created.published)
  } catch (error) {
    // 409: another tab published first. Its key is the account's; this one's
    // is scrap. The next sign-in unwraps the winner's, and until then this
    // browser simply has a key nobody encrypts to — which reads as an
    // unencrypted thread rather than as a broken one.
    if (!(error instanceof ApiError) || error.code !== 'account_key_exists') throw error
    await wipeAccountKeys()
  }
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [cached] = useState(readCachedAccount)
  const [status, setStatus] = useState<SessionStatus>(cached ? 'authenticated' : 'loading')
  const [user, setUser] = useState<SessionUser | null>(cached)
  const [revalidating, setRevalidating] = useState(true)

  // The account preference is the source of truth: it overwrites whatever the
  // boot-time local copy pinned, including unpinning it back to "system".
  const adopt = useCallback((next: SessionUser) => {
    setUser(next)
    writeCachedAccount(next)
    applyThemePrefs(prefsOf(next))
  }, [])

  useEffect(() => {
    let cancelled = false
    let retryOnline: (() => void) | null = null

    const revalidate = () => {
      api
        .me()
        .then(({ user }) => {
          if (cancelled) return
          adopt(user)
          setStatus('authenticated')
        })
        .catch((error: unknown) => {
          if (cancelled) return
          // Offline is not a verdict on the session: the request never reached
          // the worker, so the cookie may well still be good. Keep the local
          // copy, stay signed in, and ask again when the network is back.
          const unreachable = error instanceof ApiError && error.status === 0
          if (unreachable && cached) {
            const onOnline = () => {
              retryOnline = null
              revalidate()
            }
            retryOnline = onOnline
            addEventListener('online', onOnline, { once: true })
            return
          }
          // A real 401/403 — or no local copy to fall back on: the cookie is
          // gone or was never there, and the copies are worthless.
          forgetLocalState()
          setUser(null)
          setStatus('anonymous')
        })
        .finally(() => {
          if (!cancelled) setRevalidating(false)
        })
    }

    revalidate()
    return () => {
      cancelled = true
      if (retryOnline) removeEventListener('online', retryOnline)
    }
  }, [adopt, cached])

  // Expiry applies to the local copies too, and the read/write pruning in
  // lib/threadCache.ts only ever reaches the thread being opened.
  // One pass over every bucket per boot covers the threads nobody opens again.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return
    pruneCachedMessages(user.id)
  }, [status, user])

  // This device's encryption identity, created on first sign-in and re-announced
  // on every load. Announcing again is what keeps it out of the directory sweep
  // (worker/src/lib/cleanup.ts) — a browser that stops coming back is a public
  // key whose private half nobody holds, and senders should stop paying for it.
  //
  // Best effort by design: a browser with no IndexedDB (private mode, or one
  // that refuses it) gets no identity, and the app keeps working unencrypted for
  // the length of the transition rather than refusing to open.
  useEffect(() => {
    if (status !== 'authenticated' || !user) return
    let cancelled = false
    void (async () => {
      const identity = await ensureDeviceKey(user.id)
      if (!identity || cancelled) return
      try {
        await api.registerDevice(identity.id, identity.publicKey)
      } catch {
        // Offline, or the worker refused. The next load tries again; until it
        // lands, peers simply do not encrypt to this device.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [status, user])

  // Presence is a property of the session, not of any screen: while somebody is
  // signed in this tab beats (lib/presence.ts), which is what makes them show
  // as online to everyone else — the list, a thread, or an idle tab alike.
  useEffect(() => {
    if (status !== 'authenticated') return
    return startHeartbeat()
  }, [status])

  /**
   * Two requests before the login, and a possible third after it.
   *
   * `/api/auth/kdf` first, because the derivation needs a salt and the salt is
   * per account. Then the derived token. If that is refused, the account may
   * simply not have rotated yet (migration 0013) — its stored hash is of the
   * plaintext, so no derived token could ever match it — and the password goes
   * the old way, once.
   *
   * Ordered that way on purpose: an unknown username and a real account with
   * the wrong password both take the same two refusals, so the sequence says
   * nothing about which one it was. Reversing it — asking "has this account
   * rotated?" first — would answer "does this account exist?" along the way.
   *
   * The `wrapKey` that comes out of the same derivation is dropped here. It is
   * what unwraps the account key, which does not exist yet; the derivation
   * stays a single call so that when it does, there is one place to thread it
   * through and no second 600ms round of PBKDF2.
   */
  const login = useCallback(
    async (username: string, password: string) => {
      const params = await api.kdfParams(username)
      const { authToken, wrapKey } = await deriveAccountSecrets(password, params)
      let result: LoginResult
      try {
        result = await api.login(username, authToken)
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'invalid_credentials') throw error
        result = await api.loginLegacy(username, password)
      }
      // Before the screen switches, not after: every surface behind it opens a
      // thread, and a thread that paints before the key lands is a column of
      // placeholders that nothing forces it to repaint.
      //
      // Skipped for an account still on the legacy hash — `wrapKey` there was
      // derived against a decoy salt and means nothing. The rotation screen is
      // what comes next, and that is where its key is minted.
      if (!result.user.must_rotate) {
        await installAccountKey(result.user, result, wrapKey)
      }
      adopt(result.user)
      setStatus('authenticated')
    },
    [adopt],
  )

  /**
   * The rotation. A new password, derived here; the old one sent in the clear
   * one last time because the worker holds a hash of exactly that and has
   * nothing else to check against.
   *
   * `/api/auth/me` afterwards rather than trusting the local copy: the flag
   * this clears is what the whole app is gated on, and a stale `true` would
   * leave somebody staring at the rotation form they just completed.
   */
  const rotatePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!user) return
      const params = newKdfParams()
      const { authToken, wrapKey } = await deriveAccountSecrets(newPassword, params)
      // A whole key, not a rewrap. An account arriving here either never had
      // one, or had one sealed under a `wrapKey` that is gone — the owner reset
      // its password, which is the only other thing that sets `must_rotate`.
      // Either way there is nothing to re-seal, and the history sealed to a
      // previous key does not come back.
      const created = await createAccountKey(user.id, wrapKey)
      if (!created) throw new ApiError('no_keystore', 0, 'este navegador não guarda chaves')
      await api.rotatePassword({
        current_password: currentPassword,
        auth_token: authToken,
        kdf_salt: params.salt,
        kdf_iterations: params.iterations,
        account_key: created.published,
      })
      const { user: next } = await api.me()
      adopt(next)
    },
    [adopt, user],
  )

  const loginAsGuest = useCallback(async () => {
    const result = await api.createTempAccount()
    // No password, so no `wrapKey` and nothing wrapped: the private half stays
    // in this browser and only the public one is published. A guest has one
    // device by definition, which is the one case where the per-device model
    // this replaced was the right one all along.
    await installAccountKey(result.user, result, null)
    adopt(result.user)
    setStatus('authenticated')
  }, [adopt])

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
      forgetLocalState()
      setUser(null)
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
        skin: prefs.skin,
      }
      writeCachedAccount(next)
      return next
    })
    await api.updateSettings(prefs)
  }, [])

  const setPushPreview = useCallback(
    async (preview: PushPreview) => {
      // The route writes the whole appearance set on every call, so the current
      // values ride along unchanged — there is no read-modify-write server side.
      const current = user
      if (!current) return
      const { user: next } = await api.updateSettings({
        ...prefsOf(current),
        pushPreview: preview,
      })
      adopt(next)
    },
    [adopt, user],
  )

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
      logout,
      rotatePassword,
      setTheme,
      setProfile,
      setPushPreview,
    }),
    [
      status,
      user,
      revalidating,
      login,
      loginAsGuest,
      logout,
      rotatePassword,
      setTheme,
      setProfile,
      setPushPreview,
    ],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
