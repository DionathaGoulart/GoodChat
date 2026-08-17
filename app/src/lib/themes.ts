// Palette catalog — the list the settings screen renders and the only place
// that knows which themes exist on the client.
//
// An id here is three things at once: the daisyUI theme name (the `data-theme`
// value), the value stored on the account (users.theme_light / theme_dark) and
// the key the worker validates against. One identifier, no mapping table.
//
// The swatch colors point at the same `--palette-*` variables the themes are
// built from (styles/palettes.css), so a preview can never drift from the
// palette it previews — and no hex value leaks outside palettes.css.
//
// Adding a palette: declare the theme in styles/themes.css, add it here, and
// add the id to LIGHT_THEMES / DARK_THEMES in worker/src/routes/settings.ts.
// The worker rejects anything it does not know, so all three must agree.

export type Mode = 'light' | 'dark'
/** null is a real choice: "follow the operating system". */
export type ModePreference = Mode | null

export interface PaletteOption {
  id: string
  /** Shown in the settings screen. */
  label: string
  /** Swatch: page background, accent, foreground. */
  bg: string
  acc: string
  fg: string
}

export const LIGHT_PALETTES: readonly PaletteOption[] = [
  {
    id: 'goodchat-crimson',
    label: 'crimson chalk',
    bg: 'var(--palette-cream)',
    acc: 'var(--palette-crimson)',
    fg: 'var(--palette-ink)',
  },
  {
    id: 'goodchat-frost',
    label: 'abyss frost',
    bg: 'var(--palette-frost-bg)',
    acc: 'var(--palette-abyss)',
    fg: 'var(--palette-frost-ink)',
  },
  {
    id: 'goodchat-forest',
    label: 'forest mist',
    bg: 'var(--palette-forest-bg)',
    acc: 'var(--palette-forest-green)',
    fg: 'var(--palette-forest-ink)',
  },
  {
    id: 'goodchat-sand',
    label: 'sand dusk',
    bg: 'var(--palette-sand-bg)',
    acc: 'var(--palette-copper)',
    fg: 'var(--palette-sand-ink)',
  },
] as const

export const DARK_PALETTES: readonly PaletteOption[] = [
  {
    id: 'goodchat-rose',
    label: 'noir rose',
    bg: 'var(--palette-noir)',
    acc: 'var(--palette-rose)',
    fg: 'var(--palette-cream)',
  },
  {
    id: 'goodchat-gold',
    label: 'vault gold',
    bg: 'var(--palette-graphite)',
    acc: 'var(--palette-gold)',
    fg: 'var(--palette-silver)',
  },
  {
    id: 'goodchat-ember',
    label: 'midnight ember',
    bg: 'var(--palette-midnight)',
    acc: 'var(--palette-ember)',
    fg: 'var(--palette-mint)',
  },
  {
    id: 'goodchat-cyan',
    label: 'cyber teal',
    bg: 'var(--palette-cyan-bg)',
    acc: 'var(--palette-cyan)',
    fg: 'var(--palette-cyan-mist)',
  },
  {
    id: 'goodchat-violet',
    label: 'velvet purple',
    bg: 'var(--palette-violet-bg)',
    acc: 'var(--palette-violet)',
    fg: 'var(--palette-violet-mist)',
  },
  {
    id: 'goodchat-matrix',
    label: 'neon matrix',
    bg: 'var(--palette-black)',
    acc: 'var(--palette-matrix-green)',
    fg: 'var(--palette-matrix-mist)',
  },
] as const

/** The pair the app shipped with, so an account that never chose keeps it. */
export const DEFAULT_LIGHT = 'goodchat-crimson'
export const DEFAULT_DARK = 'goodchat-rose'

const LIGHT_IDS: readonly string[] = LIGHT_PALETTES.map((p) => p.id)
const DARK_IDS: readonly string[] = DARK_PALETTES.map((p) => p.id)

export function isLightPalette(id: string | null | undefined): boolean {
  return !!id && LIGHT_IDS.includes(id)
}

export function isDarkPalette(id: string | null | undefined): boolean {
  return !!id && DARK_IDS.includes(id)
}

/**
 * Falls back to the default whenever the stored value is unknown — a palette
 * removed from the catalog, or a hand-edited localStorage entry, must not
 * leave the app with a `data-theme` no stylesheet answers to.
 */
export function lightPaletteOr(id: string | null | undefined): string {
  return isLightPalette(id) ? (id as string) : DEFAULT_LIGHT
}

export function darkPaletteOr(id: string | null | undefined): string {
  return isDarkPalette(id) ? (id as string) : DEFAULT_DARK
}
