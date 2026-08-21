// Phase 15 smoke: end-to-end encryption.
//
// The crypto here is a *second* implementation of the wire format, written
// against docs/architecture.md rather than imported from app/src/lib/e2ee.ts.
// That is the point: a test that calls the same code the app calls only proves
// the code round-trips with itself, which is true of any format including a
// broken one. This proves the envelope is implementable from its description,
// and it is what would catch the app silently changing the shape.
//
// What it asserts, in order:
//   - two of alice's devices both open a message bob sent, and bob's own other
//     device does too (the sender wraps for itself);
//   - a device registered *after* the message cannot open it — the design
//     working, not a failure;
//   - the Durable Object never holds the plaintext;
//   - the key directory refuses a caller with no reason to see it;
//   - a plaintext message still works, which is what carries the transition.
//
// Usage: npm run smoke:phase15   (needs `npm run dev` on :8000 and seed data)

import { WebSocket } from 'ws'
import { d1Query, sqlString } from './lib.ts'

const API = process.env.API ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')
const ALICE = { username: 'alice', password: 'alice-goodchat' }
const BOB = { username: 'bob', password: 'bob-goodchat' }

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// --- the wire format, implemented from the docs ---------------------------

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Buffer.from(view).toString('base64url')
}

function unb64u(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

interface Device {
  id: string
  publicKey: string
  keys: CryptoKeyPair
}

async function makeDevice(): Promise<Device> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const raw = await crypto.subtle.exportKey('raw', keys.publicKey)
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const id = Buffer.from(new Uint8Array(digest).slice(0, 16)).toString('hex')
  return { id, publicKey: b64u(raw), keys }
}

function importPublic(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    unb64u(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}

/** HKDF over the ECDH secret, salted with both device ids, sorted. */
async function wrappingKey(
  privateKey: CryptoKey,
  peerPublic: CryptoKey,
  a: string,
  b: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublic },
    privateKey,
    256,
  )
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode([a, b].sort().join(':')),
      info: enc.encode('goodchat-v1-wrap'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

interface Envelope {
  v: 1
  iv: string
  sender_device: string
  keys: Record<string, { iv: string; ct: string }>
  media_iv?: string
}

async function seal(
  sender: Device,
  recipients: { id: string; public_key: string }[],
  payload: Record<string, string>,
): Promise<{ body: string; enc: Envelope }> {
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = b64u(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, contentKey, enc.encode(JSON.stringify(payload))),
  )
  const raw = await crypto.subtle.exportKey('raw', contentKey)

  const keys: Envelope['keys'] = {}
  for (const device of recipients) {
    const wrapKey = await wrappingKey(
      sender.keys.privateKey,
      await importPublic(device.public_key),
      sender.id,
      device.id,
    )
    const wrapIv = crypto.getRandomValues(new Uint8Array(12))
    keys[device.id] = {
      iv: b64u(wrapIv),
      ct: b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapKey, raw)),
    }
  }
  return { body, enc: { v: 1, iv: b64u(iv), sender_device: sender.id, keys } }
}

async function open(
  device: Device,
  senderPublicKey: string,
  body: string,
  envelope: Envelope,
): Promise<Record<string, string> | null> {
  const wrapped = envelope.keys[device.id]
  if (!wrapped) return null
  try {
    const wrapKey = await wrappingKey(
      device.keys.privateKey,
      await importPublic(senderPublicKey),
      device.id,
      envelope.sender_device,
    )
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(wrapped.iv) },
      wrapKey,
      unb64u(wrapped.ct),
    )
    const contentKey = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM', length: 256 },
      true,
      ['decrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(envelope.iv) },
      contentKey,
      unb64u(body),
    )
    return JSON.parse(dec.decode(plain)) as Record<string, string>
  } catch {
    return null
  }
}

// --- REST helpers ---------------------------------------------------------

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const cookie = response.headers.get('set-cookie')
  const token = /session=([^;]+)/.exec(cookie ?? '')?.[1]
  if (!token) throw new Error(`login failed for ${username} (${response.status})`)
  return token
}

