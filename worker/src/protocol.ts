// WebSocket protocol (PRD §4.5), Zod-validated in both directions.
// Client → server events are parsed by the ConversationAgent; server → client
// frames are typed here so the phase-5 frontend can validate them too.
//
// Deviations from the illustrative PRD shapes, all additive:
// - `history` frame on connect (last N messages + anything still undelivered).
// - `message` frames carry `client_id` and `status` so the sender can
//   reconcile its optimistic echo (receiving your own `message` == "sent" ack).
// - `message_status` carries the server `id` alongside `client_id` so status
//   transitions can target messages from previous sessions.
// - `error` frame for invalid input (connection stays open).
// - retention (PRD §3.9): `read_receipt` in, `read_receipt` and
//   `messages_expired` out — reading a message is what shortens its life, so
//   the receipt carries the new deadline back to both sides.

import { z } from 'zod'

export const MESSAGE_TYPES = ['text', 'emoji', 'sticker', 'image', 'video', 'file'] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

export const MESSAGE_STATUSES = ['sent', 'delivered', 'read'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/**
 * What a person may type. The composer enforces it (app/src/components/
 * Composer.tsx); the wire limit below is a different number for a different
 * reason.
 */
export const MAX_PLAINTEXT_LENGTH = 4096

/**
 * What may travel in `body`. Once a message is encrypted, `body` is base64 of
 * AES-GCM ciphertext, so it is no longer a character count of anything a person
 * typed: 4096 emoji is 16KB of UTF-8, plus a tag, plus base64's third. This is
 * a bound against abuse rather than a product rule — the real protection is the
 * Durable Object's token bucket.
 */
export const MAX_BODY_LENGTH = 32768

// --- end-to-end encryption (docs/architecture.md) ---
//
// The envelope that turns `body` from text into ciphertext. The server stores
// and forwards it without being able to read any of it: every field here is
// either a public key id or something already encrypted.
//
// One content key per message encrypts the body (and the media object, under
// its own IV). That key is then wrapped once per device allowed to read it —
// the peer's devices plus the sender's own, so a second tab on another machine
// is not locked out of what this one sent. `sender_device` says whose public
// key the recipient has to run ECDH against to unwrap.
//
// Optional throughout: a frame without `enc` is a plaintext message, which is
// what carries the transition. Nothing that was already sent has to be
// migrated, because retention deletes it within seven days on its own.
//
// `v: 2` adds no field. What it changes is what the AEAD tag covers: the body
// is authenticated under the conversation id, the sender's account and the
// sending device (app/src/lib/e2ee.ts, `messageAad`), so this object can still
// store and forward an envelope it cannot read but can no longer move one into
// a conversation it was not sealed for. `v: 1` is accepted for exactly as long
// as retention keeps a message written before the change — seven days — and the
// literal can be dropped after that.

/** A device id is SHA-256 of its public key, truncated (migration 0012). */
export const DEVICE_ID_RE = /^[0-9a-f]{32}$/

/**
 * Ceiling on how many devices one message may be addressed to. A person does
 * not have thirty-two browsers; this stops a client from making the server
 * store an arbitrarily large key map per message.
 */
export const MAX_ENVELOPE_RECIPIENTS = 32

/**
 * How many messages one `share_keys` frame may carry. The sharing device sends
 * as many frames as it needs; this only bounds what a single one can make the
 * Durable Object rewrite in one go.
 */
export const MAX_SHARED_KEYS = 100

export const EncEnvelopeSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  /** AES-GCM IV for `body`, base64url. */
  iv: z.string().min(1).max(64),
  /** Which device's public key unwraps the content key. */
  sender_device: z.string().regex(DEVICE_ID_RE),
  /**
   * device id -> the content key, wrapped for that device.
   *
   * `via` names whose public key the recipient runs ECDH against to unwrap.
   * Absent means `sender_device`, which is every entry the sender itself wrote.
   * It is present only on entries added afterwards, by another device of the
   * recipient's own account handing over history the recipient was not around
   * for (`share_keys` below): that device cannot produce a wrap the sender
   * would have produced, because it does not hold the sender's private key, so
   * it wraps under its own pair and says so.
   */
  keys: z
    .record(
      z.string().regex(DEVICE_ID_RE),
      z.object({
        iv: z.string().min(1).max(64),
        ct: z.string().min(1).max(512),
        via: z.string().regex(DEVICE_ID_RE).optional(),
      }),
    )
    .refine(
      (keys) => Object.keys(keys).length >= 1 && Object.keys(keys).length <= MAX_ENVELOPE_RECIPIENTS,
      { message: `keys must name 1 to ${MAX_ENVELOPE_RECIPIENTS} devices` },
    ),
  /**
   * Nonce material for the bucket object, when this message carries one.
   *
   * Eight bytes of random prefix for a chunked object, twelve bytes of whole-
   * object IV for one written before chunking — which is what `media_chunk`
   * distinguishes. Both stay readable for as long as retention keeps them.
   */
  media_iv: z.string().min(1).max(64).optional(),
  /**
   * Plaintext bytes per chunk. Present means the object is a sequence of
   * independently sealed chunks (`encryptChunked` in app/src/lib/e2ee.ts), which
   * is what lets a video play before it has finished downloading and lets a
   * seek fetch only the part it lands on. Absent means one whole AES-GCM
   * ciphertext, the shape everything uploaded before this used.
   */
  media_chunk: z.number().int().positive().max(4 * 1024 * 1024).optional(),
})
export type EncEnvelope = z.infer<typeof EncEnvelopeSchema>

