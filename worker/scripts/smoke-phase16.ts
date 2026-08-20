// Phase 16 smoke: the app's own encryption code, executed.
//
// Phase 15 proves the wire format by implementing it a second time and talking
// to the Worker. What it deliberately does *not* do is run a single line of
// app/src/lib/e2ee.ts — so a client that compiles, typechecks and is completely
// wrong would pass it. This closes that: it imports the real module and checks
// it against phase 15's independent implementation, in both directions.
//
// Both directions matter and they fail differently. If only the app sealed and
// only the app opened, two mistakes that cancel out would look like success —
// which is exactly what a test that calls one implementation twice cannot see.
// Here the app opens what the reference sealed, and the reference opens what the
// app sealed, so a wrong salt, a swapped id order or a different HKDF info
// shows up as a decryption failure rather than as a green run.
//
// app/public/sw.js is covered too, at the end: it carries its own hand-written
// copy of the key derivation, because a service worker has no bundler and
// cannot import lib/e2ee.ts. Two copies of a derivation drift, and this one
// drifts silently — a mismatch shows up as "push previews are always generic",
// which nobody reports. So the file is evaluated in a sandbox with a worker's
// globals and asked to decrypt something the app sealed.
//
// What is still not covered, named here so nobody reads this file as more than
// it is: the React wiring in hooks/useConversation.ts, and the IndexedDB
// storage in lib/deviceKeys.ts. Those need a browser.
//
// Usage: npm run smoke:phase16   (no server needed — this is pure crypto)

import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import {
  openMessage,
  safetyNumber,
  sealMessage,
  devicesFingerprint,
} from '../../app/src/lib/e2ee.ts'

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

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    'base64url',
  )
}
function unb64u(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'))
}

/** The shape lib/deviceKeys.ts stores, built here without IndexedDB. */
async function makeIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
  const digest = await crypto.subtle.digest('SHA-256', raw)
  const id = Buffer.from(new Uint8Array(digest).slice(0, 16)).toString('hex')
  return {
    id,
    publicKey: b64u(raw),
    privateKey: pair.privateKey,
    createdAt: Date.now(),
    /** How the directory publishes it. */
    asDevice: { id, public_key: b64u(raw), created_at: 0, last_seen_at: 0 },
  }
}

// --- the reference implementation, verbatim from phase 15 -----------------

function importPublic(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    unb64u(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}

async function wrappingKey(privateKey: CryptoKey, peerPublic: CryptoKey, a: string, b: string) {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublic }, privateKey, 256)
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

