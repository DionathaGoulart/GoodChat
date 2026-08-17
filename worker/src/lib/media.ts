// Media pipeline (PRD §3.5): the Worker only issues presigned B2 upload URLs
// — the bytes go browser → B2 directly and are served from a public base URL
// (Cloudflare-fronted domain in prod, or the local dev stub). B2's
// S3-compatible API accepts SigV4 presigned PUTs; Content-Type and
// Content-Length are part of the signature, so a client holding the URL can
// only store the exact MIME/size the Worker approved.

import { AwsClient } from 'aws4fetch'

export const MEDIA_TYPES: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
}

// Server-side caps (client compresses images to ~1.5MB before upload; GIFs
// pass through untouched, hence the headroom). Video duration (≤60s) is
// client-side only — checking it here would require parsing the container.
export const MAX_BYTES: Record<'image' | 'video', number> = {
  image: 8 * 1024 * 1024,
  video: 32 * 1024 * 1024,
}

export const UPLOAD_URL_TTL_SECONDS = 600

export interface MediaConfig {
  keyId: string
  applicationKey: string
  bucket: string
  s3Endpoint: string
  publicBaseUrl: string
}

/** Null when the B2 env vars are absent (endpoint answers 503). */
export function mediaConfig(env: Env): MediaConfig | null {
  const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_S3_ENDPOINT, B2_PUBLIC_BASE_URL } = env
  if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET_NAME || !B2_S3_ENDPOINT || !B2_PUBLIC_BASE_URL) {
    return null
  }
  return {
    keyId: B2_KEY_ID,
    applicationKey: B2_APPLICATION_KEY,
    bucket: B2_BUCKET_NAME,
    s3Endpoint: B2_S3_ENDPOINT.replace(/\/$/, ''),
    publicBaseUrl: B2_PUBLIC_BASE_URL.replace(/\/$/, ''),
  }
}

/** Month-prefixed unguessable key — the prefix keeps a future retention job trivial. */
export function objectKey(mime: string, now = new Date()): string {
  const month = now.toISOString().slice(0, 7) // yyyy-mm
  return `media/${month}/${crypto.randomUUID()}.${MEDIA_TYPES[mime].ext}`
}

export async function presignUpload(
  config: MediaConfig,
  key: string,
  mime: string,
  size: number,
): Promise<string> {
  // Region is embedded in B2 S3 endpoints (s3.<region>.backblazeb2.com);
  // any placeholder works for the local dev stub, which skips verification.
  const region = /^s3\.([^.]+)\.backblazeb2\.com$/.exec(new URL(config.s3Endpoint).hostname)?.[1]
  const client = new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.applicationKey,
    service: 's3',
    region: region ?? 'us-east-1',
  })

  const url = new URL(`${config.s3Endpoint}/${config.bucket}/${key}`)
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS))
  const signed = await client.sign(
    new Request(url, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': String(size) },
    }),
    // allHeaders: aws4fetch skips content-type/content-length by default;
    // signing them is exactly how the MIME/size limits get enforced by B2.
    { aws: { signQuery: true, allHeaders: true } },
  )
  return signed.url
}