async function api(
  path: string,
  { cookie, method = 'GET', body }: { cookie?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: `session=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

function register(cookie: string, device: Device) {
  return api('/api/devices', {
    cookie,
    method: 'POST',
    body: JSON.stringify({ id: device.id, public_key: device.publicKey }),
  })
}

function connect(cookie: string, conversationId: string, withId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${withId}`, {
      headers: { Cookie: `session=${cookie}` },
    })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitFor<T>(ws: WebSocket, match: (event: any) => boolean, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 8000)
    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(raw.toString())
      if (!match(event)) return
      clearTimeout(timer)
      resolve(event as T)
    })
  })
}

// --- the run --------------------------------------------------------------

console.log('--- phase 15: end-to-end encryption ---\n')

const aliceCookie = await login(ALICE.username, ALICE.password)
const bobCookie = await login(BOB.username, BOB.password)
const aliceId: string = (await api('/api/auth/me', { cookie: aliceCookie })).body.user.id
const bobId: string = (await api('/api/auth/me', { cookie: bobCookie })).body.user.id

console.log('— the directory')

// A clean directory for both accounts, because the Durable Object now refuses
// an envelope that misses a device either participant has registered — see the
// stale-directory block below. Sixteen rows left behind by previous runs would
// make every send in this file fail for a reason that has nothing to do with
// the code, and encrypting to a hand-picked subset (which this test used to do)
// is no longer a thing a real client can do.
d1Query(
  `DELETE FROM devices WHERE user_id IN (${sqlString(aliceId)}, ${sqlString(bobId)})`,
)

// Two browsers for alice, one for bob. Everything below hangs off this.
const alicePhone = await makeDevice()
const aliceDesktop = await makeDevice()
const bobPhone = await makeDevice()

check('registering a device is accepted', (await register(aliceCookie, alicePhone)).status === 200)
await register(aliceCookie, aliceDesktop)
await register(bobCookie, bobPhone)

const aliceDirectory = await api(`/api/users/${aliceId}/devices`, { cookie: bobCookie })
check(
  "bob reads alice's devices, sorted by id",
  aliceDirectory.body.devices.length >= 2 &&
    aliceDirectory.body.devices.every((d: any, i: number, all: any[]) => i === 0 || all[i - 1].id <= d.id),
  aliceDirectory.body.devices.map((d: any) => d.id),
)

check(
  'the directory needs a session',
  (await api(`/api/users/${aliceId}/devices`)).status === 401,
)
check(
  'the directory refuses an id that is not an account',
  (await api(`/api/users/does-not-exist/devices`, { cookie: bobCookie })).status === 404,
)
check(
  "a device id belonging to somebody else cannot be claimed",
  (await register(bobCookie, alicePhone)).status === 409,
)

console.log('\n— a message only the right devices can read')

const resolved = await api('/api/conversations/resolve', {
  cookie: bobCookie,
  method: 'POST',
  body: JSON.stringify({ user_id: aliceId }),
})
const conversationId: string = resolved.body.conversation_id

// Every device both sides have registered, which is what a real client sends
// to: `seal` in app/src/hooks/useConversation.ts passes the peer's directory
// plus its own, and the Durable Object refuses anything less.
const bobDirectory = await api(`/api/users/${bobId}/devices`, { cookie: aliceCookie })
const recipients = [...aliceDirectory.body.devices, ...bobDirectory.body.devices].map(
  (d: any) => ({ id: d.id, public_key: d.public_key }),
)
check('the directory returned all three of this run\'s devices', recipients.length === 3, recipients.length)
const secret = `segredo-${Date.now().toString(36)}`
const sealed = await seal(bobPhone, recipients, { t: secret })

const bobWs = await connect(bobCookie, conversationId, aliceId)
const clientId = crypto.randomUUID()
const echoed = waitFor<any>(bobWs, (e) => e.type === 'message' && e.client_id === clientId, 'echo')
bobWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: clientId,
    msg_type: 'text',
    body: sealed.body,
    enc: sealed.enc,
  }),
)
const echo = await echoed
bobWs.close()

check('the encrypted message is accepted and echoed', echo.type === 'message', echo?.error)
check('the echo carries the envelope back untouched', echo.enc?.sender_device === bobPhone.id, echo.enc)
check(
  'the body on the wire is not the plaintext',
  typeof echo.body === 'string' && !echo.body.includes(secret) && echo.body !== secret,
)

