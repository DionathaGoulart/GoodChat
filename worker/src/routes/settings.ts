// PATCH /api/settings — per-account preferences, currently the theme default.
//
// Why it lives on the account and not only in localStorage: a session follows
// the person, not the browser. Signing in on a phone should land on the theme
// they picked on the desktop, and a PWA reinstall should not reset it. The
// client still keeps a local copy so the very first paint has no flash — the
// account value is the source of truth and overwrites it on session load.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { requireSession, sessionHeaders } from '../lib/session'

/** Matches the daisyUI themes declared in app/src/index.css. */
export const THEMES = ['goodchat-light', 'goodchat-dark'] as const

const SettingsSchema = z.object({
  // null is a real value here: "follow the operating system".
  theme: z.enum(THEMES).nullable(),
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
    return apiError('invalid_request', 400, `theme must be null or one of ${THEMES.join(', ')}`)
  }

  await env.DB.prepare('UPDATE users SET theme = ? WHERE id = ?')
    .bind(parsed.data.theme, auth.user.id)
    .run()

  return json({ user: { ...auth.user, theme: parsed.data.theme } }, 200, sessionHeaders(auth))
}
