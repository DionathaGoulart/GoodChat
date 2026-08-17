// Phase 10 smoke test — temporary (guest) accounts and the deletion rule that
// keeps the other side's history, against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run media:dev                                      (terminal 2)
//   npm run smoke:phase10                                  (terminal 3)
//
// The owner account must exist (npm run user:create -- --owner good good-goodchat).
//
// Covers: guest signup and its rate limits, the session dying exactly at
// `expires_at`, the sweep deleting the account, a conversation with a
// permanent account surviving it (messages and media included), the same
// conversation turning read-only, and two guests taking their shared thread
// with them when the last of the pair goes.
//
// Expiry is forced through D1 instead of waiting five hours — the sweep and
// the session check both read the same column, so moving it back is exactly
// what the clock would have done.

import WebSocket from 'ws'
import { d1Execute, sqlString } from './lib.ts'
import { startMediaDevServer } from './media-dev-server.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const MEDIA_PORT = Number(process.env.MEDIA_DEV_PORT ?? 9000)

const OWNER = { username: 'good', password: 'good-goodchat' }
const ALICE = { username: 'alice', password: 'alice-goodchat' }

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
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, headers: res.headers }
}

function cookieOf(headers: Headers): string | null {
  const setCookie = headers.get('Set-Cookie')
  return setCookie ? setCookie.split(';')[0] : null
}

async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status !== 200) return null
  return cookieOf(res.headers)
}

interface Guest {
  cookie: string
  id: string
  username: string
  password: string
  expiresAt: number
}

async function createGuest(): Promise<Guest | { status: number; body: any }> {
  const res = await fetch(`${API}/api/auth/temp`, { method: 'POST' })
  const body = await res.json().catch(() => null)
  const cookie = cookieOf(res.headers)
  if (res.status !== 201 || !cookie) return { status: res.status, body }
  return {
    cookie,
    id: body.user.id,
    username: body.user.username,
    password: body.password,
    expiresAt: body.user.expires_at,
  }
}

/** Sends one message over the conversation socket and waits for the echo. */
function sendMessage(
  conversationId: string,
  peerId: string,
  cookie: string,
  payload: Record<string, unknown>,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${peerId}`, {
      headers: { Cookie: cookie },
    })
    const clientId = `smoke10-${Math.random().toString(36).slice(2)}`
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'send_message', client_id: clientId, ...payload }))
    })
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'message' && event.client_id === clientId) {
        ws.close()
        resolve(event)
      }
      if (event.type === 'error') {
        ws.close()
        resolve(event)
      }
    })
    ws.on('error', reject)
    setTimeout(() => {
      ws.close()
      reject(new Error('timeout sending a message'))
    }, 8000)
  })
}

/** Opens the socket and resolves with the `history` frame. */
function readHistory(conversationId: string, peerId: string, cookie: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${peerId}`, {
      headers: { Cookie: cookie },
    })
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'history') {
        ws.close()
        resolve(event.messages)
      }
    })
    ws.on('error', reject)
    setTimeout(() => {
      ws.close()
      reject(new Error('timeout reading history'))
    }, 8000)
  })
}