const openedByPhone = await open(alicePhone, bobPhone.publicKey, echo.body, echo.enc)
const openedByDesktop = await open(aliceDesktop, bobPhone.publicKey, echo.body, echo.enc)
const openedBySender = await open(bobPhone, bobPhone.publicKey, echo.body, echo.enc)
check("alice's phone opens it", openedByPhone?.t === secret, openedByPhone)
check("alice's desktop opens it too", openedByDesktop?.t === secret, openedByDesktop)
check('the sender can read its own message back', openedBySender?.t === secret, openedBySender)

const stranger = await makeDevice()
check(
  'a device registered afterwards cannot open it (by design)',
  (await open(stranger, bobPhone.publicKey, echo.body, echo.enc)) === null,
)

// The wrap is bound to the pair, so alice's key against the wrong sender fails.
check(
  'the wrapped key does not open against the wrong sender key',
  (await open(alicePhone, aliceDesktop.publicKey, echo.body, echo.enc)) === null,
)

console.log('\n— the server holds nothing readable')

const aliceWs = await connect(aliceCookie, conversationId, bobId)
const history = await waitFor<any>(aliceWs, (e) => e.type === 'history', 'history')
aliceWs.close()
const stored = history.messages.find((m: any) => m.client_id === clientId)
check('the message is in the stored history', stored !== undefined)
check(
  'and the stored body is still ciphertext',
  stored !== undefined && !JSON.stringify(stored).includes(secret),
)

const mirrored = d1Query<{ n: number }>(
  `SELECT COUNT(*) AS n FROM conversations WHERE id = '${conversationId}'`,
)
check('D1 still tracks the conversation', (mirrored[0]?.n ?? 0) === 1)

console.log('\n— an attachment the bucket cannot read either')

check(
  'an encrypted presign without a kind is refused',
  (
    await api('/api/media/upload-url', {
      cookie: bobCookie,
      method: 'POST',
      body: JSON.stringify({ mime: 'application/octet-stream', size: 1024 }),
    })
  ).status === 400,
)

const picture = enc.encode(`imagem-secreta-${Date.now().toString(36)}`)
const mediaKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const mediaIv = crypto.getRandomValues(new Uint8Array(12))
const sealedBytes = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv: mediaIv }, mediaKey, picture),
)

const presign = await api('/api/media/upload-url', {
  cookie: bobCookie,
  method: 'POST',
  body: JSON.stringify({
    mime: 'application/octet-stream',
    size: sealedBytes.byteLength,
    kind: 'image',
  }),
})
check('an encrypted presign with a kind is issued', presign.status === 200, presign.body)
check('and the key lands under media/', presign.body?.key?.startsWith('media/'), presign.body?.key)

const put = await fetch(presign.body.upload_url, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: sealedBytes,
})
check('the ciphertext uploads to the bucket', put.ok, put.status)

// The message that references it carries the same content key, wrapped, plus
// the object's IV — which is the only reason the recipient can open the bytes.
const rawMediaKey = await crypto.subtle.exportKey('raw', mediaKey)
const mediaEnvelope: Envelope = { ...(await seal(bobPhone, recipients, { m: 'image/webp' })).enc }
{
  // Re-wrap the *media* content key rather than a fresh one, so the message and
  // its object open together.
  const keys: Envelope['keys'] = {}
  for (const device of recipients) {
    const wrapKey = await wrappingKey(
      bobPhone.keys.privateKey,
      await importPublic(device.public_key),
      bobPhone.id,
      device.id,
    )
    const wrapIv = crypto.getRandomValues(new Uint8Array(12))
    keys[device.id] = {
      iv: b64u(wrapIv),
      ct: b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapKey, rawMediaKey)),
    }
  }
  mediaEnvelope.keys = keys
  mediaEnvelope.media_iv = b64u(mediaIv)
}
const bodyIv = crypto.getRandomValues(new Uint8Array(12))
mediaEnvelope.iv = b64u(bodyIv)
const mediaBody = b64u(
  await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bodyIv },
    mediaKey,
    enc.encode(JSON.stringify({ m: 'image/webp' })),
  ),
)

