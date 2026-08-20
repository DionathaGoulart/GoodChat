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

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
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
// to decrypt it here. The payload carries the body ciphertext, the content key
// wrapped for *this* device, and the sending device's public key; the private
// half is in IndexedDB, where app/src/lib/deviceKeys.ts put it as a
// non-extractable CryptoKey. That is the whole reason it went to IndexedDB
// instead of localStorage: this context can read it, and no code anywhere can
// export it.
//
// Every failure path ends at the generic body the worker already sent, so a
// browser without the key, a rotated device or a payload from an older build
// all degrade to "@alice te mandou uma mensagem" rather than to nothing.

const KEY_DB = 'goodchat-keys'
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

/** The stored identity whose device id matches, across every account. */
async function findIdentity(deviceId) {
  const db = await openKeyDb()
  try {
    if (!db.objectStoreNames.contains(KEY_STORE)) return null
    const all = await new Promise((resolve, reject) => {
      const request = db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
    return all.find((entry) => entry?.id === deviceId) ?? null
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

/** The message text, or null — and null always means "show the generic body". */
async function decryptPreview(enc) {
  try {
    const identity = await findIdentity(enc.device)
    if (!identity) return null
    const wrapKey = await wrappingKey(
      identity.privateKey,
      enc.sender_key,
      enc.device,
      // The sender's device id is not in the payload, but the salt is the two
      // ids sorted — and the id is a digest of the key, so it can be recomputed.
      await deviceIdFor(fromBase64url(enc.sender_key)),
    )
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(enc.key.iv) },
      wrapKey,
      fromBase64url(enc.key.ct),
    )
    const contentKey = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['decrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(enc.iv) },
      contentKey,
      fromBase64url(enc.ct),
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

async function deviceIdFor(publicKeyRaw) {
  const digest = await crypto.subtle.digest('SHA-256', publicKeyRaw)
  let hex = ''
  for (const byte of new Uint8Array(digest).slice(0, 16)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
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
