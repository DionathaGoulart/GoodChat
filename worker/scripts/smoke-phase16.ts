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
  GCM_TAG_BYTES,
  chunkCount,
  decryptChunks,
  encryptChunked,
  openMessage,
  plaintextLength,
  randomChunkPrefix,
  rewrapFor,
  safetyNumber,
  sealMessage,
  unwrapsVia,
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

/**
 * The additional data, written from the format description rather than by
 * calling `messageAad` — importing the app's own helper here would make both
 * sides of the comparison the same code, which is the one thing this file
 * exists to avoid.
 */
function referenceAad(context: Context, senderDevice: string): Uint8Array {
  return enc.encode(
    `goodchat-v2|${context.conversationId}|${context.senderId}|${senderDevice}|${context.clientId}`,
  )
}

interface Context {
  conversationId: string
  senderId: string
  clientId: string
}

/** Reference seal — what the app's `openMessage` has to be able to read. */
async function referenceSeal(
  sender: Awaited<ReturnType<typeof makeIdentity>>,
  context: Context,
  recipients: { id: string; public_key: string }[],
  payload: Record<string, string>,
  /** 1 seals the way this format did before the binding — see the v1 check. */
  version: 1 | 2 = 2,
) {
  const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = b64u(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        ...(version === 1 ? {} : { additionalData: referenceAad(context, sender.id) }),
      },
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
  return { body, enc: { v: version, iv: b64u(iv), sender_device: sender.id, keys } }
}

