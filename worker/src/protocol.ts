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
// - retention (PRD §3.9): `set_retention` in, `retention` and
//   `messages_expired` out — the disappearing-message window is conversation
//   state, so it travels on the same socket the messages do.

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
// Every message carries its own clock: `retention_ms` after it was created it
// is deleted for good — the row in the Durable Object and, when it carried
// one, the object in the bucket. The window belongs to the conversation, not
// to the account and not to the sender, and both participants share it.
//
// Seven days is both the default and the ceiling. The shorter values exist so
// a conversation can decide it needs less; nothing can ask for more.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const RETENTION_OPTIONS_MS = [
  3 * HOUR_MS,
  5 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  3 * DAY_MS,
  5 * DAY_MS,
  7 * DAY_MS,
] as const

export type RetentionMs = (typeof RETENTION_OPTIONS_MS)[number]

/** The window a conversation has until someone chooses otherwise — and the
    longest one anybody can choose. */
export const DEFAULT_RETENTION_MS: RetentionMs = 7 * DAY_MS

export function isRetentionOption(value: unknown): value is RetentionMs {
  return (
    typeof value === 'number' && (RETENTION_OPTIONS_MS as readonly number[]).includes(value)
  )
}

/**
 * Any stored or received number, coerced to a window that exists. An unknown
 * value (a hand-edited request, a column written by an older build) must never
 * end up meaning "keep forever", so it falls back to the maximum rather than
 * to no limit at all.
 */
export function retentionOr(value: unknown): RetentionMs {
  return isRetentionOption(value) ? value : DEFAULT_RETENTION_MS
}

export const RetentionSchema = z
  .number()
  .int()
  .refine(isRetentionOption, { message: 'unsupported retention window' })

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
  // Either participant may retune the window; the change applies to both and
  // takes effect on the messages already in the thread.
  z.object({ type: z.literal('set_retention'), retention_ms: RetentionSchema }),
  z.object({
    type: z.literal('read_receipt'),
    up_to_message_id: z.string().min(1).max(64),
  }),
])
export type ClientEvent = z.infer<typeof ClientEventSchema>
export type SendMessageEvent = Extract<ClientEvent, { type: 'send_message' }>
export type SetRetentionEvent = Extract<ClientEvent, { type: 'set_retention' }>

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
  z.object({
    type: z.literal('read_receipt'),
    up_to_message_id: z.string(),
    user_id: z.string(),
  }),
  // Sent right after `history` on every connect, and again whenever either
  // side changes it. `changed_by` is null for the frame that only states the
  // current window, so the client can tell "this is how it is" from "someone
  // just changed it".
  z.object({
    type: z.literal('retention'),
    retention_ms: z.number().int(),
    changed_by: z.string().nullable(),
  }),
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
