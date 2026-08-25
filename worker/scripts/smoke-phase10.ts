// Phase 10 smoke test — temporary (guest) accounts and the deletion rule that
// keeps the other side's history, against a live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run media:dev                                      (terminal 2)
//   npm run smoke:phase10                                  (terminal 3)
//
// The owner account must exist (npm run user:create -- --owner good good-goodchat).
//
// Covers: guest signup and its rate limits, the account having no password at
// all, signing out deleting it on the spot, the session dying exactly at
// `expires_at`, the sweep deleting the account, a conversation with a
// permanent account surviving it (messages and media included), the same
// conversation turning read-only, and two guests taking their shared thread
// with them when the last of the pair goes.
//
// Expiry is forced through D1 instead of waiting three hours — the sweep and
// the session check both read the same column, so moving it back is exactly
// what the clock would have done.

import WebSocket from 'ws'
import { d1Execute, d1Query, signIn, sqlString } from './lib.ts'
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

// Signing in goes through `signIn` (scripts/lib.ts) rather than posting the
// password: since migration 0013 the stored hash is of a token the *client*
// derives, so a plaintext login is refused. ~600ms of PBKDF2 per call.
function login(username: string, password: string): Promise<string | null> {
  return signIn(API, username, password)
}

interface Guest {
  cookie: string
  id: string
  username: string
  expiresAt: number
  /** The whole signup body, so the test can assert what is *not* in it. */
  body: any
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
    expiresAt: body.user.expires_at,
    body,
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
  // The per-IP guest quota is deliberately small, and every refused sign-in
  // below spends a slot of the login window too — twice over, because `signIn`
  // tries the derived credential and then the plaintext one the way the app
  // does. On localhost the whole suite shares one address, so the counters are
  // cleared whole rather than by prefix, at both ends of the run.
  d1Execute('DELETE FROM login_attempts;')

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
  const ttlHours = (guestA.expiresAt - Date.now()) / 3_600_000
  check(`expiry is ~3h out (${ttlHours.toFixed(2)}h)`, ttlHours > 2.9 && ttlHours < 3.1, ttlHours)

  // --- no password, anywhere -------------------------------------------
  //
  // Three places, because "we stopped showing it" and "there is none" are
  // different claims and only the third one is the property: the response body,
  // the stored row, and the login route.
  check('the signup response carries no password', !('password' in (guestA.body ?? {})), guestA.body)
  const storedHash = d1Query<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = ${sqlString(guestA.id)};`,
  )
  check('password_hash is NULL in D1', storedHash[0]?.password_hash === null, storedHash[0])

  const guestMe = await api('/api/auth/me', { cookie: guestA.cookie })
  check('the signup cookie is a working session', guestMe.status === 200, guestMe.body)
  check('the account knows it is temporary', guestMe.body?.user?.is_temp === true, guestMe.body)

  const guessed = await login(guestA.username, 'whatever-somebody-would-try')
  check('there is nothing to log back in with', guessed === null)

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
  // --- signing out ends the account ------------------------------------
  //
  // Run on the third guest rather than on a fifth one, because the per-IP
  // quota above is the point of that fourth request: creating another account
  // here would have to be refused, and the test would be measuring the quota
  // instead of the logout.
  //
  // The row goes outright rather than becoming a tombstone: this account never
  // talked to anybody, so nothing references it (`removeIfUnreferenced` in
  // lib/accounts.ts).
  if ('cookie' in third) {
    const loggedOut = await api('/api/auth/logout', { method: 'POST', cookie: third.cookie })
    check('a guest can sign out', loggedOut.status === 200, loggedOut.body)
    const afterLogout = await api('/api/auth/me', { cookie: third.cookie })
    check('the session is gone after signing out', afterLogout.status === 401, afterLogout.status)
    const rows = d1Query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE id = ${sqlString(third.id)};`,
    )
    check('signing out deleted the account itself', rows[0]?.n === 0, rows[0])
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
  const expiredLogin = await login(guestA.username, 'whatever-somebody-would-try')
  check('an expired account cannot log back in either', expiredLogin === null)

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

  d1Execute('DELETE FROM login_attempts;')

  console.log(failures === 0 ? '\nphase 10 smoke: all green' : `\nphase 10 smoke: ${failures} failure(s)`)
} finally {
  await new Promise<void>((resolve) => {
    if (!ownedServer) return resolve()
    ownedServer.close(() => resolve())
  })
}

process.exit(failures === 0 ? 0 : 1)
