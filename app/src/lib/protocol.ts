// COPY of worker/src/protocol.ts — keep the two files identical.
// (Separate packages; the plan's phase-5 note allows import-or-copy.)
//
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
// either a public identifier or something already encrypted.
//
// One content key per message encrypts the body (and the media object, under
// its own IV). That key is then wrapped once per *account* allowed to read it,
// which is two entries and only ever two: the recipient and the sender. The
// sender's own is not a courtesy to its other tabs — there is no such thing
// anymore, every browser of an account holds the same key — it is so the
// person can read what they sent.
//
// `v: 3` is what made that true, and it is mostly a subtraction. The key map
// used to be keyed by device id and to carry `sender_device`, because identity
// was per browser: a message was wrapped once per device, a new browser held a
// key no envelope named, and there was a whole handover protocol
// (`request_keys`/`share_keys`, with a `via` field on each wrapped key) for
// passing history between two of your own devices while both were online and
// looking at the same thread. Migration 0014 made the account the unit, so all
// of that is gone: two entries, no `via`, no `sender_device` — the ECDH runs
// against the sending *account's* published key, which the recipient already
// has.
//
// `v: 1` and `v: 2` are still parsed, and only parsed. Nothing seals them; the
// schema accepts them so that history written before the account key still
// validates on its way to a client that may be able to open it. Retention caps
// a message at seven days (below), so seven days after this ships nothing on
// the instance is v1 or v2 and both branches can go — the same note `v: 2` was
// shipped with, and this time it applies to two versions at once.
//
// Optional throughout: a frame without `enc` is a plaintext message, which is
// what carried the original transition.
//
// What the version literal buys, in every case, is that the AEAD's additional
// data (`messageAad` in app/src/lib/e2ee.ts) names it — so an envelope of one
// version cannot be replayed as another.

/** An account id — the key map of a v3 envelope is keyed by these. */
export const ACCOUNT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A device id is SHA-256 of its public key, truncated (migration 0012). Only
 * v1/v2 envelopes use these, and nothing writes one anymore.
 */
export const DEVICE_ID_RE = /^[0-9a-f]{32}$/

/**
 * How many accounts one v3 envelope names. Two, because a conversation has two
 * participants — and one when the peer is a tombstone with no key left, which
 * is a thread that can only be read.
 */
export const MAX_ENVELOPE_ACCOUNTS = 2

/**
 * The same ceiling for a v1/v2 envelope, which counted browsers rather than
 * people. Kept only so stored history parses.
 */
export const MAX_ENVELOPE_RECIPIENTS = 32

const WrappedKeySchema = z.object({
  iv: z.string().min(1).max(64),
  ct: z.string().min(1).max(512),
})

/**
 * Nonce material for the bucket object, when this message carries one.
 *
 * Eight bytes of random prefix for a chunked object, twelve bytes of whole-
 * object IV for one written before chunking — which is what `media_chunk`
 * distinguishes. Both stay readable for as long as retention keeps them.
 */
const mediaFields = {
  media_iv: z.string().min(1).max(64).optional(),
  /**
   * Plaintext bytes per chunk. Present means the object is a sequence of
   * independently sealed chunks (`encryptChunked` in app/src/lib/e2ee.ts),
   * which is what lets a video play before it has finished downloading and
   * lets a seek fetch only the part it lands on. Absent means one whole
   * AES-GCM ciphertext, the shape everything uploaded before this used.
   */
  media_chunk: z.number().int().positive().max(4 * 1024 * 1024).optional(),
}

/** The envelope this build seals: keyed by account, two entries. */
export const AccountEnvelopeSchema = z.object({
  v: z.literal(3),
  /** AES-GCM IV for `body`, base64url. */
  iv: z.string().min(1).max(64),
  /** account id -> the content key, wrapped for that account's key. */
  keys: z
    .record(z.string().regex(ACCOUNT_ID_RE), WrappedKeySchema)
    .refine(
      (keys) => Object.keys(keys).length >= 1 && Object.keys(keys).length <= MAX_ENVELOPE_ACCOUNTS,
      { message: `keys must name 1 to ${MAX_ENVELOPE_ACCOUNTS} accounts` },
    ),
  ...mediaFields,
})

/**
 * The shape that predates the account key. Read-only: no client seals one, and
 * this branch exists so seven days of stored history keeps validating.
 */
export const DeviceEnvelopeSchema = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  iv: z.string().min(1).max(64),
  /** Which device's public key unwraps the content key. */
  sender_device: z.string().regex(DEVICE_ID_RE),
  keys: z
    .record(
      z.string().regex(DEVICE_ID_RE),
      WrappedKeySchema.extend({
        /**
         * Whose public key the recipient runs ECDH against, when it is not
         * `sender_device`. Written by the handover this version had and the
         * next one does not need.
         */
        via: z.string().regex(DEVICE_ID_RE).optional(),
      }),
    )
    .refine(
      (keys) => Object.keys(keys).length >= 1 && Object.keys(keys).length <= MAX_ENVELOPE_RECIPIENTS,
      { message: `keys must name 1 to ${MAX_ENVELOPE_RECIPIENTS} devices` },
    ),
  ...mediaFields,
})

export const EncEnvelopeSchema = z.union([AccountEnvelopeSchema, DeviceEnvelopeSchema])
export type EncEnvelope = z.infer<typeof EncEnvelopeSchema>
export type AccountEnvelope = z.infer<typeof AccountEnvelopeSchema>
export type DeviceEnvelope = z.infer<typeof DeviceEnvelopeSchema>

/** Narrows to the only shape anything writes. */
export function isAccountEnvelope(enc: EncEnvelope): enc is AccountEnvelope {
  return enc.v === 3
}

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
  // than about the connection, so the sender knows which bubble it is about.
  z.object({
    type: z.literal('error'),
    error: z.string(),
    message: z.string().optional(),
    client_id: z.string().optional(),
  }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