/** Reference seal — what the app's `openMessage` has to be able to read. */
async function referenceSeal(
  sender: Awaited<ReturnType<typeof makeIdentity>>,
  recipients: { id: string; public_key: string }[],
  payload: Record<string, string>,
) {
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = b64u(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      contentKey,
      enc.encode(JSON.stringify(payload)),
    ),
  )
  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const keys: Record<string, { iv: string; ct: string }> = {}
  for (const device of recipients) {
    const wrapKey = await wrappingKey(
      sender.privateKey,
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
  return { body, enc: { v: 1 as const, iv: b64u(iv), sender_device: sender.id, keys } }
}

/** Reference open — what the app's `sealMessage` has to produce. */
async function referenceOpen(
  device: Awaited<ReturnType<typeof makeIdentity>>,
  senderPublicKey: string,
  body: string,
  envelope: any,
): Promise<Record<string, string> | null> {
  const wrapped = envelope.keys[device.id]
  if (!wrapped) return null
  try {
    const wrapKey = await wrappingKey(
      device.privateKey,
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
    return JSON.parse(dec.decode(plain))
  } catch {
    return null
  }
}

// --- the run --------------------------------------------------------------

console.log('--- phase 16: the app\'s own crypto, executed ---\n')

const alicePhone = await makeIdentity()
const aliceDesktop = await makeIdentity()
const bobPhone = await makeIdentity()

console.log('— the app opens what an independent implementation sealed')

const secret = `cruzado-${Date.now().toString(36)}`
const fromReference = await referenceSeal(
  bobPhone,
  [alicePhone.asDevice, aliceDesktop.asDevice, bobPhone.asDevice],
  { t: secret },
)

const openedByApp = await openMessage(
  alicePhone as any,
  bobPhone.publicKey,
  fromReference.body,
  fromReference.enc as any,
)
check("app's openMessage reads it", openedByApp?.payload.t === secret, openedByApp?.payload)

const openedBySecondDevice = await openMessage(
  aliceDesktop as any,
  bobPhone.publicKey,
  fromReference.body,
  fromReference.enc as any,
)
check("and so does the account's other device", openedBySecondDevice?.payload.t === secret)

const outsider = await makeIdentity()
check(
  'a device not named in the envelope gets null, not a throw',
  (await openMessage(outsider as any, bobPhone.publicKey, fromReference.body, fromReference.enc as any)) ===
    null,
)
check(
  'a tampered ciphertext gets null, not a throw',
  (await openMessage(
    alicePhone as any,
    bobPhone.publicKey,
    b64u(enc.encode('nao-e-ciphertext')),
    fromReference.enc as any,
  )) === null,
)

console.log('\n— an independent implementation opens what the app sealed')

const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const reply = `resposta-${Date.now().toString(36)}`
const fromApp = await sealMessage(
  alicePhone as any,
  [bobPhone.asDevice, aliceDesktop.asDevice],
  { t: reply },
  contentKey,
)
check(
  "the app's envelope names the sender among its recipients (the DO checks this)",
  fromApp.enc.sender_device in fromApp.enc.keys,
  Object.keys(fromApp.enc.keys),
)
check(
  'and every recipient it was given',
  [bobPhone.id, aliceDesktop.id].every((id) => id in fromApp.enc.keys),
)
const openedByReference = await referenceOpen(
  bobPhone,
  alicePhone.publicKey,
  fromApp.body,
  fromApp.enc,
)
check('the reference implementation reads it', openedByReference?.t === reply, openedByReference)

// The round trip that would hide a pair of cancelling mistakes if it were the
// only assertion here — kept because it is also the one the app actually runs.
const roundTrip = await openMessage(bobPhone as any, alicePhone.publicKey, fromApp.body, fromApp.enc)
check('and so does the app itself', roundTrip?.payload.t === reply)

console.log('\n— media rides the same content key')

const picture = enc.encode('bytes-da-imagem')
const mediaIv = crypto.getRandomValues(new Uint8Array(12))
const sealedPicture = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv: mediaIv }, contentKey, picture),
)
const mediaMessage = await sealMessage(
  alicePhone as any,
  [bobPhone.asDevice],
  { m: 'image/webp' },
  contentKey,
  mediaIv,
)
check('the envelope carries the object IV', mediaMessage.enc.media_iv === b64u(mediaIv))
const openedMedia = await openMessage(
  bobPhone as any,
  alicePhone.publicKey,
  mediaMessage.body,
  mediaMessage.enc,
)
check('the recipient learns the real mime', openedMedia?.payload.m === 'image/webp')
const openedPicture = new Uint8Array(
  await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(mediaMessage.enc.media_iv!) },
    openedMedia!.contentKey,
    sealedPicture,
  ),
)
check(
  'and the key it unwrapped opens the object',
  Buffer.from(openedPicture).equals(Buffer.from(picture)),
)

console.log('\n— the safety number, and the fingerprint behind the banner')

const aliceSide = [alicePhone.asDevice, aliceDesktop.asDevice]
const bobSide = [bobPhone.asDevice]
const a = await safetyNumber(aliceSide, bobSide)
const b = await safetyNumber(bobSide, aliceSide)
check('both sides compute the same number, in either order', a === b, { a, b })
check('it is 12 groups of 5 digits', /^(\d{5} ){11}\d{5}$/.test(a), a)
check(
  'adding a device changes it',
  (await safetyNumber([...aliceSide, outsider.asDevice], bobSide)) !== a,
)
check(
  'device order does not',
  (await safetyNumber([aliceDesktop.asDevice, alicePhone.asDevice], bobSide)) === a,
)

