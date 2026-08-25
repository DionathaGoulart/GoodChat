// Reading a v1/v2 message. Nothing here writes one.
//
// This is the whole of what survives the move to the account key: the ability
// to open messages that were sealed before it, in the browser that was there
// when they arrived. Retention caps a message at seven days, so seven days
// after the account key ships nothing on the instance is v1 or v2 and this
// file is dead — which is why it is a file and not four branches scattered
// through lib/e2ee.ts. The deletion is `rm` plus three call sites.
//
// What it needs, and what it therefore keeps alive for the same seven days:
//
//   - this browser's old device key, still sitting in IndexedDB where
//     lib/deviceKeys.ts put it. Nothing creates one anymore.
//   - the sending device's public key, from the directory
//     (GET /api/users/:id/devices). Nothing registers one anymore either, so
//     the table only drains.
//
// Both of those are why a message from before the change is readable *here*
// and nowhere else: a browser that has never held the device key cannot open
// it, and no amount of design can change that — the content key exists only
// wrapped, and it was wrapped for a key that browser does not have. That is
// the one place `[mensagem de antes deste dispositivo]` is still an honest
// sentence, and it says a different one now so it does not read as a promise
// this build broke.
//
// The v2 binding is reproduced exactly as it was, `sender_device` and all
// (`messageAad` in lib/e2ee.ts no longer names a device, on purpose). A v1
// envelope predates the binding entirely and is opened without one; the worst
// that buys is replaying an envelope that was already unbound when it was
// written, and retention ends that on the same clock as everything else here.

import { fromBase64url } from './kdf'
import {
  decryptBytes,
  importPublicKey,
  wrappingKey,
  type MessageContext,
  type Payload,
} from './e2ee'
import type { DeviceIdentity } from './deviceKeys'
import type { DeviceEnvelope } from './protocol'

/** The additional data a v2 body was authenticated under. Frozen. */
function legacyAad(context: MessageContext, senderDevice: string): Uint8Array {
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

/** Whether this envelope holds a content key for this browser's old device. */
export function legacyAddressedTo(enc: DeviceEnvelope, deviceId: string): boolean {
  return deviceId in enc.keys
}

/**
 * Whose public key opens the content key for `deviceId` — the sender's device,
 * or the device of this account that handed the message over afterwards
 * (`via`). Null when the envelope holds nothing for this browser at all.
 */
export function legacyUnwrapsVia(enc: DeviceEnvelope, deviceId: string): string | null {
  const wrapped = enc.keys[deviceId]
  if (!wrapped) return null
  return wrapped.via ?? enc.sender_device
}

/**
 * Opens a v1/v2 message with this browser's old device key.
 *
 * `senderPublicKey` is whatever `legacyUnwrapsVia` named, looked up in the
 * device directory by the caller.
 */
export async function openLegacyMessage(
  identity: DeviceIdentity,
  context: MessageContext,
  senderPublicKey: string,
  body: string,
  enc: DeviceEnvelope,
): Promise<{ payload: Payload; contentKey: CryptoKey } | null> {
  const wrapped = enc.keys[identity.id]
  if (!wrapped) return null
  try {
    const senderKey = await importPublicKey(senderPublicKey)
    const wrapKey = await wrappingKey(
      identity.privateKey,
      senderKey,
      identity.id,
      wrapped.via ?? enc.sender_device,
    )
    const raw = await decryptBytes(
      wrapKey,
      fromBase64url(wrapped.iv),
      fromBase64url(wrapped.ct) as BufferSource,
    )
    const contentKey = await crypto.subtle.importKey(
      'raw',
      raw as BufferSource,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const plaintext = await decryptBytes(
      contentKey,
      fromBase64url(enc.iv),
      fromBase64url(body) as BufferSource,
      enc.v === 1 ? undefined : legacyAad(context, enc.sender_device),
    )
    return { payload: JSON.parse(new TextDecoder().decode(plaintext)) as Payload, contentKey }
  } catch {
    return null
  }
}
