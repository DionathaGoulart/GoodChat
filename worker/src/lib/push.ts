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

/**
 * The push services a subscription may point at.
 *
 * A stored endpoint is an outbound fetch target the Worker will POST to,
 * chosen by whoever called /api/push/subscribe. "https, and at most 2048
 * characters" made that any host on the internet: an authenticated account
 * could park a URL of its choosing in D1 and have the Worker call it on every
 * message it receives. The list is what turns the endpoint back into what it
 * is supposed to be — a browser vendor's push service.
 *
 * Suffix match, because every one of these hands out per-device subdomains.
 * PUSH_ENDPOINT_HOSTS (comma-separated) *adds* to this list rather than
 * replacing it — a browser the defaults miss has to be allowed without
 * silently un-allowing the four that already work, and "I widened the list"
 * quietly narrowing it is the wrong way for this setting to fail. Local dev
 * uses it for the fake push endpoints the smoke tests subscribe to.
 */
const DEFAULT_PUSH_HOSTS = [
  'push.services.mozilla.com', // Firefox
  'fcm.googleapis.com', // Chrome, Chromium, Brave
  'android.googleapis.com', // Chrome, legacy GCM endpoints
  'push.apple.com', // Safari, installed iOS PWAs
  'notify.windows.com', // Edge (WNS)
  'push.services.microsoft.com', // Edge (newer)
]

export function isAllowedPushEndpoint(endpoint: string, env: Env): boolean {
  let host: string
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:') return false
    host = url.hostname.toLowerCase()
  } catch {
    return false
  }
  const extra =
    env.PUSH_ENDPOINT_HOSTS?.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0) ?? []
  return [...DEFAULT_PUSH_HOSTS, ...extra].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
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
  // Checked on the way out as well as on the way in: rows written before the
  // allowlist existed are still in this table, and this is the side that turns
  // one into an outbound request.
  const targets = results.filter((sub) => isAllowedPushEndpoint(sub.endpoint, env))
  if (targets.length === 0) return

  await Promise.all(
    targets.map(async (sub) => {
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

/**
 * How much of a message may appear in a device notification (migration 0010).
 *
 * The push transport itself is end-to-end encrypted (RFC 8291 — the push
 * service cannot read the payload), but the notification's final destination is
 * the operating system's notification centre, which has no retention window: a
 * preview shown there survives the message it previews, on a lock screen,
 * indefinitely. So the recipient chooses, and "generic" is the default — the
 * product's whole premise is that the text does not stick around.
 */
export type PushPreview = 'generic' | 'full'

export const DEFAULT_PUSH_PREVIEW: PushPreview = 'generic'

export function pushPreviewOr(value: unknown): PushPreview {
  return value === 'full' ? 'full' : DEFAULT_PUSH_PREVIEW
}

/** The recipient's choice. Unknown account or unset column reads as generic. */
export async function previewPreferenceOf(
  db: D1Database,
  userId: string,
): Promise<PushPreview> {
  try {
    const row = await db
      .prepare('SELECT push_preview FROM users WHERE id = ?')
      .bind(userId)
      .first<{ push_preview: string | null }>()
    return pushPreviewOr(row?.push_preview)
  } catch (error) {
    console.warn('push preview lookup failed', error instanceof Error ? error.message : error)
    return DEFAULT_PUSH_PREVIEW
  }
}

/**
 * PT-BR notification preview for a message, mirroring the list previews.
 * `preview: 'generic'` never reveals content — the title already carries the
 * sender's @username, which is the part that makes the notification useful.
 */
export function previewFor(
  msgType: MessageType,
  body: string,
  preview: PushPreview = DEFAULT_PUSH_PREVIEW,
): string {
  if (preview === 'generic') return 'te mandou uma mensagem'
  switch (msgType) {
    case 'text':
    case 'emoji': {
      // Truncate by code point — a bare .slice() could split an emoji's
      // surrogate pair and leak U+FFFD into the notification.
      const points = [...body]
      return points.length > 120 ? `${points.slice(0, 119).join('')}…` : body
    }
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
