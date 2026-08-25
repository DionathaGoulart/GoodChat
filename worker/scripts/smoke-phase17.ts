// Phase 17 smoke: the password never arrives, and the key it wraps stays shut.
//
// Phase 15 proves the envelope and phase 16 proves the app implements it. Both
// of them start from a browser that already holds a private key, and neither
// asks where it came from. This is that question: a password turns into three
// values (app/src/lib/kdf.ts), exactly one of them is allowed to leave the
// browser, and the account key is sealed under one of the two that are not.
//
// The KDF is implemented a second time here, from the description, for the same
// reason phase 15 reimplements the envelope: a test that calls kdf.ts to check
// kdf.ts proves the code agrees with itself, which is true of a broken
// derivation too. What is *not* reimplemented is the app's flow — this file
// drives the real endpoints in the real order, because the thing being checked
// is what crosses the wire.
//
// Four claims, and each one fails in a different way if it is wrong:
//
//   1. nothing the wrapping key derives from ever reaches the worker. Every
//      request body this file sends is recorded and searched for the password,
//      for the master key, and for the wrapping key's own bytes.
//   2. a copy of D1 plus the token the worker verifies does not open the
//      account key. This is the claim the whole design rests on, and it is the
//      one an implementation can silently break — by deriving the wrapping key
//      from the wrong half, which round-trips perfectly and protects nothing.
//   3. a browser with an empty key store signs in with the password alone and
//      reads the entire history. This is what the account key exists for.
//   4. POST /api/auth/kdf answers for a username that does not exist, and
//      answers the same thing twice. Without that it is an account-enumeration
//      oracle with no rate limit in front of it.
//
// Usage: npm run smoke:phase17   (needs `npm run dev` on :8000 and an owner)

import { WebSocket } from 'ws'
import { d1Execute, d1Query, insertUser, signIn, sqlString } from './lib.ts'

const API = process.env.API ?? 'http://localhost:8000'
const WS_API = API.replace(/^http/, 'ws')

const STAMP = Date.now().toString(36)
const ALICE = { username: `kdf_a${STAMP}`, password: `alice-${STAMP}-goodchat` }
const BOB = { username: `kdf_b${STAMP}`, password: `bob-${STAMP}-goodchat` }
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

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64u = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')
const unb64u = (v: string) => new Uint8Array(Buffer.from(v, 'base64url'))

// --- the KDF, implemented from the description ----------------------------
//
//   masterKey = PBKDF2-SHA256(password, kdf_salt, iterations)
//   authToken = PBKDF2-SHA256(masterKey, password, 1)
//   wrapKey   = HKDF-SHA256(masterKey, salt="", info="goodchat/wrap/v1")

async function pbkdf2(
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      256,
    ),
  )
}

interface Secrets {
  masterKey: Uint8Array
  authToken: string
  /** The raw HKDF output, so this file can look for it on the wire. */
  wrapBytes: Uint8Array
  wrapKey: CryptoKey
}

async function derive(password: string, params: { salt: string; iterations: number }): Promise<Secrets> {
  const passwordBytes = enc.encode(password)
  const masterKey = await pbkdf2(passwordBytes, unb64u(params.salt), params.iterations)
  const authToken = await pbkdf2(masterKey, passwordBytes, 1)
  const material = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const hkdf = {
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: enc.encode('goodchat/wrap/v1'),
  } as const
  return {
    masterKey,
    authToken: b64u(authToken),
    wrapBytes: new Uint8Array(await crypto.subtle.deriveBits(hkdf, material, 256)),
    wrapKey: await crypto.subtle.deriveKey(hkdf, material, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  }
}

// --- a recording client ---------------------------------------------------

/** Every request body this file sent, so claim 1 can be checked against them. */
const sent: { path: string; body: string }[] = []

async function api(
  path: string,
  { cookie, method = 'GET', body }: { cookie?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  if (body) sent.push({ path, body })
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] || null,
  }
}

