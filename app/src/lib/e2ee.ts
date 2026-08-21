// End-to-end encryption: the whole of it, on the only side that holds keys.
//
// The shape, in one paragraph. Each message gets a fresh random content key.
// That key encrypts the payload (and, when there is one, the bucket object
// under a second IV). The content key is then wrapped once per device allowed
// to read the message — the peer's devices, plus this account's own others, or
// the desktop could not read what the phone just sent. Wrapping uses ECDH
// between the sender's device key and each recipient device key, run through
// HKDF. The server stores the ciphertext and the wrapped keys and can open
// none of it: it never sees a private key, and the content key only ever
// exists wrapped.
//
// The payload is a small JSON object rather than a bare string, so one
// encrypted shape covers every message type: `{t}` for text and emoji, `{s}`
// for a sticker id, `{m, t?}` for media. That also means the real MIME of an
// attachment is inside the ciphertext — the server learns image-vs-video from
// the size cap it has to apply, and nothing finer.
//
// What this does not do, stated plainly because the difference matters: there
// is no forward secrecy. ECDH here is static, so a device key that leaks opens
// the messages that device could read. Retention already bounds that to seven
// days, which is why a ratchet is not worth its complexity here — but it is a
// weaker property than Signal's, and docs/architecture.md says so too.
//
// And the part no code can fix: the server publishes the device directory, so
// it could add a device of its own to somebody's list. `safetyNumber` is what
// closes that, by making the directory comparable out of band.
//
// One more thing the ciphertext has to say, and the reason for `v: 2`. AES-GCM
// authenticates what it encrypts and nothing else, so a v1 envelope was a
// sealed box with no address on it: the server could take a message Alice sent
// Bob and hand it back to Bob inside a different conversation, or attributed to
// somebody else. Bob's client would unwrap it — the content key really is
// wrapped for his device — and render it under whatever name the frame claimed.
// No plaintext leaks that way, but forged context is its own kind of lie.
//
// So the address goes into the AEAD's additional data (`messageAad`): the
// conversation, the sending account, the sending device, and the client id of
// this particular message. None of it is encrypted and none of it needs to be —
// the server already knows all four. What it cannot do is change any of them,
// because the tag stops verifying and `openMessage` returns null.
//
// The client id is the part that stops a replay. Without it the binding says
// "somewhere in this conversation, from this person", which a message that
// really was sent here already satisfies — so the server could serve the same
// envelope again as a new message and it would open. With it, an envelope
// authenticates as exactly one message. The id is the sender's own random
// UUID, already on the wire because the Durable Object dedups on it.
//
// A v1 envelope has no such binding and is opened without it, which is what
// keeps the seven days of history sent before this shipped readable; after that
// window nothing on the instance is v1 any more.

// Type-only, and deliberately: with no value import from `./api` this module
// pulls in no `import.meta.env`, no `fetch` and no bundler, which is what lets
// worker/scripts/smoke-phase16.ts run the real thing under Node and check it
// against an independent implementation of the same format. The directory —
// the part that does need the network — lives in ./deviceDirectory.
import type { PublicDevice } from './api'
import {
  base64url,
  fromBase64url,
  importPublicKey,
  type DeviceIdentity,
} from './deviceKeys'
import type { EncEnvelope } from './protocol'

/** The decrypted contents of a message. Every field is optional by type. */
export interface Payload {
  /** Text, or a media caption. */
  t?: string
  /** Sticker asset id. */
  s?: string
  /** Real MIME of the attachment — the server only ever saw a generic one. */
  m?: string
}

/**
 * Where a message sits, which is what its ciphertext is bound to.
 *
 * Both fields are things the sender knows without asking anybody and the
 * recipient already has in hand before it decrypts — the thread it opened, and
 * the `sender_id` on the frame. Neither is a secret; the point is only that
 * neither can be changed after the fact.
 */
export interface MessageContext {
  /** The conversation the message belongs to. */
  conversationId: string
  /** The account that sent it — the frame's `sender_id`. */
  senderId: string
  /**
   * The sender's own id for this message, unique per message and already on
   * the wire. This is the field that makes the binding name *one* message
   * rather than a conversation, which is the difference between "cannot be
   * moved" and "cannot be moved or repeated".
   */
  clientId: string
}

const AES = { name: 'AES-GCM', length: 256 } as const
const WRAP_INFO = new TextEncoder().encode('goodchat-v1-wrap')

/** The envelope version this build seals. See the note at the top of the file. */
export const ENVELOPE_VERSION = 2

/**
 * The additional data every v2 ciphertext is authenticated under.
 *
 * Joined with `|`, which is unambiguous here rather than by luck: a
 * conversation id is hex, account and message ids are UUIDs and a device id is
 * 32 hex characters, so none of the four can contain the separator or be
 * confused with its neighbour. The literal prefix carries the version, so a v1
 * envelope cannot be replayed as a v2 one or the reverse.
 */
