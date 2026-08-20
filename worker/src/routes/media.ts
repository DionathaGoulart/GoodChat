import { z } from 'zod'
import { apiError, json } from '../lib/http'
import {
  AVATAR_MIMES,
  ENCRYPTED_MIME,
  MAX_AVATAR_BYTES,
  MAX_BYTES,
  MEDIA_PATH_PREFIX,
  MEDIA_TYPES,
  UPLOAD_URL_TTL_SECONDS,
  avatarObjectKey,
  fetchObject,
  isAvatarKey,
  isMessageMediaKey,
  isValidObjectKey,
  maxAgeFor,
  mediaConfig,
  objectKey,
  presignUpload,
} from '../lib/media'
import { mediaCacheKey } from '../lib/mediaGc'
import { findObject, recordUpload } from '../lib/mediaIndex'
import { HOUR_MS, UPLOAD_QUOTA_PER_HOUR, consumeQuota } from '../lib/ratelimit'
import { requireSession, sessionHeaders, type AuthContext } from '../lib/session'

// POST /api/media/upload-url (PRD §3.5): validates session + MIME allowlist +
// size cap, then returns a presigned B2 PUT URL. The client must upload with
// exactly the declared Content-Type/Content-Length — both are signed.
//
// Rate-limited per account: each call writes an index row and licenses up to
// 32MB into the bucket, so an authenticated loop here is the cheapest way to
// fill both D1 and B2.
//
// `purpose` picks which set of rules applies. A message attachment may be a
// video and may be 32MB; a profile picture is a still image capped at 512KB and
// lands under the `avatars/` prefix, which is what makes it readable by the
// whole instance and invisible to the retention sweep (lib/media.ts). The
// prefix is decided here and never taken from the client.

const UploadRequestSchema = z.object({
  mime: z.string().min(1).max(128),
  size: z.number().int().positive(),
  purpose: z.enum(['message', 'avatar']).default('message'),
  /**
   * Only meaningful for an encrypted attachment, where `mime` says nothing:
   * ciphertext has no media type, so this is the one bit the size cap needs.
   * Ignored otherwise — the MIME already answers it.
   */
  kind: z.enum(['image', 'video']).optional(),
})

export async function createUploadUrl(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = UploadRequestSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'expected { mime, size }')
  }

  const { mime, size, purpose, kind } = parsed.data
  // An encrypted attachment declares no real media type — see ENCRYPTED_MIME.
  // It is a message attachment by definition: an avatar is readable by the
  // whole instance (routes/media.ts `canRead`), so there is nobody to encrypt
  // one *to*, and it stays a plain image.
  const encrypted = mime === ENCRYPTED_MIME && purpose === 'message'
  if (encrypted && !kind) {
    return apiError('invalid_request', 400, 'encrypted uploads must declare kind')
  }
  const mediaType = MEDIA_TYPES[mime]
  if (!encrypted && !mediaType) {
    return apiError('unsupported_media_type', 415, `mime ${mime} not allowed`)
  }
  if (purpose === 'avatar' && !AVATAR_MIMES.includes(mime as (typeof AVATAR_MIMES)[number])) {
    return apiError('unsupported_media_type', 415, `avatar must be one of ${AVATAR_MIMES.join(', ')}`)
  }
  const sizeKind = encrypted ? kind! : mediaType!.kind
  const maxBytes = purpose === 'avatar' ? MAX_AVATAR_BYTES : MAX_BYTES[sizeKind]
  if (size > maxBytes) {
    return apiError(
      'payload_too_large',
      413,
      `${purpose === 'avatar' ? 'avatar' : sizeKind} must be <= ${maxBytes} bytes`,
    )
  }

  const config = mediaConfig(env)
  if (!config) {
    return apiError('media_not_configured', 503, 'B2 env vars missing (see .env.example)')
  }

  const quota = await consumeQuota(
    env.DB,
    `upload:${auth.user.id}`,
    UPLOAD_QUOTA_PER_HOUR,
    HOUR_MS,
  )
  if (!quota.allowed) {
    return apiError('rate_limited', 429, 'too many uploads, try again later', {
      'Retry-After': String(quota.retryAfterSeconds),
    })
  }

  const key = purpose === 'avatar' ? avatarObjectKey(mime) : objectKey(mime)
  // Indexed before the URL is handed out: an upload that never becomes a
  // message still leaves a row, which is exactly how the orphan sweep finds it.
  // `size` is the signed Content-Length, so it is also the stored size.
  await recordUpload(env.DB, { key, userId: auth.user.id, mime, size })
  const uploadUrl = await presignUpload(config, key, mime, size)
  return json(
    {
      key,
      upload_url: uploadUrl,
      headers: { 'Content-Type': mime },
      // Same-origin read path — the bucket is private, so this is the only
      // way to get the bytes back (see serveMedia).
      public_url: `${MEDIA_PATH_PREFIX}${key}`,
      expires_in: UPLOAD_URL_TTL_SECONDS,
    },
    200,
    sessionHeaders(auth),
  )
}

// GET /api/media/<key>: authenticated read-through proxy for the private
// bucket. The Worker signs the GET, streams the object back, and caches it at
// the edge — B2 → Cloudflare egress is free, so only Worker requests are
// spent.
//
// Access control is membership, not obscurity: the media index (migration
// 0003) says which conversation an object belongs to, and `conversations` says
// whether the caller is one of its two participants. Authorization runs before
// the cache lookup, so the shared edge copy never shortcuts the check.
const PASSTHROUGH_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'ETag',
  'Last-Modified',
]

const STICKER_PREFIX = 'stickers/'

