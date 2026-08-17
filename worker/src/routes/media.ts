import { z } from 'zod'
import { apiError, json } from '../lib/http'
import {
  MAX_BYTES,
  MEDIA_TYPES,
  UPLOAD_URL_TTL_SECONDS,
  mediaConfig,
  objectKey,
  presignUpload,
} from '../lib/media'
import { requireSession } from '../lib/session'

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
  const uploadUrl = await presignUpload(config, key, mime, size)
  return json(
    {
      key,
      upload_url: uploadUrl,
      headers: { 'Content-Type': mime },
      public_url: `${config.publicBaseUrl}/${key}`,
      expires_in: UPLOAD_URL_TTL_SECONDS,
    },
    200,
    auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined,
  )
}