export function messageAad(context: MessageContext, senderDevice: string): Uint8Array {
  return new TextEncoder().encode(
    [
      'goodchat-v2',
      context.conversationId,
      context.senderId,
      senderDevice,
      context.clientId,
    ].join('|'),
  )
}

export function randomIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12))
}

export function createContentKey(): Promise<CryptoKey> {
  // Extractable: the content key has to be exported to be wrapped for each
  // recipient. It never leaves this function's callers in the clear.
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt'])
}

/**
 * `aad` is optional because the two callers differ. A message body passes one
 * and is therefore bound to its conversation; a bucket object does not, and
 * does not need to be — the only way to reach its content key is through the
 * body that names it, so an attachment inherits whatever binding that body has.
 * Moving a media message to another conversation fails at the body, before
 * anything is ever fetched from the bucket.
 */
export async function encryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  bytes: BufferSource,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    bytes,
  )
  return new Uint8Array(out)
}

export async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  bytes: BufferSource,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    bytes,
  )
  return new Uint8Array(out)
}

/**
 * The key that wraps a content key for one (sender device, recipient device)
 * pair.
 *
 * The HKDF salt is both device ids, sorted, so the same ECDH secret produces a
 * different wrapping key than it would in any other context — and so both
 * sides derive it identically without having to agree who is "first".
 */
async function wrappingKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  aDeviceId: string,
  bDeviceId: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  )
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const salt = new TextEncoder().encode([aDeviceId, bDeviceId].sort().join(':'))
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: WRAP_INFO as BufferSource },
    material,
    AES,
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts `payload` under `contentKey` and wraps that key for every device in
 * `recipients`. Returns what goes on the wire.
 *
 * `recipients` must already include this device — `sealMessage` adds it if the
 * caller forgot, because a message this device cannot read is never what
 * anybody meant, and the Durable Object rejects an envelope shaped that way.
 *
 * `context` is a required parameter rather than an optional one on purpose:
 * every call site had to be visited when it was added, and a future one cannot
 * quietly seal a message that is bound to nothing.
 */
export async function sealMessage(
  identity: DeviceIdentity,
  context: MessageContext,
  recipients: readonly PublicDevice[],
  payload: Payload,
  contentKey: CryptoKey,
  mediaIv?: Uint8Array,
  /** Set for a chunked object; absent keeps the whole-object shape. */
  mediaChunk?: number,
): Promise<{ body: string; enc: EncEnvelope }> {
  const iv = randomIv()
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const aad = messageAad(context, identity.id)
  const body = base64url(await encryptBytes(contentKey, iv, plaintext as BufferSource, aad))

  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const targets = recipients.some((device) => device.id === identity.id)
    ? recipients
    : [...recipients, { id: identity.id, public_key: identity.publicKey } as PublicDevice]

  const keys: EncEnvelope['keys'] = {}
  for (const device of targets) {
    try {
      const peerKey = await importPublicKey(device.public_key)
      const wrapKey = await wrappingKey(identity.privateKey, peerKey, identity.id, device.id)
      const wrapIv = randomIv()
      keys[device.id] = {
        iv: base64url(wrapIv),
        ct: base64url(await encryptBytes(wrapKey, wrapIv, raw)),
      }
    } catch {
      // One unusable public key in the directory must not cost everybody else
      // the message. That device simply cannot read this one.
    }
  }

  return {
    body,
    enc: {
      v: ENVELOPE_VERSION,
      iv: base64url(iv),
      sender_device: identity.id,
      keys,
      ...(mediaIv ? { media_iv: base64url(mediaIv) } : {}),
      ...(mediaIv && mediaChunk ? { media_chunk: mediaChunk } : {}),
    },
  }
}

/**
 * Whether this envelope carries a content key for `deviceId` at all.
 *
 * Split out of `openMessage` so the caller can tell "this message was never
 * addressed to this browser" — the ordinary case for anything sent before it
 * registered — from "it was, and it did not open", which is not ordinary at
 * all. Both used to arrive as the same null and be rendered with the same
 * sentence.
 */
export function isAddressedTo(enc: EncEnvelope, deviceId: string): boolean {
  return deviceId in enc.keys
}

/**
 * Whose public key opens the content key for `deviceId` — the sender, or the
 * device of this account that handed the message over afterwards.
 *
 * Returns null when the envelope holds nothing for this device at all, which
 * the caller renders as `not-addressed`.
 */
export function unwrapsVia(enc: EncEnvelope, deviceId: string): string | null {
  const wrapped = enc.keys[deviceId]
  if (!wrapped) return null
  return wrapped.via ?? enc.sender_device
}

