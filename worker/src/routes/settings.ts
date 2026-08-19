// PATCH /api/settings — per-account preferences, currently the theme.
//
// Why it lives on the account and not only in localStorage: a session follows
// the person, not the browser. Signing in on a phone should land on the theme
// they picked on the desktop, and a PWA reinstall should not reset it. The
// client still keeps a local copy so the very first paint has no flash — the
// account value is the source of truth and overwrites it on session load.
//
// The theme is three values: a mode (null = follow the OS) and the palette
// each mode uses. They are written together on every call — the appearance
// screen always knows the whole triple, so a full write keeps this route free
// of read-modify-write.
//
// The skin (migration 0007) is the fourth value: which geometry the palette is
// painted on. It is optional in the body — a client that does not send it keeps
// whatever the account already has, and the session row this route already
// holds supplies that value without a second read.
//
// `push_preview` (migration 0010) rides along for the same reason the theme
// does: it is a property of the person, not of the browser. It decides how much
// of a message may be printed in a device notification — the one copy of a
// message that outlives the retention window, because the notification centre
// has no window of its own (lib/push.ts). Optional here too, same rule.

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

/**
 * The skins declared in app/src/styles/skins.css and catalogued in
 * app/src/lib/skins.ts. Keep the three in sync — this list is what the account
 * is allowed to store, so a skin missing here cannot be chosen.
 */
export const SKINS = ['retro', 'terminal'] as const

export const PUSH_PREVIEWS = ['generic', 'full'] as const

const SettingsSchema = z.object({
  // null is a real value here: "follow the operating system".
  theme_mode: z.enum(['light', 'dark']).nullable(),
  theme_light: z.enum(LIGHT_THEMES),
  theme_dark: z.enum(DARK_THEMES),
  // Absent means "leave it alone"; null means "back to the default skin".
  skin: z.enum(SKINS).nullish(),
  // Same rule; null means "back to the default preview", which is 'generic'.
  push_preview: z.enum(PUSH_PREVIEWS).nullish(),
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
      `theme_mode must be null, "light" or "dark"; theme_light one of ${LIGHT_THEMES.join(', ')}; theme_dark one of ${DARK_THEMES.join(', ')}; skin one of ${SKINS.join(', ')}; push_preview one of ${PUSH_PREVIEWS.join(', ')}`,
    )
  }

  const { theme_mode, theme_light, theme_dark } = parsed.data
  const skin = parsed.data.skin === undefined ? auth.user.skin : parsed.data.skin
  const pushPreview =
    parsed.data.push_preview === undefined ? auth.user.push_preview : parsed.data.push_preview
  await env.DB.prepare(
    `UPDATE users SET theme_mode = ?, theme_light = ?, theme_dark = ?, skin = ?,
                      push_preview = ?
     WHERE id = ?`,
  )
    .bind(theme_mode, theme_light, theme_dark, skin, pushPreview, auth.user.id)
    .run()

  return json(
    {
      user: {
        ...auth.user,
        theme_mode,
        theme_light,
        theme_dark,
        skin,
        push_preview: pushPreview,
      },
    },
    200,
    sessionHeaders(auth),
  )
}
