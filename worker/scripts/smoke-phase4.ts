// Phase 4 smoke test — two WebSocket clients against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase4                                   (terminal 2)
//
// Node ≥24 + `ws` (the browser-style global WebSocket cannot send a Cookie
// header). DO storage persists across runs (.wrangler/state), so every
// assertion is scoped to this run's unique client_ids — reruns stay green.
//
// Covers: auth/pair validation on upgrade, history on connect, online
// delivery, offline delivery on reconnect, client_id dedup, read receipts,
// lazy conversation-row creation in D1.

import WebSocket from 'ws'
import { signIn } from './lib.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')

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
  private waiters: {
    pred: (e: any) => boolean
    resolve: (e: any) => void
  }[] = []

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

async function expectHandshakeStatus(
  label: string,
  path: string,
  cookie: string | undefined,
  expected: number,
): Promise<void> {
  try {
    const client = await Client.connect(path, cookie ?? '')
    await client.close()
    check(label, false, 'handshake unexpectedly succeeded')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    check(label, msg.includes(String(expected)), msg)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

// --- handshake validation ---
await expectHandshakeStatus('upgrade without session → 401', wsPath(bobId), undefined, 401)
await expectHandshakeStatus(
  'upgrade with mismatched conversation id → 403',
  `/api/ws/${'0'.repeat(32)}?with=${bobId}`,
  alice,
  403,
)
await expectHandshakeStatus(
  'upgrade with unknown peer → 404',
  `/api/ws/${conversationId}?with=no-such-user`,
  alice,
  404,
)

// --- online + offline delivery ---
const wsAlice = await Client.connect(wsPath(bobId), alice)
const hello = await wsAlice.next('history on connect', (e) => e.type === 'history')
check('alice receives history frame on connect', Array.isArray(hello.messages))

const m1 = crypto.randomUUID()
wsAlice.send({ type: 'send_message', client_id: m1, msg_type: 'text', body: 'oi bob! (m1)' })
const echo1 = await wsAlice.next(
  'echo of m1',
  (e) => e.type === 'message' && e.client_id === m1,
)
check(
  "m1 echo: sender_id=alice, status='sent' (bob offline)",
  echo1.sender_id === aliceId && echo1.status === 'sent',
  echo1,
)

const wsBob = await Client.connect(wsPath(aliceId), bob)
const bobHistory = await wsBob.next('bob history', (e) => e.type === 'history')
const m1InHistory = bobHistory.messages.find((m: any) => m.client_id === m1)
check(
  "offline delivery: m1 in bob's history as 'delivered'",
  m1InHistory !== undefined && m1InHistory.status === 'delivered',
  m1InHistory,
)
const status1 = await wsAlice.next(
  'delivered status for m1',
  (e) => e.type === 'message_status' && e.client_id === m1,
)
check("alice notified m1 → 'delivered' when bob connects", status1.status === 'delivered', status1)

const m2 = crypto.randomUUID()
wsBob.send({ type: 'send_message', client_id: m2, msg_type: 'text', body: 'oi alice! (m2)' })
const m2AtAlice = await wsAlice.next(
  'm2 in real time',
  (e) => e.type === 'message' && e.client_id === m2,
)
check(
  "online delivery: alice gets m2 in real time, status 'delivered'",
  m2AtAlice.sender_id === bobId && m2AtAlice.status === 'delivered',
  m2AtAlice,
)

// --- dedup ---
wsAlice.send({ type: 'send_message', client_id: m1, msg_type: 'text', body: 'oi bob! (m1)' })
const dupAck = await wsAlice.next(
  'dedup ack',
  (e) => e.type === 'message_status' && e.client_id === m1,
)
check('resent client_id acks existing message id (no new row)', dupAck.id === echo1.id, dupAck)
await sleep(300)
check(
  'bob received exactly one message frame for m1',
  wsBob.received.filter((e) => e.type === 'message' && e.client_id === m1).length === 0 &&
    bobHistory.messages.filter((m: any) => m.client_id === m1).length === 1,
  wsBob.received,
)

// --- read receipts ---
wsBob.send({ type: 'read_receipt', ids: [echo1.id] })
const read1 = await wsAlice.next(
  'read receipt at alice',
  (e) => e.type === 'read_receipt' && e.reads.some((r: any) => r.id === echo1.id),
)
check('alice receives read_receipt from bob for m1', read1.user_id === bobId, read1)
check(
  'and the receipt carries the message its new deadline',
  read1.reads.find((r: any) => r.id === echo1.id).expires_at < echo1.expires_at,
  read1.reads,
)

// --- typing (protocol only; UI in phase 7) ---
wsAlice.send({ type: 'typing' })
const typing = await wsBob.next('typing at bob', (e) => e.type === 'typing')
check('bob receives typing event with alice user_id', typing.user_id === aliceId, typing)

// --- invalid payload ---
wsAlice.send({ type: 'send_message', client_id: crypto.randomUUID() })
const invalid = await wsAlice.next('error frame', (e) => e.type === 'error')
check('malformed send_message → error frame, socket stays open', invalid.error === 'invalid_message')

// --- offline delivery with a previously-connected recipient ---
await wsBob.close()
await sleep(500) // let the DO observe the close before m3 is sent
const m3 = crypto.randomUUID()
wsAlice.send({ type: 'send_message', client_id: m3, msg_type: 'text', body: 'tá aí? (m3)' })
const echo3 = await wsAlice.next(
  'echo of m3',
  (e) => e.type === 'message' && e.client_id === m3,
)
check("m3 sent while bob disconnected → status 'sent'", echo3.status === 'sent', echo3)

const wsBob2 = await Client.connect(wsPath(aliceId), bob)
const bobHistory2 = await wsBob2.next('bob history after reconnect', (e) => e.type === 'history')
const m3InHistory = bobHistory2.messages.find((m: any) => m.client_id === m3)
check(
  "reconnect delivery: m3 in bob's history as 'delivered'",
  m3InHistory !== undefined && m3InHistory.status === 'delivered',
  m3InHistory,
)
check(
  'history is deduped across the whole run (one frame per client_id)',
  [m1, m2, m3].every(
    (cid) => bobHistory2.messages.filter((m: any) => m.client_id === cid).length === 1,
  ),
  bobHistory2.messages.map((m: any) => m.client_id),
)
const status3 = await wsAlice.next(
  'delivered status for m3',
  (e) => e.type === 'message_status' && e.client_id === m3,
)
check("alice notified m3 → 'delivered' on bob reconnect", status3.status === 'delivered', status3)

// --- lazy conversation row in D1 ---
const list = await api('/api/conversations', { cookie: alice })
const row = list.body.conversations.find((c: any) => c.id === conversationId)
check(
  'first message materialized the conversation row (list + last_message_at)',
  row !== undefined && typeof row.last_message_at === 'number' && row.other_user.id === bobId,
  list.body,
)

await wsAlice.close()
await wsBob2.close()

console.log(failures === 0 ? '\nphase 4 smoke: all green' : `\nphase 4 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