/** A browser: one key store, emptied by construction on every call. */
async function browser(credentials: { username: string; password: string }) {
  const params = (
    await api('/api/auth/kdf', {
      method: 'POST',
      body: JSON.stringify({ username: credentials.username }),
    })
  ).body
  const secrets = await derive(credentials.password, params)
  const signedIn = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: credentials.username, auth_token: secrets.authToken }),
  })
  if (signedIn.status !== 200 || !signedIn.cookie) {
    throw new Error(`could not sign in as ${credentials.username}: ${signedIn.status}`)
  }
  return { ...signedIn, secrets, params }
}

async function publishKey(cookie: string, secrets: Secrets) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey))
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, secrets.wrapKey, pkcs8))
  const published = await api('/api/account/key', {
    cookie,
    method: 'PUT',
    body: JSON.stringify({ public_key: publicKey, wrapped, iv: b64u(iv) }),
  })
  if (published.status !== 200) throw new Error(`publish failed: ${published.status}`)
  return { publicKey, privateKey: pair.privateKey }
}

// --- the envelope, the short version --------------------------------------

async function wrappingKey(privateKey: CryptoKey, peerPublic: string, a: string, b: string) {
  const shared = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: await crypto.subtle.importKey(
        'raw',
        unb64u(peerPublic),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      ),
    },
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

const aad = (conversationId: string, senderId: string, clientId: string) =>
  enc.encode(['goodchat-v3', conversationId, senderId, clientId].join('|'))

async function seal(
  senderId: string,
  senderPrivate: CryptoKey,
  senderPublic: string,
  peerId: string,
  peerPublic: string,
  conversationId: string,
  clientId: string,
  text: string,
) {
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = b64u(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(conversationId, senderId, clientId) },
      contentKey,
      enc.encode(JSON.stringify({ t: text })),
    ),
  )
  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const keys: Record<string, { iv: string; ct: string }> = {}
  for (const target of [
    { id: peerId, key: peerPublic },
    { id: senderId, key: senderPublic },
  ]) {
    const wk = await wrappingKey(senderPrivate, target.key, senderId, target.id)
    const wIv = crypto.getRandomValues(new Uint8Array(12))
    keys[target.id] = {
      iv: b64u(wIv),
      ct: b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wIv }, wk, raw)),
    }
  }
  return { body, enc: { v: 3, iv: b64u(iv), keys } }
}

async function openText(
  readerId: string,
  readerPrivate: CryptoKey,
  senderId: string,
  senderPublic: string,
  conversationId: string,
  clientId: string,
  body: string,
  envelope: any,
): Promise<string | null> {
  const wrapped = envelope.keys[readerId]
  if (!wrapped) return null
  try {
    const wk = await wrappingKey(readerPrivate, senderPublic, readerId, senderId)
    const raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(wrapped.iv) },
      wk,
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
      {
        name: 'AES-GCM',
        iv: unb64u(envelope.iv),
        additionalData: aad(conversationId, senderId, clientId),
      },
      contentKey,
      unb64u(body),
    )
    return (JSON.parse(dec.decode(plain)) as { t: string }).t
  } catch {
    return null
  }
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

console.log('--- phase 17: the password never arrives ---\n')

d1Execute('DELETE FROM login_attempts;')

console.log('— /api/auth/kdf answers for everybody')

const unknown = `ghost_${STAMP}`
const first = await api('/api/auth/kdf', { method: 'POST', body: JSON.stringify({ username: unknown }) })
const second = await api('/api/auth/kdf', { method: 'POST', body: JSON.stringify({ username: unknown }) })
check('a username with no account still gets a salt', first.status === 200 && typeof first.body?.salt === 'string', first.body)
check('the salt is 16 bytes, like a real one', unb64u(first.body.salt).length === 16, first.body.salt)
check('and it quotes the same cost a real account would', first.body.iterations === 600_000, first.body)
// Determinism is the whole of it. A random decoy would be worse than a 404:
// two calls returning two different salts says "there is no row here" out loud.
check('the same unknown username gets the same salt twice', first.body.salt === second.body.salt)
const other = await api('/api/auth/kdf', {
  method: 'POST',
  body: JSON.stringify({ username: `ghost2_${STAMP}` }),
})
check('a different unknown username gets a different one', other.body.salt !== first.body.salt)

