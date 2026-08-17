// Phase 6 smoke test — media pipeline against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase6                                   (terminal 2)
//
// The fake-B2 stub (scripts/media-dev-server.ts) is started in-process on the
// port from worker/.dev.vars (9000); if it's already running (`npm run
// media:dev`), the existing instance is reused.
//
// Covers: auth on upload-url, MIME allowlist + size caps rejected by the
// Worker, presigned URL shape (signed content-length/content-type, upload
// bypasses the Worker), PUT→GET roundtrip, image message over WS delivered in
// real time with the media_key, media in history after reconnect, and DO
// rejection of media messages without a key.

import WebSocket from 'ws'
import { startMediaDevServer } from './media-dev-server.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const MEDIA_PORT = Number(process.env.MEDIA_DEV_PORT ?? 9000)

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

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const setCookie = res.headers.get('Set-Cookie')
  if (res.status !== 200 || !setCookie) throw new Error(`login ${username} failed (${res.status})`)
  return setCookie.split(';')[0]
}

/** WS client: buffers frames, lets the test await a matching one. */
class Client {
  received: any[] = []
  private waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = []
  private ws: WebSocket

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      this.received.push(event)
      const i = this.waiters.findIndex((w) => w.pred(event))
      if (i !== -1) this.waiters.splice(i, 1)[0].resolve(event)
    })
  }

  static connect(path: string, cookie: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_API}${path}`, { headers: { Cookie: cookie } })
      ws.on('open', () => resolve(new Client(ws)))
      ws.on('unexpected-response', (_req, res) => {
        reject(new Error(`handshake rejected: ${res.statusCode}`))
        ws.terminate()
      })
      ws.on('error', (err) => reject(err))
    })
  }

  send(event: unknown): void {
    this.ws.send(JSON.stringify(event))
  }

  next(label: string, pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const already = this.received.find(pred)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped)
        reject(new Error(`timeout waiting for: ${label}`))
      }, timeoutMs)
      const wrapped = (e: any) => {
        clearTimeout(timer)
        resolve(e)
      }
      this.waiters.push({ pred, resolve: wrapped })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.on('close', () => resolve())
      this.ws.close()
    })
  }
}

// --- media stub (reuse a running one if the port is taken) ---
let ownedServer: Awaited<ReturnType<typeof startMediaDevServer>> | null = null
try {
  ownedServer = await startMediaDevServer(MEDIA_PORT)
  console.log(`media stub started on :${MEDIA_PORT}`)
} catch (err: any) {
  if (err?.code !== 'EADDRINUSE') throw err
  console.log(`media stub already running on :${MEDIA_PORT} — reusing`)
}

try {
  // --- setup ---
  const alice = await login('alice', 'alice-goodchat')
  const bob = await login('bob', 'bob-goodchat')
  const bobId: string = (await api('/api/auth/me', { cookie: bob })).body.user.id
  const aliceId: string = (await api('/api/auth/me', { cookie: alice })).body.user.id
  const resolved = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: alice,
    body: JSON.stringify({ user_id: bobId }),
  })
  const conversationId: string = resolved.body.conversation_id
  const wsPath = (peer: string) => `/api/ws/${conversationId}?with=${peer}`

  // --- upload-url validation (Worker-side enforcement) ---
  const noAuth = await api('/api/media/upload-url', {
    method: 'POST',
    body: JSON.stringify({ mime: 'image/png', size: 100 }),
  })
  check('upload-url without session → 401', noAuth.status === 401, noAuth)

  const badMime = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: alice,
    body: JSON.stringify({ mime: 'application/pdf', size: 100 }),
  })
  check(
    'disallowed MIME → 415 unsupported_media_type',
    badMime.status === 415 && badMime.body?.error === 'unsupported_media_type',
    badMime,
  )

  const bigImage = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: alice,
    body: JSON.stringify({ mime: 'image/png', size: 9 * 1024 * 1024 }),
  })
  check(
    'oversized image → 413 payload_too_large',
    bigImage.status === 413 && bigImage.body?.error === 'payload_too_large',
    bigImage,
  )

  const bigVideo = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: alice,
    body: JSON.stringify({ mime: 'video/mp4', size: 33 * 1024 * 1024 }),
  })
  check('oversized video → 413', bigVideo.status === 413, bigVideo)

  // --- happy path: presign, upload, serve ---
  const bytes = Buffer.from(`fake-png-${crypto.randomUUID()}`)
  const grant = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: alice,
    body: JSON.stringify({ mime: 'image/png', size: bytes.byteLength }),
  })
  check('valid request → 200 with key/upload_url/public_url', grant.status === 200, grant)
  const key: string = grant.body.key
  check(
    'key is month-prefixed and unguessable',
    /^media\/\d{4}-\d{2}\/[0-9a-f-]{36}\.png$/.test(key),
    key,
  )
  const uploadUrl = new URL(grant.body.upload_url)
  check(
    'upload goes direct to B2, not through the Worker',
    uploadUrl.origin !== new URL(API).origin,
    uploadUrl.origin,
  )
  check(
    'presigned URL signs content-length + content-type',
    uploadUrl.searchParams.get('X-Amz-SignedHeaders')?.includes('content-length') === true &&
      uploadUrl.searchParams.get('X-Amz-SignedHeaders')?.includes('content-type') === true &&
      uploadUrl.searchParams.has('X-Amz-Signature'),
    uploadUrl.search,
  )

  const put = await fetch(grant.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: bytes,
  })
  check('PUT to presigned URL → 200', put.status === 200, put.status)

  const served = await fetch(grant.body.public_url)
  const servedBytes = Buffer.from(await served.arrayBuffer())
  check(
    'GET public_url serves the exact bytes + content-type',
    served.status === 200 &&
      served.headers.get('content-type') === 'image/png' &&
      servedBytes.equals(bytes),
    { status: served.status, contentType: served.headers.get('content-type') },
  )

  // --- WS: image message delivered in real time with the media key ---
  const bobClient = await Client.connect(wsPath(aliceId), bob)
  const aliceClient = await Client.connect(wsPath(bobId), alice)
  const clientId = crypto.randomUUID()
  aliceClient.send({
    type: 'send_message',
    client_id: clientId,
    msg_type: 'image',
    body: '',
    media_key: key,
  })
  const frame = await bobClient.next(
    'bob receives image message',
    (e) => e.type === 'message' && e.client_id === clientId,
  )
  check(
    'peer receives image frame with media_key, delivered',
    frame.msg_type === 'image' && frame.media_key === key && frame.status === 'delivered',
    frame,
  )
  await aliceClient.next('alice echo', (e) => e.type === 'message' && e.client_id === clientId)

  // --- history after reconnect (covers "still there after reload") ---
  await bobClient.close()
  const bobAgain = await Client.connect(wsPath(aliceId), bob)
  const history = await bobAgain.next('history on reconnect', (e) => e.type === 'history')
  check(
    'image message persisted in history with media_key',
    history.messages.some((m: any) => m.client_id === clientId && m.media_key === key),
    history.messages.length,
  )

  // --- DO rejects media messages without a key ---
  aliceClient.send({
    type: 'send_message',
    client_id: crypto.randomUUID(),
    msg_type: 'image',
    body: '',
  })
  const err = await aliceClient.next('error frame', (e) => e.type === 'error')
  check('image without media_key → error media_key_required', err.error === 'media_key_required', err)

  await bobAgain.close()
  await aliceClient.close()
} finally {
  ownedServer?.close()
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall green')
