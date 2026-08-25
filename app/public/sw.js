// GoodChat service worker (phase 8).
//
// Caching: deliberately minimal (plan: "cache estático mínimo, sem cache de
// API"). Same-origin GETs only; the API lives on another origin and is never
// touched here — and /api/ is skipped anyway as defense in depth.
//   - /assets/*  → cache-first (Vite content-hashed, immutable)
//   - navigations → network-first, cached app shell as offline fallback
//   - everything else (icons, manifest) → network, no caching
//
// SHELL is written at build time by the precacheShell plugin (vite.config.ts):
// the entry chunk, its static imports and the stylesheets. Install caches them
// alongside `/`, so the first offline load has the markup *and* what it points
// at — before, it had only the HTML and every script 404'd into a blank page.
// The names are content-hashed, so a build that changes them leaves the old
// entries behind in the cache; they are never requested again and the browser
// evicts them under pressure, which is cheaper than versioning the cache and
// re-downloading the fonts on every deploy.
//
// Push: displays the worker's NotificationPayload shape
// ({ title, body, url, tag } — see worker/src/lib/push.ts). Click focuses an
// existing window and navigates to the conversation, or opens a new one.
//
// A notification is also the one copy of a message that outlives the app: it
// sits in the system's notification centre, which knows nothing about the
// conversation's retention window. So the page asks this worker to close a
// thread's notifications the moment the server says those messages expired
// (app/src/lib/push.ts → 'close-notifications').

const CACHE = 'goodchat-v1'
// Valid JS either way: the build swaps this expression for the array literal,
// and in dev — where public/sw.js is served untouched and the worker is still
// registered (src/main.tsx) — it is undefined and the shell is simply empty.
const SHELL = self.__PRECACHE__ ?? []

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing: one asset off the network would fail the
      // whole install and leave no worker at all. The shell is worth having in
      // pieces, so each file is added on its own and a miss is skipped.
      .then((cache) =>
        Promise.all(['/', ...SHELL].map((url) => cache.add(url).catch(() => undefined))),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

// --- serving a video without downloading it first -------------------------
//
// A bucket object is a sequence of independently sealed chunks (`encryptChunked`
// in app/src/lib/e2ee.ts), which means a byte range of the plaintext maps to a
// byte range of the ciphertext by arithmetic. That is what makes this possible:
// the page hands over the content key, the `<video>` element makes ordinary
// Range requests against a URL under this scope, and each one turns into a
// Range request for the chunks covering it, decrypted here.
//
// The element does the demuxing. Nothing in this file understands MP4, and it
// does not have to — it only has to hand back the right plaintext bytes with
// the right `Content-Range`.
//
// Keys live in memory for as long as the video is on screen. They arrive as
// `CryptoKey` objects through `postMessage`, so they are never bytes here
// either, and a worker restart simply loses them and the page re-hands them.

const STREAM_SCOPE = '/__media/'
const GCM_TAG_BYTES = 16
/** mediaKey -> { contentKey, prefix, chunk, mime, size } */
const streams = new Map()

function chunkNonce(prefix, index, final) {
  const nonce = new Uint8Array(12)
  nonce.set(prefix.subarray(0, 8), 0)
  nonce[8] = (index >>> 16) & 0xff
  nonce[9] = (index >>> 8) & 0xff
  nonce[10] = index & 0xff
  nonce[11] = final ? 1 : 0
  return nonce
}

/**
 * The object's ciphertext length, asked once and remembered.
 *
 * A one-byte Range rather than a HEAD: the media route answers GET only
 * (worker/src/index.ts), and `Content-Range: bytes 0-0/N` carries the total
 * anyway. Costs one byte and one round trip per video.
 */
async function ciphertextSize(entry) {
  if (entry.size !== undefined) return entry.size
  const response = await fetch(entry.url, {
    credentials: 'include',
    headers: { Range: 'bytes=0-0' },
  })
  if (!response.ok) throw new Error(`size ${response.status}`)
  const total = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
  if (!total) throw new Error('no content-range')
  entry.size = Number(total)
  return entry.size
}

/**
 * One Range request, answered.
 *
 * `totalChunks` comes from the object's full length rather than from the bytes
 * fetched, because it is what tells the last chunk apart from every other one —
 * a truncated object has to fail rather than look like a shorter video that
 * simply ended (see the note in lib/e2ee.ts).
 */
async function serveRange(request, mediaKey) {
  const entry = streams.get(mediaKey)
  if (!entry) return new Response('no key', { status: 404 })

  const sealedSize = entry.chunk + GCM_TAG_BYTES
  const cipherBytes = await ciphertextSize(entry)
  const totalChunks = Math.max(1, Math.ceil(cipherBytes / sealedSize))
  const plainBytes = cipherBytes - totalChunks * GCM_TAG_BYTES

  const header = request.headers.get('range')
  const match = /bytes=(\d*)-(\d*)/.exec(header ?? '')
  const start = match && match[1] ? Number(match[1]) : 0
  const end = match && match[2] ? Math.min(Number(match[2]), plainBytes - 1) : plainBytes - 1
  if (start >= plainBytes || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${plainBytes}` },
    })
  }

  const firstChunk = Math.floor(start / entry.chunk)
  const lastChunk = Math.floor(end / entry.chunk)
  const cipherFrom = firstChunk * sealedSize
  const cipherTo = Math.min((lastChunk + 1) * sealedSize, cipherBytes) - 1

  // `entry.url` comes from the page rather than being built here: the bucket
  // proxy can live on another origin (VITE_MEDIA_URL), and this worker has no
  // business knowing which.
  const response = await fetch(entry.url, {
    credentials: 'include',
    headers: { Range: `bytes=${cipherFrom}-${cipherTo}` },
  })
  if (!response.ok) return new Response('upstream', { status: 502 })
  const sealed = new Uint8Array(await response.arrayBuffer())

  const parts = []
  let length = 0
  for (let offset = 0; offset < sealed.length; offset += sealedSize) {
    const index = firstChunk + parts.length
    const slice = sealed.subarray(offset, Math.min(offset + sealedSize, sealed.length))
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: chunkNonce(entry.prefix, index, index === totalChunks - 1) },
        entry.contentKey,
        slice,
      ),
    )
    parts.push(plain)
    length += plain.length
  }
  const decoded = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    decoded.set(part, at)
    at += part.length
  }

  // The chunks cover the request but usually overshoot it on both ends; the
  // element asked for exact bytes and gets exactly those.
  const body = decoded.subarray(start - firstChunk * entry.chunk, end - firstChunk * entry.chunk + 1)
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': entry.mime ?? 'video/mp4',
      'Content-Length': String(body.length),
      'Content-Range': `bytes ${start}-${end}/${plainBytes}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith(STREAM_SCOPE)) {
    const mediaKey = decodeURIComponent(url.pathname.slice(STREAM_SCOPE.length))
    event.respondWith(
      serveRange(request, mediaKey).catch(() => new Response('decrypt failed', { status: 500 })),
    )
    return
  }

  if (url.pathname.startsWith('/api/')) return

  if (url.pathname.startsWith('/assets/')) {
    // Content-hashed build assets: safe to serve from cache forever.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request)
        if (hit) return hit
        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      }),
    )
    return
  }

  if (request.mode === 'navigate') {
    // App shell: fresh when online, cached copy when offline.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          const cache = await caches.open(CACHE)
          cache.put('/', response.clone())
          return response
        } catch {
          const hit = await caches.match('/')
          return hit ?? Response.error()
        }
      })(),
    )
  }
})

