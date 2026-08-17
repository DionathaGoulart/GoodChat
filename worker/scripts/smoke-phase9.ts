// Phase 9 smoke test — hardening, settings and the owner console, against a
// live dev server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run media:dev                                      (terminal 2)
//   npm run smoke:phase9                                   (terminal 3)
//
// The owner account is created by the test itself when it is missing, so this
// runs on any seeded database.
//
// Covers: security headers on the SPA document and the API, the CORS
// allowlist, login timing parity (user enumeration), account-level theme,
// the owner role gate, storage accounting, media authorization by conversation
// membership, WS rate limiting, account disable revoking live sessions, and
// the orphan-upload sweep.

import WebSocket from 'ws'
import { startMediaDevServer } from './media-dev-server.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const MEDIA_PORT = Number(process.env.MEDIA_DEV_PORT ?? 9000)

const OWNER = { username: 'good', password: 'good-goodchat' }

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

/**
 * Wall-clock median of `runs` failed login attempts, in ms. Kept low on
 * purpose: every call burns one slot of the per-account (5) and per-IP (20)
 * rate limit windows, and the test must not lock the accounts it uses next.
 */
async function medianLoginMs(username: string, runs = 3): Promise<number> {
  const samples: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now()
    await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: `wrong-password-${i}` }),
    })
    samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
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
  // --- security headers ------------------------------------------------
  const doc = await fetch(`${API}/`)
  const csp = doc.headers.get('Content-Security-Policy') ?? ''
  check('SPA document carries a CSP', csp.includes("default-src 'self'"), csp.slice(0, 40))
  check('CSP forbids framing (clickjacking)', csp.includes("frame-ancestors 'none'"))
  check('CSP keeps script-src strict', csp.includes("script-src 'self'") && !csp.includes("script-src 'self' 'unsafe"))
  // Without the B2 origin here every presigned upload dies in the browser
  // before it reaches the network — the failure is invisible server-side.
  check(
    'CSP lets the browser reach the upload endpoint',
    csp.includes(`connect-src 'self' http://localhost:${MEDIA_PORT}`),
    csp.match(/connect-src[^;]*/)?.[0],
  )
  check('CSP keeps font-src same-origin', csp.includes("font-src 'self'"))
  check('document sets Referrer-Policy', doc.headers.get('Referrer-Policy') === 'no-referrer')

  const health = await fetch(`${API}/api/health`)
  check('API sets nosniff', health.headers.get('X-Content-Type-Options') === 'nosniff')
  check('API denies framing', health.headers.get('X-Frame-Options') === 'DENY')

  // --- CORS allowlist ---------------------------------------------------
  const evil = await fetch(`${API}/api/health`, { headers: { Origin: 'https://evil.example' } })
  check(
    'unknown Origin gets no Access-Control-Allow-Origin',
    evil.headers.get('Access-Control-Allow-Origin') === null,
    evil.headers.get('Access-Control-Allow-Origin'),
  )
  const sameOrigin = await fetch(`${API}/api/health`, { headers: { Origin: API } })
  check(
    'same Origin is allowed with credentials',
    sameOrigin.headers.get('Access-Control-Allow-Origin') === API &&
      sameOrigin.headers.get('Access-Control-Allow-Credentials') === 'true',
  )

  // --- owner bootstrap --------------------------------------------------
  let ownerCookie = await login(OWNER.username, OWNER.password)
  if (!ownerCookie) {
    console.log(`  (owner "${OWNER.username}" missing — create it with:`)
    console.log(`   npm run user:create -- --owner ${OWNER.username} ${OWNER.password} Good)`)
    throw new Error('owner account required for the admin checks')
  }
  const owner = (await api('/api/auth/me', { cookie: ownerCookie })).body.user
  check('owner session reports role=owner', owner.role === 'owner', owner.role)
  check(
    'session payload carries the account theme',
    'theme_mode' in owner && 'theme_light' in owner && 'theme_dark' in owner,
  )

  const aliceCookie = await login('alice', 'alice-goodchat')
  if (!aliceCookie) throw new Error('alice login failed (run npm run db:seed)')
  const alice = (await api('/api/auth/me', { cookie: aliceCookie })).body.user
  check('regular session reports role=user', alice.role === 'user', alice.role)

  const bobCookie = await login('bob', 'bob-goodchat')
  if (!bobCookie) throw new Error('bob login failed (run npm run db:seed)')

  // --- login timing (user enumeration) ----------------------------------
  // A missing account must cost the same KDF work as a real one. Measured on a
  // throwaway account, never on a seeded one: failed attempts count against
  // the per-account rate limit, and locking alice/bob would break the rest of
  // the suite. Every login below this point is a successful one.
  const timingAccount = {
    username: `timing_${Date.now().toString(36)}`,
    password: 'timing-phase9-pw',
  }
  const timingCreated = await api('/api/admin/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify(timingAccount),
  })
  check('owner creates the timing fixture', timingCreated.status === 201, timingCreated.body)

  const missingMs = await medianLoginMs(`ghost_${Date.now().toString(36)}`)
  const existingMs = await medianLoginMs(timingAccount.username)
  const ratio = Math.max(missingMs, existingMs) / Math.max(1, Math.min(missingMs, existingMs))
  check(
    `login timing within 3x for existing vs missing accounts (${missingMs.toFixed(1)}ms vs ${existingMs.toFixed(1)}ms)`,
    ratio < 3,
    { missingMs, existingMs },
  )
  await api(`/api/admin/users/${timingCreated.body.id}`, {
    method: 'DELETE',
    cookie: ownerCookie,
  })

  // --- account settings -------------------------------------------------
  const dark = { theme_mode: 'dark', theme_light: 'goodchat-sand', theme_dark: 'goodchat-matrix' }
  const setDark = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify(dark),
  })
  check(
    'PATCH /api/settings stores mode and both palettes',
    setDark.body?.user?.theme_mode === 'dark' &&
      setDark.body?.user?.theme_light === 'goodchat-sand' &&
      setDark.body?.user?.theme_dark === 'goodchat-matrix',
    setDark.body,
  )
  const afterSet = await api('/api/auth/me', { cookie: aliceCookie })
  check(
    'theme survives on the account',
    afterSet.body?.user?.theme_mode === 'dark' &&
      afterSet.body?.user?.theme_dark === 'goodchat-matrix',
    afterSet.body?.user,
  )

  const setSystem = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...dark, theme_mode: null }),
  })
  check('null mode means "follow the system"', setSystem.body?.user?.theme_mode === null)

  const badTheme = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...dark, theme_light: 'hacker-green' }),
  })
  check('unknown palette rejected', badTheme.status === 400, badTheme.body)

  // A dark palette in the light slot would leave the header toggle switching
  // between two dark screens.
  const crossed = await api('/api/settings', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ ...dark, theme_light: 'goodchat-matrix' }),
  })
  check('palette from the wrong mode rejected', crossed.status === 400, crossed.body)

  // --- owner gate -------------------------------------------------------
  for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/conversations']) {
    const forbidden = await api(path, { cookie: aliceCookie })
    check(`${path} is 403 for a non-owner`, forbidden.status === 403, forbidden.body)
    const anonymous = await api(path)
    check(`${path} is 401 without a session`, anonymous.status === 401)
  }

  // --- storage accounting ----------------------------------------------
  const overview = await api('/api/admin/overview', { cookie: ownerCookie })
  check('overview responds', overview.status === 200, overview.body)
  check(
    'overview reports both storage sides',
    typeof overview.body?.do_storage_bytes === 'number' &&
      typeof overview.body?.indexed_media_bytes === 'number',
    overview.body,
  )
  check(
    'overview reports the ceilings the console divides by',
    ['do_storage_limit_bytes', 'bucket_limit_bytes'].every(
      (field) => overview.body?.[field] === null || typeof overview.body?.[field] === 'number',
    ),
    overview.body,
  )

  const accounts = await api('/api/admin/users', { cookie: ownerCookie })
  const aliceRow = accounts.body?.users?.find((u: any) => u.username === 'alice')
  check('per-account usage is broken down', aliceRow !== undefined && 'db_bytes' in aliceRow && 'media_bytes' in aliceRow, aliceRow)
  check(
    'total_bytes is the sum of both sides',
    aliceRow && aliceRow.total_bytes === aliceRow.db_bytes + aliceRow.media_bytes,
    aliceRow,
  )

  // --- media authorization ---------------------------------------------
  const bytes = new Uint8Array(64).fill(7)
  const presigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'image/webp', size: bytes.byteLength }),
  })
  check('presign succeeds for an allowed mime', presigned.status === 200, presigned.body)
  const key: string = presigned.body.key

  const put = await fetch(presigned.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: bytes,
  })
  check('direct upload to the bucket succeeds', put.ok, put.status)

  const ownerRead = await fetch(`${API}/api/media/${key}`, { headers: { Cookie: aliceCookie } })
  check('uploader can read its own object', ownerRead.status === 200, ownerRead.status)

  // Nobody claimed the object yet, so it belongs to no conversation: a second
  // account must not be able to read it just by holding the key.
  const strangerRead = await fetch(`${API}/api/media/${key}`, { headers: { Cookie: bobCookie } })
  check(
    'a non-participant cannot read an unclaimed object',
    strangerRead.status === 404,
    strangerRead.status,
  )

  const anonymousRead = await fetch(`${API}/api/media/${key}`)
  check('no session cannot read media', anonymousRead.status === 401, anonymousRead.status)

  // --- WS rate limiting -------------------------------------------------
  // Deliberately the owner↔alice thread, never the seeded alice↔bob one: the
  // flood below writes dozens of junk messages, and phases 4/6/7 assert on
  // alice↔bob's history.
  const aliceId: string = alice.id
  const resolved = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ user_id: aliceId }),
  })
  const conversationId: string = resolved.body.conversation_id

  const rateLimited = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${aliceId}`, {
      headers: { Cookie: ownerCookie },
    })
    let seen = false
    const done = (value: boolean) => {
      if (!seen) {
        seen = true
        try {
          ws.close()
        } catch {
          // already closing
        }
        resolve(value)
      }
    }
    ws.on('open', () => {
      // Well past the message bucket's capacity, in one burst.
      for (let i = 0; i < 60; i += 1) {
        ws.send(
          JSON.stringify({
            type: 'send_message',
            client_id: `flood-${Date.now()}-${i}`,
            msg_type: 'text',
            body: `flood ${i}`,
          }),
        )
      }
    })
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'error' && event.error === 'rate_limited') done(true)
    })
    ws.on('close', () => done(false))
    setTimeout(() => done(false), 8000)
  })
  check('flooding send_message trips the rate limit', rateLimited)

  // The limiter must throttle, not maim: a client draining a long offline
  // queue at the client's pace (4 frames per 2.5s, under the 2/s refill) has
  // to get every message through. This is the regression guard for the queue
  // flush in app/src/hooks/useConversation.ts.
  const QUEUE_SIZE = 24
  const acked = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${aliceId}`, {
      headers: { Cookie: ownerCookie },
    })
    const pending = new Set<string>()
    for (let i = 0; i < QUEUE_SIZE; i += 1) pending.add(`queue-${Date.now()}-${i}`)
    const ids = [...pending]
    let cursor = 0
    let timer: NodeJS.Timeout | undefined
    const finish = () => {
      clearInterval(timer)
      try {
        ws.close()
      } catch {
        // already closing
      }
      resolve(QUEUE_SIZE - pending.size)
    }
    ws.on('open', () => {
      const pump = () => {
        for (let i = 0; i < 4 && cursor < ids.length; i += 1, cursor += 1) {
          ws.send(
            JSON.stringify({
              type: 'send_message',
              client_id: ids[cursor],
              msg_type: 'text',
              body: `queued ${cursor}`,
            }),
          )
        }
      }
      pump()
      timer = setInterval(() => {
        if (cursor >= ids.length) return
        pump()
      }, 2500)
    })
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'message' || event.type === 'message_status') {
        pending.delete(event.client_id)
        if (pending.size === 0) finish()
      }
    })
    ws.on('close', () => finish())
    setTimeout(finish, 45_000)
  })
  check(
    `a ${QUEUE_SIZE}-message queue drains completely at the client's pace`,
    acked === QUEUE_SIZE,
    { acked, expected: QUEUE_SIZE },
  )

  // Once a message referencing the object lands, the DO claims it for this
  // conversation — and the peer, who could not read it a moment ago, can.
  const claimed = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ mime: 'image/webp', size: bytes.byteLength }),
  })
  await fetch(claimed.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: bytes,
  })
  const beforeClaim = await fetch(`${API}/api/media/${claimed.body.key}`, {
    headers: { Cookie: aliceCookie },
  })
  check('peer cannot read the object before it is claimed', beforeClaim.status === 404, beforeClaim.status)

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${aliceId}`, {
      headers: { Cookie: ownerCookie },
    })
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'send_message',
          client_id: `claim-${Date.now()}`,
          msg_type: 'image',
          body: '',
          media_key: claimed.body.key,
        }),
      )
    })
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString())
      if (event.type === 'message' && event.media_key === claimed.body.key) {
        ws.close()
        resolve()
      }
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('timeout sending the media message')), 8000)
  })
  // The claim runs in waitUntil, just off the delivery path.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const peerRead = await fetch(`${API}/api/media/${claimed.body.key}`, {
    headers: { Cookie: aliceCookie },
  })
  check('the peer can read media of a message in their conversation', peerRead.status === 200, peerRead.status)

  // --- account lifecycle ------------------------------------------------
  const temp = { username: `smoke_${Date.now().toString(36)}`, password: 'smoke-phase9-pw' }
  const created = await api('/api/admin/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ ...temp, display_name: 'Smoke' }),
  })
  check('owner creates an account', created.status === 201, created.body)
  const tempId: string = created.body.id

  const tempCookie = await login(temp.username, temp.password)
  check('the new account can sign in', tempCookie !== null)

  const disabled = await api(`/api/admin/users/${tempId}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: JSON.stringify({ disabled: true }),
  })
  check('owner disables the account', disabled.status === 200, disabled.body)
  check('disabling revokes the live session', (await api('/api/auth/me', { cookie: tempCookie! })).status === 401)
  check('a disabled account cannot sign in', (await login(temp.username, temp.password)) === null)

  const selfDisable = await api(`/api/admin/users/${owner.id}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: JSON.stringify({ disabled: true }),
  })
  check('an owner cannot disable itself', selfDisable.status === 400, selfDisable.body)

  const selfDelete = await api(`/api/admin/users/${owner.id}`, {
    method: 'DELETE',
    cookie: ownerCookie,
  })
  check('an owner cannot delete itself', selfDelete.status === 403, selfDelete.body)

  const deleted = await api(`/api/admin/users/${tempId}`, {
    method: 'DELETE',
    cookie: ownerCookie,
  })
  check('owner deletes the account', deleted.status === 200, deleted.body)

  // --- orphan sweep -----------------------------------------------------
  // The first presign was never referenced by a message; it is exactly what
  // the sweep is for, but only after the 24h TTL — so it must still be there.
  const cleanup = await api('/api/admin/cleanup', { method: 'POST', cookie: ownerCookie })
  check('cleanup runs and reports', cleanup.status === 200 && 'orphan_media_deleted' in cleanup.body, cleanup.body)
  const stillThere = await fetch(`${API}/api/media/${key}`, { headers: { Cookie: aliceCookie } })
  check('a fresh unclaimed upload is not swept yet (24h TTL)', stillThere.status === 200, stillThere.status)

  console.log(failures === 0 ? '\nphase 9 smoke: all green' : `\nphase 9 smoke: ${failures} failure(s)`)
} finally {
  await new Promise<void>((resolve) => {
    if (!ownedServer) return resolve()
    ownedServer.close(() => resolve())
  })
}

process.exit(failures === 0 ? 0 : 1)
