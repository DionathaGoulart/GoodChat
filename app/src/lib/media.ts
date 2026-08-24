// Client side of the media pipeline (PRD §3.5): compress in-browser, upload
// straight to B2 via the Worker-issued presigned URL (bytes never touch the
// Worker), then reference the object key in a WS message. Server-side caps in
// worker/src/lib/media.ts are mirrored here for UX-side validation only — the
// Worker + the signed Content-Type/Content-Length are the real enforcement.
//
// Reads go the other way: the bucket is private, so every GET goes through
// the Worker's /api/media/<key> proxy, which checks session and conversation
// membership.
//
// What gets compressed, and why:
//   - images: resized and re-encoded (WebP, JPEG fallback). A chat bubble is
//     at most a few hundred CSS pixels tall, so 1600px/600KB is already more
//     than any screen shows — the previous 2048px/1.5MB target was paying for
//     detail nobody sees;
//   - video: the single biggest consumer of the bucket. Transcoded to 720p at
//     ~1.5 Mbps through canvas + MediaRecorder, which is real-time, so it only
//     runs when the file is actually fat (see shouldTranscodeVideo);
//   - large GIFs: pixel-for-pixel the worst format there is. Above the
//     threshold they become WebM (and therefore a video message); below it
//     they pass through unchanged, which keeps small reaction GIFs as GIFs.

import { requestUploadUrl } from './api'
import { MEDIA_CHUNK_BYTES, createContentKey, encryptChunked, randomChunkPrefix } from './e2ee'

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

/** Post-compression target. */
const IMAGE_TARGET_BYTES = 600 * 1024
const IMAGE_MAX_DIMENSION = 1600
const QUALITY_STEPS = [0.85, 0.72, 0.58, 0.45]

/**
 * Avatar: center-cropped square, since every frame that renders one is square.
 * 512px covers the largest use (the settings preview) on a 2x screen; the
 * worker refuses anything over MAX_AVATAR_BYTES.
 */
const AVATAR_DIMENSION = 512
const AVATAR_TARGET_BYTES = 160 * 1024
export const MAX_AVATAR_BYTES = 512 * 1024

/**
 * What an encrypted attachment declares to the worker. Ciphertext has no media
 * type: the real one goes inside the encrypted message payload, so the server
 * stops learning jpeg-from-webp and only ever sees the image/video distinction
 * its size caps need (worker/src/lib/media.ts ENCRYPTED_MIME).
 */
export const ENCRYPTED_MIME = 'application/octet-stream'

/** Video transcode target: 720p at ~1.5 Mbps + 96 kbps audio. */
const VIDEO_MAX_DIMENSION = 1280
const VIDEO_BITS_PER_SECOND = 1_500_000
const AUDIO_BITS_PER_SECOND = 96_000

/**
 * Transcoding runs in real time, so it is only worth the wait when the source
 * is genuinely oversized: above 1600px, or averaging more than ~2.4 Mbps.
 * A clip already under both is left alone.
 */
const TRANSCODE_MIN_BITRATE = 2_400_000
const TRANSCODE_MIN_DIMENSION = 1600

/** GIFs above this are re-encoded to WebM; smaller ones stay GIFs. */
const GIF_TRANSCODE_THRESHOLD_BYTES = 2 * 1024 * 1024

export class MediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaError'
  }
}

export type MediaKind = 'image' | 'video'

export interface PreparedMedia {
  blob: Blob
  mime: string
  kind: MediaKind
  /** Source bytes, so the UI can show what the compression saved. */
  originalSize: number
}

/**
 * Everything between "user picked a file" and "bytes are ready to upload".
 * `onProgress` reports the compression phase only (0..1); uploads have their
 * own progress. Throws MediaError with a pt-BR message on anything the user
 * needs to know about.
 */