const mediaWs = await connect(bobCookie, conversationId, aliceId)
const mediaClientId = crypto.randomUUID()
const mediaEchoed = waitFor<any>(
  mediaWs,
  (e) => e.type === 'message' && e.client_id === mediaClientId,
  'media echo',
)
mediaWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: mediaClientId,
    msg_type: 'image',
    body: mediaBody,
    media_key: presign.body.key,
    enc: mediaEnvelope,
  }),
)
const mediaEcho = await mediaEchoed
mediaWs.close()
check('the media message is accepted', mediaEcho.type === 'message', mediaEcho?.error)
check('and carries the object IV', typeof mediaEcho.enc?.media_iv === 'string')

const fetched = await fetch(`${API}/api/media/${presign.body.key}`, {
  headers: { Cookie: `session=${aliceCookie}` },
})
const served = new Uint8Array(await fetched.arrayBuffer())
check('alice may read the object (she is a participant)', fetched.status === 200, fetched.status)
check(
  'what the proxy serves is the ciphertext, not the picture',
  !Buffer.from(served).equals(Buffer.from(picture)) &&
    Buffer.from(served).equals(Buffer.from(sealedBytes)),
)

const openedMedia = await open(alicePhone, bobPhone.publicKey, mediaEcho.body, mediaEcho.enc)
check('alice opens the message and learns the real mime', openedMedia?.m === 'image/webp', openedMedia)

// And the same key opens the object, which is the whole point of reusing it.
{
  const wrapped = mediaEcho.enc.keys[alicePhone.id]
  const wrapKey = await wrappingKey(
    alicePhone.keys.privateKey,
    await importPublic(bobPhone.publicKey),
    alicePhone.id,
    mediaEcho.enc.sender_device,
  )
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(wrapped.iv) },
    wrapKey,
    unb64u(wrapped.ct),
  )
  const contentKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    true,
    ['decrypt'],
  )
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(mediaEcho.enc.media_iv) },
      contentKey,
      served,
    ),
  )
  check(
    'the same content key opens the object back to the original bytes',
    Buffer.from(plain).equals(Buffer.from(picture)),
  )
}

console.log('\n— the envelope has to be well formed')

const badWs = await connect(bobCookie, conversationId, aliceId)
const badId = crypto.randomUUID()
const refused = waitFor<any>(badWs, (e) => e.type === 'error', 'error frame')
badWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: badId,
    msg_type: 'text',
    body: sealed.body,
    // The sender left itself out, which the DO can check without a key.
    enc: { ...sealed.enc, keys: { [alicePhone.id]: sealed.enc.keys[alicePhone.id] } },
  }),
)
const refusal = await refused
badWs.close()
check('an envelope that omits its own sender is refused', refusal.error === 'invalid_envelope', refusal)

console.log('\n— the push preview is read back, not carried')

// The notification names a message; the service worker fetches it and decrypts
// it there (lib/push.ts `EncryptedPreview`, app/public/sw.js). So what this
// asserts is that the endpoint the worker will call actually hands back
// everything decryption needs — the envelope, the body, and the sender's public
// key — because a field missing there shows up as "notifications are silently
// always generic", which is exactly the kind of failure nobody reports.
const list = await api('/api/conversations', { cookie: aliceCookie })
const listed = list.body.conversations.find((c: any) => c.id === conversationId)
check('the conversation list carries the last message', Boolean(listed?.last_message), listed?.id)
check('with its envelope intact', Boolean(listed?.last_message?.enc?.keys), listed?.last_message?.enc)
check(
  "and the peer's device keys, which is what the ECDH needs",
  (listed?.peer_devices ?? []).some((d: any) => d.id === bobPhone.id),
  (listed?.peer_devices ?? []).map((d: any) => d.id),
)

// The device id is recomputed from the public key in that payload, which is the
// only form the service worker has it in.
const recomputedSenderId = await (async () => {
  const source = listed.peer_devices.find((d: any) => d.id === listed.last_message.enc.sender_device)
  const digest = await crypto.subtle.digest('SHA-256', unb64u(source.public_key))
  return Buffer.from(new Uint8Array(digest).slice(0, 16)).toString('hex')
})()
check(
  'the sender device id can be recomputed from its public key alone',
  recomputedSenderId === listed.last_message.enc.sender_device,
  { recomputedSenderId },
)

// Whatever the newest message happens to be by now — this file has sent several
// — the point is that the payload the worker will hand the service worker is
// openable with nothing but what is in it.
const preview = await open(
  alicePhone,
  bobPhone.publicKey,
  listed.last_message.body,
  listed.last_message.enc,
)
check('and the listed message opens with only what that payload carries', preview !== null, preview)
check(
  'into a payload a notification can render',
  Boolean(preview && (preview.t || preview.s || preview.m)),
  preview,
)