// The accounts. `insertUser` derives client-side, so they start rotated.
await insertUser(ALICE.username, ALICE.password, ALICE.username)
await insertUser(BOB.username, BOB.password, BOB.username)

const alice = await browser(ALICE)
const bob = await browser(BOB)
const aliceId: string = alice.body.user.id
const bobId: string = bob.body.user.id
check('an account created by the CLI signs in with the derived token', aliceId !== undefined)
check('and does not have to rotate', alice.body.user.must_rotate === false, alice.body.user)

const aliceKey = await publishKey(alice.cookie!, alice.secrets)
const bobKey = await publishKey(bob.cookie!, bob.secrets)

console.log('\n— nothing the wrapping key derives from crosses the wire')

// Every form the values could plausibly travel in. A leak would be a bug of
// omission — somebody adding a field — so the search is over the raw bodies
// rather than over a list of field names.
const forbidden: { what: string; needles: string[] }[] = [
  { what: 'the password', needles: [ALICE.password, BOB.password] },
  {
    what: 'the master key',
    needles: [
      b64u(alice.secrets.masterKey),
      Buffer.from(alice.secrets.masterKey).toString('hex'),
      Buffer.from(alice.secrets.masterKey).toString('base64'),
    ],
  },
  {
    what: 'the wrapping key',
    needles: [
      b64u(alice.secrets.wrapBytes),
      Buffer.from(alice.secrets.wrapBytes).toString('hex'),
      Buffer.from(alice.secrets.wrapBytes).toString('base64'),
    ],
  },
]

check(`there is something to search (${sent.length} request bodies)`, sent.length >= 6, sent.length)
for (const { what, needles } of forbidden) {
  const leaked = sent.filter((request) => needles.some((needle) => request.body.includes(needle)))
  check(`${what} appears in no request body`, leaked.length === 0, leaked.map((r) => r.path))
}
// The one value that is meant to travel, checked positively — otherwise the
// three assertions above would also pass on a client that sent nothing at all.
check(
  'the auth token, which is meant to travel, does appear',
  sent.some((request) => request.body.includes(alice.secrets.authToken)),
)

console.log('\n— a copy of D1 does not open the account key')

const row = d1Query<{
  password_hash: string
  kdf_salt: string
  kdf_iterations: number
  account_public_key: string
  account_key_wrapped: string
  account_key_iv: string
}>(
  `SELECT password_hash, kdf_salt, kdf_iterations, account_public_key,
          account_key_wrapped, account_key_iv
   FROM users WHERE username = ${sqlString(ALICE.username)}`,
)[0]!

check('the row holds a wrapped key', typeof row.account_key_wrapped === 'string')
check('and the salt the client derived against', row.kdf_salt === alice.params.salt)
check(
  'and a hash of the token, not of the password',
  row.password_hash.startsWith('pbkdf2-sha256$') && !row.password_hash.includes(ALICE.password),
)

/** Everything an attacker holding the dump could plausibly try. */
async function opens(key: CryptoKey): Promise<boolean> {
  try {
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(row.account_key_iv) },
      key,
      unb64u(row.account_key_wrapped),
    )
    return true
  } catch {
    return false
  }
}

const tokenBytes = unb64u(alice.secrets.authToken)
const asKey = (bytes: Uint8Array) =>
  crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])

check('the token used directly as a key does not open it', !(await opens(await asKey(tokenBytes))))
check(
  'nor does HKDF over the token with the same info string',
  !(await opens(
    await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: enc.encode('goodchat/wrap/v1'),
      },
      await crypto.subtle.importKey('raw', tokenBytes, 'HKDF', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    ),
  )),
)
check(
  'nor does the stored salt, which is the only other thing in the row',
  !(await opens(await asKey(new Uint8Array(32).fill(0)))) &&
    !(await opens(await asKey((await pbkdf2(unb64u(row.kdf_salt), unb64u(row.kdf_salt), 1))))),
)
// And the positive control: the real wrapping key does open it, so the three
// refusals above are the derivation being one-way rather than the ciphertext
// being unopenable by anything.
check('the wrapping key derived from the password does open it', await opens(alice.secrets.wrapKey))