// --- retention (PRD §3.9) ---
//
// GoodChat is not a place messages are kept; it is a place they pass through.
// Every message carries its own clock, and reading it is what winds that clock
// down: three hours after the recipient has read it, the message is deleted for
// good — the row in the Durable Object and, when it carried one, the object in
// the bucket. A message nobody reads is not kept forever either; seven days
// after it was sent it goes the same way.
//
//   expires_at = min(created_at + UNREAD_TTL_MS, read_at + READ_TTL_MS)
//
// Both numbers are fixed for the whole instance. There is no per-conversation
// window to choose anymore: one rule, stated in one sentence, that holds in
// every thread. The clock is on the message, not on a copy of it — the row is
// shared, so both participants watch the same countdown and lose it in the same
// second.
//
// Only the *recipient* reading starts it. Seeing your own message back has
// never meant anything, and a sender who could start the other side's clock
// could delete a message before it was read.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** How long a message survives being read. */
export const READ_TTL_MS = 3 * HOUR_MS

/**
 * How long a message survives *not* being read. The ceiling on any message's
 * life, and the number the media cache and the cron backstop are sized against.
 */
export const UNREAD_TTL_MS = 7 * DAY_MS

/**
 * When a message sent at `createdAt` and read at `readAt` dies. `readAt` null
 * means it has not been read: the unread ceiling is the whole of its clock.
 *
 * `min`, not "whichever happened last": a message read on day seven has already
 * spent its ceiling, and the read must not hand it three more hours.
 */
export function expiryFor(createdAt: number, readAt: number | null): number {
  const ceiling = createdAt + UNREAD_TTL_MS
  return readAt === null ? ceiling : Math.min(ceiling, readAt + READ_TTL_MS)
}

/**
 * How many message ids one `read_receipt` frame may carry. A thread painting a
 * long scrollback flushes in batches; this bounds what a single frame can make
 * the Durable Object rewrite in one go.
 */
export const MAX_READ_IDS = 200

// Sticker messages carry a pack asset id in `body` (PRD §4.4). The id is used
// to build asset URLs client-side, so it is locked to a safe slug shape.
export const STICKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A persisted message on the wire (mirrors the DO's `messages` row). */
export const WireMessageSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  sender_id: z.string(),
  msg_type: z.enum(MESSAGE_TYPES),
  body: z.string(),
  media_key: z.string().nullable(),
  created_at: z.number(),
  status: z.enum(MESSAGE_STATUSES),
  /**
   * When the recipient read it, and the moment it is deleted — the second one
   * derived from the first (`expiryFor`). Both travel because the thread paints
   * a countdown from them, and because a client must never have to guess a
   * deadline it is about to show somebody.
   */
  read_at: z.number().nullable(),
  expires_at: z.number(),
  /** Absent on a plaintext message — see the note above. */
  enc: EncEnvelopeSchema.nullish(),
})
export type WireMessage = z.infer<typeof WireMessageSchema>

// --- client → server ---

