// Phase 8 smoke test — Web Push. Three parts:
//
//   A. Library/crypto roundtrip, no server: mock global fetch, send a push
//      with @mmmike/web-push, then decrypt the captured body per RFC 8291
//      (aes128gcm) with the "browser" keys generated here. Proves headers
//      (vapid/aes128gcm/ttl/urgency/topic) and real payload encryption.
//   B. REST endpoints against a live dev server with seed data:
//        npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//        npm run smoke:phase8                                   (terminal 2)
//   C. DO trigger path: bob messages alice while she is offline and holds a
//      subscription pointing at an unreachable endpoint — the message must
//      still deliver, and the subscription row must survive (only 404/410
//      prune it).
//
// Plain Node ≥24 + `ws`. Equivalent curl calls for manual poking:
//   curl localhost:8000/api/push/vapid-public-key
//   curl -b /tmp/gc.jar -X POST localhost:8000/api/push/subscribe \
//     -H 'Content-Type: application/json' \
//     -d '{"endpoint":"https://push.example.com/x","keys":{"p256dh":"...","auth":"..."}}'
//   curl -b /tmp/gc.jar -X POST localhost:8000/api/push/unsubscribe \
//     -H 'Content-Type: application/json' -d '{"endpoint":"https://push.example.com/x"}'

import { randomUUID, subtle, getRandomValues } from 'node:crypto'
import WebSocket from 'ws'
import { generateVapidKeys } from '@mmmike/web-push/vapid'
import { sendPushNotification } from '@mmmike/web-push/send'
import { insertUser } from './lib.ts'

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

// --- helpers shared with earlier smokes ---

async function api(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, setCookie: res.headers.get('Set-Cookie') }
}

async function login(username: string, password: string): Promise<string> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (res.status !== 200 || !res.setCookie) {
    throw new Error(`login ${username} failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return res.setCookie.split(';')[0]
}

// --- RFC 8291 receiver side (what the browser's push service + SW do) ---

const enc = (s: string) => new TextEncoder().encode(s)

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/** Decrypt an aes128gcm push body with the receiver's ECDH pair + auth secret. */
async function decryptPush(
  raw: Uint8Array,
  uaKeys: CryptoKeyPair,
  authSecret: Uint8Array,
): Promise<string> {
  // Coding header (RFC 8188): salt(16) | rs(4) | idlen(1) | keyid(idlen)
  const salt = raw.slice(0, 16)
  const idlen = raw[20]
  const asPublicBytes = raw.slice(21, 21 + idlen)
  const ciphertext = raw.slice(21 + idlen)

  const asPublic = await subtle.importKey(
    'raw',
    asPublicBytes as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: asPublic }, uaKeys.privateKey, 256),
  )
  const uaPublicBytes = new Uint8Array(await subtle.exportKey('raw', uaKeys.publicKey))

  // RFC 8291 §3.4: IKM ← HKDF(auth, ecdh, "WebPush: info"||0x00||ua_pub||as_pub)
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concatBytes(enc('WebPush: info\0'), uaPublicBytes, asPublicBytes),
    32,
  )
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12)

  const key = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      key,
      ciphertext as BufferSource,
    ),
  )
  // Strip the last-record padding delimiter (0x02) and trailing zeros.
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  if (plain[end] !== 0x02) throw new Error('bad padding delimiter')
  return new TextDecoder().decode(plain.slice(0, end))
}

// =====================================================================
// Part A — library/crypto roundtrip with a mocked fetch
// =====================================================================
console.log('--- part A: crypto roundtrip (no server) ---')

const vapid = { ...(await generateVapidKeys()), subject: 'mailto:smoke@goodchat.local' }
const uaKeys = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
])) as CryptoKeyPair
const authSecret = getRandomValues(new Uint8Array(16))
const subscription = {
  endpoint: 'https://push.stub.invalid/send/abc123',
  keys: {
    p256dh: toBase64Url(new Uint8Array(await subtle.exportKey('raw', uaKeys.publicKey))),
    auth: toBase64Url(authSecret),
  },
}
const payload = { title: '@bob', body: 'oi', url: '/#/t/user-1', tag: 'ab12'.repeat(8) }

const captured: { url: string; headers: Headers; body: Uint8Array }[] = []
const realFetch = globalThis.fetch
let mockStatus = 201
globalThis.fetch = (async (input: any, init?: any) => {
  const request = new Request(input, init)
  captured.push({
    url: request.url,
    headers: request.headers,
    body: new Uint8Array(await request.arrayBuffer()),
  })
  return new Response(null, { status: mockStatus })
}) as typeof fetch

const delivered = await sendPushNotification(subscription, payload, vapid, {
  ttl: 3600,
  urgency: 'high',
  topic: payload.tag,
})
check('sendPushNotification resolves true on 201', delivered === true)
check('exactly one push request', captured.length === 1)

const req = captured[0]
check('request hits the subscription endpoint', req.url === subscription.endpoint, req.url)
check(
  'content-encoding is aes128gcm (RFC 8291 final, not legacy aesgcm)',
  req.headers.get('content-encoding') === 'aes128gcm',
  req.headers.get('content-encoding'),
)
const authz = req.headers.get('authorization') ?? ''
check(
  'authorization is "vapid t=<jwt>, k=<server key>" (RFC 8292)',
  /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(authz) && authz.endsWith(vapid.publicKey),
  authz.slice(0, 40),
)
check('ttl header forwarded', req.headers.get('ttl') === '3600', req.headers.get('ttl'))
check('urgency header forwarded', req.headers.get('urgency') === 'high')
check('topic header forwarded', req.headers.get('topic') === payload.tag)

const decrypted = await decryptPush(req.body, uaKeys, authSecret)
check(
  'body decrypts back to the exact payload JSON',
  decrypted === JSON.stringify(payload),
  decrypted,
)

mockStatus = 410
const gone = await sendPushNotification(subscription, payload, vapid)
check('410 Gone resolves false (caller must prune the row)', gone === false)

globalThis.fetch = realFetch

// =====================================================================
// Part B — REST endpoints (live dev server + seed)
// =====================================================================
console.log('--- part B: REST endpoints ---')

const vapidRes = await api('/api/push/vapid-public-key')
check(
  'vapid-public-key → 200 with a raw P-256 key (87-char base64url, leading "B")',
  vapidRes.status === 200 && /^B[\w-]{86}$/.test(vapidRes.body?.public_key ?? ''),
  vapidRes.body,
)

const noAuth = await api('/api/push/subscribe', {
  method: 'POST',
  body: JSON.stringify({ endpoint: 'https://x.example/e', keys: { p256dh: 'a', auth: 'b' } }),
})
check('subscribe without session → 401', noAuth.status === 401, noAuth.status)

const alice = await login('alice', 'alice-goodchat')
const bob = await login('bob', 'bob-goodchat')

const badBody = await api('/api/push/subscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ nope: true }),
})
check('subscribe with invalid body → 400', badBody.status === 400, badBody.status)

const httpEndpoint = await api('/api/push/subscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({
    endpoint: 'http://internal.local/hook',
    keys: { p256dh: 'a', auth: 'b' },
  }),
})
check('subscribe with http:// endpoint → 400 (SSRF guard)', httpEndpoint.status === 400)

const endpointB = `https://push.example.com/smoke8/${randomUUID()}`
const sub1 = await api('/api/push/subscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ endpoint: endpointB, keys: subscription.keys }),
})
check('subscribe → 200 {ok:true}', sub1.status === 200 && sub1.body?.ok === true, sub1.body)

const sub2 = await api('/api/push/subscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ endpoint: endpointB, keys: subscription.keys }),
})
check('re-subscribe same endpoint upserts → 200', sub2.status === 200 && sub2.body?.ok === true)