export async function prepareMedia(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<PreparedMedia> {
  if (IMAGE_MIMES.includes(file.type)) {
    if (file.type === 'image/gif') return prepareGif(file, onProgress)
    const { blob, mime } = await compressImage(file)
    return { blob, mime, kind: 'image', originalSize: file.size }
  }
  if (VIDEO_MIMES.includes(file.type)) {
    return prepareVideo(file, onProgress)
  }
  throw new MediaError('formato não suportado (jpg/png/webp/gif/mp4/webm)')
}

/**
 * Resize + re-encode an image (WebP, JPEG fallback) down to the target size.
 */
export async function compressImage(file: File): Promise<{ blob: Blob; mime: string }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new MediaError('não deu pra ler a imagem')
  }
  const canvas = scaledCanvas(bitmap.width, bitmap.height, IMAGE_MAX_DIMENSION)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
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

/**
 * Profile picture: square, small, still. GIFs and videos are refused here
 * rather than animated in a 40px frame; everything else is cropped from the
 * center (the part of a photo a face is in) and re-encoded like any image.
 */
export async function compressAvatar(file: File): Promise<{ blob: Blob; mime: string }> {
  if (!IMAGE_MIMES.includes(file.type) || file.type === 'image/gif') {
    throw new MediaError('foto de perfil aceita jpg, png ou webp')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new MediaError('não deu pra ler a imagem')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_DIMENSION
  canvas.height = AVATAR_DIMENSION
  canvas
    .getContext('2d')
    ?.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_DIMENSION,
      AVATAR_DIMENSION,
    )
  bitmap.close()

  for (const mime of ['image/webp', 'image/jpeg']) {
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(canvas, mime, quality)
      if (!blob) break // encoder unsupported — try the next mime
      const last = quality === QUALITY_STEPS[QUALITY_STEPS.length - 1]
      if (blob.size <= AVATAR_TARGET_BYTES || (last && blob.size <= MAX_AVATAR_BYTES)) {
        return { blob, mime }
      }
    }
  }
  throw new MediaError('falha ao comprimir a foto')
}

/** Empty canvas sized to fit `maxDimension`, aspect preserved. */
function scaledCanvas(width: number, height: number, maxDimension: number): HTMLCanvasElement {
  const scale = Math.min(1, maxDimension / Math.max(width, height, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  return canvas
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

// --- video ---------------------------------------------------------------

async function prepareVideo(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<PreparedMedia> {
  if (file.size > MAX_VIDEO_BYTES) throw new MediaError('vídeo muito grande (máx 32mb)')

  const meta = await videoMetadata(file)
  if (meta.duration > MAX_VIDEO_SECONDS) throw new MediaError('vídeo muito longo (máx 60s)')

  if (shouldTranscodeVideo(file, meta)) {
    const transcoded = await transcodeVideo(file, meta, onProgress).catch(() => null)
    // Only keep the result if it actually won — a short, already-efficient clip
    // can come out bigger than it went in.
    if (transcoded && transcoded.size < file.size) {
      return {
        blob: transcoded,
        mime: 'video/webm',
        kind: 'video',
        originalSize: file.size,
      }
    }
  }
  return { blob: file, mime: file.type, kind: 'video', originalSize: file.size }
}

interface VideoMetadata {
  duration: number
  width: number
  height: number
}

function videoMetadata(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new MediaError('não deu pra ler o vídeo'))
    }
    video.src = url
  })
}

function shouldTranscodeVideo(file: File, meta: VideoMetadata): boolean {
  if (!canRecordCanvas()) return false
  if (!Number.isFinite(meta.duration) || meta.duration <= 0) return false
  const bitrate = (file.size * 8) / meta.duration
  return (
    bitrate > TRANSCODE_MIN_BITRATE ||
    Math.max(meta.width, meta.height) > TRANSCODE_MIN_DIMENSION
  )
}

function canRecordCanvas(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  )
}

/** First container the browser can actually record, or null. */
function pickRecorderMime(withAudio: boolean): string | null {
  const candidates = withAudio
    ? [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ]
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null
}

