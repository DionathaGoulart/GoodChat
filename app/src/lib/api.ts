// REST client for the GoodChat Worker (phases 2–3 shapes, see plan.md
// handoffs). Cookie-based session: every call rides `credentials: include`.

import type { WireMessage } from './protocol'

// Empty string (production build) = same origin: REST calls go out as
// relative paths and wsUrl() falls back to window.location.origin.
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export interface PublicUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  created_at: number
}

export interface ConversationListItem {
  id: string
  created_at: number | null
  last_message_at: number | null
  last_message: WireMessage | null
  unread_count: number
  other_user: PublicUser
}

export interface ResolveResult {
  conversation_id: string
  exists: boolean
  other_user: PublicUser
}

/** Uniform worker error shape: { error: <code>, message? }. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message?: string) {
    super(message ?? code)
    this.code = code
    this.status = status
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
    })
  } catch {
    throw new ApiError('network_error', 0, 'servidor inacessível')
  }
  if (!response.ok) {
    let code = 'unknown_error'
    let message: string | undefined
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      code = body.error ?? code
      message = body.message
    } catch {
      // Non-JSON error body — keep the fallback code.
    }
    throw new ApiError(code, response.status, message)
  }
  return (await response.json()) as T
}

export function login(username: string, password: string): Promise<{ user: PublicUser }> {
  return call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function logout(): Promise<{ ok: boolean }> {
  return call('/api/auth/logout', { method: 'POST' })
}

export function me(): Promise<{ user: PublicUser }> {
  return call('/api/auth/me')
}

export function lookupUsers(q: string): Promise<{ users: PublicUser[] }> {
  return call(`/api/users/lookup?q=${encodeURIComponent(q)}`)
}

export function listConversations(): Promise<{ conversations: ConversationListItem[] }> {
  return call('/api/conversations')
}

export function resolveConversation(userId: string): Promise<ResolveResult> {
  return call('/api/conversations/resolve', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  })
}

export interface UploadUrlResult {
  key: string
  upload_url: string
  headers: Record<string, string>
  public_url: string
  expires_in: number
}

export function requestUploadUrl(mime: string, size: number): Promise<UploadUrlResult> {
  return call('/api/media/upload-url', {
    method: 'POST',
    body: JSON.stringify({ mime, size }),
  })
}

export interface PushSubscriptionBody {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export function pushVapidKey(): Promise<{ public_key: string }> {
  return call('/api/push/vapid-public-key')
}

export function pushSubscribe(subscription: PushSubscriptionBody): Promise<{ ok: boolean }> {
  return call('/api/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) })
}

export function pushUnsubscribe(endpoint: string): Promise<{ ok: boolean; removed: boolean }> {
  return call('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) })
}

/** ws(s):// endpoint for a conversation (cookie rides the handshake). */
export function wsUrl(conversationId: string, otherUserId: string): string {
  const origin = API_URL !== '' ? API_URL : window.location.origin
  const base = origin.replace(/^http/, 'ws')
  return `${base}/api/ws/${conversationId}?with=${encodeURIComponent(otherUserId)}`
}
