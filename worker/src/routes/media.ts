import { z } from 'zod'
import { apiError, json } from '../lib/http'
import {
  DOWNLOAD_MAX_AGE_SECONDS,
  MAX_BYTES,
  MEDIA_PATH_PREFIX,
  MEDIA_TYPES,
  UPLOAD_URL_TTL_SECONDS,
  fetchObject,
  isValidObjectKey,
  mediaConfig,
  objectKey,
  presignUpload,
} from '../lib/media'
import { findObject, recordUpload } from '../lib/mediaIndex'
import { requireSession, sessionHeaders, type AuthContext } from '../lib/session'

// POST /api/media/upload-url (PRD §3.5): validates session + MIME allowlist +
// size cap, then returns a presigned B2 PUT URL. The client must upload with
// exactly the declared Content-Type/Content-Length — both are signed.

const UploadRequestSchema = z.object({
  mime: z.string().min(1).max(128),
  size: z.number().int().positive(),
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

  const { mime, size } = parsed.data
  const mediaType = MEDIA_TYPES[mime]
  if (!mediaType) return apiError('unsupported_media_type', 415, `mime ${mime} not allowed`)
  if (size > MAX_BYTES[mediaType.kind]) {
    return apiError(
      'payload_too_large',
      413,
      `${mediaType.kind} must be <= ${MAX_BYTES[mediaType.kind]} bytes`,
    )
  }

  const config = mediaConfig(env)
  if (!config) {
    return apiError('media_not_configured', 503, 'B2 env vars missing (see .env.example)')
  }

  const key = objectKey(mime)
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
  const cacheKey = new Request(url.toString(), { method: 'GET' })
  if (!range) {
    const hit = await cache.match(cacheKey)
    if (hit) return clientResponse(hit, setCookie?.['Set-Cookie'])
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
    // The edge copy is shared: public caching, and never a Set-Cookie.
    const cacheable = response.clone()
    cacheable.headers.set('Cache-Control', `public, max-age=${DOWNLOAD_MAX_AGE_SECONDS}, immutable`)
    ctx.waitUntil(cache.put(cacheKey, cacheable))
  }
  return clientResponse(response, setCookie?.['Set-Cookie'])
}

/**
 * Membership check for one object key.
 *
 * - `stickers/…` is shared instance content: any session reads it.
 * - An indexed object is readable by its uploader, and by both participants of
 *   the conversation that claimed it.
 * - An object with no index row predates migration 0003. `MEDIA_LEGACY_READS`
 *   decides what happens to those: "allow" (default) keeps the old rule — any
 *   session plus an unguessable uuid key — so existing threads keep rendering;
 *   "deny" closes it. Run `POST /api/admin/media/reindex` once to backfill the
 *   index from the Durable Objects, then flip it to "deny".
 */
async function canRead(env: Env, auth: AuthContext, key: string): Promise<boolean> {
  if (key.startsWith(STICKER_PREFIX)) return true

  const row = await findObject(env.DB, key)
  if (!row) return env.MEDIA_LEGACY_READS !== 'deny'
  if (row.user_id === auth.user.id) return true
  if (!row.conversation_id) return false

  const participant = await env.DB.prepare(
    'SELECT 1 FROM conversations WHERE id = ?1 AND (user_a = ?2 OR user_b = ?2)',
  )
    .bind(row.conversation_id, auth.user.id)
    .first()
  return participant !== null
}

/** Browser-facing copy: private caching (per user) plus any session refresh. */
function clientResponse(response: Response, cookie: string | undefined): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', `private, max-age=${DOWNLOAD_MAX_AGE_SECONDS}, immutable`)
  if (cookie) headers.set('Set-Cookie', cookie)
  return new Response(response.body, { status: response.status, headers })
}
