// Client side of the media pipeline (PRD §3.5): compress in-browser, upload
// straight to B2 via the Worker-issued presigned URL (bytes never touch the
// Worker), then reference the object key in a WS message. Server-side caps in
// worker/src/lib/media.ts are mirrored here for UX-side validation only — the
// Worker + the signed Content-Type/Content-Length are the real enforcement.
//
// Reads go the other way: the bucket is private, so every GET goes through
// the Worker's /api/media/<key> proxy, which checks the session cookie.

import { requestUploadUrl } from './api'

export const MEDIA_URL: string =
  import.meta.env.VITE_MEDIA_URL ?? 'http://localhost:8000/api/media'

export function mediaUrl(key: string): string {
  return `${MEDIA_URL}/${key}`
}

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
export const VIDEO_MIMES = ['video/mp4', 'video/webm']
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_VIDEO_BYTES = 32 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 60

/** Post-compression target (PRD: images ≤ 1–2MB). */
const IMAGE_TARGET_BYTES = 1.5 * 1024 * 1024
const IMAGE_MAX_DIMENSION = 2048
const QUALITY_STEPS = [0.85, 0.72, 0.58, 0.45]

export class MediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaError'
  }
}

/**
 * Resize + re-encode an image (WebP, JPEG fallback) down to the target size.
 * GIFs pass through untouched — canvas would drop the animation.
 */
export async function compressImage(file: File): Promise<{ blob: Blob; mime: string }> {
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new MediaError('gif muito grande (máx 8mb)')
    return { blob: file, mime: file.type }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new MediaError('não deu pra ler a imagem')
  }
  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new MediaError('canvas indisponível')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  for (const mime of ['image/webp', 'image/jpeg']) {
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(canvas, mime, quality)
      if (!blob) break // encoder unsupported — try the next mime
      if (blob.size <= IMAGE_TARGET_BYTES || quality === QUALITY_STEPS[QUALITY_STEPS.length - 1]) {
        return { blob, mime }
      }
    }
  }
  throw new MediaError('falha ao comprimir a imagem')
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality))
}

/** Duration in seconds, read from metadata without decoding the whole file. */
export function videoDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(video.duration)
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new MediaError('não deu pra ler o vídeo'))
    }
    video.src = url
  })
}

export interface UploadHandle {
  promise: Promise<{ key: string; publicUrl: string }>
  abort: () => void
}

/**
 * Presigned upload with progress (XHR — fetch still has no upload progress).
 * Content-Type must match what the Worker signed; the browser sets the
 * matching Content-Length from the blob automatically.
 */
export function uploadMedia(
  blob: Blob,
  mime: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  let aborted = false

  const promise = (async () => {
    const target = await requestUploadUrl(mime, blob.size)
    if (aborted) throw new DOMException('upload cancelado', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      xhr.open('PUT', target.upload_url)
      xhr.setRequestHeader('Content-Type', mime)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total)
      }
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new MediaError(`upload falhou (${xhr.status})`))
      xhr.onerror = () => reject(new MediaError('upload falhou (rede)'))
      xhr.onabort = () => reject(new DOMException('upload cancelado', 'AbortError'))
      xhr.send(blob)
    })
    return { key: target.key, publicUrl: target.public_url }
  })()

  return {
    promise,
    abort: () => {
      aborted = true
      xhr.abort()
    },
  }
}