console.log('\n— a device that registered mid-conversation is not left out')

// The race this closes: a browser seals against the directory it cached, the
// peer signs in somewhere new a moment later, and the message lands stored but
// permanently unopenable on that new device — no key was ever wrapped for it.
// The Durable Object is the only place that sees both the envelope and the
// current directory, so it is what notices.
const staleWs = await connect(bobCookie, conversationId, aliceId)
const staleId = crypto.randomUUID()
// `recipients` is the directory as it stood before the tablet below exists —
// exactly the copy a browser would still be holding from its last refresh.
const staleSealed = await seal(bobPhone, recipients, { t: 'selada antes do aparelho novo' })

// Alice opens the app somewhere new, after bob already addressed the message.
const aliceTablet = await makeDevice()
await register(aliceCookie, aliceTablet)

const staleResult = waitFor<any>(
  staleWs,
  (e) => (e.type === 'message' && e.client_id === staleId) || e.type === 'error',
  'stale directory result',
)
staleWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: staleId,
    msg_type: 'text',
    body: staleSealed.body,
    enc: staleSealed.enc,
  }),
)
const stale = await staleResult
check('an envelope that misses a registered device is refused', stale.error === 'stale_directory', stale)
check('and the refusal names the message, so the client knows what to seal again', stale.client_id === staleId, stale)

// What the client does next: refresh, address it again, same client id.
const refreshed = (await api(`/api/users/${aliceId}/devices`, { cookie: bobCookie })).body.devices
check(
  'the refreshed directory carries the new device',
  refreshed.some((d: any) => d.id === aliceTablet.id),
  refreshed.map((d: any) => d.id),
)
const resealed = await seal(
  bobPhone,
  [...refreshed, ...bobDirectory.body.devices].map((d: any) => ({
    id: d.id,
    public_key: d.public_key,
  })),
  { t: 'selada de novo' },
)
const resealedResult = waitFor<any>(
  staleWs,
  (e) => (e.type === 'message' && e.client_id === staleId) || e.type === 'error',
  'resealed result',
)
staleWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: staleId,
    msg_type: 'text',
    body: resealed.body,
    enc: resealed.enc,
  }),
)
const resent = await resealedResult
check('the re-sealed message is accepted under the same client id', resent.type === 'message', resent)
check(
  'and it is addressed to the device that was missing',
  resent.enc && aliceTablet.id in resent.enc.keys,
  resent.enc && Object.keys(resent.enc.keys),
)
staleWs.close()

console.log('\n— history handed to a device of your own account')

// A browser signed into after the fact holds a key no envelope names, and no
// amount of server help fixes that: the content keys exist only wrapped. So an
// existing device of the same account re-wraps them under *its* pair and says
// so with `via` — which is the whole reason that field exists, because it
// cannot produce the wrap the original sender would have written.
const aliceLaptop = await makeDevice()
await register(aliceCookie, aliceLaptop)

// It cannot read the message from earlier in this run: no key was ever wrapped
// for it, which is the state this whole exchange exists to leave behind.
check(
  'the new device is not named in the envelope at all',
  !(aliceLaptop.id in echo.enc.keys),
  Object.keys(echo.enc.keys),
)

// Alice's phone opens it, re-wraps the content key for the laptop, and hands it
// over. `contentKey` here is what `open` recovered — the same key the sender
// generated, never seen by the server in the clear.
const opened = await openWithKey(alicePhone, bobPhone.publicKey, echo.body, echo.enc)
const handover = await rewrap(alicePhone, aliceLaptop, opened!.contentKey)

const handoverWs = await connect(aliceCookie, conversationId, bobId)
const shared = waitFor<any>(handoverWs, (e) => e.type === 'keys_shared', 'keys_shared')
handoverWs.send(
  JSON.stringify({
    type: 'share_keys',
    device_id: aliceLaptop.id,
    keys: { [echo.id]: handover },
  }),
)
const sharedFrame = await shared
check('the durable object merges the handed-over key', sharedFrame.count === 1, sharedFrame)