/** Reference open — what the app's `sealMessage` has to produce. */
async function referenceOpen(
  device: Awaited<ReturnType<typeof makeIdentity>>,
  context: Context,
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
      {
        name: 'AES-GCM',
        iv: unb64u(envelope.iv),
        ...(envelope.v === 1
          ? {}
          : { additionalData: referenceAad(context, envelope.sender_device) }),
      },
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

// The three values a v2 body is bound to, in the shapes the real ones have: a
// conversation id is hex, an account id is a UUID. The device id comes out of
// the envelope, so it is not named here.
const ALICE = 'a1000000-0000-4000-8000-0000000a11ce'
const BOB = 'b1000000-0000-4000-8000-00000000b0b0'
const THREAD = '4d1f8c3b9a2e5701'
const OTHER_THREAD = '9e07a5c2b3f81d46'
const MSG = 'e6b1f0d4-0000-4000-8000-000000000001'
const OTHER_MSG = 'e6b1f0d4-0000-4000-8000-000000000002'
const fromBob: Context = { conversationId: THREAD, senderId: BOB, clientId: MSG }
const fromAlice: Context = { conversationId: THREAD, senderId: ALICE, clientId: MSG }

console.log('— the app opens what an independent implementation sealed')

const secret = `cruzado-${Date.now().toString(36)}`
const fromReference = await referenceSeal(
  bobPhone,
  fromBob,
  [alicePhone.asDevice, aliceDesktop.asDevice, bobPhone.asDevice],
  { t: secret },
)

const openedByApp = await openMessage(
  alicePhone as any,
  fromBob,
  bobPhone.publicKey,
  fromReference.body,
  fromReference.enc as any,
)
check("app's openMessage reads it", openedByApp?.payload.t === secret, openedByApp?.payload)

const openedBySecondDevice = await openMessage(
  aliceDesktop as any,
  fromBob,
  bobPhone.publicKey,
  fromReference.body,
  fromReference.enc as any,
)
check("and so does the account's other device", openedBySecondDevice?.payload.t === secret)

const outsider = await makeIdentity()
check(
  'a device not named in the envelope gets null, not a throw',
  (await openMessage(
    outsider as any,
    fromBob,
    bobPhone.publicKey,
    fromReference.body,
    fromReference.enc as any,
  )) === null,
)
check(
  'a tampered ciphertext gets null, not a throw',
  (await openMessage(
    alicePhone as any,
    fromBob,
    bobPhone.publicKey,
    b64u(enc.encode('nao-e-ciphertext')),
    fromReference.enc as any,
  )) === null,
)

console.log('\n— the envelope is bound to where it was sealed')

// The reason `v: 2` exists. Everything below is a *valid* envelope, correctly
// wrapped for the device that is opening it: the only thing wrong is where the
// server put it. Before the binding, all three read as the original message.
check(
  'the same envelope in another conversation does not open',
  (await openMessage(
    alicePhone as any,
    { ...fromBob, conversationId: OTHER_THREAD },
    bobPhone.publicKey,
    fromReference.body,
    fromReference.enc as any,
  )) === null,
)
check(
  'nor does it when attributed to another account',
  (await openMessage(
    alicePhone as any,
    { ...fromBob, senderId: ALICE },
    bobPhone.publicKey,
    fromReference.body,
    fromReference.enc as any,
  )) === null,
)
// The replay case, and the reason the client id is in there. Everything about
// this envelope is genuine — right conversation, right sender, right device —
// and it is the same message served a second time under a new id. Without the
// client id in the binding it opens, and the thread shows it twice.
check(
  'nor does the same envelope served again as a different message',
  (await openMessage(
    alicePhone as any,
    { ...fromBob, clientId: OTHER_MSG },
    bobPhone.publicKey,
    fromReference.body,
    fromReference.enc as any,
  )) === null,
)
check(
  'and the reference implementation agrees on all three',
  (await referenceOpen(
    alicePhone,
    { ...fromBob, conversationId: OTHER_THREAD },
    bobPhone.publicKey,
    fromReference.body,
    fromReference.enc,
  )) === null &&
    (await referenceOpen(
      alicePhone,
      { ...fromBob, clientId: OTHER_MSG },
      bobPhone.publicKey,
      fromReference.body,
      fromReference.enc,
    )) === null,
)
check(
  'the untouched context still opens it — the binding is not just breaking things',
  (
    await openMessage(
      alicePhone as any,
      fromBob,
      bobPhone.publicKey,
      fromReference.body,
      fromReference.enc as any,
    )
  )?.payload.t === secret,
)

// The seven-day tail: a message sealed before this shipped carries no binding
// and has to stay readable until retention removes it. It is also, necessarily,
// still movable — which is the cost of not breaking a week of history, and ends
// on its own.
const legacy = await referenceSeal(bobPhone, fromBob, [alicePhone.asDevice], { t: secret }, 1)
check('a v1 envelope is still opened', legacy.enc.v === 1)
check(
  'and it opens, because v1 was never bound to anything',
  (await openMessage(alicePhone as any, fromBob, bobPhone.publicKey, legacy.body, legacy.enc as any))
    ?.payload.t === secret,
)

console.log('\n— an independent implementation opens what the app sealed')

const contentKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const reply = `resposta-${Date.now().toString(36)}`
const fromApp = await sealMessage(
  alicePhone as any,
  fromAlice,
  [bobPhone.asDevice, aliceDesktop.asDevice],
  { t: reply },
  contentKey,
)
check('the app seals v2', fromApp.enc.v === 2, fromApp.enc.v)
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
  fromAlice,
  alicePhone.publicKey,
  fromApp.body,
  fromApp.enc,
)
check('the reference implementation reads it', openedByReference?.t === reply, openedByReference)

// The round trip that would hide a pair of cancelling mistakes if it were the
// only assertion here — kept because it is also the one the app actually runs.
const roundTrip = await openMessage(
  bobPhone as any,
  fromAlice,
  alicePhone.publicKey,
  fromApp.body,
  fromApp.enc,
)
check('and so does the app itself', roundTrip?.payload.t === reply)

console.log('\n— media rides the same content key')