/**
 * Wraps an already-open content key for another device of the *same* account,
 * so a browser somebody just signed into can read what arrived before it
 * existed.
 *
 * This is the only place a content key is wrapped by somebody other than the
 * message's sender, and it is why `via` exists: the wrap is under ECDH between
 * this device and the target, not between the sender and the target, because
 * the sender's private key is not here and never will be.
 *
 * It hands over read access to messages, so it is gated on the person saying
 * yes (screens/ThreadScreen.tsx) rather than happening because a device
 * appeared. A session token that can register a device would otherwise be a
 * session token that can pull down the whole retention window.
 */
export async function rewrapFor(
  identity: DeviceIdentity,
  target: PublicDevice,
  contentKey: CryptoKey,
): Promise<{ iv: string; ct: string; via: string }> {
  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const targetKey = await importPublicKey(target.public_key)
  const wrapKey = await wrappingKey(identity.privateKey, targetKey, identity.id, target.id)
  const iv = randomIv()
  return {
    iv: base64url(iv),
    ct: base64url(await encryptBytes(wrapKey, iv, raw)),
    via: identity.id,
  }
}

/**
 * Opens a message addressed to this device. Returns the payload and the content
 * key, because a media message needs the same key to decrypt its object.
 *
 * Null covers three different, all expected, situations: the message predates
 * this device (no wrapped key for it), the sender's device is no longer in the
 * directory, or the ciphertext does not authenticate. The caller renders a
 * placeholder rather than treating any of them as an error.
 */
export async function openMessage(
  identity: DeviceIdentity,
  context: MessageContext,
  senderPublicKey: string,
  body: string,
  enc: EncEnvelope,
): Promise<{ payload: Payload; contentKey: CryptoKey } | null> {
  const wrapped = enc.keys[identity.id]
  if (!wrapped) return null
  try {
    const senderKey = await importPublicKey(senderPublicKey)
    const wrapKey = await wrappingKey(
      identity.privateKey,
      senderKey,
      identity.id,
      enc.sender_device,
    )
    const raw = await decryptBytes(
      wrapKey,
      fromBase64url(wrapped.iv),
      fromBase64url(wrapped.ct) as BufferSource,
    )
    const contentKey = await crypto.subtle.importKey('raw', raw as BufferSource, AES, true, [
      'encrypt',
      'decrypt',
    ])
    // v1 predates the binding and is opened without it. Not a fallback the
    // caller can be talked into: the version is inside the envelope the server
    // stores, but downgrading a v2 message to v1 means re-encrypting a body
    // whose key the server does not have. The worst it buys is replaying an
    // envelope that was already unbound when it was written — and retention
    // ends that seven days after this ships.
    const plaintext = await decryptBytes(
      contentKey,
      fromBase64url(enc.iv),
      fromBase64url(body) as BufferSource,
      enc.v === 1 ? undefined : messageAad(context, enc.sender_device),
    )
    return { payload: JSON.parse(new TextDecoder().decode(plaintext)) as Payload, contentKey }
  } catch {
    return null
  }
}

// --- media, in chunks -----------------------------------------------------
//
// A bucket object used to be one AES-GCM ciphertext. That authenticates the
// whole thing at once, which sounds like the strong choice and costs more than
// it buys: nothing can be believed until the last byte arrives, so a video
// downloads in full before the first frame plays and seeking is impossible.
// Thirty-two megabytes over a bad connection is a blank rectangle and a wait.
//
// So the object is a sequence of independently sealed chunks — the STREAM
// construction, the same shape age and Tink use. Each chunk is AES-GCM under
// the same content key, and what keeps it from being reorderable is the nonce:
//
//   8 bytes random prefix | 3 bytes chunk index | 1 byte final flag
//
// The prefix is per object, so no two objects share a nonce. The index means a
// chunk decrypts only at the position it was written to, which makes reordering
// and duplication fail. The final flag is the one that matters most and is the
// easiest to leave out: without it an attacker could serve the first half of a
// video and it would authenticate perfectly, just ending early. Only the last
// chunk is sealed with the flag set, so a truncated object fails at its new
// last chunk instead of looking complete.
//
// The layout is fixed-size, so byte ranges are arithmetic rather than an index:
// chunk `i` of ciphertext starts at `i * (chunkSize + 16)`, the 16 being the
// GCM tag. That is what lets a Range request for the middle of a video turn
// into a Range request for the chunks covering it.

/** Plaintext bytes per chunk. */
export const MEDIA_CHUNK_BYTES = 256 * 1024
/** AES-GCM tag, appended to each chunk's ciphertext. */
export const GCM_TAG_BYTES = 16

/** Random per-object nonce prefix. Travels in the envelope as `media_iv`. */
export function randomChunkPrefix(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8))
}

/**
 * The nonce for one chunk. Index is big-endian in three bytes, which covers
 * 2^24 chunks — four terabytes at the size above, against a 32MB upload cap.
 */
