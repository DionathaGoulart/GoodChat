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

import { z } from 'zod'

export const MESSAGE_TYPES = ['text', 'emoji', 'sticker', 'image', 'video', 'file'] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

export const MESSAGE_STATUSES = ['sent', 'delivered', 'read'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

export const MAX_BODY_LENGTH = 4096

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
  z.object({
    type: z.literal('read_receipt'),
    up_to_message_id: z.string().min(1).max(64),
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
  z.object({
    type: z.literal('read_receipt'),
    up_to_message_id: z.string(),
    user_id: z.string(),
  }),
  z.object({ type: z.literal('error'), error: z.string(), message: z.string().optional() }),
])
export type ServerEvent = z.infer<typeof ServerEventSchema>
