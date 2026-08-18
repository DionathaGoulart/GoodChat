// Appearance state: a mode (light / dark / follow the system), which palette
// each mode uses, and which skin paints them (lib/skins.ts — `data-skin` on
// <html>). Resolution order is unchanged from the single-pair days:
//   1. the account preference (users.theme_mode / theme_light / theme_dark),
//      which follows the person across devices and survives a PWA reinstall;
//   2. the local copy of that preference, so the first paint has no flash
//      while /api/auth/me is still in flight;
//   3. the catalog defaults, for an account that never picked anything.
//
// The session provider owns the account value and calls applyThemePrefs when
// it arrives; this module only ever touches <html data-theme> / <html
// data-skin>, the theme-color meta and localStorage.
//
// One change the palettes forced: "system" can no longer mean "pin nothing and
// let daisyUI's prefersdark decide" — the OS only says light or dark, it does
// not know which of the four light palettes the person picked. So the
// attribute is always pinned, and in system mode a matchMedia listener repins
// it when the OS flips.

import { useSyncExternalStore } from 'react'
import { DEFAULT_SKIN, skinOr } from '../lib/skins'
import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  darkPaletteOr,
  lightPaletteOr,
  type Mode,
  type ModePreference,
} from '../lib/themes'

export type { Mode, ModePreference }

export interface ThemePrefs {
  mode: ModePreference
  light: string
  dark: string
  /** Skin id — the geometry the palette is painted on (lib/skins.ts). */
  skin: string
}

const STORAGE_KEY = 'goodchat-theme'

export const DEFAULT_PREFS: ThemePrefs = {
  mode: null,
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  skin: DEFAULT_SKIN,
}

function systemMode(): Mode {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Reads the local copy. Values written before the palettes existed were the
 * bare theme name of the old pair; they map onto a mode and keep the person
 * on the palette they already had.
 */
function readStored(): ThemePrefs {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return DEFAULT_PREFS
  }
  if (!raw) return DEFAULT_PREFS
  if (raw === 'goodchat-light') return { ...DEFAULT_PREFS, mode: 'light' }
  if (raw === 'goodchat-dark') return { ...DEFAULT_PREFS, mode: 'dark' }

  try {
    const parsed = JSON.parse(raw) as Partial<ThemePrefs>
    return {
      mode: parsed.mode === 'light' || parsed.mode === 'dark' ? parsed.mode : null,
      light: lightPaletteOr(parsed.light),
      dark: darkPaletteOr(parsed.dark),
      // Copies written before skins existed have none: the default is the look
      // they were already seeing.
      skin: skinOr(parsed.skin),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

let current: ThemePrefs = readStored()
const listeners = new Set<() => void>()

/** Effective mode right now, with "system" already resolved. */
export function currentMode(): Mode {
  return current.mode ?? systemMode()
}

/** The daisyUI theme the current preferences resolve to. */
export function currentThemeName(): string {
  return currentMode() === 'dark' ? current.dark : current.light
}

export function themePrefs(): ThemePrefs {
  return current
}

/**
 * Browser chrome color. A <meta> tag cannot read a CSS variable, so the value
 * is read back off the resolved theme instead of being duplicated as a hex —
 * setAttribute above already forced the style recalc, so base-100 is current.
 */
function paintThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-base-100')
    .trim()
  if (color) meta.setAttribute('content', color)
}

function paint(prefs: ThemePrefs): void {
  const theme = (prefs.mode ?? systemMode()) === 'dark' ? prefs.dark : prefs.light
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-skin', prefs.skin)
  paintThemeColor()
}

/** Applies the local copy at boot, before React mounts. */
export function bootTheme(): void {
  paint(current)
  // In system mode the OS is the input, so keep following it.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current.mode === null) {
      paint(current)
      listeners.forEach((notify) => notify())
    }
  })
}

/** Pins the preferences on <html> and mirrors them locally. */
export function applyThemePrefs(prefs: ThemePrefs): void {
  current = {
    mode: prefs.mode,
    light: lightPaletteOr(prefs.light),
    dark: darkPaletteOr(prefs.dark),
    skin: skinOr(prefs.skin),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // Private mode / quota: the account copy still syncs on the next load.
  }
  paint(current)
  listeners.forEach((notify) => notify())
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

/**
 * Current preferences plus the light/dark flip the header button needs.
 * `toggleMode` writes locally and returns the new value; persisting it to the
 * account is the caller's job (useSession), so a quick toggle stays instant
 * and the network call is not in the way.
 */
export function useTheme(): {
  prefs: ThemePrefs
  mode: Mode
  toggleMode: () => ThemePrefs
} {
  const prefs = useSyncExternalStore(subscribe, themePrefs, themePrefs)
  const mode = prefs.mode ?? systemMode()

  const toggleMode = (): ThemePrefs => {
    const next: ThemePrefs = { ...current, mode: currentMode() === 'dark' ? 'light' : 'dark' }
    applyThemePrefs(next)
    return next
  }

  return { prefs, mode, toggleMode }
}
