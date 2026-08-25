// End-to-end encryption: the whole of it, on the only side that holds keys.
//
// The shape, in one paragraph. Each message gets a fresh random content key.
// That key encrypts the payload (and, when there is one, the bucket object
// under a second IV). The content key is then wrapped twice — once for the
// recipient's account and once for the sender's own, so the person can read
// what they sent. Wrapping uses ECDH between the two account keys
// (lib/accountKeys.ts), run through HKDF. The server stores the ciphertext and
// the two wrapped keys and can open neither: it never sees a private key, and
// the content key only ever exists wrapped.
//
// Twice, and not once per browser. That is the whole of what `v: 3` changed.
// Identity used to be per device, so a message was wrapped once per device a
// person had, a browser they had just signed into held a key no envelope
// named, and there was a handover protocol for passing history between two of
// your own machines while both were online. An account has one key, in every
// browser it signs into, so all of that is gone — and with it
// `[mensagem de antes deste dispositivo]`, which was the visible shape of the
// problem.
//
// The payload is a small JSON object rather than a bare string, so one
// encrypted shape covers every message type: `{t}` for text and emoji, `{s}`
// for a sticker id, `{m, t?}` for media. That also means the real MIME of an
// attachment is inside the ciphertext — the server learns image-vs-video from
// the size cap it has to apply, and nothing finer.
//
// What this does not do, stated plainly because the difference matters: there
// is no forward secrecy. ECDH here is static, so an account key that leaks
// opens every message that account could read. Retention already bounds that
// to seven days, which is why a ratchet is not worth its complexity here — but
// it is a weaker property than Signal's, and docs/architecture.md says so too.
// The account key made that trade wider, not different: what leaks with a
// stolen browser is now the account rather than one device's share of it, and
// the plan says so out loud.
//
// And the part no code can fix: the server publishes the key directory, so it
// could hand out a key of its own in somebody's place. `safetyNumber` is what
// closes that, by making the two keys comparable out of band — and now it is a
// number that changes only when a key really changes, rather than every time
// somebody opened a new browser.
//
// One more thing the ciphertext has to say. AES-GCM authenticates what it
// encrypts and nothing else, so a v1 envelope was a sealed box with no address
// on it: the server could take a message Alice sent Bob and hand it back to Bob
// inside a different conversation, or attributed to somebody else. Bob's client
// would unwrap it — the content key really is wrapped for him — and render it
// under whatever name the frame claimed. No plaintext leaks that way, but
// forged context is its own kind of lie.
//
// So the address goes into the AEAD's additional data (`messageAad`): the
// version, the conversation, the sending account, and the client id of this
// particular message. None of it is encrypted and none of it needs to be — the
// server already knows all four. What it cannot do is change any of them,
// because the tag stops verifying and `openMessage` returns null.
//
// The client id is the part that stops a replay. Without it the binding says
// "somewhere in this conversation, from this person", which a message that
// really was sent here already satisfies — so the server could serve the same
// envelope again as a new message and it would open. With it, an envelope
// authenticates as exactly one message. The id is the sender's own random
// UUID, already on the wire because the Durable Object dedups on it.
//
// The sending *device* used to be in there too, and is not anymore, for the
// same reason the envelope stopped naming devices: there is no such party.
// Opening a v1/v2 message still needs the old binding, and that lives in
// lib/legacyEnvelope.ts — one file, so the day retention makes it dead it is
// one deletion.

// Type-only, and deliberately: with no value import from `./api` this module
// pulls in no `import.meta.env`, no `fetch` and no bundler, which is what lets
// worker/scripts/smoke-phase16.ts run the real thing under Node and check it
// against an independent implementation of the same format. The directory —
// the part that does need the network — lives in ./keyDirectory.
import type { AccountIdentity } from './accountKeys'
import { base64url, fromBase64url } from './kdf'
import type { AccountEnvelope } from './protocol'

/**
 * Imports a published key for `deriveBits`. Here rather than in
 * lib/accountKeys.ts because it is crypto and that module is storage — and
 * because a value import from there would drag IndexedDB into this file, which
 * is what the note above says it does not have.
 */
export function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64url(publicKey) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}

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
export const ENVELOPE_VERSION = 3

/**
 * The additional data every v3 ciphertext is authenticated under.
 *
 * Joined with `|`, which is unambiguous here rather than by luck: a
 * conversation id is hex and account and message ids are UUIDs, so none of the
 * three can contain the separator or be confused with its neighbour. The
 * literal prefix carries the version, so an envelope of one version cannot be
 * replayed as another — which is also what makes dropping the sending device
 * from this list safe rather than merely tidy.
 */
export function messageAad(context: MessageContext): Uint8Array {
  return new TextEncoder().encode(
    ['goodchat-v3', context.conversationId, context.senderId, context.clientId].join('|'),
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
 * The key that wraps a content key for one (sender account, recipient account)
 * pair.
 *
 * The HKDF salt is both account ids, sorted, so the same ECDH secret produces a
 * different wrapping key than it would in any other context — and so both
 * sides derive it identically without having to agree who is "first". When the
 * two ids are the same, which is the entry a sender writes for itself, the
 * salt is that id twice and the ECDH is the key against its own public half:
 * unusual to look at, correct, and the reason a person can read what they sent.
 */
export async function wrappingKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  aId: string,
  bId: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  )
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const salt = new TextEncoder().encode([aId, bId].sort().join(':'))
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: WRAP_INFO as BufferSource },
    material,
    AES,
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Encrypts `payload` under `contentKey` and wraps that key for the recipient's
 * account and for this one. Returns what goes on the wire.
 *
 * `peer` is the other account's published key, or null when it has not
 * published one — a guest that has not finished signing up, or an account that
 * has not rotated yet. Null is not an error and not a silent downgrade either:
 * the caller checks for it and sends plaintext, which the instance may well
 * refuse (`E2EE_REQUIRED`), and refusing is the honest answer.
 *
 * `context` is a required parameter rather than an optional one on purpose:
 * every call site had to be visited when it was added, and a future one cannot
 * quietly seal a message that is bound to nothing.
 */
