// Theme resolution, in priority order:
//   1. the account preference (users.theme), which follows the person across
//      devices and survives a PWA reinstall;
//   2. the local copy of that preference, so the first paint has no flash
//      while /api/auth/me is still in flight;
//   3. prefers-color-scheme, when neither is set — daisyUI resolves it on its
//      own as long as no data-theme attribute is pinned.
//
// The session provider owns the account value and calls applyTheme when it
// arrives; this module only ever touches <html data-theme> and localStorage.

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'goodchat-light' | 'goodchat-dark'
/** null is a real choice: "follow the operating system". */
export type ThemePreference = Theme | null

const STORAGE_KEY = 'goodchat-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'goodchat-dark'
    : 'goodchat-light'
}

export function storedTheme(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'goodchat-light' || value === 'goodchat-dark' ? value : null
}

/** Effective theme right now — for widgets that cannot inherit CSS through a
 * shadow DOM (e.g. emoji-picker-element). */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme()
}

/**
 * Pins (or unpins) the preference on <html> and mirrors it locally. Removing
 * the attribute is what hands control back to prefers-color-scheme, so
 * "sistema" is a real state and not just "light".
 */
export function applyTheme(preference: ThemePreference): void {
  if (preference) {
    document.documentElement.setAttribute('data-theme', preference)
    localStorage.setItem(STORAGE_KEY, preference)
  } else {
    document.documentElement.removeAttribute('data-theme')
    localStorage.removeItem(STORAGE_KEY)
  }
}

/** Applies the local copy at boot, before React mounts. */
export function applyStoredTheme(): void {
  const stored = storedTheme()
  if (stored) document.documentElement.setAttribute('data-theme', stored)
}

/**
 * Light/dark toggle for the header. It writes locally and returns the new
 * value; persisting it to the account is the caller's job (useSession), so a
 * quick toggle stays instant and the network call is not in the way.
 */
export function useTheme(): { theme: Theme; toggle: () => Theme } {
  const [theme, setTheme] = useState<Theme>(() => currentTheme())

  // Follow the OS while no explicit choice is pinned.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (!storedTheme()) setTheme(systemTheme())
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // Another surface (the settings screen) may have changed the attribute.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])

  const toggle = useCallback((): Theme => {
    const next: Theme = currentTheme() === 'goodchat-light' ? 'goodchat-dark' : 'goodchat-light'
    applyTheme(next)
    setTheme(next)
    return next
  }, [])

  return { theme, toggle }
}
