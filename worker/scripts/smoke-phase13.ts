// Phase 13 smoke test — the disappearing-message clock (PRD §3.9), against a
// live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase13                                  (terminal 2)
//
// Covers the rule that replaced the per-conversation window: a message lands
// with seven days to live, and the recipient reading it pulls that deadline in
// to three hours. Asserted here: the deadline a new message carries, the
// receipt naming ids and moving it, both sides being told the same new moment,
// the sender's tick following, the D1 mirror the cron backstop scans, and the
// three refusals that make reading safe to be destructive — a sender cannot
// report its own message read, a second report cannot restart a clock, and an
// unknown id is ignored rather than answered with an error.
//
// What it deliberately does not cover: a message actually being deleted. The
// shortest life the product offers is three hours and nothing here can move the
// clock — the DO stamps `created_at` and `read_at` itself. What is asserted
// instead is every input to that deletion.

import WebSocket from 'ws'
import { signIn } from './lib.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Mirrors READ_TTL_MS and UNREAD_TTL_MS in src/protocol.ts. */
const READ_TTL_MS = 3 * HOUR_MS
const UNREAD_TTL_MS = 7 * DAY_MS

/** Clock skew and round-trip slack for a deadline the server stamped. */
const SLACK_MS = 60_000

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

  /** Ignores everything buffered so far — for "and then this happens". */
  nextNew(label: string, pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const from = this.received.length
    return this.next(label, pred, timeoutMs, from)
  }

  next(label: string, pred: (e: any) => boolean, timeoutMs = 5000, from = 0): Promise<any> {
    const already = this.received.slice(from).find(pred)
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

// --- setup ---------------------------------------------------------------
const alice = await requireLogin('alice', 'alice-goodchat')
const bob = await requireLogin('bob', 'bob-goodchat')

// The console assertions need the owner. Same contract as the phase-9 smoke:
// the account is not seeded, so the test says how to create it and stops.
const owner = await login('good', 'good-goodchat')
if (!owner) {
  console.error('FAIL: owner account required — npm run user:create -- --owner good good-goodchat Good')
  process.exit(1)
}
const bobId: string = (await api('/api/auth/me', { cookie: bob })).body.user.id
const aliceId: string = (await api('/api/auth/me', { cookie: alice })).body.user.id

const resolved = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: bobId }),
})
const conversationId: string = resolved.body.conversation_id

const wsAlice = await Client.connect(`/api/ws/${conversationId}?with=${bobId}`, alice)
const wsBob = await Client.connect(`/api/ws/${conversationId}?with=${aliceId}`, bob)

check(
  'resolve no longer reports a window — there is one rule, not a per-thread choice',
  resolved.body.retention_ms === undefined,
  resolved.body,
)

// --- a message lands on the unread ceiling --------------------------------
const clientId = `expiry-${Date.now()}`
wsAlice.send({ type: 'send_message', client_id: clientId, msg_type: 'text', body: 'oi' })
const echo = await wsAlice.next('message echo', (e) => e.type === 'message' && e.client_id === clientId)
const sentAt: number = echo.created_at
check(
  'a new message is unread and carries seven days',
  echo.read_at === null && echo.expires_at === sentAt + UNREAD_TTL_MS,
  { read_at: echo.read_at, expires_at: echo.expires_at, expected: sentAt + UNREAD_TTL_MS },
)
// Being handed the bytes is not being shown to anybody: Bob's socket is open,
// so this message is already 'delivered', and its clock has not started.
const onBob = await wsBob.next('peer copy', (e) => e.type === 'message' && e.client_id === clientId)
check(
  'delivered is not read: an open socket does not start the clock',
  onBob.status === 'delivered' && onBob.read_at === null,
  { status: onBob.status, read_at: onBob.read_at },
)

const beforeRead = await api('/api/admin/conversations', { cookie: owner })
const beforeRow = beforeRead.body.conversations.find((c: any) => c.id === conversationId)
check(
  'D1 mirrors the earliest deadline the DO holds',
  beforeRow !== undefined && beforeRow.next_expiry_at !== null && beforeRow.next_expiry_at <= echo.expires_at,
  { mirrored: beforeRow?.next_expiry_at, message: echo.expires_at },
)

// --- the sender cannot condemn its own message ----------------------------
wsAlice.send({ type: 'read_receipt', ids: [echo.id] })
wsBob.send({ type: 'typing' })
await wsAlice.nextNew('a round trip to let any wrong receipt land', (e) => e.type === 'typing')
const selfRead = wsAlice.received.filter((e) => e.type === 'read_receipt')
check(
  'a sender reporting its own message read changes nothing',
  selfRead.length === 0,
  selfRead,
)

