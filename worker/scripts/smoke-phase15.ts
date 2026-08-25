// Phase 15 smoke: end-to-end encryption, the wire format.
//
// The crypto here is a *second* implementation of the envelope, written against
// docs/architecture.md rather than imported from app/src/lib/e2ee.ts. That is
// the point: a test that calls the same code the app calls only proves the code
// round-trips with itself, which is true of any format including a broken one.
// This proves the envelope is implementable from its description, and it is
// what would catch the app silently changing the shape.
//
// It covers the envelope and nothing else. The password KDF and the wrapped
// account key — how a browser comes to hold the private half at all — are
// phase 17's, which is also where "sign in somewhere new and read everything"
// is proved end to end. Here the accounts publish a public key and keep the
// private half in this process, so `account_key_wrapped` is opaque filler: the
// worker never opens it, which is the property phase 17 asserts and this file
// relies on.
//
// What it asserts, in order:
//   - a v3 envelope names two accounts, the recipient and the sender, and no
//     devices at all;
//   - both of them open it, and nobody else does;
//   - the Durable Object never holds the plaintext, and refuses an envelope
//     that leaves out its own sender;
//   - an attachment is ciphertext in the bucket, opened by the same content
//     key as the message that names it;
//   - the key directory refuses a caller with no reason to see it;
//   - the conversation list carries what a push preview needs;
//   - the safety number is the two account keys, and only those.
//
// Usage: npm run smoke:phase15   (needs `npm run dev` on :8000 and seed data)

import { WebSocket } from 'ws'
import { d1Execute, insertUser, signIn } from './lib.ts'

const API = process.env.API ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')

/**
 * Fresh accounts per run rather than alice and bob.
 *
 * `PUT /api/account/key` is create-only — replacing a key is what cuts
 * somebody off from their own history, so a session alone must not be able to
 * do it — which means this file cannot publish a key it holds the private half
 * of for an account that already has one. Creating its own is the honest way
 * to get there, and it leaves the seed fixtures alone.
 */
const STAMP = Date.now().toString(36)
const ALICE = { username: `e2ee_a${STAMP}`, password: `alice-${STAMP}-goodchat` }
const BOB = { username: `e2ee_b${STAMP}`, password: `bob-${STAMP}-goodchat` }
/** Only for the teardown: deleting an account with history needs the console. */
const OWNER = { username: 'good', password: 'good-goodchat' }

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

/** One account's key, with the private half kept in this process. */
interface Account {
  /** The account id — what the envelope's key map is keyed by. */
  id: string
  publicKey: string
  keys: CryptoKeyPair
  cookie: string
}

async function makeKeypair(): Promise<{ publicKey: string; keys: CryptoKeyPair }> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  return { publicKey: b64u(await crypto.subtle.exportKey('raw', keys.publicKey)), keys }
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

/** HKDF over the ECDH secret, salted with both account ids, sorted. */
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

interface Context {
  conversationId: string
  senderId: string
  clientId: string
}

/**
 * What a v3 body is authenticated under. No sending device: with the account as
 * the unit there is no such party, and the version literal is what stops an
 * envelope of one version being replayed as another.
 */
function messageAad(context: Context): Uint8Array {
  return enc.encode(
    ['goodchat-v3', context.conversationId, context.senderId, context.clientId].join('|'),
  )
}

interface Envelope {
  v: 3
  iv: string
  keys: Record<string, { iv: string; ct: string }>
  media_iv?: string
}

async function seal(
  sender: Account,
  peer: { id: string; publicKey: string },
  context: Context,
  payload: Record<string, string>,
  contentKey?: CryptoKey,
  mediaIv?: Uint8Array,
): Promise<{ body: string; enc: Envelope; contentKey: CryptoKey }> {
  const key =
    contentKey ??
    (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ]))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = b64u(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: messageAad(context) },
      key,
      enc.encode(JSON.stringify(payload)),
    ),
  )
  const raw = await crypto.subtle.exportKey('raw', key)

  // Two entries, always: the recipient and the sender's own — the second one so
  // the person can read what they sent, not so another of their tabs can.
  const keys: Envelope['keys'] = {}
  for (const target of [peer, { id: sender.id, publicKey: sender.publicKey }]) {
    const wrapKey = await wrappingKey(
      sender.keys.privateKey,
      await importPublic(target.publicKey),
      sender.id,
      target.id,
    )
    const wrapIv = crypto.getRandomValues(new Uint8Array(12))
    keys[target.id] = {
      iv: b64u(wrapIv),
      ct: b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapKey, raw)),
    }
  }
  return {
    body,
    enc: { v: 3, iv: b64u(iv), keys, ...(mediaIv ? { media_iv: b64u(mediaIv) } : {}) },
    contentKey: key,
  }
}