export async function serveMedia(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth
  const setCookie = sessionHeaders(auth) as Record<string, string> | undefined

  let key: string
  try {
    key = decodeURIComponent(url.pathname.slice(MEDIA_PATH_PREFIX.length))
  } catch {
    return apiError('invalid_request', 400, 'malformed media key')
  }
  if (!isValidObjectKey(key)) return apiError('invalid_request', 400, 'invalid media key')

  if (!(await canRead(env, auth, key))) {
    // 404, not 403: whether a key exists is itself information.
    return apiError('not_found', 404)
  }

  const config = mediaConfig(env)
  if (!config) {
    return apiError('media_not_configured', 503, 'B2 env vars missing (see .env.example)')
  }

  const range = request.headers.get('Range')
  const cache = caches.default
  // Ranged reads are never cached (partial bodies); the full object is.
  //
  // Keyed by the object key, never by the incoming URL: `?v=2` or a
  // percent-encoded path would otherwise mint a second entry for the same
  // bytes that no eviction could ever find (lib/mediaGc.ts builds the same
  // key when the object is deleted).
  const cacheKey = mediaCacheKey(url.origin, key)
  if (!range) {
    const hit = await cache.match(cacheKey)
    if (hit) return clientResponse(hit, key, setCookie?.['Set-Cookie'])
  }

  const upstream = await fetchObject(config, key, range)
  if (!upstream.ok && upstream.status !== 206) {
    // Do not leak B2's XML error body.
    return apiError(upstream.status === 404 ? 'not_found' : 'media_unavailable', upstream.status)
  }

  const headers = new Headers()
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('Accept-Ranges', upstream.headers.get('Accept-Ranges') ?? 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')

  const response = new Response(upstream.body, { status: upstream.status, headers })
  if (!range && upstream.status === 200) {
    // The edge copy is shared: public caching, and never a Set-Cookie. Its TTL
    // is capped at the shortest retention window for message media, so the
    // copy cannot outlive the message even if an eviction is ever missed.
    const cacheable = response.clone()
    cacheable.headers.set('Cache-Control', `public, max-age=${maxAgeFor(key)}, immutable`)
    ctx.waitUntil(cache.put(cacheKey, cacheable))
  }
  return clientResponse(response, key, setCookie?.['Set-Cookie'])
}

/**
 * Membership check for one object key.
 *
 * - `stickers/…` is shared instance content: any session reads it.
 * - An indexed object is readable by its uploader, and by both participants of
 *   the conversation that claimed it.
 * - `avatars/…` that somebody adopted as their picture (claimed_at set by
 *   PATCH /api/profile) is readable by any session: it is rendered in search
 *   results, conversation tiles and thread headers, so scoping it to a
 *   conversation would blank the avatar exactly where it is needed. An avatar
 *   object nobody adopted stays private to its uploader — an upload that never
 *   became a picture must not become a shared file drop.
 * - An object with no index row is either an upload that predates migration
 *   0003 or — far more often now — an object that was *deleted*: every delete
 *   path drops the index row with the bytes (lib/mediaGc.ts). So "no row" is
 *   never enough on its own:
 *     · `media/…` is refused outright. A message attachment always has a row
 *       from the moment it was presigned, so a missing one means retention (or
 *       a purge) already took it, and the legacy door would hand it back.
 *     · `avatars/…` is refused for the same reason — the prefix is three
 *       migrations younger than the index, so it can have no legacy objects.
 *     · anything else falls to `MEDIA_LEGACY_READS`, which must be set to
 *       "allow" explicitly. Run `POST /api/admin/media/reindex` once to
 *       backfill the index from the Durable Objects before closing it.
 */
async function canRead(env: Env, auth: AuthContext, key: string): Promise<boolean> {
  if (key.startsWith(STICKER_PREFIX)) return true

  const row = await findObject(env.DB, key)
  if (!row) {
    if (isAvatarKey(key) || isMessageMediaKey(key)) return false
    return env.MEDIA_LEGACY_READS === 'allow'
  }
  if (row.user_id === auth.user.id) return true
  if (isAvatarKey(key)) return row.claimed_at !== null
  if (!row.conversation_id) return false

  const participant = await env.DB.prepare(
    'SELECT 1 FROM conversations WHERE id = ?1 AND (user_a = ?2 OR user_b = ?2)',
  )
    .bind(row.conversation_id, auth.user.id)
    .first()
  return participant !== null
}

/**
 * What to do if one of these bytes is ever not the picture it claims to be.
 * This path serves whatever Content-Type the object was stored with, and the
 * sticker pack is `image/svg+xml` — an SVG opened as a top-level document runs
 * its own script, on this origin, next to the session cookie. The document CSP
 * never reaches here (lib/http.ts attaches it to the SPA only), so the response
 * carries its own:
 *
 *   - `default-src 'none'; sandbox` — an SVG rendered from this URL gets no
 *     script, no fetch and an opaque origin. `<img src>` is unaffected, which
 *     is the only way the app ever renders one;
 *   - `Cross-Origin-Resource-Policy: same-origin` — nothing off this origin may
 *     embed the bytes. The session cookie is SameSite=Strict so a cross-site
 *     load already 401s, but this is the header that says so out loud.
 */
const MEDIA_ISOLATION_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Disposition': 'inline',
}

/**
 * Browser-facing copy: private caching (per user) plus any session refresh.
 * Same ceiling as the edge copy — the disk cache of the recipient's browser is
 * one more place a deleted photo could survive, and nothing evicts it from
 * here. Keys are uuids, so a short max-age never causes a false cache miss.
 */
function clientResponse(response: Response, key: string, cookie: string | undefined): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', `private, max-age=${maxAgeFor(key)}, immutable`)
  for (const [name, value] of Object.entries(MEDIA_ISOLATION_HEADERS)) headers.set(name, value)
  if (cookie) headers.set('Set-Cookie', cookie)
  return new Response(response.body, { status: response.status, headers })
}