console.log('\n— a browser with an empty key store reads the whole history')

const resolved = await api('/api/conversations/resolve', {
  cookie: alice.cookie!,
  method: 'POST',
  body: JSON.stringify({ user_id: bobId }),
})
const conversationId: string = resolved.body.conversation_id

const secrets = [`um-${STAMP}`, `dois-${STAMP}`, `tres-${STAMP}`]
const aliceWs = await connect(alice.cookie!, conversationId, bobId)
const sentIds: string[] = []
for (const text of secrets) {
  const clientId = crypto.randomUUID()
  sentIds.push(clientId)
  const sealed = await seal(
    aliceId,
    aliceKey.privateKey,
    aliceKey.publicKey,
    bobId,
    bobKey.publicKey,
    conversationId,
    clientId,
    text,
  )
  const echoed = waitFor<any>(aliceWs, (e) => e.type === 'message' && e.client_id === clientId, 'echo')
  aliceWs.send(
    JSON.stringify({
      type: 'send_message',
      client_id: clientId,
      msg_type: 'text',
      body: sealed.body,
      enc: sealed.enc,
    }),
  )
  await echoed
}
aliceWs.close()
console.log(`  (${secrets.length} messages sealed to alice's key)`)

// A second browser. Nothing carried over: it signs in with the password and
// nothing else, exactly as a machine that has never seen this account would.
const elsewhere = await browser(ALICE)
check('the login hands back the wrapped key', Boolean(elsewhere.body.account_key?.wrapped))
const reopened = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: unb64u(elsewhere.body.account_key.iv) },
  elsewhere.secrets.wrapKey,
  unb64u(elsewhere.body.account_key.wrapped),
)
const elsewherePrivate = await crypto.subtle.importKey(
  'pkcs8',
  reopened,
  { name: 'ECDH', namedCurve: 'P-256' },
  false,
  ['deriveBits'],
)
check(
  'and it is the key the directory publishes',
  elsewhere.body.account_key.public_key === aliceKey.publicKey,
)

const secondWs = await connect(elsewhere.cookie!, conversationId, bobId)
const history = await waitFor<any>(secondWs, (e) => e.type === 'history', 'history')
secondWs.close()
const encrypted = history.messages.filter((m: any) => m.enc?.v === 3 && sentIds.includes(m.client_id))
const opened: (string | null)[] = []
for (const message of encrypted) {
  opened.push(
    await openText(
      aliceId,
      elsewherePrivate,
      message.sender_id,
      message.sender_id === aliceId ? aliceKey.publicKey : bobKey.publicKey,
      conversationId,
      message.client_id,
      message.body,
      message.enc,
    ),
  )
}
check(
  'every message this run sent is in the history',
  encrypted.length === secrets.length,
  encrypted.length,
)
check(
  'and the new browser opens all of them',
  opened.length === secrets.length && opened.every((text, i) => text === secrets[i]),
  opened,
)
// The placeholder this whole plan exists to delete: there is no message in this
// thread that a browser holding the account key cannot open.
check('none of them came back unreadable', opened.every((text) => text !== null))

// A wrong password derives a wrapping key that opens nothing, which is what
// "no recovery" means when it is written as an assertion.
const wrong = await derive(`${ALICE.password}-errada`, alice.params)
check(
  'the wrong password unwraps nothing, and there is no other way in',
  !(await opens(wrong.wrapKey)),
)

// Leave the instance as it was found.
const ownerCookie = await signIn(API, OWNER.username, OWNER.password)
if (ownerCookie) {
  for (const id of [aliceId, bobId]) {
    await api(`/api/admin/users/${id}`, { cookie: ownerCookie, method: 'DELETE' })
  }
} else {
  console.log("  note: no owner account, leaving this run's two test accounts behind")
}
d1Execute('DELETE FROM login_attempts;')

console.log(failures === 0 ? '\nphase 17 smoke: all green' : `\nphase 17 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