// --- decrypting a preview ------------------------------------------------
//
// The worker cannot read a message, so a notification that shows its text has
// to decrypt it here. What arrives in the push is only *which* message: the
// conversation and the message id. This context reads it back through
// /api/conversations — same origin, same session cookie the page uses — and
// opens it with the private key in IndexedDB, where app/src/lib/accountKeys.ts
// put it as a non-extractable CryptoKey. That is the whole reason it went to
// IndexedDB instead of localStorage: this context can use it, and no code
// anywhere can export it.
//
// The key is the *account's* now (migration 0014), not this browser's, which
// is why the subscription no longer names a device and why every browser
// signed into an account can show the same preview. A v1/v2 message is not
// decrypted here: it was sealed to a device key, and a notification is not
// worth carrying that path into a second implementation. It falls through to
// the generic line, which is what a preview does whenever anything is missing.
//
// The ciphertext used to travel in the notification itself, which meant a
// message too long for Web Push's 4096-byte record silently lost its preview —
// short message previewed, long message did not, no way for anyone to tell why.
// Reading it back is one request and behaves the same every time. It also means
// the browser vendor's push service is no longer handed ciphertext at all.
//
// Every failure path ends at the generic body the worker already sent, so no
// network, a browser without the key, a rotated device or a payload from an
// older build all degrade to "@alice te mandou uma mensagem" rather than to
// nothing.

const KEY_DB = 'goodchat-account'
const KEY_STORE = 'identity'

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    // Never upgrades: if the store does not exist yet, the app has not created
    // an identity and there is nothing here to decrypt with.
    request.onupgradeneeded = () => request.transaction?.abort()
  })
}

