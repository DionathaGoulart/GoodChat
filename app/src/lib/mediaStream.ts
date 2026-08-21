// Handing a video to the service worker so it can be played instead of waited for.
//
// The problem this solves is not encryption — that already worked. It is that a
// blob URL needs the whole object first: `<video src={blobUrl}>` cannot start
// until the last of up to 32MB has arrived and been decrypted, and seeking is
// impossible because there is nothing to seek in until then.
//
// A service worker can answer a Range request. So the page hands it what it
// needs — the content key, the object's nonce prefix, the chunk size — and gets
// back a URL under the worker's scope. The `<video>` element then makes ordinary
// range requests against that URL, and the worker turns each one into a range
// request for the chunks covering it (`sw.js`), decrypts those, and returns the
// bytes. The element does the demuxing; nothing here has to understand MP4.
//
// The key travels by `postMessage`, which structured-clones a `CryptoKey`
// without ever serializing it — the same property that put it in IndexedDB in
// the first place (lib/deviceKeys.ts). It never becomes bytes, and it never
// leaves this origin.
//
// Everything degrades to null rather than throwing: no service worker (a
// browser that refuses one, a page loaded before registration finished) means
// the caller falls back to downloading the object whole, which is exactly what
// it did before this existed.

/** Where the worker answers. Must match the prefix `sw.js` intercepts. */
const STREAM_SCOPE = '/__media/'

export interface StreamHandoff {
  mediaKey: string
  contentKey: CryptoKey
  /** Base64url of the object's 8-byte nonce prefix. */
  prefix: string
  chunk: number
  mime?: string
  /**
   * Where the ciphertext actually lives. Passed in rather than rebuilt in the
   * worker, because the bucket proxy can be on another origin entirely
   * (`VITE_MEDIA_URL`) and only this side knows.
   */
  url: string
}

async function controller(): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    // `ready` rather than `controller`: a first load registers the worker but is
    // not yet controlled by it, and a video in that tab would otherwise fall
    // back for no reason. `ready` resolves once there is an active worker.
    const registration = await navigator.serviceWorker.ready
    return registration.active ?? navigator.serviceWorker.controller
  } catch {
    return null
  }
}

/**
 * Registers one object with the worker and returns the URL to play, or null if
 * there is no worker to register it with.
 *
 * The URL is scoped by the bucket key, which is already unguessable and already
 * the thing the media proxy authorises against — so this adds no name that did
 * not exist, and two messages carrying the same object share one registration.
 */
export async function handStreamToWorker(handoff: StreamHandoff): Promise<string | null> {
  const worker = await controller()
  if (!worker) return null
  worker.postMessage({ type: 'media-stream', ...handoff })
  return `${STREAM_SCOPE}${encodeURIComponent(handoff.mediaKey)}`
}

/**
 * Drops a registration when the bubble goes away.
 *
 * Best effort, and harmless if it never lands: the worker holds a content key
 * per open video, which a page reload clears anyway. It matters for a long
 * session scrolling a thread full of them.
 */
export async function releaseStream(url: string): Promise<void> {
  const worker = await controller()
  worker?.postMessage({ type: 'media-stream-release', url })
}
