// Web Push delivery (phase 8, PRD §3.8). VAPID keys live in env (dev:
// .dev.vars, prod: wrangler secrets); subscriptions live in D1 (one row per
// browser, several per user). Sending uses @mmmike/web-push — pure WebCrypto,
// RFC 8291 aes128gcm — via plain fetch, so it runs in workerd and Node alike.
//
// Endpoints are capability URLs (whoever holds one can push to that device):
// never log them; errors below log status codes only.

import { sendPushNotification, WebPushError } from '@mmmike/web-push/send'
import type { MessageType } from '../protocol'

export interface PushConfig {
  publicKey: string
  privateKey: string
  subject: string
}

/** VAPID config from env, or null when push is not configured (feature off). */
export function pushConfig(env: Env): PushConfig | null {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return null
  return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT }
}

/** Payload shape the service worker reads back with event.data.json(). */
export interface NotificationPayload {
  title: string
  body: string
  /** SPA location to open on click, e.g. "/#/t/<sender id>". */
  url: string
  /** Collapses visible notifications per conversation on the device. */
  tag: string
}

interface SubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Push `payload` to every subscription of `userId`. Gone subscriptions
 * (404/410 from the push service) are pruned from D1. Never throws — push is
 * best-effort and must not disturb message delivery.
 */
export async function notifyUser(
  env: Env,
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  const vapid = pushConfig(env)
  if (!vapid) return

  const { results } = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
  )
    .bind(userId)
    .all<SubscriptionRow>()
  if (results.length === 0) return

  await Promise.all(
    results.map(async (sub) => {
      try {
        const delivered = await sendPushNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          vapid,
          {
            ttl: 24 * 60 * 60,
            urgency: 'high',
            // Push-service-side collapse: while the device is offline, a newer
            // push for the same conversation replaces the queued one. The tag
            // is a 32-hex conversation id — already valid topic charset.
            topic: payload.tag,
          },
        )
        if (!delivered) {
          // 404/410 — subscription is dead; forget it.
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
            .bind(sub.endpoint)
            .run()
        }
      } catch (error) {
        if (error instanceof WebPushError) {
          console.warn('push service rejected notification', { status: error.statusCode })
        } else {
          console.warn('push delivery failed', error instanceof Error ? error.message : error)
        }
      }
    }),
  )
}

/** PT-BR notification preview for a message, mirroring the list previews. */
export function previewFor(msgType: MessageType, body: string): string {
  switch (msgType) {
    case 'text':
    case 'emoji':
      return body.length > 120 ? `${body.slice(0, 119)}…` : body
    case 'image':
      return '[imagem]'
    case 'video':
      return '[vídeo]'
    case 'sticker':
      return '[sticker]'
    case 'file':
      return '[arquivo]'
  }
}
