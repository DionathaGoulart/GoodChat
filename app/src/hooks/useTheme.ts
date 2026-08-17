// Theme toggle. Without a stored choice the <html> gets no data-theme and
// daisyUI resolves by prefers-color-scheme (goodchat-dark has prefersdark).
// An explicit toggle pins data-theme and persists it.

import { useCallback, useEffect, useState } from 'react'

export type Theme = 'goodchat-light' | 'goodchat-dark'
const STORAGE_KEY = 'goodchat-theme'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'goodchat-dark'
    : 'goodchat-light'
}

function storedTheme(): Theme | null {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'goodchat-light' || value === 'goodchat-dark' ? value : null
}

/** Effective theme right now (stored choice, else system) — for widgets that
 * cannot inherit CSS through a shadow DOM (e.g. emoji-picker-element). */
export function currentTheme(): Theme {
  return storedTheme() ?? systemTheme()
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme())

  useEffect(() => {
    if (storedTheme()) document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'goodchat-light' ? 'goodchat-dark' : 'goodchat-light'
      localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.setAttribute('data-theme', next)
      return next
    })
  }, [])

  return { theme, toggle }
}