const picture = enc.encode('bytes-da-imagem')
const mediaIv = crypto.getRandomValues(new Uint8Array(12))
const sealedPicture = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv: mediaIv }, contentKey, picture),
)
const mediaMessage = await sealMessage(
  alicePhone as any,
  fromAlice,
  [bobPhone.asDevice],
  { m: 'image/webp' },
  contentKey,
  mediaIv,
)
check('the envelope carries the object IV', mediaMessage.enc.media_iv === b64u(mediaIv))
const openedMedia = await openMessage(
  bobPhone as any,
  fromAlice,
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
// The object itself carries no additional data, and does not need to: its
// content key is only reachable through the body above, so a media message
// moved to another conversation fails there — before anything is fetched.
check(
  'a media envelope in the wrong conversation never yields the key',
  (await openMessage(
    bobPhone as any,
    { ...fromAlice, conversationId: OTHER_THREAD },
    alicePhone.publicKey,
    mediaMessage.body,
    mediaMessage.enc,
  )) === null,
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

// app/public/sw.js carries its own hand-written `wrappingKey` and `messageAad`,
// because a service worker has no bundler and cannot import lib/e2ee.ts. Two copies of a key derivation is exactly the thing that drifts
// silently — the failure mode is "push previews are always generic", which
// nobody reports as a bug. So the file is executed here, in a sandbox that
// gives it the globals a worker would have, and asked to decrypt something the
// app sealed.
//
// It now reads the message back through /api/conversations instead of being
// handed the ciphertext in the push, so the sandbox has to answer that request.
const swSource = await readFile(new URL('../../app/public/sw.js', import.meta.url), 'utf8')

const PREVIEW_MSG = 'f00dcafe-0000-4000-8000-00000000feed'
const previewContext: Context = { conversationId: THREAD, senderId: BOB, clientId: PREVIEW_MSG }
const previewPayload = await sealMessage(
  bobPhone as any,
  previewContext,
  [alicePhone.asDevice],
  { t: secret },
  await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
)

/** What GET /api/conversations returns, trimmed to what the worker reads. */
function conversationsResponse(overrides: Record<string, unknown> = {}) {
  return {
    conversations: [
      {
        id: THREAD,
        peer_devices: [bobPhone.asDevice],
        last_message: {
          id: PREVIEW_MSG,
          client_id: PREVIEW_MSG,
          sender_id: BOB,
          body: previewPayload.body,
          enc: previewPayload.enc,
          ...overrides,
        },
      },
    ],
  }
}

let conversationsBody = conversationsResponse()
/** Stands in for the bucket while the range tests run. */
let mediaObject: { url: string; bytes: Uint8Array } | null = null

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
  // Same-origin, cookie-authenticated in a real worker; here it just answers.
  // The media half honours Range the way the bucket proxy does, because that
  // is the contract `serveRange` is written against.
  fetch: async (input: string, init?: { headers?: Record<string, string> }) => {
    if (String(input).startsWith('/api/conversations')) {
      return { ok: true, json: async () => conversationsBody }
    }
    if (mediaObject && String(input) === mediaObject.url) {
      const header = init?.headers?.Range ?? ''
      const match = /bytes=(\d+)-(\d*)/.exec(header)
      const from = match ? Number(match[1]) : 0
      const to = match && match[2] ? Number(match[2]) : mediaObject.bytes.length - 1
      const slice = mediaObject.bytes.subarray(from, to + 1)
      return {
        ok: true,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-range'
              ? `bytes ${from}-${to}/${mediaObject!.bytes.length}`
              : null,
        },
        arrayBuffer: async () => slice.slice().buffer,
      }
    }
    return { ok: false, json: async () => ({}) }
  },
  Headers,
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
  `${swSource}\n;({ decryptPreview, serveRange, streams })`,
  sandbox,
) as {
  decryptPreview: (ref: unknown) => Promise<string | null>
  serveRange: (request: unknown, mediaKey: string) => Promise<any>
  streams: Map<string, unknown>
}

const swPreview = await swExports.decryptPreview({ conv: THREAD, mid: PREVIEW_MSG })
check('and it decrypts a preview the app sealed', swPreview === secret, swPreview)

