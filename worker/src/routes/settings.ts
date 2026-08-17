// PATCH /api/settings — per-account preferences, currently the theme.
//
// Why it lives on the account and not only in localStorage: a session follows
// the person, not the browser. Signing in on a phone should land on the theme
// they picked on the desktop, and a PWA reinstall should not reset it. The
// client still keeps a local copy so the very first paint has no flash — the
// account value is the source of truth and overwrites it on session load.
//
// The theme is three values: a mode (null = follow the OS) and the palette
// each mode uses. They are written together on every call — the settings
// screen always knows the whole triple, so a full write keeps this route free
// of read-modify-write.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { requireSession, sessionHeaders } from '../lib/session'

/**
 * The daisyUI themes declared in app/src/styles/themes.css, split by the mode
 * they belong to — a light palette in the dark slot would make the header
 * toggle a no-op. Keep in sync with app/src/lib/themes.ts.
 */
export const LIGHT_THEMES = [
  'goodchat-crimson',
  'goodchat-frost',
  'goodchat-forest',
  'goodchat-sand',
] as const

export const DARK_THEMES = [
  'goodchat-rose',
  'goodchat-gold',
  'goodchat-ember',
  'goodchat-cyan',
  'goodchat-violet',
  'goodchat-matrix',
] as const

const SettingsSchema = z.object({
  // null is a real value here: "follow the operating system".
  theme_mode: z.enum(['light', 'dark']).nullable(),
  theme_light: z.enum(LIGHT_THEMES),
  theme_dark: z.enum(DARK_THEMES),
})

export async function updateSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = SettingsSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      400,
      `theme_mode must be null, "light" or "dark"; theme_light one of ${LIGHT_THEMES.join(', ')}; theme_dark one of ${DARK_THEMES.join(', ')}`,
    )
  }

  const { theme_mode, theme_light, theme_dark } = parsed.data
  await env.DB.prepare(
    'UPDATE users SET theme_mode = ?, theme_light = ?, theme_dark = ? WHERE id = ?',
  )
    .bind(theme_mode, theme_light, theme_dark, auth.user.id)
    .run()

  return json(
    { user: { ...auth.user, theme_mode, theme_light, theme_dark } },
    200,
    sessionHeaders(auth),
  )
}
