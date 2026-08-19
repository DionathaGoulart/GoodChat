// Deleting media, in every place a copy of it lives.
//
// An object exists in three places at once: the bucket (the bytes), the D1
// index (who may read it), and the Cloudflare edge cache (a copy the Worker
// wrote itself while serving it). Retention promises the message is gone, so
// all three have to go — and the edge copy is the one that has no clock of its
// own, because `caches.default` only expires what its Cache-Control says.
//
// That is why deletion is one function instead of four call sites: the DO's
// retention sweep, the conversation purge, the cron backstop and the account
// teardown all delete the same object the same way. A path that forgets the
// edge copy keeps serving a deleted photo from the same URL.
//
// Order matters and is the same everywhere: bucket → index → edge. A failed
// bucket DELETE leaves the index row in place so the next sweep retries it
// (dropping the row first would leak the object forever), and the edge copy is
// only evicted for keys the bucket confirmed gone.

import { MEDIA_PATH_PREFIX, deleteObjects, mediaConfig } from './media'
import { forgetKeys } from './mediaIndex'

/**
 * The origin this Worker serves media from — the one `serveMedia` used as the
 * cache key. Callers with a live `Request` pass its origin; the ones that have
 * none (the Durable Object's alarm, the cron) rely on `PUBLIC_ORIGIN`, which is
 * safe to hardcode because the deployment has exactly one canonical origin
 * (wrangler.jsonc `routes`). Null means eviction is skipped, not that the
 * delete failed: authorization already refuses a key with no index row.
 */
export function publicOrigin(env: Env, fromRequest?: string | null): string | null {
  const configured = fromRequest ?? env.PUBLIC_ORIGIN ?? null
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    return null
  }
}

/**
 * The cache key for one object, derived from the *object key* rather than from
 * the incoming URL. Both sides — the store in `serveMedia` and the eviction
 * here — have to build it identically, and a URL carries things an object key
 * does not: a query string, percent-encoding, a trailing marker. Any of those
 * would make a second, un-evictable entry for the same bytes.
 *
 * Keys are URL-safe by construction (isValidObjectKey), so no encoding step.
 */
export function mediaCacheKey(origin: string, key: string): Request {
  return new Request(`${origin}${MEDIA_PATH_PREFIX}${key}`, { method: 'GET' })
}

/** Drops the edge copy of one object. Never throws — eviction is best effort. */
export async function forgetCachedObject(origin: string, key: string): Promise<void> {
  try {
    await caches.default.delete(mediaCacheKey(origin, key))
  } catch (error) {
    // Eviction is a second line of defence: authorization already refuses the
    // key, and the copy carries a short max-age (lib/media.ts).
    console.error('media cache eviction failed', error)
  }
}

export async function forgetCachedObjects(
  origin: string | null,
  keys: readonly string[],
): Promise<void> {
  if (!origin || keys.length === 0) return
  for (const key of keys) await forgetCachedObject(origin, key)
}

/**
 * Deletes objects from the bucket, the index and the edge, and returns how many
 * bytes-carrying objects actually went away. Every deletion path in the app
 * goes through here.
 */
export async function deleteMediaObjects(
  env: Env,
  keys: readonly string[],
  requestOrigin?: string | null,
): Promise<number> {
  if (keys.length === 0) return 0
  const config = mediaConfig(env)
  if (!config) return 0

  const deleted = await deleteObjects(config, [...keys])
  if (deleted.length === 0) return 0

  await forgetKeys(env.DB, deleted)
  await forgetCachedObjects(publicOrigin(env, requestOrigin), deleted)
  return deleted.length
}