const before = await devicesFingerprint(aliceSide)
check('the fingerprint is stable for the same set', (await devicesFingerprint(aliceSide)) === before)
check(
  'and moves when the set does — which is what raises the banner',
  (await devicesFingerprint([...aliceSide, outsider.asDevice])) !== before,
)

console.log('\n— the service worker\'s copy of the derivation')

// app/public/sw.js carries its own hand-written `wrappingKey` and `deviceIdFor`,
// because a service worker has no bundler and cannot import lib/e2ee.ts. Two
// copies of a key derivation is exactly the thing that drifts silently — the
// failure mode is "push previews are always generic", which nobody reports as a
// bug. So the file is executed here, in a sandbox that gives it the globals a
// worker would have, and asked to decrypt something the app sealed.
const swSource = await readFile(new URL('../../app/public/sw.js', import.meta.url), 'utf8')

const previewPayload = await sealMessage(
  bobPhone as any,
  [alicePhone.asDevice],
  { t: secret },
  await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
)

/** The identity record lib/deviceKeys.ts stores, as IndexedDB would return it. */
const storedIdentity = {
  id: alicePhone.id,
  publicKey: alicePhone.publicKey,
  privateKey: alicePhone.privateKey,
  createdAt: alicePhone.createdAt,
}

function fakeRequest<T>(value: T) {
  const request: any = { result: value, onsuccess: null, onerror: null, transaction: null }
  queueMicrotask(() => request.onsuccess?.())
  return request
}

const sandbox: Record<string, unknown> = {
  crypto,
  atob,
  btoa,
  TextEncoder,
  TextDecoder,
  queueMicrotask,
  console,
  URL,
  Response,
  fetch,
  caches: { open: async () => ({}), keys: async () => [], match: async () => undefined },
  // Enough of a worker for the file to evaluate: it registers listeners at load.
  self: {
    addEventListener: () => {},
    registration: { showNotification: async () => {} },
    clients: {},
    location: { origin: 'http://localhost' },
    __PRECACHE__: [],
  },
  indexedDB: {
    open: () => fakeRequest({
      objectStoreNames: { contains: () => true },
      transaction: () => ({ objectStore: () => ({ getAll: () => fakeRequest([storedIdentity]) }) }),
      close: () => {},
    }),
  },
}

const swExports = runInNewContext(
  `${swSource}\n;({ decryptPreview, deviceIdFor })`,
  sandbox,
) as {
  decryptPreview: (enc: unknown) => Promise<string | null>
  deviceIdFor: (raw: Uint8Array) => Promise<string>
}

check(
  "the worker's deviceIdFor agrees with lib/deviceKeys.ts",
  (await swExports.deviceIdFor(unb64u(bobPhone.publicKey))) === bobPhone.id,
)

const swPreview = await swExports.decryptPreview({
  device: alicePhone.id,
  sender_key: bobPhone.publicKey,
  iv: previewPayload.enc.iv,
  ct: previewPayload.body,
  key: previewPayload.enc.keys[alicePhone.id],
})
check('and it decrypts a preview the app sealed', swPreview === secret, swPreview)

const swWrongDevice = await swExports.decryptPreview({
  device: outsider.id,
  sender_key: bobPhone.publicKey,
  iv: previewPayload.enc.iv,
  ct: previewPayload.body,
  key: previewPayload.enc.keys[alicePhone.id],
})
check(
  'an envelope for another device falls back to the generic body',
  swWrongDevice === null,
  swWrongDevice,
)

console.log(failures === 0 ? '\nphase 16 smoke: all green' : `\nphase 16 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
