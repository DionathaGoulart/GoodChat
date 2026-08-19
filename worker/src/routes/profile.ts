// PATCH /api/profile — the two things about an account its owner can change:
// the display name and the profile picture.
//
// Why it is not /api/settings: settings writes the whole theme triple every
// call because the settings screen always knows all of it. A profile write is
// the opposite — the name form and the picture picker fire independently, so
// both fields are optional and only what is present is written.
//
// The picture arrives as a key, not as bytes: the client uploads to the bucket
// through the presigned PUT (POST /api/media/upload-url with
// `purpose: "avatar"`) and then hands the key over here. So this route's job is
// to decide whether the caller may point their row at that key, and to keep the
// bucket honest:
//
//   - the key must be an `avatars/` object this account uploaded. Anything else
//     — someone else's avatar, a message attachment, a key that was never
//     presigned — is a 400. Without that check, `avatar_key` would be a way to
//     publish any object in the bucket to the whole instance, since an adopted
//     avatar is readable by every session (routes/media.ts);
//   - adopting the key claims its index row, which is what takes it out of the
//     orphan sweep's reach (an unclaimed upload is garbage after 24h);
//   - the picture it replaces is deleted from the bucket right here. A profile
//     picture has exactly one referent, so the old object is unreachable the
//     moment the row moves — nothing else would ever collect it.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { deleteObject, isAvatarKey, isValidObjectKey, mediaConfig } from '../lib/media'
import { findObject, forgetKeys } from '../lib/mediaIndex'
import { forgetCachedObject } from '../lib/mediaGc'
import { requireSession, sessionHeaders } from '../lib/session'

export const MAX_DISPLAY_NAME_LENGTH = 64

const ProfileSchema = z.object({
  /**
   * null (or blank) clears it — the UI then falls back to @username, which is
   * what an account that never set a name already shows.
   */
  display_name: z.string().trim().max(MAX_DISPLAY_NAME_LENGTH).nullable().optional(),
  /** null removes the picture (and deletes the object). */
  avatar_key: z.string().min(1).max(255).nullable().optional(),
})

export async function updateProfile(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = ProfileSchema.safeParse(body)
  if (!parsed.success) {
    return apiError(
      'invalid_request',
      400,
      `display_name must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters (or null); avatar_key must be an uploaded avatar key (or null)`,
    )
  }
  if (parsed.data.display_name === undefined && parsed.data.avatar_key === undefined) {
    return apiError('invalid_request', 400, 'nothing to update')
  }

  const sets: string[] = []
  const bindings: unknown[] = []

  // Blank and null are the same request: "no name of my own".
  const nextName =
    parsed.data.display_name === undefined
      ? undefined
      : parsed.data.display_name === null || parsed.data.display_name.length === 0
        ? null
        : parsed.data.display_name
  if (nextName !== undefined) {
    sets.push(`display_name = ?${sets.length + 1}`)
    bindings.push(nextName)
  }

  const previousKey = auth.user.avatar_key
  let nextKey: string | null | undefined
  if (parsed.data.avatar_key !== undefined) {
    nextKey = parsed.data.avatar_key
    if (nextKey !== null && nextKey !== previousKey) {
      const owned = await ownedAvatar(env, nextKey, auth.user.id)
      if (!owned) return apiError('invalid_request', 400, 'avatar_key is not an upload of yours')
      // Claimed = adopted: the orphan sweep leaves it alone from now on, and
      // routes/media.ts starts serving it to the rest of the instance.
      await env.DB.prepare(
        'UPDATE media_objects SET claimed_at = ?1 WHERE key = ?2 AND user_id = ?3',
      )
        .bind(Date.now(), nextKey, auth.user.id)
        .run()
    }
    sets.push(`avatar_key = ?${sets.length + 1}`)
    bindings.push(nextKey)
  }

  bindings.push(auth.user.id)
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${bindings.length}`)
    .bind(...bindings)
    .run()

  // After the row moved, so a failed delete leaves an orphan object instead of
  // an account pointing at bytes that are gone.
  if (nextKey !== undefined && previousKey && previousKey !== nextKey) {
    await discardAvatar(env, previousKey, new URL(request.url).origin)
  }

  const user = {
    ...auth.user,
    display_name: nextName === undefined ? auth.user.display_name : nextName,
    avatar_key: nextKey === undefined ? auth.user.avatar_key : nextKey,
  }
  return json({ user }, 200, sessionHeaders(auth))
}

/** True when `key` is an `avatars/` object this account presigned. */
async function ownedAvatar(env: Env, key: string, userId: string): Promise<boolean> {
  if (!isValidObjectKey(key) || !isAvatarKey(key)) return false
  const row = await findObject(env.DB, key)
  return row !== null && row.user_id === userId
}

/** Drops a replaced picture from the bucket, the index and the edge cache. */
async function discardAvatar(env: Env, key: string, origin: string): Promise<void> {
  const config = mediaConfig(env)
  if (!config) return
  try {
    if (await deleteObject(config, key)) {
      await forgetKeys(env.DB, [key])
      await forgetCachedObject(origin, key)
    }
  } catch (error) {
    // The row stays indexed, so the account keeps being charged for it and a
    // later account deletion still finds it. Not worth failing the rename over.
    console.error('avatar delete failed', error)
  }
}