export const ClientEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_message'),
    client_id: z.string().min(1).max(64),
    msg_type: z.enum(MESSAGE_TYPES),
    body: z.string().max(MAX_BODY_LENGTH),
    media_key: z.string().min(1).max(512).optional(),
    enc: EncEnvelopeSchema.optional(),
  }),
  z.object({ type: z.literal('typing') }),
  // --- handing history to another device of your own account ---
  //
  // A browser somebody just signed into holds a key no message was ever
  // wrapped for, so its history is a column of placeholders. Nothing on the
  // server can fix that — the content keys only exist wrapped, and only this
  // account's existing devices can open them. So the new device asks, an old
  // one is offered the choice, and the wrapped keys travel through here.
  //
  // The Durable Object checks that both devices belong to the account on the
  // connection and then only ever *adds* entries to an envelope's key map. It
  // still cannot read anything: a wrapped key is opaque to it, exactly like
  // the ones the sender wrote.
  z.object({ type: z.literal('request_keys'), device_id: z.string().regex(DEVICE_ID_RE) }),
  z.object({
    type: z.literal('share_keys'),
    device_id: z.string().regex(DEVICE_ID_RE),
    /** message id -> the content key, wrapped by this device for that one. */
    keys: z
      .record(
        z.string().min(1).max(64),
        z.object({
          iv: z.string().min(1).max(64),
          ct: z.string().min(1).max(512),
          via: z.string().regex(DEVICE_ID_RE),
        }),
      )
      .refine((keys) => Object.keys(keys).length <= MAX_SHARED_KEYS, {
        message: `at most ${MAX_SHARED_KEYS} messages per frame`,
      }),
  }),
  // Named ids, not a "everything up to here" watermark.
  //
  // A prefix was fine while reading was free. It is not fine now that reading
  // deletes: scrolling up past a message you had not opened, or landing on the
  // thread from a notification, would mark — and so condemn — everything below
  // the newest thing on screen. The client decides message by message what it
  // actually showed somebody (app/src/lib/readObserver.ts) and names those.
  z.object({
    type: z.literal('read_receipt'),
    ids: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(MAX_READ_IDS),
  }),
])
export type ClientEvent = z.infer<typeof ClientEventSchema>
export type SendMessageEvent = Extract<ClientEvent, { type: 'send_message' }>

// --- server → client ---

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('history'), messages: z.array(WireMessageSchema) }),
  WireMessageSchema.extend({ type: z.literal('message') }),
  z.object({
    type: z.literal('message_status'),
    id: z.string(),
    client_id: z.string(),
    status: z.enum(MESSAGE_STATUSES),
  }),
  z.object({ type: z.literal('typing'), user_id: z.string() }),
  // Somebody read these, and here is when each one now dies.
  //
  // Sent to *every* connection, the reader's own other tabs included. The row
  // is shared, so the deadline is shared: the sender needs it to show the
  // countdown under its own bubble, and a second browser of the reader's needs
  // it because it did not witness the read that started the clock.
  z.object({
    type: z.literal('read_receipt'),
    user_id: z.string(),
    reads: z.array(
      z.object({ id: z.string(), read_at: z.number().int(), expires_at: z.number().int() }),
    ),
  }),
  // Another device of this same account has no keys and is asking. Delivered
  // only to this account's *other* connections — never to the peer, who has
  // nothing to hand over and no business knowing.
  z.object({ type: z.literal('keys_requested'), device_id: z.string() }),
  // Keys were merged into stored envelopes for this device. `count` is how
  // many messages became readable, which is what the asking device needs to
  // know to go and read them again.
  z.object({ type: z.literal('keys_shared'), device_id: z.string(), count: z.number().int() }),
  // What this instance requires of a message, stated once per connect.
  //
  // It comes from the Durable Object rather than from /api/health because the
  // Durable Object is what enforces it: a client that asked somewhere else
  // could be told one thing and refused for another. The thread uses it to say
  // that messages are not being delivered, instead of only that they are not
  // encrypted — two very different sentences for the person typing.
  z.object({ type: z.literal('policy'), e2ee_required: z.boolean() }),
  // Messages that just aged out. Sent to both participants the moment the
  // sweep runs, so an open thread drops them without waiting for a reload.
  z.object({ type: z.literal('messages_expired'), ids: z.array(z.string()) }),
  // `client_id` is set when the refusal is about one specific message rather
  // than about the connection — `stale_directory` is, because the client has to
  // know which pending send to seal again.
  z.object({
    type: z.literal('error'),
    error: z.string(),
    message: z.string().optional(),
    client_id: z.string().optional(),
  }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