check(
  'a push for a message that is no longer the newest shows the generic body',
  (await swExports.decryptPreview({ conv: THREAD, mid: OTHER_MSG })) === null,
)
check(
  'so does a conversation this browser is not in',
  (await swExports.decryptPreview({ conv: OTHER_THREAD, mid: PREVIEW_MSG })) === null,
)

// The worker has its own copy of the additional data, and it is the copy most
// likely to drift: nothing in the app fails when it does, the notification just
// quietly goes generic. Both bound fields are checked by editing what the API
// hands back, which is what a server in the middle would be able to do.
conversationsBody = conversationsResponse({ sender_id: ALICE })
check(
  'a message whose sender was rewritten in flight goes generic',
  (await swExports.decryptPreview({ conv: THREAD, mid: PREVIEW_MSG })) === null,
)
conversationsBody = conversationsResponse({ client_id: OTHER_MSG })
check(
  'and so does one whose message id was',
  (await swExports.decryptPreview({ conv: THREAD, mid: PREVIEW_MSG })) === null,
)
conversationsBody = conversationsResponse()
check(
  'the untouched payload still previews — the binding is not just breaking things',
  (await swExports.decryptPreview({ conv: THREAD, mid: PREVIEW_MSG })) === secret,
)

console.log('\n— media sealed in chunks, so a video can start before it ends')

// A small chunk size so a handful of kilobytes exercises the boundaries a real
// 32MB upload would. Everything below is about the nonce: prefix, index, final
// flag. Get any of the three wrong and the format still round-trips with
// itself, which is why each one is attacked separately here rather than trusted
// because the happy path works.
const CHUNK = 64
const clip = crypto.getRandomValues(new Uint8Array(CHUNK * 3 + 17))
const clipKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const prefix = randomChunkPrefix()
const sealedClip = await encryptChunked(clipKey, prefix, clip, CHUNK)
const clipChunks = chunkCount(clip.length, CHUNK)

check('four chunks for three and a bit', clipChunks === 4, clipChunks)
check(
  'ciphertext is the plaintext plus one tag per chunk',
  sealedClip.length === clip.length + clipChunks * GCM_TAG_BYTES,
  sealedClip.length,
)
check(
  'and the plaintext length is recoverable from the ciphertext length alone',
  plaintextLength(sealedClip.length, CHUNK) === clip.length,
  plaintextLength(sealedClip.length, CHUNK),
)

const wholeClip = await decryptChunks(clipKey, prefix, sealedClip, 0, clipChunks, CHUNK)
check(
  'the whole object round-trips',
  Buffer.from(wholeClip).equals(Buffer.from(clip)),
)

// The point of the format: a range in the middle, without the bytes around it.
const sealedSize = CHUNK + GCM_TAG_BYTES
const middle = await decryptChunks(
  clipKey,
  prefix,
  sealedClip.subarray(sealedSize, sealedSize * 3),
  1,
  clipChunks,
  CHUNK,
)
check(
  'two chunks from the middle open on their own — this is what seeking needs',
  Buffer.from(middle).equals(Buffer.from(clip.subarray(CHUNK, CHUNK * 3))),
)

// Reordering: chunk 1's bytes offered as chunk 2.
check(
  'a chunk does not open at another chunk\'s index',
  await (async () => {
    try {
      await decryptChunks(clipKey, prefix, sealedClip.subarray(sealedSize, sealedSize * 2), 2, clipChunks, CHUNK)
      return false
    } catch {
      return true
    }
  })(),
)

// Truncation: the first three chunks served as if that were the whole object.
// Without the final flag this authenticates perfectly and the video just ends
// early, which is the failure the flag exists to prevent.
check(
  'a truncated object fails instead of ending early',
  await (async () => {
    try {
      await decryptChunks(clipKey, prefix, sealedClip.subarray(0, sealedSize * 3), 0, 3, CHUNK)
      return false
    } catch {
      return true
    }
  })(),
)
check(
  'and the same bytes open fine when they are not claimed to be the whole object',
  Buffer.from(
    await decryptChunks(clipKey, prefix, sealedClip.subarray(0, sealedSize * 3), 0, clipChunks, CHUNK),
  ).equals(Buffer.from(clip.subarray(0, CHUNK * 3))),
)

