// REST client for the GoodChat Worker (phases 2–3 shapes, see plan.md
// handoffs). Cookie-based session: every call rides `credentials: include`.

import type { WireMessage } from './protocol'

// Empty string (production build) = same origin: REST calls go out as
// relative paths and wsUrl() falls back to window.location.origin.
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

/** Another account, as everyone sees it. */
export interface PublicUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  created_at: number
}

export type Theme = 'goodchat-light' | 'goodchat-dark'
export type Role = 'owner' | 'user'

/** My own account: role and theme are only ever sent to their owner. */
export interface SessionUser extends PublicUser {
  role: Role
  /** Account-level default; null follows the OS preference. */
  theme: Theme | null
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

export function login(username: string, password: string): Promise<{ user: SessionUser }> {
  return call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function logout(): Promise<{ ok: boolean }> {
  return call('/api/auth/logout', { method: 'POST' })
}

export function me(): Promise<{ user: SessionUser }> {
  return call('/api/auth/me')
}

/** Account-level preferences. `theme: null` means "follow the system". */
export function updateSettings(theme: Theme | null): Promise<{ user: SessionUser }> {
  return call('/api/settings', { method: 'PATCH', body: JSON.stringify({ theme }) })
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

// --- owner console (/api/admin/*, 403 for everyone else) -----------------

export interface AdminOverview {
  users: number
  disabled_users: number
  sessions: number
  conversations: number
  messages: number
  do_storage_bytes: number
  indexed_media_objects: number
  indexed_media_bytes: number
  unclaimed_objects: number
  unclaimed_bytes: number
  /** Null when B2 is unreachable or unconfigured. */
  bucket_objects: number | null
  bucket_bytes: number | null
  retention_days: number | null
  legacy_media_reads: 'allow' | 'deny'
}

export interface AdminUser {
  id: string
  username: string
  display_name: string | null
  created_at: number
  role: Role
  created_by: string | null
  disabled: boolean
  conversations: number
  messages: number
  /** Message payload attributed to this account. */
  db_bytes: number
  media_bytes: number
  media_objects: number
  total_bytes: number
  last_activity_at: number | null
}

export interface AdminConversation {
  id: string
  created_at: number | null
  last_message_at: number | null
  participants: { id: string; username: string }[]
  messages: number
  body_bytes: number
  storage_bytes: number
  media_objects: number
  unreachable: boolean
}

export interface PurgeResult {
  ok: boolean
  messages_deleted?: number
  media_deleted?: number
  conversations_purged?: number
}

export function adminOverview(): Promise<AdminOverview> {
  return call('/api/admin/overview')
}

export function adminUsers(): Promise<{ users: AdminUser[] }> {
  return call('/api/admin/users')
}

export function adminConversations(): Promise<{ conversations: AdminConversation[] }> {
  return call('/api/admin/conversations')
}

export function adminCreateUser(input: {
  username: string
  password: string
  display_name?: string
}): Promise<{ id: string; username: string }> {
  return call('/api/admin/users', { method: 'POST', body: JSON.stringify(input) })
}

export function adminUpdateUser(
  id: string,
  patch: { display_name?: string; password?: string; disabled?: boolean; role?: Role },
): Promise<{ ok: boolean }> {
  return call(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function adminDeleteUser(id: string): Promise<PurgeResult> {
  return call(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function adminPurgeUser(id: string): Promise<PurgeResult> {
  return call(`/api/admin/users/${encodeURIComponent(id)}/purge`, { method: 'POST' })
}

export function adminPurgeConversation(id: string): Promise<PurgeResult> {
  return call(`/api/admin/conversations/${encodeURIComponent(id)}/purge`, { method: 'POST' })
}

export interface CleanupReport {
  sessions_deleted: number
  login_attempts_deleted: number
  orphan_media_deleted: number
  expired_media_deleted: number
}

export function adminCleanup(): Promise<CleanupReport> {
  return call('/api/admin/cleanup', { method: 'POST' })
}

export function adminReindexMedia(): Promise<{ ok: boolean; indexed: number }> {
  return call('/api/admin/media/reindex', { method: 'POST' })
}

/** ws(s):// endpoint for a conversation (cookie rides the handshake). */
export function wsUrl(conversationId: string, otherUserId: string): string {
  const origin = API_URL !== '' ? API_URL : window.location.origin
  const base = origin.replace(/^http/, 'ws')
  return `${base}/api/ws/${conversationId}?with=${encodeURIComponent(otherUserId)}`
}
