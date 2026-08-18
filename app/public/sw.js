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

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    // Not JSON — show a bare notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'GoodChat', {
      body: data.body ?? '',
      tag: data.tag,
      icon: '/icon-192.png',
      data: { url: data.url },
    }),
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