// A different object's prefix, same key: no chunk opens.
check(
  'another object\'s nonce prefix opens nothing',
  await (async () => {
    try {
      await decryptChunks(clipKey, randomChunkPrefix(), sealedClip, 0, clipChunks, CHUNK)
      return false
    } catch {
      return true
    }
  })(),
)

console.log('\n— the service worker serves a video a range at a time')

// The arithmetic that turns a plaintext range into a ciphertext range is the
// part of this that can be wrong without anything looking wrong: an off-by-one
// on a chunk boundary produces a video that plays and stutters, or one that
// seeks to the wrong second. So the worker's own handler is driven here with a
// sealed object and asked for ranges across the boundaries.
const CLIP_CHUNK = 64
const video = crypto.getRandomValues(new Uint8Array(CLIP_CHUNK * 4 + 5))
const videoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
  'encrypt',
  'decrypt',
])
const videoPrefix = randomChunkPrefix()
const sealedVideo = await encryptChunked(videoKey, videoPrefix, video, CLIP_CHUNK)

// The bucket, as far as the worker is concerned: a URL that honours Range.
mediaObject = { url: 'https://bucket.invalid/clip', bytes: sealedVideo }

swExports.streams.set('media/clip', {
  contentKey: videoKey,
  prefix: unb64u(b64u(videoPrefix)),
  chunk: CLIP_CHUNK,
  mime: 'video/mp4',
  url: 'https://bucket.invalid/clip',
})

async function rangeOf(header: string | null) {
  const response = await swExports.serveRange(
    { headers: { get: (name: string) => (name.toLowerCase() === 'range' ? header : null) } },
    'media/clip',
  )
  return {
    status: response.status,
    contentRange: response.headers.get('Content-Range'),
    bytes: new Uint8Array(await response.arrayBuffer()),
  }
}

const opening = await rangeOf('bytes=0-')
check('an opening request gets the whole plaintext', opening.status === 206, opening.status)
check(
  'and it is the original bytes, not the ciphertext',
  Buffer.from(opening.bytes).equals(Buffer.from(video)),
)
check(
  'with a Content-Range naming the plaintext length',
  opening.contentRange === `bytes 0-${video.length - 1}/${video.length}`,
  opening.contentRange,
)

// A seek into the middle, deliberately not on a chunk boundary — the worker has
// to fetch the chunks covering it and then trim to exactly what was asked.
const seek = await rangeOf(`bytes=${CLIP_CHUNK + 7}-${CLIP_CHUNK * 3 + 2}`)
check(
  'a seek across chunk boundaries returns exactly the requested bytes',
  Buffer.from(seek.bytes).equals(Buffer.from(video.subarray(CLIP_CHUNK + 7, CLIP_CHUNK * 3 + 3))),
  { got: seek.bytes.length, want: CLIP_CHUNK * 2 - 4 },
)
check(
  'and says so',
  seek.contentRange === `bytes ${CLIP_CHUNK + 7}-${CLIP_CHUNK * 3 + 2}/${video.length}`,
  seek.contentRange,
)

// The tail, which is the chunk sealed with the final flag set.
const tail = await rangeOf(`bytes=${video.length - 3}-`)
check(
  'the last bytes come back too — the final chunk opens at its own index',
  Buffer.from(tail.bytes).equals(Buffer.from(video.subarray(video.length - 3))),
)

const past = await rangeOf(`bytes=${video.length}-`)
check('a range past the end is a 416, not a decrypt failure', past.status === 416, past.status)

console.log(failures === 0 ? '\nphase 16 smoke: all green' : `\nphase 16 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