// --- an unknown id is ignored, not refused --------------------------------
wsBob.send({ type: 'read_receipt', ids: ['00000000-0000-0000-0000-000000000000'] })
wsBob.send({ type: 'typing' })
await wsAlice.nextNew('a round trip after the unknown id', (e) => e.type === 'typing')
check(
  'an id that no longer exists is ignored rather than answered with an error',
  wsBob.received.filter((e) => e.type === 'error').length === 0,
  wsBob.received.filter((e) => e.type === 'error'),
)

// --- the read that starts the clock ---------------------------------------
const readSentAt = Date.now()
wsBob.send({ type: 'read_receipt', ids: [echo.id] })
const receipt = await wsAlice.nextNew(
  'read receipt on the sender',
  (e) => e.type === 'read_receipt' && e.reads.some((r: any) => r.id === echo.id),
)
const read = receipt.reads.find((r: any) => r.id === echo.id)
check('the receipt names who read it', receipt.user_id === bobId, receipt.user_id)
check(
  'reading pulls the deadline in to three hours from now',
  Math.abs(read.expires_at - (readSentAt + READ_TTL_MS)) < SLACK_MS,
  { expires_at: read.expires_at, expected: readSentAt + READ_TTL_MS },
)
check(
  'and that is very much earlier than the seven days it had',
  read.expires_at < echo.expires_at,
  { after: read.expires_at, before: echo.expires_at },
)
// The reader's own connection is told too — its other tabs did not witness it.
// `next`, not `nextNew`: the reader's copy is broadcast in the same breath as
// the sender's, so by the time Alice's await resolved it was already buffered.
const onReader = await wsBob.next(
  'the reader hears its own receipt',
  (e) => e.type === 'read_receipt' && e.reads.some((r: any) => r.id === echo.id),
)
check(
  'the reader is told the same deadline the sender was',
  onReader.reads.find((r: any) => r.id === echo.id).expires_at === read.expires_at,
  onReader.reads,
)
check(
  'and no second frame says the same thing: the receipt is the status change',
  wsAlice.received.filter((e) => e.type === 'message_status' && e.id === echo.id).length === 0,
  wsAlice.received.filter((e) => e.type === 'message_status'),
)

// --- a second report cannot restart a clock -------------------------------
wsBob.send({ type: 'read_receipt', ids: [echo.id] })
wsBob.send({ type: 'typing' })
await wsAlice.nextNew('a round trip after the repeat', (e) => e.type === 'typing')
const receipts = wsAlice.received.filter(
  (e) => e.type === 'read_receipt' && e.reads.some((r: any) => r.id === echo.id),
)
check(
  'reporting the same message read twice does not grant it three more hours',
  receipts.length === 1,
  receipts.map((r) => r.reads),
)

// --- the mirror the cron backstop scans -----------------------------------
const afterRead = await api('/api/admin/conversations', { cookie: owner })
const afterRow = afterRead.body.conversations.find((c: any) => c.id === conversationId)
check(
  'the read moved the deadline D1 mirrors, not just the one in the DO',
  afterRow !== undefined && afterRow.next_expiry_at <= read.expires_at,
  { before: beforeRow?.next_expiry_at, after: afterRow?.next_expiry_at, read: read.expires_at },
)

// --- the scheduled backstop -----------------------------------------------
const cleanup = await api('/api/admin/cleanup', { method: 'POST', cookie: owner })
check(
  'cleanup reports the two retention counters',
  cleanup.status === 200 &&
    typeof cleanup.body?.retention_media_deleted === 'number' &&
    typeof cleanup.body?.retention_conversations_swept === 'number',
  cleanup.body,
)

// --- a purged conversation has no deadline left ---------------------------
await api(`/api/admin/conversations/${conversationId}/purge`, { method: 'POST', cookie: owner })
const purged = await api('/api/admin/conversations', { cookie: owner })
const purgedRow = purged.body.conversations.find((c: any) => c.id === conversationId)
check(
  'with no messages there is nothing to expire and nothing scheduled',
  purgedRow !== undefined && purgedRow.next_expiry_at === null,
  purgedRow,
)

await wsAlice.close()
await wsBob.close()

console.log(failures === 0 ? '\nphase 13 smoke: all green' : `\nphase 13 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