const refreshedHistory = await waitFor<any>(handoverWs, (e) => e.type === 'history', 'history after share')
const updated = refreshedHistory.messages.find((m: any) => m.id === echo.id)
check('and hands the envelope back with the new entry in it', Boolean(updated?.enc?.keys?.[aliceLaptop.id]), updated?.enc && Object.keys(updated.enc.keys))
check(
  'the entry names the device that wrapped it, not the sender',
  updated?.enc?.keys?.[aliceLaptop.id]?.via === alicePhone.id,
  updated?.enc?.keys?.[aliceLaptop.id],
)

// The point of all of it: the laptop reads a message that predates it, by
// running ECDH against the phone rather than against bob.
const byLaptop = await open(aliceLaptop, alicePhone.publicKey, updated.body, updated.enc)
check('and the new device can now open the message', byLaptop?.t === secret, byLaptop)

// The handover moved who can read it and nothing else: the body is still bound
// to bob and to bob's device, so it still says it came from bob.
check(
  'the envelope still names bob as the sender',
  updated.enc.sender_device === bobPhone.id,
  updated.enc.sender_device,
)

// A device belonging to somebody else is refused: this object will not be the
// tool that grants a stranger read access.
const outsiderRefusal = waitFor<any>(handoverWs, (e) => e.type === 'error', 'share refusal')
handoverWs.send(
  JSON.stringify({ type: 'share_keys', device_id: bobPhone.id, keys: { [echo.id]: handover } }),
)
check(
  "sharing to another account's device is refused",
  (await outsiderRefusal).error === 'unknown_device',
)
handoverWs.close()

// Both halves of the transition switch. Which one is in force is read off the
// worker's answer rather than off this process's environment: `E2EE_REQUIRED`
// reaches the Durable Object through .dev.vars or wrangler.jsonc, and an env var
// exported in front of `npm run smoke:phase15` changes nothing about what is
// running. Asking, instead of assuming, is what stops this from asserting the
// wrong half and reporting it as a failure of the code.
//
//   E2EE_REQUIRED=false — plaintext still works, which is what lets a fleet
//                         upgrade one browser at a time, and what the smoke
//                         tests that predate encryption rely on;
//   E2EE_REQUIRED=true  — it does not, which is the deployed default.
const plainWs = await connect(bobCookie, conversationId, aliceId)
const plainId = crypto.randomUUID()
const plainResult = waitFor<any>(
  plainWs,
  (e) => (e.type === 'message' && e.client_id === plainId) || e.type === 'error',
  'plaintext result',
)
plainWs.send(
  JSON.stringify({ type: 'send_message', client_id: plainId, msg_type: 'text', body: 'em claro' }),
)
const plain = await plainResult
plainWs.close()
if (required) {
  check('a message with no envelope is refused', plain.error === 'encryption_required', plain)
} else {
  check('a message with no envelope is accepted', plain.body === 'em claro', plain)
  check('and comes back with no envelope', plain.enc === null || plain.enc === undefined, plain.enc)
}

console.log('\n— the safety number')

/** Mirrors `safetyNumber` in app/src/lib/e2ee.ts. */
async function safetyNumber(a: { public_key: string }[], b: { public_key: string }[]) {
  const fingerprint = (devices: { public_key: string }[]) =>
    devices.map((d) => d.public_key).sort().join('|')
  const material = [fingerprint(a), fingerprint(b)].sort().join('||')
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(material))
  const digits = [...new Uint8Array(digest)]
    .map((byte) => byte.toString().padStart(3, '0'))
    .join('')
    .slice(0, 60)
  return (digits.match(/.{1,5}/g) ?? []).join(' ')
}

const aliceSide = [
  { public_key: alicePhone.publicKey },
  { public_key: aliceDesktop.publicKey },
]
const bobSide = [{ public_key: bobPhone.publicKey }]
const fromAlice = await safetyNumber(aliceSide, bobSide)
const fromBob = await safetyNumber(bobSide, aliceSide)
check('both sides compute the same number, in either order', fromAlice === fromBob)
check('it is 12 groups of 5 digits', /^(\d{5} ){11}\d{5}$/.test(fromAlice), fromAlice)
check(
  'a swapped device key changes it',
  (await safetyNumber([{ public_key: stranger.publicKey }], bobSide)) !== fromAlice,
)

console.log(failures === 0 ? '\nphase 15 smoke: all green' : `\nphase 15 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