/**
 * Real-time transcode: the source plays once into an offscreen canvas while a
 * MediaRecorder captures the canvas plus the audio graph. Playback is silent
 * (audio is routed to a MediaStreamDestination, never to the speakers) but
 * runs at 1x — MediaRecorder timestamps by wall clock, so speeding the source
 * up would produce a chipmunk video, not a faster export.
 *
 * WebCodecs would do this far faster than real time; it needs a demuxer and a
 * muxer, which is the natural next step if the wait becomes a problem.
 */
async function transcodeVideo(
  file: File,
  meta: VideoMetadata,
  onProgress: (fraction: number) => void,
): Promise<Blob | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true

  let audioContext: AudioContext | null = null
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new MediaError('não deu pra ler o vídeo'))
    })

    const canvas = scaledCanvas(meta.width, meta.height, VIDEO_MAX_DIMENSION)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    const stream = canvas.captureStream()

    // Audio through Web Audio: an element-sourced MediaStreamDestination keeps
    // the track in the recording while the page stays silent.
    let hasAudio = false
    try {
      audioContext = new AudioContext()
      const source = audioContext.createMediaElementSource(video)
      const destination = audioContext.createMediaStreamDestination()
      source.connect(destination)
      const [track] = destination.stream.getAudioTracks()
      if (track) {
        stream.addTrack(track)
        hasAudio = true
      }
    } catch {
      // No audio track, or the browser refused the graph — video only.
    }

    const mimeType = pickRecorderMime(hasAudio)
    if (!mimeType) return null

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })

    let frameHandle = 0
    const drawFrame = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (meta.duration > 0) onProgress(Math.min(1, video.currentTime / meta.duration))
      frameHandle = requestAnimationFrame(drawFrame)
    }

    recorder.start(1000)
    drawFrame()
    await video.play()
    await new Promise<void>((resolve) => {
      video.onended = () => resolve()
    })
    cancelAnimationFrame(frameHandle)
    // One last frame so the tail is not a black flash.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    recorder.stop()
    await finished

    onProgress(1)
    // Upload as the bare container: the Worker's allowlist has no codec params.
    return new Blob(chunks, { type: 'video/webm' })
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    void audioContext?.close()
  }
}

// --- gif -----------------------------------------------------------------

