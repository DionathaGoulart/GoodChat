// Phase 14 smoke test — the copies of a message, and the powers that reach
// them. Against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase14                                  (terminal 2)
//
// A privacy review found the retention promise holding everywhere except in
// the copies: the edge cache served objects the sweep had already deleted, the
// legacy-reads door was open for exactly those keys, the cron backstop only
// woke conversations whose whole history had aged out, and the owner could
// take over an account without leaving a trace. This is the regression net for
// the fixes, one section per finding.
//
// What it cannot check, and deliberately does not pretend to: whether the edge
// copy was really evicted. `caches.default` is consulted *after* authorization,
// so once the index row is gone a cached object is unreachable by any request
// this test can make — the eviction is defence in depth behind a check that
// already refuses. Confirming it takes a request to production against a key
// that expired minutes ago. What is asserted here instead is everything that
// makes that eviction reachable at all: one delete path, a cache key derived
// from the object key, and a TTL that cannot outlive the window.

import { d1Execute, d1Query, signIn, sqlString } from './lib.ts'
import { startMediaDevServer } from './media-dev-server.ts'
import WebSocket from 'ws'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const MEDIA_PORT = 9000

const ALICE = { username: 'alice', password: 'alice-goodchat' }
const BOB = { username: 'bob', password: 'bob-goodchat' }
const OWNER = { username: 'good', password: 'good-goodchat' }

/** Mirrors MEDIA_MAX_AGE_SECONDS in src/lib/media.ts: the shortest life any
    message can have, which is READ_TTL_MS. */
const MEDIA_MAX_AGE = 3 * 60 * 60
const YEAR_MAX_AGE = 31_536_000

let failures = 0

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${label}`)
  } else {
    failures++
    console.error(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function api(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

// Signing in goes through `signIn` (scripts/lib.ts) rather than posting the
// password: since migration 0013 the stored hash is of a token the *client*
// derives, so a plaintext login is refused. ~600ms of PBKDF2 per call.
function login(username: string, password: string): Promise<string | null> {
  return signIn(API, username, password)
}

async function requireLogin(username: string, password: string): Promise<string> {
  const cookie = await login(username, password)
  if (!cookie) throw new Error(`login ${username} failed`)
  return cookie
}

/** Presigns, uploads four bytes, returns the key. */
async function upload(cookie: string): Promise<string> {
  const presigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ mime: 'image/webp', size: 4 }),
  })
  if (presigned.status !== 200) throw new Error(`presign failed (${presigned.status})`)
  const put = await fetch(presigned.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: new Uint8Array([1, 2, 3, 4]),
  })
  if (!put.ok) throw new Error(`upload failed (${put.status})`)
  return presigned.body.key as string
}

/** WS client that buffers frames and lets the test await a matching one. */
class Client {
  private readonly frames: any[] = []
  private readonly waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = []
  private readonly ws: WebSocket

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      this.frames.push(event)
      const i = this.waiters.findIndex((w) => w.pred(event))
      if (i !== -1) this.waiters.splice(i, 1)[0].resolve(event)
    })
  }

  static connect(path: string, cookie: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_API}${path}`, { headers: { Cookie: cookie } })
      ws.on('open', () => resolve(new Client(ws)))
      ws.on('unexpected-response', (_req, res) => reject(new Error(`handshake ${res.statusCode}`)))
      ws.on('error', reject)
    })
  }

  send(event: unknown): void {
    this.ws.send(JSON.stringify(event))
  }

  /** Resolves with the first frame matching `pred`, or null after `ms`. */
  await(pred: (e: any) => boolean, ms = 3000): Promise<any> {
    const seen = this.frames.find(pred)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve) => {
      const waiter = { pred, resolve }
      this.waiters.push(waiter)
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i !== -1) this.waiters.splice(i, 1)[0].resolve(null)
      }, ms)
    })
  }

  close(): void {
    this.ws.close()
  }
}