/**
 * Opens a message and keeps the content key, which a media message needs for
 * its object.
 *
 * `senderPublicKey` is the sending *account's* published key. There is no
 * second possibility anymore: the handover that could put another device's key
 * here died with the device model.
 */
async function openWithKey(
  reader: Account,
  senderPublicKey: string,
  context: Context,
  body: string,
  envelope: Envelope,
): Promise<{ payload: Record<string, string>; contentKey: CryptoKey } | null> {
  const wrapped = envelope.keys[reader.id]
  if (!wrapped) return null
  try {
    const wrapKey = await wrappingKey(
      reader.keys.privateKey,
      await importPublic(senderPublicKey),
      reader.id,
      context.senderId,
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
      ['decrypt', 'encrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(envelope.iv), additionalData: messageAad(context) },
      contentKey,
      unb64u(body),
    )
    return { payload: JSON.parse(dec.decode(plain)) as Record<string, string>, contentKey }
  } catch {
    return null
  }
}

async function open(
  reader: Account,
  senderPublicKey: string,
  context: Context,
  body: string,
  envelope: Envelope,
): Promise<Record<string, string> | null> {
  return (await openWithKey(reader, senderPublicKey, context, body, envelope))?.payload ?? null
}

// --- REST helpers ---------------------------------------------------------

async function api(
  path: string,
  { cookie, method = 'GET', body }: { cookie?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/**
 * Creates the account, signs in, and publishes a keypair this process holds.
 *
 * `wrapped` is filler. The worker stores it and never opens it — that is the
 * whole design (migration 0014) — so a test of the *envelope* does not need a
 * real KDF behind it, and phase 17 is where "the worker cannot open it" is
 * asserted rather than assumed.
 */
async function makeAccount(credentials: { username: string; password: string }): Promise<Account> {
  await insertUser(credentials.username, credentials.password, credentials.username)
  const cookie = await signIn(API, credentials.username, credentials.password)
  if (!cookie) throw new Error(`could not sign in as ${credentials.username}`)
  const id: string = (await api('/api/auth/me', { cookie })).body.user.id
  const { publicKey, keys } = await makeKeypair()
  const published = await api('/api/account/key', {
    cookie,
    method: 'PUT',
    body: JSON.stringify({
      public_key: publicKey,
      wrapped: b64u(crypto.getRandomValues(new Uint8Array(160))),
      iv: b64u(crypto.getRandomValues(new Uint8Array(12))),
    }),
  })
  if (published.status !== 200) {
    throw new Error(`could not publish a key for ${credentials.username}: ${published.status}`)
  }
  return { id, publicKey, keys, cookie }
}

function connect(cookie: string, conversationId: string, withId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_API}/api/ws/${conversationId}?with=${withId}`, {
      headers: { Cookie: cookie },
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

console.log('--- phase 15: the account envelope ---\n')

// Every sign-in below spends a slot of the per-IP login window — twice over,
// because `signIn` tries the derived credential and then the plaintext one the
// way the app does. Cleared at both ends so this run neither inherits nor
// leaves a lockout.
d1Execute('DELETE FROM login_attempts;')

const alice = await makeAccount(ALICE)
const bob = await makeAccount(BOB)

console.log('— the directory')

const aliceKey = await api(`/api/users/${alice.id}/key`, { cookie: bob.cookie })
check('bob reads alice’s account key', aliceKey.body?.public_key === alice.publicKey, aliceKey.body)
check(
  'it is one key, not a list of devices',
  typeof aliceKey.body?.public_key === 'string' && !('devices' in (aliceKey.body ?? {})),
  aliceKey.body,
)
check('the directory needs a session', (await api(`/api/users/${alice.id}/key`)).status === 401)
check(
  'the directory refuses an id that is not an account',
  (await api('/api/users/does-not-exist/key', { cookie: bob.cookie })).status === 404,
)
check(
  'a second key cannot be published over the first',
  (
    await api('/api/account/key', {
      cookie: alice.cookie,
      method: 'PUT',
      body: JSON.stringify({
        public_key: (await makeKeypair()).publicKey,
        wrapped: b64u(crypto.getRandomValues(new Uint8Array(160))),
        iv: b64u(crypto.getRandomValues(new Uint8Array(12))),
      }),
    })
  ).status === 409,
)

console.log('\n— a message only the two accounts can read')

const resolved = await api('/api/conversations/resolve', {
  cookie: bob.cookie,
  method: 'POST',
  body: JSON.stringify({ user_id: alice.id }),
})
const conversationId: string = resolved.body.conversation_id

const secret = `segredo-${STAMP}`
const clientId = crypto.randomUUID()
const context: Context = { conversationId, senderId: bob.id, clientId }
const sealed = await seal(bob, { id: alice.id, publicKey: alice.publicKey }, context, { t: secret })

check('the envelope is v3', sealed.enc.v === 3)
check('it names exactly two accounts', Object.keys(sealed.enc.keys).length === 2, sealed.enc.keys)
check(
  'and they are the two participants',
  Object.keys(sealed.enc.keys).sort().join() === [alice.id, bob.id].sort().join(),
  Object.keys(sealed.enc.keys),
)
check('there is no sender_device', !('sender_device' in sealed.enc))

const bobWs = await connect(bob.cookie, conversationId, alice.id)
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
check('the echo carries the envelope back untouched', echo.enc?.v === 3, echo.enc)
check(
  'the body on the wire is not the plaintext',
  typeof echo.body === 'string' && !echo.body.includes(secret) && echo.body !== secret,
)

check(
  'the recipient opens it',
  (await open(alice, bob.publicKey, context, echo.body, echo.enc))?.t === secret,
)
check(
  'the sender reads its own message back',
  (await open(bob, bob.publicKey, context, echo.body, echo.enc))?.t === secret,
)

const stranger: Account = { ...(await makeKeypair()), id: crypto.randomUUID(), cookie: '' }
check(
  'an account the envelope does not name cannot open it',
  (await open(stranger, bob.publicKey, context, echo.body, echo.enc)) === null,
)
check(
  'the wrapped key does not open against the wrong sender key',
  (await open(alice, stranger.publicKey, context, echo.body, echo.enc)) === null,
)

// The binding, which is the only thing stopping the server relocating a
// message: the body authenticates under the conversation, the sender and this
// one message id, and none of the three is inside the envelope.
check(
  'an envelope moved to another conversation does not open',
  (await open(alice, bob.publicKey, { ...context, conversationId: '0'.repeat(32) }, echo.body, echo.enc)) ===
    null,
)
check(
  'an envelope re-attributed to another sender does not open',
  (await open(alice, bob.publicKey, { ...context, senderId: alice.id }, echo.body, echo.enc)) === null,
)
check(
  'an envelope replayed as another message does not open',
  (await open(alice, bob.publicKey, { ...context, clientId: crypto.randomUUID() }, echo.body, echo.enc)) ===
    null,
)

console.log('\n— the server holds nothing readable')

const aliceWs = await connect(alice.cookie, conversationId, bob.id)
const history = await waitFor<any>(aliceWs, (e) => e.type === 'history', 'history')
aliceWs.close()
const stored = history.messages.find((m: any) => m.client_id === clientId)
check('the message is in the stored history', stored !== undefined)
check(
  'and the stored body is still ciphertext',
  stored !== undefined && !JSON.stringify(stored).includes(secret),
)

console.log('\n— an attachment the bucket cannot read either')

const picture = enc.encode(`imagem-secreta-${STAMP}`)
const mediaContentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const mediaIv = crypto.getRandomValues(new Uint8Array(12))
const sealedBytes = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv: mediaIv }, mediaContentKey, picture),
)

check(
  'an encrypted presign without a kind is refused',
  (
    await api('/api/media/upload-url', {
      cookie: bob.cookie,
      method: 'POST',
      body: JSON.stringify({ mime: 'application/octet-stream', size: 1024 }),
    })
  ).status === 400,
)

const presign = await api('/api/media/upload-url', {
  cookie: bob.cookie,
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

// The message that references it carries the *same* content key, wrapped, plus
// the object's IV — which is the only reason the recipient can open the bytes.
const mediaClientId = crypto.randomUUID()
const mediaContext: Context = { conversationId, senderId: bob.id, clientId: mediaClientId }
const mediaSealed = await seal(
  bob,
  { id: alice.id, publicKey: alice.publicKey },
  mediaContext,
  { m: 'image/webp' },
  mediaContentKey,
  mediaIv,
)

const mediaWs = await connect(bob.cookie, conversationId, alice.id)
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
    body: mediaSealed.body,
    media_key: presign.body.key,
    enc: mediaSealed.enc,
  }),
)
const mediaEcho = await mediaEchoed
mediaWs.close()
check('the media message is accepted', mediaEcho.type === 'message', mediaEcho?.error)
check('and carries the object IV', typeof mediaEcho.enc?.media_iv === 'string')

const fetched = await fetch(`${API}/api/media/${presign.body.key}`, {
  headers: { Cookie: alice.cookie },
})
const served = new Uint8Array(await fetched.arrayBuffer())
check('alice may read the object (she is a participant)', fetched.status === 200, fetched.status)
check(
  'what the proxy serves is the ciphertext, not the picture',
  !Buffer.from(served).equals(Buffer.from(picture)) &&
    Buffer.from(served).equals(Buffer.from(sealedBytes)),
)

const openedMedia = await openWithKey(
  alice,
  bob.publicKey,
  mediaContext,
  mediaEcho.body,
  mediaEcho.enc,
)
check('alice opens the message and learns the real mime', openedMedia?.payload.m === 'image/webp', openedMedia?.payload)

// And the same key opens the object, which is the whole point of reusing it.
{
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(mediaEcho.enc.media_iv) },
      openedMedia!.contentKey,
      served,
    ),
  )
  check(
    'the same content key opens the object back to the original bytes',
    Buffer.from(plain).equals(Buffer.from(picture)),
  )
}

console.log('\n— the envelope has to be well formed')

const badWs = await connect(bob.cookie, conversationId, alice.id)
const badId = crypto.randomUUID()
const refused = waitFor<any>(badWs, (e) => e.type === 'error', 'error frame')
badWs.send(
  JSON.stringify({
    type: 'send_message',
    client_id: badId,
    msg_type: 'text',
    body: sealed.body,
    // The sender left itself out, which the DO can check without a key.
    enc: { ...sealed.enc, keys: { [alice.id]: sealed.enc.keys[alice.id] } },
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
const list = await api('/api/conversations', { cookie: alice.cookie })
const listed = list.body.conversations.find((c: any) => c.id === conversationId)
check('the conversation list carries the last message', Boolean(listed?.last_message), listed?.id)
check('with its envelope intact', Boolean(listed?.last_message?.enc?.keys), listed?.last_message?.enc)
check(
  "and the peer's account key, which is what the ECDH needs",
  listed?.peer_account_key === bob.publicKey,
  listed?.peer_account_key,
)

const preview = await open(
  alice,
  listed.peer_account_key,
  {
    conversationId,
    senderId: listed.last_message.sender_id,
    clientId: listed.last_message.client_id,
  },
  listed.last_message.body,
  listed.last_message.enc,
)
check('and the listed message opens with only what that payload carries', preview !== null, preview)
check(
  'into a payload a notification can render',
  Boolean(preview && (preview.t || preview.s || preview.m)),
  preview,
)

// Both halves of the transition switch. Which one is in force is read off the
// worker's answer rather than off this process's environment: `E2EE_REQUIRED`
// reaches the Durable Object through .dev.vars or wrangler.jsonc, and an env var
// exported in front of `npm run smoke:phase15` changes nothing about what is
// running. Asking, instead of assuming, is what stops this from asserting the
// wrong half and reporting it as a failure of the code.
const plainWs = await connect(bob.cookie, conversationId, alice.id)
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
const required = plain.type === 'error'
console.log(
  required
    ? '\n— plaintext is refused (E2EE_REQUIRED=true)'
    : '\n— plaintext still works during the transition (E2EE_REQUIRED=false)',
)
if (required) {
  check('a message with no envelope is refused', plain.error === 'encryption_required', plain)
} else {
  check('a message with no envelope is accepted', plain.body === 'em claro', plain)
  check('and comes back with no envelope', plain.enc === null || plain.enc === undefined, plain.enc)
}

console.log('\n— the safety number')

/** Mirrors `safetyNumber` in app/src/lib/e2ee.ts: two account keys, sorted. */
async function safetyNumber(a: string, b: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode([a, b].sort().join('||')))
  const digits = [...new Uint8Array(digest)]
    .map((byte) => byte.toString().padStart(3, '0'))
    .join('')
    .slice(0, 60)
  return (digits.match(/.{1,5}/g) ?? []).join(' ')
}

const fromAlice = await safetyNumber(alice.publicKey, bob.publicKey)
const fromBob = await safetyNumber(bob.publicKey, alice.publicKey)
check('both sides compute the same number, in either order', fromAlice === fromBob)
check('it is 12 groups of 5 digits', /^(\d{5} ){11}\d{5}$/.test(fromAlice), fromAlice)
check('a swapped key changes it', (await safetyNumber(stranger.publicKey, bob.publicKey)) !== fromAlice)
// The property the device directory could not have: the number depends on the
// two keys and on nothing else, so opening a third browser does not move it.
check(
  'and nothing else changes it — no device set to grow',
  (await safetyNumber(alice.publicKey, bob.publicKey)) === fromAlice,
)

// Leave the instance as it was found.
//
// Through the owner console rather than a DELETE against `users`: these two
// accounts now own a conversation and a bucket object, and the foreign keys
// say so. `deleteAccount` is the path that unwinds all of it — the same one an
// expiring guest takes (lib/accounts.ts) — and using it here means the cleanup
// is exercising a real code path rather than working around one.
const ownerCookie = await signIn(API, OWNER.username, OWNER.password)
if (ownerCookie) {
  for (const account of [alice, bob]) {
    await api(`/api/admin/users/${account.id}`, { cookie: ownerCookie, method: 'DELETE' })
  }
} else {
  console.log('  note: no owner account, leaving this run\'s two test accounts behind')
}
d1Execute('DELETE FROM login_attempts;')

console.log(failures === 0 ? '\nphase 15 smoke: all green' : `\nphase 15 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