/** Every account key this browser holds — one per account signed in here. */
async function storedIdentities() {
  const db = await openKeyDb()
  try {
    if (!db.objectStoreNames.contains(KEY_STORE)) return []
    return await new Promise((resolve, reject) => {
      const request = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

function fromBase64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Mirrors `wrappingKey` in app/src/lib/e2ee.ts — same salt, same info. */
async function wrappingKey(privateKey, senderKeyRaw, aId, bId) {
  const senderKey = await crypto.subtle.importKey(
    'raw',
    fromBase64url(senderKeyRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: senderKey },
    privateKey,
    256,
  )
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode([aId, bId].sort().join(':')),
      info: new TextEncoder().encode('goodchat-v1-wrap'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
}

/**
 * Mirrors `messageAad` in app/src/lib/e2ee.ts — same order, same separator,
 * same literal. A v3 body does not decrypt without it, so a drift here shows up
 * as "push previews went generic" rather than as anything dangerous.
 */
function previewAad(conversationId, message) {
  return new TextEncoder().encode(
    ['goodchat-v3', conversationId, message.sender_id, message.client_id].join('|'),
  )
}

/**
 * The conversation the push names, read back from the API.
 *
 * /api/conversations rather than a purpose-built endpoint: it already carries
 * the last message with its envelope *and* the peer's account key, already
 * checks the session and membership, and is the same payload the conversation
 * list decrypts on screen. One endpoint doing both is one endpoint to keep
 * right.
 */
async function fetchConversation(conversationId) {
  const response = await fetch('/api/conversations', { credentials: 'include' })
  if (!response.ok) return null
  const { conversations } = await response.json()
  return (conversations ?? []).find((item) => item.id === conversationId) ?? null
}

/** The message text, or null — and null always means "show the generic body". */
async function decryptPreview(ref) {
  try {
    if (!ref?.conv || !ref?.mid) return null
    const conversation = await fetchConversation(ref.conv)
    const message = conversation?.last_message
    // The newest message is normally the one the push is about; when it is not,
    // showing it would put the wrong text on the lock screen.
    if (!message?.enc || message.id !== ref.mid) return null
    // v1/v2 was sealed to a device key. Not decrypted here — see the note at
    // the top of this section.
    if (message.enc.v !== 3) return null

    // Whichever account this browser holds a key for that the envelope names.
    const identities = await storedIdentities()
    const identity = identities.find((entry) => entry?.id && message.enc.keys[entry.accountId])
    if (!identity) return null
    const wrapped = message.enc.keys[identity.accountId]

    // Whose key sealed it: the peer's, or this account's own for a message this
    // person sent from somewhere else.
    const senderKey =
      message.sender_id === identity.accountId
        ? identity.publicKey
        : conversation.peer_account_key
    if (!senderKey) return null

    const wrapKey = await wrappingKey(
      identity.privateKey,
      senderKey,
      identity.accountId,
      message.sender_id,
    )
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(wrapped.iv) },
      wrapKey,
      fromBase64url(wrapped.ct),
    )
    const contentKey = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['decrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64url(message.enc.iv),
        additionalData: previewAad(ref.conv, message),
      },
      contentKey,
      fromBase64url(message.body),
    )
    const payload = JSON.parse(new TextDecoder().decode(plain))
    const text = payload.t ?? (payload.s ? '[sticker]' : payload.m ? '[mídia]' : '')
    if (typeof text !== 'string' || text.length === 0) return null
    // Same ceiling the worker used to apply, by code point so an emoji at the
    // boundary is not split into a replacement character.
    const points = [...text]
    return points.length > 120 ? `${points.slice(0, 119).join('')}…` : text
  } catch {
    return null
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    // Not JSON — show a bare notification.
  }
  event.waitUntil(
    (async () => {
      const decrypted = data.enc ? await decryptPreview(data.enc) : null
      await self.registration.showNotification(data.title ?? 'GoodChat', {
        body: decrypted ?? data.body ?? '',
        tag: data.tag,
        icon: '/icon-192.png',
        data: { url: data.url },
      })
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data?.type === 'media-stream' && typeof data.mediaKey === 'string') {
    streams.set(data.mediaKey, {
      contentKey: data.contentKey,
      prefix: fromBase64url(data.prefix),
      chunk: data.chunk,
      mime: data.mime,
      url: data.url,
    })
    return
  }
  if (data?.type === 'media-stream-release' && typeof data.url === 'string') {
    const path = data.url.startsWith(STREAM_SCOPE) ? data.url.slice(STREAM_SCOPE.length) : null
    if (path) streams.delete(decodeURIComponent(path))
    return
  }
  if (!data || data.type !== 'close-notifications' || typeof data.tag !== 'string') return
  event.waitUntil(
    self.registration
      .getNotifications({ tag: data.tag })
      .then((notifications) => {
        for (const notification of notifications) notification.close()
      })
      .catch(() => undefined),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url ?? '/'
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins[0]
      if (win) {
        await win.focus()
        if ('navigate' in win) await win.navigate(url)
      } else {
        await self.clients.openWindow(url)
      }
    })(),
  )
})
