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

export const MAX_BODY_LENGTH = 4096

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
  z.object({ type: z.literal('error'), error: z.string(), message: z.string().optional() }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
