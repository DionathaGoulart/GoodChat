// Skin catalog — the geometry half of the appearance preference.
//
// A palette (lib/themes.ts) decides the colors; a skin decides what those
// colors are painted on: how thick a frame is, whether a panel casts a hard
// offset shadow or a CRT glow, how the caret blinks. The two are independent on
// purpose — every palette works under every skin, so the ten palettes and the
// two skins are twenty looks instead of a list of twenty themes to maintain.
//
// An id here is the `data-skin` value on <html> (styles/skins.css), the value
// stored on the account (users.skin) and the key the worker validates against
// (SKINS in worker/src/routes/settings.ts). One identifier, three places that
// must agree — the worker rejects anything it does not know.
//
// Adding a skin: declare its `[data-skin='<id>']` block in styles/skins.css,
// add it here, and add the id to SKINS in the worker.

export interface SkinOption {
  id: string
  /** Shown in the appearance screen. */
  label: string
  /** One line on what changes — the colors never do. */
  hint: string
}

export const SKINS: readonly SkinOption[] = [
  {
    id: 'retro',
    label: 'neobrutal',
    hint: 'moldura 2px, sombra dura',
  },
  {
    id: 'terminal',
    label: 'terminal',
    hint: 'moldura 1px, brilho crt',
  },
] as const

/** The look the app shipped with, so an account that never chose keeps it. */
export const DEFAULT_SKIN = 'retro'

const SKIN_IDS: readonly string[] = SKINS.map((skin) => skin.id)

export function isSkin(id: string | null | undefined): boolean {
  return !!id && SKIN_IDS.includes(id)
}

/**
 * Falls back to the default whenever the stored value is unknown — a retired
 * skin, or a hand-edited localStorage entry, must not leave the app with a
 * `data-skin` no stylesheet answers to.
 */
export function skinOr(id: string | null | undefined): string {
  return isSkin(id) ? (id as string) : DEFAULT_SKIN
}
