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

const AES = { name: 'AES-GCM', length: 256 } as const
const WRAP_INFO = new TextEncoder().encode('goodchat-v1-wrap')

export function randomIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(12))
}

export function createContentKey(): Promise<CryptoKey> {
  // Extractable: the content key has to be exported to be wrapped for each
  // recipient. It never leaves this function's callers in the clear.
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt'])
}

export async function encryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  bytes: BufferSource,
): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, bytes)
  return new Uint8Array(out)
}

export async function decryptBytes(
  key: CryptoKey,
  iv: Uint8Array,
  bytes: BufferSource,
): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, bytes)
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
 */
export async function sealMessage(
  identity: DeviceIdentity,
  recipients: readonly PublicDevice[],
  payload: Payload,
  contentKey: CryptoKey,
  mediaIv?: Uint8Array,
): Promise<{ body: string; enc: EncEnvelope }> {
  const iv = randomIv()
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const body = base64url(await encryptBytes(contentKey, iv, plaintext as BufferSource))

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
      v: 1,
      iv: base64url(iv),
      sender_device: identity.id,
      keys,
      ...(mediaIv ? { media_iv: base64url(mediaIv) } : {}),
    },
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
    const plaintext = await decryptBytes(
      contentKey,
      fromBase64url(enc.iv),
      fromBase64url(body) as BufferSource,
    )
    return { payload: JSON.parse(new TextDecoder().decode(plaintext)) as Payload, contentKey }
  } catch {
    return null
  }
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