/** The status of a WS handshake carrying `origin` (null = no Origin header). */
function handshakeStatus(path: string, cookie: string, origin: string | null): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_API}${path}`, {
      headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) },
    })
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate()
      resolve(res.statusCode ?? 0)
    })
    ws.on('open', () => {
      ws.close()
      resolve(101)
    })
    ws.on('error', () => resolve(0))
  })
}

/** D1 is written from `waitUntil`, so the mirror lands a beat after the call. */
async function untilMirrored(
  conversationId: string,
  pred: (row: any) => boolean,
  attempts = 6,
): Promise<any> {
  let row: any = null
  for (let i = 0; i < attempts; i++) {
    row = d1Query(
      `SELECT next_expiry_at FROM conversations WHERE id = ${sqlString(conversationId)};`,
    )[0]
    if (row && pred(row)) return row
    await new Promise((r) => setTimeout(r, 400))
  }
  return row
}

let ownedServer: Awaited<ReturnType<typeof startMediaDevServer>> | null = null
try {
  ownedServer = await startMediaDevServer(MEDIA_PORT)
  console.log(`media stub started on :${MEDIA_PORT}`)
} catch (err: any) {
  if (err?.code !== 'EADDRINUSE') throw err
  console.log(`media stub already running on :${MEDIA_PORT} — reusing`)
}

try {
  const aliceCookie = await requireLogin(ALICE.username, ALICE.password)
  const bobCookie = await requireLogin(BOB.username, BOB.password)
  const ownerCookie = await login(OWNER.username, OWNER.password)
  if (!ownerCookie) {
    console.log(`  (owner "${OWNER.username}" missing — create it with:`)
    console.log(`   npm run user:create -- --owner ${OWNER.username} ${OWNER.password} Good)`)
    throw new Error('owner account required for the audit-trail checks')
  }
  const alice = (await api('/api/auth/me', { cookie: aliceCookie })).body.user
  const bob = (await api('/api/auth/me', { cookie: bobCookie })).body.user

  console.log('\n— an object with no index row (F-02)')

  // Both prefixes are indexed at presign time, so "no row" cannot mean "old":
  // it means the object was deleted and the key must stop working with it.
  const ghostMedia = await fetch(`${API}/api/media/media/2020-01/${crypto.randomUUID()}.webp`, {
    headers: { Cookie: aliceCookie },
  })
  check('a media key with no row is refused', ghostMedia.status === 404, ghostMedia.status)

  const ghostAvatar = await fetch(`${API}/api/media/avatars/${crypto.randomUUID()}.webp`, {
    headers: { Cookie: aliceCookie },
  })
  check('an avatar key with no row is refused', ghostAvatar.status === 404, ghostAvatar.status)

  console.log('\n— how long a copy may be kept (F-01b, F-06)')

  const ownKey = await upload(aliceCookie)
  const ownRead = await fetch(`${API}/api/media/${ownKey}`, { headers: { Cookie: aliceCookie } })
  check('the uploader reads its own object', ownRead.status === 200, ownRead.status)
  check(
    'a message attachment is capped at the shortest window',
    ownRead.headers.get('Cache-Control') === `private, max-age=${MEDIA_MAX_AGE}, immutable`,
    ownRead.headers.get('Cache-Control'),
  )

  // A query string used to mint a second edge entry that no eviction could
  // find; the cache key comes from the object key now, so this is the same
  // object by every measure the caller can observe.
  const queried = await fetch(`${API}/api/media/${ownKey}?v=2`, {
    headers: { Cookie: aliceCookie },
  })
  check(
    'a query string changes nothing about the answer (F-03)',
    queried.status === 200 &&
      queried.headers.get('Cache-Control') === ownRead.headers.get('Cache-Control'),
    { status: queried.status, cacheControl: queried.headers.get('Cache-Control') },
  )

  const sticker = await fetch(`${API}/api/media/stickers/v1/manifest.json`, {
    headers: { Cookie: aliceCookie },
  })
  if (sticker.status === 200) {
    check(
      'shared instance content keeps the year',
      sticker.headers.get('Cache-Control') === `private, max-age=${YEAR_MAX_AGE}, immutable`,
      sticker.headers.get('Cache-Control'),
    )
  } else {
    console.log('  (sticker pack not published in this store — skipping its ceiling)')
  }

  console.log('\n— deleting an object means deleting every copy of it (F-01a)')

  const resolved = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ user_id: bob.id }),
  })
  const conversationId = resolved.body.conversation_id as string

  // Clean slate: other phases leave history in this pair's thread, and the
  // deadline assertions below are about one known message.
  await api(`/api/admin/conversations/${conversationId}/purge`, {
    method: 'POST',
    cookie: ownerCookie,
  })

  const socket = await Client.connect(
    `/api/ws/${conversationId}?with=${encodeURIComponent(bob.id)}`,
    aliceCookie,
  )

  const attachmentKey = await upload(aliceCookie)
  socket.send({
    type: 'send_message',
    client_id: `phase14-media-${Date.now()}`,
    msg_type: 'image',
    body: '',
    media_key: attachmentKey,
  })
  const mediaMessage = await socket.await((e) => e.type === 'message' && e.media_key === attachmentKey)
  check('the attachment is delivered as a message', mediaMessage !== null)

  // The claim is written from waitUntil; the peer's read is what proves it.
  await new Promise((r) => setTimeout(r, 500))
  const peerRead = await fetch(`${API}/api/media/${attachmentKey}`, {
    headers: { Cookie: bobCookie },
  })
  check('the peer reads media of their own conversation', peerRead.status === 200, peerRead.status)

  const purged = await api(`/api/admin/conversations/${conversationId}/purge`, {
    method: 'POST',
    cookie: ownerCookie,
  })
  check('the purge reports the object it deleted', purged.body?.media_deleted >= 1, purged.body)
  check(
    'the index row goes with the bytes',
    d1Query(`SELECT key FROM media_objects WHERE key = ${sqlString(attachmentKey)};`).length === 0,
  )

  const afterPurge = await fetch(`${API}/api/media/${attachmentKey}`, {
    headers: { Cookie: bobCookie },
  })
  check('and the key stops working for the peer', afterPurge.status === 404, afterPurge.status)
  const afterPurgeQueried = await fetch(`${API}/api/media/${attachmentKey}?v=2`, {
    headers: { Cookie: bobCookie },
  })
  check('…including the form that carries a query string', afterPurgeQueried.status === 404)

  console.log('\n— the deadline the cron backstop scans by (F-04)')

  const before = await untilMirrored(conversationId, (row) => row?.next_expiry_at === null)
  check('a purged conversation has nothing left to expire', before?.next_expiry_at === null, before)

  socket.send({ type: 'send_message', client_id: `phase14-text-${Date.now()}`, msg_type: 'text', body: 'oi' })
  const textMessage = await socket.await((e) => e.type === 'message' && e.msg_type === 'text')
  check('the message is persisted', textMessage !== null)

  const mirrored = await untilMirrored(conversationId, (row) => row?.next_expiry_at !== null)
  check(
    'D1 mirrors the deadline an unread message carries',
    mirrored?.next_expiry_at === textMessage.expires_at,
    { mirrored, expires_at: textMessage?.expires_at },
  )

  console.log('\n— a media key the sender made up (F-10)')

  socket.send({
    type: 'send_message',
    client_id: `phase14-bad-${Date.now()}`,
    msg_type: 'image',
    body: '',
    media_key: '../../etc/passwd',
  })
  const refused = await socket.await((e) => e.type === 'error' && e.error === 'invalid_media_key')
  check('a key outside the allowed shape is refused on send', refused !== null)

  socket.close()

  console.log('\n— the WebSocket handshake checks Origin (F-09)')

  const wsPath = `/api/ws/${conversationId}?with=${encodeURIComponent(bob.id)}`
  check(
    'a foreign Origin is refused',
    (await handshakeStatus(wsPath, aliceCookie, 'https://evil.example')) === 403,
  )
  const ownOrigin = await handshakeStatus(wsPath, aliceCookie, API)
  check('the app own origin is accepted', ownOrigin === 101, ownOrigin)
  const noOrigin = await handshakeStatus(wsPath, aliceCookie, null)
  // Only browsers must send one, and a non-browser client could forge it
  // anyway — refusing here would break every script in this folder.
  check('a client without an Origin is not refused by it', noOrigin === 101, noOrigin)

  console.log('\n— how much of a message may reach a lock screen (F-05)')

  const me = await api('/api/auth/me', { cookie: aliceCookie })
  check('the account carries the preference', 'push_preview' in (me.body?.user ?? {}), me.body?.user)

  const theme = {
    theme_mode: me.body.user.theme_mode,
    theme_light: me.body.user.theme_light ?? 'goodchat-crimson',
    theme_dark: me.body.user.theme_dark ?? 'goodchat-rose',
  }
  const full = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...theme, push_preview: 'full' }),
  })
  check('the preview can be opened up', full.body?.user?.push_preview === 'full', full.body?.user)

  const untouched = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify(theme),
  })
  check(
    'a call without the field keeps the stored value',
    untouched.body?.user?.push_preview === 'full',
    untouched.body?.user,
  )

  const bogusPreview = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...theme, push_preview: 'everything' }),
  })
  check('an unknown value is refused', bogusPreview.status === 400, bogusPreview.body)

  const generic = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...theme, push_preview: 'generic' }),
  })
  check('and closed back down', generic.body?.user?.push_preview === 'generic', generic.body?.user)

  console.log('\n— the owner leaves a trail (F-07)')

  const trailBefore = await api('/api/admin/audit', { cookie: ownerCookie })
  check('the trail is readable by an owner', trailBefore.status === 200, trailBefore.status)
  const asUser = await api('/api/admin/audit', { cookie: aliceCookie })
  check('and by nobody else', asUser.status === 403, asUser.status)

  const subject = `audit${Date.now().toString(36)}`
  const created = await api('/api/admin/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ username: subject, password: 'audited-goodchat' }),
  })
  check('owner creates the fixture account', created.status === 201, created.body)

  await api(`/api/admin/users/${created.body.id}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: JSON.stringify({ password: 'taken-over-goodchat' }),
  })
  await api(`/api/admin/users/${created.body.id}`, { method: 'DELETE', cookie: ownerCookie })

  const trailAfter = await api('/api/admin/audit', { cookie: ownerCookie })
  // By id, not by how much longer the list got: the endpoint returns the 50
  // newest rows, so on an instance that has been running a while both reads
  // come back the same length and a length diff is silently always zero.
  const seenBefore = new Set(trailBefore.body.entries.map((entry: any) => entry.id))
  const added = trailAfter.body.entries.filter((entry: any) => !seenBefore.has(entry.id))
  const actions = added.map((entry: any) => entry.action)
  check(
    'creating, taking over and deleting an account are all recorded',
    actions.includes('user.create') &&
      actions.includes('user.password_reset') &&
      actions.includes('user.delete'),
    actions,
  )
  const takeover = added.find((entry: any) => entry.action === 'user.password_reset')
  check(
    'the takeover names both sides of it',
    takeover?.target_name === subject && takeover?.actor_name === OWNER.username,
    takeover,
  )

  await api('/api/admin/users', { cookie: ownerCookie })
  await api('/api/admin/conversations', { cookie: ownerCookie })
  const trailAfterReads = await api('/api/admin/audit', { cookie: ownerCookie })
  // Same reason: compare the newest id rather than the length, which saturates.
  check(
    'reading the console records nothing',
    trailAfterReads.body.entries[0]?.id === trailAfter.body.entries[0]?.id,
    {
      before: trailAfter.body.entries[0]?.action,
      after: trailAfterReads.body.entries[0]?.action,
    },
  )

  console.log('\n— a username is not a way to lock its owner out (F-12)')

  // Counters are per (account, IP) and this whole file shares one IP, so the
  // table starts clean — otherwise the earlier failed logins of other phases
  // would decide the outcome.
  d1Execute('DELETE FROM login_attempts;')

  const stranger = `locked${Date.now().toString(36)}`
  const known = `trusted${Date.now().toString(36)}`
  for (const username of [stranger, known]) {
    const account = await api('/api/admin/users', {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ username, password: 'lockout-goodchat' }),
    })
    if (account.status !== 201) throw new Error(`could not create ${username} (${account.status})`)
  }

  // The address vouches for itself by signing in once, before the flood.
  check('the account can be used at all', (await login(known, 'lockout-goodchat')) !== null)

  for (const username of [stranger, known]) {
    for (let i = 0; i < 5; i++) {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: `wrong-${i}` }),
      })
    }
  }

  const strangerRetry = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: stranger, password: 'lockout-goodchat' }),
  })
  check(
    'five failures from an unknown address lock the account',
    strangerRetry.status === 429,
    strangerRetry.status,
  )

  const knownRetry = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: known, password: 'lockout-goodchat' }),
  })
  check(
    'an address that has signed in before is not locked out with it',
    knownRetry.status === 200,
    knownRetry.status,
  )

  // Leave the instance as it was found.
  d1Execute('DELETE FROM login_attempts;')
  for (const username of [stranger, known]) {
    d1Execute(`DELETE FROM users WHERE username = ${sqlString(username)};`)
  }
} finally {
  await ownedServer?.close()
}

console.log(failures === 0 ? '\nphase 14 smoke: all green' : `\nphase 14 smoke: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
