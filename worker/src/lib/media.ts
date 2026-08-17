// Media pipeline (PRD §3.5): uploads go browser → B2 directly through a
// presigned PUT (bytes never touch the Worker); downloads come back through
// the Worker, which signs a GET against a *private* bucket and streams the
// object. B2's S3-compatible API accepts SigV4 on both: for the PUT,
// Content-Type and Content-Length are part of the signature, so a client
// holding the URL can only store the exact MIME/size the Worker approved.
//
// Reading through the Worker means the bucket is never public: every GET is
// session-checked, and B2 → Cloudflare egress is free (Bandwidth Alliance),
// so proxying costs Worker requests but no bandwidth.

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

/** Objects are immutable (uuid keys, versioned sticker packs) — cache hard. */
export const DOWNLOAD_MAX_AGE_SECONDS = 31_536_000

/** Path prefix the Worker serves objects from, and the only keys it accepts. */
export const MEDIA_PATH_PREFIX = '/api/media/'
const KEY_RE = /^(media|stickers)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/

export interface MediaConfig {
  keyId: string
  applicationKey: string
  bucket: string
  s3Endpoint: string
}

/** Null when the B2 env vars are absent (endpoint answers 503). */
export function mediaConfig(env: Env): MediaConfig | null {
  const { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_S3_ENDPOINT } = env
  if (!B2_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET_NAME || !B2_S3_ENDPOINT) {
    return null
  }
  return {
    keyId: B2_KEY_ID,
    applicationKey: B2_APPLICATION_KEY,
    bucket: B2_BUCKET_NAME,
    s3Endpoint: B2_S3_ENDPOINT.replace(/\/$/, ''),
  }
}

/** Rejects traversal and anything outside the two known prefixes. */
export function isValidObjectKey(key: string): boolean {
  return KEY_RE.test(key) && !key.includes('..') && !key.includes('//')
}

/** Month-prefixed unguessable key — the prefix keeps a future retention job trivial. */
export function objectKey(mime: string, now = new Date()): string {
  const month = now.toISOString().slice(0, 7) // yyyy-mm
  return `media/${month}/${crypto.randomUUID()}.${MEDIA_TYPES[mime].ext}`
}

function s3Client(config: MediaConfig): AwsClient {
  // Region is embedded in B2 S3 endpoints (s3.<region>.backblazeb2.com);
  // any placeholder works for the local dev stub, which skips verification.
  const region = /^s3\.([^.]+)\.backblazeb2\.com$/.exec(new URL(config.s3Endpoint).hostname)?.[1]
  return new AwsClient({
    accessKeyId: config.keyId,
    secretAccessKey: config.applicationKey,
    service: 's3',
    region: region ?? 'us-east-1',
  })
}

export async function presignUpload(
  config: MediaConfig,
  key: string,
  mime: string,
  size: number,
): Promise<string> {
  const client = s3Client(config)

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

/**
 * Signed GET against the private bucket. `range` is forwarded verbatim so
 * video seeking keeps working (aws4fetch leaves Range unsigned, which B2
 * accepts); the caller streams the body straight back to the browser.
 */
export function fetchObject(
  config: MediaConfig,
  key: string,
  range: string | null,
): Promise<Response> {
  return s3Client(config).fetch(`${config.s3Endpoint}/${config.bucket}/${key}`, {
    method: 'GET',
    headers: range ? { Range: range } : undefined,
  })
}

/** Concurrency for bulk deletes — B2 has no batch DELETE on the S3 API. */
const DELETE_CONCURRENCY = 6

/** True when the object is gone (404 counts: the goal is "not there"). */
export async function deleteObject(config: MediaConfig, key: string): Promise<boolean> {
  const response = await s3Client(config).fetch(
    `${config.s3Endpoint}/${config.bucket}/${key}`,
    { method: 'DELETE' },
  )
  return response.ok || response.status === 404
}

/**
 * Deletes many keys with bounded concurrency; returns the ones that actually
 * went away. A failed delete is left in the index so the next sweep retries.
 */
export async function deleteObjects(config: MediaConfig, keys: string[]): Promise<string[]> {
  const deleted: string[] = []
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    const batch = keys.slice(i, i + DELETE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (key) => {
        try {
          return (await deleteObject(config, key)) ? key : null
        } catch {
          return null
        }
      }),
    )
    for (const key of results) if (key) deleted.push(key)
  }
  return deleted
}

export interface ListedObject {
  key: string
  size: number
  lastModified: number
}

/**
 * One page of ListObjectsV2. Used by the owner panel to report what the bucket
 * really holds (objects predating the media index, or written out of band like
 * the sticker pack) and by the reconcile sweep.
 *
 * The response is XML and the Workers runtime has no parser; the shape is a
 * flat, attribute-free <Contents> list, so a scan over the tags is enough —
 * keys are URL-safe by construction (isValidObjectKey) and cannot smuggle
 * markup.
 */
export async function listObjects(
  config: MediaConfig,
  prefix: string,
  continuationToken?: string,
): Promise<{ objects: ListedObject[]; nextToken: string | null }> {
  const url = new URL(`${config.s3Endpoint}/${config.bucket}`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('prefix', prefix)
  url.searchParams.set('max-keys', '1000')
  if (continuationToken) url.searchParams.set('continuation-token', continuationToken)

  const response = await s3Client(config).fetch(url.toString(), { method: 'GET' })
  if (!response.ok) throw new Error(`list objects failed (${response.status})`)
  const xml = await response.text()

  const objects: ListedObject[] = []
  const contents = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)
  for (const [, block] of contents) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
    if (!key) continue
    objects.push({
      key: decodeXmlEntities(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      lastModified: Date.parse(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? '') || 0,
    })
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
  const nextToken = truncated
    ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
    : null
  return { objects, nextToken: nextToken ? decodeXmlEntities(nextToken) : null }
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}