export async function sealMessage(
  identity: AccountIdentity,
  context: MessageContext,
  peer: { accountId: string; publicKey: string },
  payload: Payload,
  contentKey: CryptoKey,
  mediaIv?: Uint8Array,
  /** Set for a chunked object; absent keeps the whole-object shape. */
  mediaChunk?: number,
): Promise<{ body: string; enc: AccountEnvelope }> {
  const iv = randomIv()
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const aad = messageAad(context)
  const body = base64url(await encryptBytes(contentKey, iv, plaintext as BufferSource, aad))

  const raw = await crypto.subtle.exportKey('raw', contentKey)
  const keys: AccountEnvelope['keys'] = {}

  // The recipient first and this account second, but both unconditionally: a
  // message this account cannot read is never what anybody meant, and the
  // Durable Object rejects an envelope shaped that way. When the peer is this
  // account — which nothing in the product allows, but the loop does not know
  // that — the second write is the same entry twice and costs nothing.
  for (const target of [
    { id: peer.accountId, publicKey: peer.publicKey },
    { id: identity.accountId, publicKey: identity.publicKey },
  ]) {
    const peerKey = await importPublicKey(target.publicKey)
    const wrapKey = await wrappingKey(
      identity.privateKey,
      peerKey,
      identity.accountId,
      target.id,
    )
    const wrapIv = randomIv()
    keys[target.id] = {
      iv: base64url(wrapIv),
      ct: base64url(await encryptBytes(wrapKey, wrapIv, raw)),
    }
  }

  return {
    body,
    enc: {
      v: ENVELOPE_VERSION,
      iv: base64url(iv),
      keys,
      ...(mediaIv ? { media_iv: base64url(mediaIv) } : {}),
      ...(mediaIv && mediaChunk ? { media_chunk: mediaChunk } : {}),
    },
  }
}

/**
 * Opens a message addressed to this account. Returns the payload and the
 * content key, because a media message needs the same key to decrypt its
 * object.
 *
 * `senderPublicKey` is the sending account's published key — the one the
 * directory names for `context.senderId`. There is no longer a second
 * possibility: the handover that could put somebody else's key here died with
 * the device model.
 *
 * Null covers three situations, and none of them is an error the caller should
 * treat as one: the sender's key is not in the directory, the ciphertext does
 * not authenticate, or the envelope was moved and `context` no longer matches
 * what it was sealed against. All three render as a placeholder, which is the
 * right handling for the third too — a message the server relocated is one this
 * account genuinely cannot read.
 */
export async function openMessage(
  identity: AccountIdentity,
  context: MessageContext,
  senderPublicKey: string,
  body: string,
  enc: AccountEnvelope,
): Promise<{ payload: Payload; contentKey: CryptoKey } | null> {
  const wrapped = enc.keys[identity.accountId]
  if (!wrapped) return null
  try {
    const senderKey = await importPublicKey(senderPublicKey)
    const wrapKey = await wrappingKey(
      identity.privateKey,
      senderKey,
      identity.accountId,
      context.senderId,
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
    const plaintext = await decryptBytes(
      contentKey,
      fromBase64url(enc.iv),
      fromBase64url(body) as BufferSource,
      messageAad(context),
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
/**
 * Length of a chunked object's nonce prefix. It is also what tells the two
 * media formats apart from the outside: a whole-object `media_iv` is a full
 * twelve-byte AES-GCM IV (`randomIv`), a chunked one is these eight bytes.
 */
export const CHUNK_PREFIX_BYTES = 8

/** Random per-object nonce prefix. Travels in the envelope as `media_iv`. */
export function randomChunkPrefix(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CHUNK_PREFIX_BYTES))
}

/**
 * The nonce for one chunk. Index is big-endian in three bytes, which covers
 * 2^24 chunks — four terabytes at the size above, against a 32MB upload cap.
 */
export function chunkNonce(prefix: Uint8Array, index: number, final: boolean): Uint8Array {
  const nonce = new Uint8Array(12)
  nonce.set(prefix.subarray(0, CHUNK_PREFIX_BYTES), 0)
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
 * Derived from the two accounts' public keys, which is what makes it worth
 * comparing: it is now stable for the life of those keys. It used to mix both
 * *device directories*, so it changed every time either person signed into a
 * new browser — several times a year, for a reason that was never an attack,
 * and a number that keeps changing for innocent reasons is a number nobody
 * checks. This one moves when a key really moves, and the only things that
 * move a key are a fresh account and an owner's password reset.
 *
 * Sixty digits in twelve groups of five, the Signal shape, because it is a
 * format people have some chance of comparing without losing their place.
 */
export async function safetyNumber(a: string, b: string): Promise<string> {
  // Sorted so both sides hash the same string without agreeing who is first.
  const material = [a, b].sort().join('||')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  const digits = [...new Uint8Array(digest)]
    .map((byte) => byte.toString().padStart(3, '0'))
    .join('')
    .slice(0, 60)
  return (digits.match(/.{1,5}/g) ?? []).join(' ')
}

/**
 * A short digest of one account's key, for "did this change since I last
 * looked". Not the safety number: that one mixes both sides and is meant to be
 * read out loud.
 */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey))
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
