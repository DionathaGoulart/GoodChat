// Phase 7 smoke test — typing, emoji (plain Unicode), stickers, and the pack
// pipeline, against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase7                                   (terminal 2)
//
// The fake-B2 media server is started in-process when port 9000 is free
// (otherwise the one already running is used) and the sticker pack is
// published to it first. DO storage persists across runs, so every assertion
// is scoped to this run's unique client_ids — reruns stay green.
//
// Covers: pack publish + manifest/asset roundtrip, typing broadcast (peer
// only, never echoed to the sender's own tabs), emoji body persistence,
// sticker online/offline delivery + read receipt, sticker id validation.

import WebSocket from 'ws'
import { STICKER_ID_RE } from '../src/protocol.ts'
import { startMediaDevServer } from './media-dev-server.ts'
import { publishStickers } from './publish-stickers.ts'
import { signIn } from './lib.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const MEDIA_PORT = Number(process.env.MEDIA_DEV_PORT ?? 9000)
const MEDIA_BASE = `http://localhost:${MEDIA_PORT}/goodchat-media`

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
async function login(username: string, password: string): Promise<string> {
  const cookie = await signIn(API, username, password)
  if (!cookie) throw new Error(`login ${username} failed`)
  return cookie
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- sticker pack: publish + roundtrip ---
try {
  await startMediaDevServer(MEDIA_PORT)
  console.log(`media dev server started in-process on :${MEDIA_PORT}`)
} catch {
  console.log(`port ${MEDIA_PORT} busy — assuming the media dev server is already running`)
}
await publishStickers(MEDIA_BASE)

const manifestRes = await fetch(`${MEDIA_BASE}/stickers/v1/manifest.json`)
const manifest = (await manifestRes.json()) as {
  version: number
  base: string
  stickers: { id: string; file: string; label: string }[]
}
check(
  'manifest served with application/json and a non-empty pack',
  manifestRes.headers.get('content-type') === 'application/json' && manifest.stickers.length > 0,
  manifest,
)
check(
  'every sticker id in the manifest matches STICKER_ID_RE',
  manifest.stickers.every((s) => STICKER_ID_RE.test(s.id)),
  manifest.stickers.map((s) => s.id),
)
const assetChecks = await Promise.all(
  manifest.stickers.map(async (s) => {
    const res = await fetch(`${MEDIA_BASE}/${manifest.base}/${s.file}`)
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')
  }),
)
check('every manifest asset serves 200 with an image/* content-type', assetChecks.every(Boolean))

// --- setup ---
const alice = await login('alice', 'alice-goodchat')
const bob = await login('bob', 'bob-goodchat')
const aliceId: string = (await api('/api/auth/me', { cookie: alice })).body.user.id
const bobId: string = (await api('/api/auth/me', { cookie: bob })).body.user.id
const resolve = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: bobId }),
})
const conversationId: string = resolve.body.conversation_id
const wsPath = (peer: string) => `/api/ws/${conversationId}?with=${peer}`
console.log(`conversation ${conversationId} (alice=${aliceId}, bob=${bobId})`)

const wsAlice = await Client.connect(wsPath(bobId), alice)
await wsAlice.next('alice history', (e) => e.type === 'history')
const wsAliceTab2 = await Client.connect(wsPath(bobId), alice)
await wsAliceTab2.next('alice tab2 history', (e) => e.type === 'history')
const wsBob = await Client.connect(wsPath(aliceId), bob)
await wsBob.next('bob history', (e) => e.type === 'history')

// --- typing: peer-only broadcast ---
wsAlice.send({ type: 'typing' })
const typing = await wsBob.next('typing at bob', (e) => e.type === 'typing')
check('bob receives typing with alice user_id', typing.user_id === aliceId, typing)
await sleep(300)
check(
  "alice's own tabs never see her typing",
  !wsAliceTab2.received.some((e) => e.type === 'typing') &&
    !wsAlice.received.some((e) => e.type === 'typing'),
)

// --- emoji: plain Unicode body survives the roundtrip ---
const emojiBody = 'caveman aprova 🔥👍😄'
const mEmoji = crypto.randomUUID()
wsAlice.send({ type: 'send_message', client_id: mEmoji, msg_type: 'text', body: emojiBody })
const emojiAtBob = await wsBob.next(
  'emoji text at bob',
  (e) => e.type === 'message' && e.client_id === mEmoji,
)
check('emoji body arrives byte-identical', emojiAtBob.body === emojiBody, emojiAtBob.body)

// --- sticker: online delivery ---
const mSticker = crypto.randomUUID()
wsAlice.send({ type: 'send_message', client_id: mSticker, msg_type: 'sticker', body: 'fire' })
const stickerAtBob = await wsBob.next(
  'sticker at bob',
  (e) => e.type === 'message' && e.client_id === mSticker,
)
check(
  "sticker delivered online: msg_type 'sticker', body 'fire', status 'delivered'",
  stickerAtBob.msg_type === 'sticker' &&
    stickerAtBob.body === 'fire' &&
    stickerAtBob.status === 'delivered',
  stickerAtBob,
)

// --- sticker: id validation ---
for (const bad of ['../evil', 'FIRE', 'a b', '']) {
  const cid = crypto.randomUUID()
  wsAlice.send({ type: 'send_message', client_id: cid, msg_type: 'sticker', body: bad })
  const err = await wsAlice.next(
    `error for sticker ${JSON.stringify(bad)}`,
    (e) => e.type === 'error',
  )
  check(
    `sticker body ${JSON.stringify(bad)} rejected`,
    err.error === 'invalid_sticker' || err.error === 'empty_body',
    err,
  )
  // Consume the error so the next iteration waits for a fresh frame.
  wsAlice.received = wsAlice.received.filter((e) => e !== err)
}
await sleep(300)
check(
  'no invalid sticker ever reached bob',
  wsBob.received.filter((e) => e.type === 'message' && e.msg_type === 'sticker').length === 1,
)

// --- sticker: offline delivery + read receipt ---
await wsBob.close()
await sleep(500) // let the DO observe the close
const mOffline = crypto.randomUUID()
wsAlice.send({ type: 'send_message', client_id: mOffline, msg_type: 'sticker', body: 'gg' })
const echoOffline = await wsAlice.next(
  'echo of offline sticker',
  (e) => e.type === 'message' && e.client_id === mOffline,
)
check("sticker sent while bob offline → status 'sent'", echoOffline.status === 'sent', echoOffline)

const wsBob2 = await Client.connect(wsPath(aliceId), bob)
const bobHistory2 = await wsBob2.next('bob history after reconnect', (e) => e.type === 'history')
const offlineInHistory = bobHistory2.messages.find((m: any) => m.client_id === mOffline)
check(
  "reconnect delivery: sticker in bob's history as 'delivered'",
  offlineInHistory !== undefined &&
    offlineInHistory.msg_type === 'sticker' &&
    offlineInHistory.status === 'delivered',
  offlineInHistory,
)
const emojiInHistory = bobHistory2.messages.find((m: any) => m.client_id === mEmoji)
check('emoji body persisted intact in history', emojiInHistory?.body === emojiBody, emojiInHistory)

wsBob2.send({ type: 'read_receipt', ids: [echoOffline.id] })
const read = await wsAlice.next(
  'read receipt at alice',
  (e) => e.type === 'read_receipt' && e.reads.some((r: any) => r.id === echoOffline.id),
)
check('read receipt on the sticker reaches alice', read.user_id === bobId, read)

await wsAlice.close()
await wsAliceTab2.close()
await wsBob2.close()

console.log(failures === 0 ? '\nphase 7 smoke: all green' : `\nphase 7 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