const wrongOwner = await api('/api/push/unsubscribe', {
  method: 'POST',
  cookie: bob,
  body: JSON.stringify({ endpoint: endpointB }),
})
check(
  "unsubscribe someone else's endpoint → removed:false",
  wrongOwner.status === 200 && wrongOwner.body?.removed === false,
  wrongOwner.body,
)

const unsub = await api('/api/push/unsubscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ endpoint: endpointB }),
})
check('unsubscribe own endpoint → removed:true', unsub.body?.removed === true, unsub.body)

const unsubAgain = await api('/api/push/unsubscribe', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ endpoint: endpointB }),
})
check('unsubscribe again → removed:false (idempotent)', unsubAgain.body?.removed === false)

// =====================================================================
// Part C — DO trigger: offline peer with an unreachable subscription
// =====================================================================
console.log('--- part C: DO push trigger ---')

// Dedicated pair: alice/bob may hold live sockets in the developer's own
// browser, which would flip the peer to online and mute the push branch.
await insertUser('smoke8_ana', 'smoke8-goodchat', 'Smoke8 Ana', { ignoreExisting: true })
await insertUser('smoke8_ben', 'smoke8-goodchat', 'Smoke8 Ben', { ignoreExisting: true })
const ana = await login('smoke8_ana', 'smoke8-goodchat')
const ben = await login('smoke8_ben', 'smoke8-goodchat')

const anaMe = await api('/api/auth/me', { cookie: ana })
const lookup = await api('/api/users/lookup?q=smoke8_ben', { cookie: ana })
const benId: string = lookup.body.users.find((u: any) => u.username === 'smoke8_ben').id
const resolved = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: ana,
  body: JSON.stringify({ user_id: benId }),
})
const conversationId: string = resolved.body.conversation_id

// Ana subscribes on an endpoint nothing listens on (TLS/conn error ≠ gone).
const endpointC = `https://localhost:9099/smoke8/${randomUUID()}`
await api('/api/push/subscribe', {
  method: 'POST',
  cookie: ana,
  body: JSON.stringify({ endpoint: endpointC, keys: subscription.keys }),
})

const bobWs = await new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${anaMe.body.user.id}`, {
    headers: { Cookie: ben },
  })
  ws.on('open', () => resolve(ws))
  ws.on('error', reject)
})

const clientId = randomUUID()
const echo = await new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout waiting for echo')), 5000)
  bobWs.on('message', (data) => {
    const event = JSON.parse(data.toString())
    if (event.type === 'message' && event.client_id === clientId) {
      clearTimeout(timer)
      resolve(event)
    }
  })
  bobWs.send(
    JSON.stringify({
      type: 'send_message',
      client_id: clientId,
      msg_type: 'text',
      body: 'smoke8: push trigger',
    }),
  )
})
check(
  "message to offline peer still delivers (status 'sent') with push branch active",
  echo.status === 'sent',
  echo,
)
bobWs.close()

// Give the DO's waitUntil push attempt time to fail against the dead endpoint.
await new Promise((r) => setTimeout(r, 1500))

const survivor = await api('/api/push/unsubscribe', {
  method: 'POST',
  cookie: ana,
  body: JSON.stringify({ endpoint: endpointC }),
})
check(
  'subscription row survives a network-failed push (only 404/410 prune)',
  survivor.body?.removed === true,
  survivor.body,
)

console.log(failures === 0 ? '\nall green' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
