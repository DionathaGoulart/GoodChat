// Web Push subscription endpoints (phase 8, PRD §3.8).
//
// GET  /api/push/vapid-public-key — the key the browser needs to subscribe
//                                   (single source; the app has no VAPID env).
// POST /api/push/subscribe        — upsert the caller's subscription. Explicit
//                                   opt-in: rows only ever appear through here.
// POST /api/push/unsubscribe      — forget one subscription (caller's only).

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { pushConfig } from '../lib/push'
import { requireSession } from '../lib/session'

// Shape of PushSubscription.toJSON() from the browser. Endpoint must be a
// real push-service https URL — stored endpoints are outbound fetch targets,
// so a non-https value is rejected here (defense against SSRF-style rows).
const SubscribeSchema = z.object({
  endpoint: z.url().max(2048).refine((u) => u.startsWith('https://'), 'https only'),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
})

const UnsubscribeSchema = z.object({
  endpoint: z.string().min(1).max(2048),
})

export function vapidPublicKey(_request: Request, env: Env): Response {
  const config = pushConfig(env)
  if (!config) {
    return apiError('push_not_configured', 503, 'VAPID env vars missing (see .env.example)')
  }
  return json({ public_key: config.publicKey })
}

export async function subscribePush(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth
  if (!pushConfig(env)) {
    return apiError('push_not_configured', 503, 'VAPID env vars missing (see .env.example)')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = SubscribeSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'expected { endpoint, keys: { p256dh, auth } }')
  }

  const { endpoint, keys } = parsed.data
  // Upsert by endpoint: re-subscribing refreshes keys and reclaims a row that
  // previously belonged to another account on the same browser profile.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, created_at = excluded.created_at`,
  )
    .bind(endpoint, auth.user.id, keys.p256dh, keys.auth, Date.now())
    .run()

  return json(
    { ok: true },
    200,
    auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined,
  )
}

export async function unsubscribePush(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = UnsubscribeSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'expected { endpoint }')
  }

  const result = await env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
  )
    .bind(parsed.data.endpoint, auth.user.id)
    .run()

  return json(
    { ok: true, removed: result.meta.changes > 0 },
    200,
    auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined,
  )
}
