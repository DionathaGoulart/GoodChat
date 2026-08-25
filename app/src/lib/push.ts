// Web Push opt-in flow (phase 8). Browser side rides @mmmike/web-push/client
// (same package the worker sends with); server side is our REST API. The
// VAPID public key comes from the worker — the app has no push env vars.
//
// Explicit opt-in: nothing here runs on its own. A subscription is only
// created by enablePush(), which the user triggers from the UI.

import {
  getNotificationPermission,
  getCurrentSubscription,
  isPushSupported,
  serializeSubscription,
  subscribe,
  unsubscribe,
} from '@mmmike/web-push/client'
import { ApiError, pushSubscribe, pushUnsubscribe, pushVapidKey } from './api'

export type PushState =
  | 'unsupported' // browser has no Push API (or: iOS Safari outside an installed PWA)
  | 'denied' // notification permission blocked at the browser level
  | 'off' // supported, not subscribed
  | 'on' // permission granted + browser subscription exists
  | 'unavailable' // worker has no VAPID config (503 push_not_configured)

/**
 * Tells the service worker to close the notifications of one conversation.
 *
 * A notification is the one copy of a message that lives outside the app, in
 * the system's notification centre, where nothing here can delete it later. The
 * moment the server says those messages expired, the notification that
 * previewed them has no reason to exist — and if the preview preference is
 * 'full', it is still showing the text. Best effort: no service worker, or no
 * `getNotifications` support, simply means nothing to close.
 */
export function dismissNotifications(tag: string): void {
  void navigator.serviceWorker?.ready
    .then((registration) => registration.active?.postMessage({ type: 'close-notifications', tag }))
    .catch(() => undefined)
}

/** Current state, from browser-side facts only (no server round-trip). */
export async function currentPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported'
  if (getNotificationPermission() === 'denied') return 'denied'
  const subscription = await getCurrentSubscription()
  return subscription && getNotificationPermission() === 'granted' ? 'on' : 'off'
}

/** Ask permission, subscribe the browser, register with the worker. */
export async function enablePush(): Promise<PushState> {
  let publicKey: string
  try {
    ;({ public_key: publicKey } = await pushVapidKey())
  } catch (error) {
    if (error instanceof ApiError && error.code === 'push_not_configured') return 'unavailable'
    throw error
  }
  const result = await subscribe(publicKey)
  if (result.status === 'unsupported') return 'unsupported'
  if (result.status === 'denied') return 'denied'
  // The subscription used to name a device, because the preview's content key
  // was wrapped per browser and the worker had to pick the right one. With one
  // key per account every browser of that account can open it, so there is
  // nothing to name (migration 0014, worker/src/lib/push.ts `withPreview`).
  await pushSubscribe(serializeSubscription(result.subscription))
  return 'on'
}

/** Drop the browser subscription and the worker's row. Never throws. */
export async function disablePush(): Promise<PushState> {
  try {
    const endpoint = await unsubscribe()
    if (endpoint) await pushUnsubscribe(endpoint)
  } catch {
    // Best-effort: a dead server row is pruned on the next failed push anyway.
  }
  return 'off'
}