async function prepareGif(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<PreparedMedia> {
  if (file.size > MAX_IMAGE_BYTES) throw new MediaError('gif muito grande (máx 8mb)')
  if (file.size <= GIF_TRANSCODE_THRESHOLD_BYTES) {
    // Small enough that the format tax does not matter; keep it a GIF so it
    // still renders as an inline looping image.
    return { blob: file, mime: file.type, kind: 'image', originalSize: file.size }
  }

  const webm = await gifToWebm(file, onProgress).catch(() => null)
  if (webm && webm.size < file.size) {
    return { blob: webm, mime: 'video/webm', kind: 'video', originalSize: file.size }
  }
  return { blob: file, mime: file.type, kind: 'image', originalSize: file.size }
}

/**
 * Re-encodes an animated GIF as WebM by decoding its frames (WebCodecs
 * ImageDecoder, which is what knows the real per-frame durations) and
 * recording them off a canvas. Returns null when the browser has no decoder —
 * the caller then uploads the GIF untouched.
 */
async function gifToWebm(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<Blob | null> {
  const decoderCtor = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder
  if (!decoderCtor || !canRecordCanvas()) return null

  const decoder = new decoderCtor({ data: await file.arrayBuffer(), type: file.type })
  await decoder.completed
  const track = decoder.tracks.selectedTrack
  const frameCount = track?.frameCount ?? 0
  if (frameCount < 2) return null // a still GIF is not worth a video container

  const first = await decoder.decode({ frameIndex: 0 })
  const canvas = scaledCanvas(
    first.image.displayWidth,
    first.image.displayHeight,
    IMAGE_MAX_DIMENSION,
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  first.image.close()

  const mimeType = pickRecorderMime(false)
  if (!mimeType) return null

  const recorder = new MediaRecorder(canvas.captureStream(), {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.start(1000)

  for (let index = 0; index < frameCount; index += 1) {
    const { image } = await decoder.decode({ frameIndex: index })
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    // VideoFrame durations are microseconds; GIF frames default to ~100ms.
    const holdMs = image.duration ? image.duration / 1000 : 100
    image.close()
    onProgress((index + 1) / frameCount)
    await new Promise((resolve) => setTimeout(resolve, holdMs))
  }

  recorder.stop()
  await finished
  decoder.close()
  return new Blob(chunks, { type: 'video/webm' })
}

// --- upload --------------------------------------------------------------

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
  purpose: 'message' | 'avatar' = 'message',
  kind?: MediaKind,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  let aborted = false

  const promise = (async () => {
    const target = await requestUploadUrl(mime, blob.size, purpose, kind)
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

/**
 * What a message has to carry to point at the object that was just uploaded:
 * the content key its bytes were sealed with, the object's nonce prefix, the
 * real MIME (the worker only ever saw `application/octet-stream`) and the
 * chunk size it was written at. All four are needed to read it back — a
 * message missing `chunk` describes an object nobody can open.
 */
export interface MediaSealing {
  contentKey: CryptoKey
  mediaIv: Uint8Array
  mime: string
  chunk: number
}

/**
 * The encrypted half of the pipeline: the bytes are sealed here, before they
 * ever reach the network, so the bucket and the read proxy both hold nothing
 * but ciphertext.
 *
 * The content key is returned rather than generated inside, because it is the
 * *same* key the message body is sealed with — the recipient unwraps it once
 * and uses it for both. `mediaIv` travels in the envelope next to it.
 *
 * A profile picture deliberately does not come through here: it is readable by
 * the whole instance (it is rendered in search results, tiles and thread
 * headers), so there is no pair to encrypt it to.
 */
export interface SealedUpload extends MediaSealing {
  /** Bucket object key — what the message references. */
  key: string
}

export interface SealedUploadHandle {
  promise: Promise<SealedUpload>
  abort: () => void
}

export function uploadEncryptedMedia(
  prepared: PreparedMedia,
  onProgress: (fraction: number) => void,
): SealedUploadHandle {
  // Eight bytes, not twelve: the rest of each chunk's nonce is its index and
  // the final flag (`chunkNonce` in lib/e2ee.ts).
  const mediaIv = randomChunkPrefix()
  let inner: UploadHandle | null = null
  let aborted = false

  const promise = (async (): Promise<SealedUpload> => {
    const contentKey = await createContentKey()
    const sealed = await encryptChunked(
      contentKey,
      mediaIv,
      new Uint8Array(await prepared.blob.arrayBuffer()),
    )
    if (aborted) throw new DOMException('upload cancelado', 'AbortError')
    inner = uploadMedia(
      new Blob([sealed as BlobPart], { type: ENCRYPTED_MIME }),
      ENCRYPTED_MIME,
      onProgress,
      'message',
      prepared.kind,
    )
    const { key } = await inner.promise
    return { key, contentKey, mediaIv, mime: prepared.mime, chunk: MEDIA_CHUNK_BYTES }
  })()

  return {
    promise,
    abort: () => {
      aborted = true
      inner?.abort()
    },
  }
}

/**
 * Picks a file, crops it and uploads it as a profile picture. Returns the key
 * for PATCH /api/profile — until that call lands the object is an unclaimed
 * upload, which the worker's orphan sweep removes on its own.
 */
export async function uploadAvatar(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const { blob, mime } = await compressAvatar(file)
  const { key } = await uploadMedia(blob, mime, onProgress, 'avatar').promise
  return key
}