export function chunkNonce(prefix: Uint8Array, index: number, final: boolean): Uint8Array {
  const nonce = new Uint8Array(12)
  nonce.set(prefix.subarray(0, 8), 0)
  nonce[8] = (index >>> 16) & 0xff
  nonce[9] = (index >>> 8) & 0xff
  nonce[10] = index & 0xff
  nonce[11] = final ? 1 : 0
  return nonce
}

/** How many chunks a plaintext of this size becomes. Zero bytes is one chunk. */
export function chunkCount(plaintextBytes: number, chunkSize = MEDIA_CHUNK_BYTES): number {
  return Math.max(1, Math.ceil(plaintextBytes / chunkSize))
}

/** How many chunks an object of `ciphertextBytes` was written as. */
export function sealedChunkCount(ciphertextBytes: number, chunkSize = MEDIA_CHUNK_BYTES): number {
  return Math.max(1, Math.ceil(ciphertextBytes / (chunkSize + GCM_TAG_BYTES)))
}

/** Plaintext length of an object stored as `ciphertextBytes` of chunks. */
export function plaintextLength(ciphertextBytes: number, chunkSize = MEDIA_CHUNK_BYTES): number {
  const sealed = chunkSize + GCM_TAG_BYTES
  const whole = Math.floor(ciphertextBytes / sealed)
  const remainder = ciphertextBytes - whole * sealed
  return whole * chunkSize + Math.max(0, remainder - GCM_TAG_BYTES)
}

/** Seals a whole object. What the upload puts in the bucket. */
export async function encryptChunked(
  key: CryptoKey,
  prefix: Uint8Array,
  bytes: Uint8Array,
  chunkSize = MEDIA_CHUNK_BYTES,
): Promise<Uint8Array> {
  const total = chunkCount(bytes.length, chunkSize)
  const out = new Uint8Array(bytes.length + total * GCM_TAG_BYTES)
  let offset = 0
  for (let index = 0; index < total; index++) {
    const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
    const sealed = await encryptBytes(
      key,
      chunkNonce(prefix, index, index === total - 1),
      slice as BufferSource,
    )
    out.set(sealed, offset)
    offset += sealed.length
  }
  return out
}

/**
 * Opens a run of chunks starting at `firstIndex`.
 *
 * `totalChunks` is what tells this function which chunk is the last one, and it
 * has to come from the object's full length rather than from the bytes in hand
 * — otherwise a truncated response would look like a complete one that simply
 * ended, which is the exact attack the final flag exists to stop.
 */
export async function decryptChunks(
  key: CryptoKey,
  prefix: Uint8Array,
  ciphertext: Uint8Array,
  firstIndex: number,
  totalChunks: number,
  chunkSize = MEDIA_CHUNK_BYTES,
): Promise<Uint8Array> {
  const sealedSize = chunkSize + GCM_TAG_BYTES
  const parts: Uint8Array[] = []
  let length = 0
  for (let offset = 0; offset < ciphertext.length; offset += sealedSize) {
    const index = firstIndex + parts.length
    const slice = ciphertext.subarray(offset, Math.min(offset + sealedSize, ciphertext.length))
    const plain = await decryptBytes(
      key,
      chunkNonce(prefix, index, index === totalChunks - 1),
      slice as BufferSource,
    )
    parts.push(plain)
    length += plain.length
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// --- safety numbers -------------------------------------------------------

/**
 * A number both sides can read out loud to check they are talking through the
 * same keys.
 *
 * Derived from the two device directories rather than from a single identity
 * key, because identity here is per device: the number therefore changes when
 * either side adds or loses a device, which is the honest behaviour — a new
 * device really is a new party that can read the conversation, whether it
 * belongs to the peer or to the server pretending to be them.
 *
 * Sixty digits in twelve groups of five, the Signal shape, because it is a
 * format people have some chance of comparing without losing their place.
 */
/**
 * A short digest of one side's device set, for "did this change since I last
 * looked". Not the safety number: that one mixes both sides and is meant to be
 * read out loud.
 */
export async function devicesFingerprint(devices: readonly PublicDevice[]): Promise<string> {
  const material = [...devices].map((device) => device.id).sort().join('|')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function safetyNumber(
  a: readonly PublicDevice[],
  b: readonly PublicDevice[],
): Promise<string> {
  const fingerprint = (devices: readonly PublicDevice[]) =>
    [...devices]
      .map((device) => device.public_key)
      .sort()
      .join('|')
  // Sorted so both sides hash the same string without agreeing who is first.
  const material = [fingerprint(a), fingerprint(b)].sort().join('||')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  const digits = [...new Uint8Array(digest)]
    .map((byte) => byte.toString().padStart(3, '0'))
    .join('')
    .slice(0, 60)
  return (digits.match(/.{1,5}/g) ?? []).join(' ')
}
