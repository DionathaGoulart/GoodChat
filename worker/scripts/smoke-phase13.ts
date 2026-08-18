// Phase 13 smoke test — the disappearing-message window (PRD §3.9), against a
// live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase13                                  (terminal 2)
//
// Covers: the default window on resolve and on connect, either participant
// changing it and both being told, the change landing in D1's mirror, the
// refusal of a window that is not on the menu, the deadline the owner console
// reports (first message + window, which is what the alarm is armed for), and
// the cleanup report carrying the two retention counters.
//
// What it deliberately does not cover: a message actually aging out. The
// shortest window the product offers is three hours and nothing here can move
// the clock — the DO stamps `created_at` itself. What is asserted instead is
// every input to that deletion: the window in force, the deadline computed
// from it, and the fact that shortening it re-computes the deadline at once.

import WebSocket from 'ws'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** Mirrors RETENTION_OPTIONS_MS in src/protocol.ts. */
const MENU = [3 * HOUR_MS, 5 * HOUR_MS, 12 * HOUR_MS, DAY_MS, 3 * DAY_MS, 5 * DAY_MS, 7 * DAY_MS]

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

async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const setCookie = res.headers.get('Set-Cookie')
  if (res.status !== 200 || !setCookie) return null
  return setCookie.split(';')[0]
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

// Every conversation has a window, even one with no row yet. Reruns inherit
// whatever the last run chose, so the value is only checked against the menu
// here; the default is asserted below, on a conversation put back to it.
check(
  'resolve reports a window, and it is one of the offered ones',
  MENU.includes(resolved.body.retention_ms),
  resolved.body.retention_ms,
)

const wsAlice = await Client.connect(`/api/ws/${conversationId}?with=${bobId}`, alice)
const wsBob = await Client.connect(`/api/ws/${conversationId}?with=${aliceId}`, bob)

// --- the window is stated on connect --------------------------------------
const stated = await wsAlice.next('retention frame on connect', (e) => e.type === 'retention')
check(
  'connect states the window, without claiming anyone just changed it',
  stated.retention_ms === resolved.body.retention_ms && stated.changed_by === null,
  stated,
)

// Back to the default, so the rest of the run starts from a known window and
// so the maximum is exercised as a choice too.
wsAlice.send({ type: 'set_retention', retention_ms: 7 * DAY_MS })
const reset = await wsAlice.nextNew(
  'window back to the default',
  (e) => e.type === 'retention' && e.changed_by !== null && e.retention_ms === 7 * DAY_MS,
)
check('7 days is a window like any other, and can be chosen back', reset.retention_ms === 7 * DAY_MS, reset)

// --- a message, so the conversation has a clock to run --------------------
const clientId = `retention-${Date.now()}`
wsAlice.send({ type: 'send_message', client_id: clientId, msg_type: 'text', body: 'oi' })
const echo = await wsAlice.next('message echo', (e) => e.type === 'message' && e.client_id === clientId)
const sentAt: number = echo.created_at

// --- either side changes it, both hear about it ---------------------------
wsBob.send({ type: 'set_retention', retention_ms: 3 * HOUR_MS })
const onBob = await wsBob.nextNew(
  'retention echo',
  (e) => e.type === 'retention' && e.changed_by !== null,
)
const onAlice = await wsAlice.nextNew(
  'retention broadcast',
  (e) => e.type === 'retention' && e.changed_by !== null,
)
check('the side that changed it is told', onBob.retention_ms === 3 * HOUR_MS, onBob)
check(
  'the other side is told too, and by whom',
  onAlice.retention_ms === 3 * HOUR_MS && onAlice.changed_by === bobId,
  onAlice,
)

// --- and a window that is not on the menu is refused ----------------------
wsAlice.send({ type: 'set_retention', retention_ms: 60_000 })
const refused = await wsAlice.next('refusal', (e) => e.type === 'error')
check('a window outside the menu is refused', refused.error === 'invalid_message', refused)

const stillThere = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: bobId }),
})
check(
  'the refusal changed nothing: D1 still mirrors the chosen window',
  stillThere.body.retention_ms === 3 * HOUR_MS,
  stillThere.body.retention_ms,
)

// --- the deadline the alarm is armed for ----------------------------------
const consoleView = await api('/api/admin/conversations', { cookie: owner })
const row = consoleView.body.conversations.find((c: any) => c.id === conversationId)
check(
  'the owner console reports the window',
  row !== undefined && row.retention_ms === 3 * HOUR_MS,
  row,
)
// The oldest surviving message plus the window. Which message that is depends
// on what else has run against this pair (the phase-4 suite writes here too),
// so what is asserted is the range the 3h sweep guarantees: everything older
// is already deleted, so the deadline is at most 3h out and still ahead of now.
check(
  'and the deadline, which is the oldest surviving message plus the window',
  row !== undefined &&
    row.next_expiry_at > sentAt &&
    row.next_expiry_at <= sentAt + 3 * HOUR_MS,
  { next_expiry_at: row?.next_expiry_at, sent_at: sentAt, window: 3 * HOUR_MS },
)
const deadlineAt3h: number = row?.next_expiry_at

// --- a longer window moves the same deadline ------------------------------
wsAlice.send({ type: 'set_retention', retention_ms: DAY_MS })
await wsBob.nextNew(
  'retention widened',
  (e) => e.type === 'retention' && e.changed_by !== null && e.retention_ms === DAY_MS,
)
const widened = await api('/api/admin/conversations', { cookie: owner })
const widenedRow = widened.body.conversations.find((c: any) => c.id === conversationId)
check(
  'widening the window pushes the deadline out by exactly the difference',
  widenedRow !== undefined && widenedRow.next_expiry_at - deadlineAt3h === DAY_MS - 3 * HOUR_MS,
  { before: deadlineAt3h, after: widenedRow?.next_expiry_at, difference: DAY_MS - 3 * HOUR_MS },
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