function expire(userId: string): void {
  d1Execute(
    `UPDATE users SET expires_at = ${Date.now() - 1000} WHERE id = ${sqlString(userId)};`,
  )
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
  // The per-IP guest quota is deliberately small; a rerun inside the same hour
  // would trip it before testing anything.
  d1Execute("DELETE FROM login_attempts WHERE key LIKE 'temp:%';")

  const ownerCookie = await login(OWNER.username, OWNER.password)
  const aliceCookie = await login(ALICE.username, ALICE.password)
  if (!ownerCookie || !aliceCookie) {
    console.error('FAIL: could not sign in as owner/alice — seed the database first')
    process.exit(1)
  }
  const alice = (await api('/api/auth/me', { cookie: aliceCookie })).body.user

  // --- signup -----------------------------------------------------------
  const first = await createGuest()
  check('POST /api/auth/temp creates an account', 'cookie' in first, first)
  if (!('cookie' in first)) throw new Error('guest signup failed, nothing else can run')
  const guestA = first

  check('username is a valid handle', /^temp_[a-z0-9]{9}$/.test(guestA.username), guestA.username)
  check('password is long enough to be worth showing once', guestA.password.length >= 12)
  const ttlHours = (guestA.expiresAt - Date.now()) / 3_600_000
  check(`expiry is ~5h out (${ttlHours.toFixed(2)}h)`, ttlHours > 4.9 && ttlHours < 5.1, ttlHours)

  const guestMe = await api('/api/auth/me', { cookie: guestA.cookie })
  check('the signup cookie is a working session', guestMe.status === 200, guestMe.body)
  check('the account knows it is temporary', guestMe.body?.user?.is_temp === true, guestMe.body)

  const reLogin = await login(guestA.username, guestA.password)
  check('the credentials shown once actually work', reLogin !== null)

  const guestB = await createGuest()
  check('a second guest can be created', 'cookie' in guestB, guestB)
  if (!('cookie' in guestB)) throw new Error('second guest signup failed')

  // --- per-IP quota -----------------------------------------------------
  // Two are already spent; the third is the last one allowed.
  const third = await createGuest()
  const fourth = await createGuest()
  check(
    'the per-IP hourly quota closes the endpoint',
    'status' in fourth && fourth.status === 429,
    'status' in fourth ? fourth : 'created a fourth account',
  )
  if ('cookie' in third) {
    // Not needed by the rest of the test; expire it so it is swept below.
    expire(third.id)
  }

  // --- guest ↔ permanent account ---------------------------------------
  const resolvedAlice = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: guestA.cookie,
    body: JSON.stringify({ user_id: alice.id }),
  })
  check('a guest can start a thread with a permanent account', resolvedAlice.status === 200)
  const aliceThread: string = resolvedAlice.body.conversation_id

  await sendMessage(aliceThread, alice.id, guestA.cookie, {
    msg_type: 'text',
    body: 'oi good, sou temporário',
  })

  // Media rides the conversation, not the account that uploaded it.
  const bytes = new Uint8Array(64).fill(9)
  const presigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: guestA.cookie,
    body: JSON.stringify({ mime: 'image/webp', size: bytes.byteLength }),
  })
  check('a guest can presign an upload', presigned.status === 200, presigned.body)
  const mediaKey: string = presigned.body.key
  await fetch(presigned.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: bytes,
  })
  await sendMessage(aliceThread, alice.id, guestA.cookie, {
    msg_type: 'image',
    body: '',
    media_key: mediaKey,
  })
  // The claim runs in waitUntil, just off the delivery path.
  await new Promise((resolve) => setTimeout(resolve, 500))

  // --- guest ↔ guest ----------------------------------------------------
  const resolvedPair = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: guestA.cookie,
    body: JSON.stringify({ user_id: guestB.id }),
  })
  check('two guests can find each other', resolvedPair.status === 200, resolvedPair.body)
  const guestThread: string = resolvedPair.body.conversation_id
  await sendMessage(guestThread, guestB.id, guestA.cookie, {
    msg_type: 'text',
    body: 'conversa que morre com a gente',
  })

  // --- expiry ends access immediately ----------------------------------
  expire(guestA.id)
  const afterExpiry = await api('/api/auth/me', { cookie: guestA.cookie })
  check('an expired account cannot use its session', afterExpiry.status === 401, afterExpiry.status)
  const expiredLogin = await login(guestA.username, guestA.password)
  check('an expired account cannot log back in', expiredLogin === null)

  // --- the sweep --------------------------------------------------------
  const cleanup = await api('/api/admin/cleanup', { method: 'POST', cookie: ownerCookie })
  check('cleanup reports the guest teardown', cleanup.status === 200, cleanup.body)
  check(
    'the expired guests were deleted',
    (cleanup.body?.temp_accounts_deleted ?? 0) >= 1,
    cleanup.body,
  )

  // --- what the permanent account keeps ---------------------------------
  const aliceList = await api('/api/conversations', { cookie: aliceCookie })
  const kept = aliceList.body?.conversations?.find((c: any) => c.id === aliceThread)
  check('the thread survives the account that started it', kept !== undefined, aliceList.body)
  check('the peer is flagged as gone', kept?.other_user?.deleted === true, kept?.other_user)

  const history = await readHistory(aliceThread, guestA.id, aliceCookie)
  check('the messages are still there', history.length >= 2, history.length)

  const mediaRead = await fetch(`${API}/api/media/${mediaKey}`, {
    headers: { Cookie: aliceCookie },
  })
  check('media sent by the deleted guest still loads', mediaRead.status === 200, mediaRead.status)

  const readonlySend = await sendMessage(aliceThread, guestA.id, aliceCookie, {
    msg_type: 'text',
    body: 'ainda dá pra responder?',
  })
  check(
    'the thread is read-only now',
    readonlySend?.type === 'error' && readonlySend.error === 'peer_unavailable',
    readonlySend,
  )

  const resolveGone = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ user_id: guestA.id }),
  })
  check('resolve flags the dead peer read-only', resolveGone.body?.readonly === true, resolveGone.body)

  const lookup = await api(`/api/users/lookup?q=${guestA.username}`, { cookie: aliceCookie })
  check('a deleted account is not searchable', (lookup.body?.users?.length ?? 0) === 0, lookup.body)

  // --- the last guest of a pair takes the thread with it ----------------
  const beforePair = await api('/api/admin/conversations', { cookie: ownerCookie })
  check(
    'the guest↔guest thread is still around while one of them lives',
    beforePair.body?.conversations?.some((c: any) => c.id === guestThread) === true,
  )

  expire(guestB.id)
  const secondSweep = await api('/api/admin/cleanup', { method: 'POST', cookie: ownerCookie })
  check('the second guest is swept too', (secondSweep.body?.temp_accounts_deleted ?? 0) >= 1, secondSweep.body)

  const afterPair = await api('/api/admin/conversations', { cookie: ownerCookie })
  check(
    'a thread with no live participant is destroyed',
    afterPair.body?.conversations?.some((c: any) => c.id === guestThread) === false,
    afterPair.body?.conversations?.map((c: any) => c.id),
  )
  check(
    'the thread with the permanent account is untouched',
    afterPair.body?.conversations?.some((c: any) => c.id === aliceThread) === true,
  )

  const overview = await api('/api/admin/overview', { cookie: ownerCookie })
  check('overview counts guests and tombstones', 'temp_users' in overview.body && 'tombstones' in overview.body, overview.body)

  console.log(failures === 0 ? '\nphase 10 smoke: all green' : `\nphase 10 smoke: ${failures} failure(s)`)
} finally {
  await new Promise<void>((resolve) => {
    if (!ownedServer) return resolve()
    ownedServer.close(() => resolve())
  })
}

process.exit(failures === 0 ? 0 : 1)
