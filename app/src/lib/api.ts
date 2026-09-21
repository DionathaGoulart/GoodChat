// REST client for the GoodChat Worker (endpoints in docs/architecture.md).
// Cookie-based session: every call rides `credentials: include`.

import type { WrappedAccountKey } from './accountKeys'
import type { KdfParams } from './kdf'
import type { WireMessage } from './protocol'
import type { Mode } from './themes'

/** Wire alias for the theme mode; the palette catalog owns the definition. */
export type ThemeMode = Mode

// Empty string (production build) = same origin: REST calls go out as
// relative paths and wsUrl() falls back to window.location.origin.
export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

/** Another account, as everyone sees it. */
export interface PublicUser {
  id: string
  username: string
  display_name: string | null
  /**
   * Profile picture as a bucket object key, not a URL: the bucket is private,
   * so the bytes come from `mediaUrl(key)` (lib/media.ts) like any attachment.
   */
  avatar_key: string | null
  created_at: number
  /**
   * Presence (worker/src/lib/presence.ts): the last heartbeat and whether it is
   * recent enough to call this account online. Optional because only the
   * endpoints that render presence compute it — and because a payload from a
   * worker that predates it must still parse.
   */
  last_seen_at?: number | null
  online?: boolean
  /**
   * The account is gone (a temporary one that expired, or one the owner
   * removed). The thread stays readable, but nothing can be sent to it.
   */
  deleted?: boolean
}

export type Role = 'owner' | 'user'

/** My own account: role and theme are only ever sent to their owner. */
export interface SessionUser extends PublicUser {
  role: Role
  /** Account-level mode; null follows the OS preference. */
  theme_mode: ThemeMode | null
  /**
   * Palette ids from lib/themes.ts, one per mode. null means "never picked" —
   * the client falls back to the catalog default rather than storing it.
   */
  theme_light: string | null
  theme_dark: string | null
  /** Skin id from lib/skins.ts; null means the catalog default. */
  skin: string | null
  /**
   * How much of a message may show up in a device notification: 'generic'
   * (sender only) or 'full' (a 120-character preview). null means "never
   * chose" and reads as 'generic' — a notification outlives the message it
   * previews, so the private option is the default.
   */
  push_preview: string | null
  /** Guest account: it and its data are deleted at `expires_at`. */
  is_temp: boolean
  expires_at: number | null
  /**
   * The worker still holds a hash of a password it was told (migration 0013).
   * The app refuses to show anything else until a new one is set — see
   * screens/RotatePasswordScreen.tsx.
   */
  must_rotate: boolean
}

export interface ConversationListItem {
  id: string
  created_at: number | null
  last_message_at: number | null
  last_message: WireMessage | null
  unread_count: number
  other_user: PublicUser
  /**
   * The peer's account key, inline so the tile preview can be decrypted without
   * one /api/users/:id/key call per thread (migration 0014). Null when they
   * have not published one.
   */
  peer_account_key?: string | null
}

export interface ResolveResult {
  conversation_id: string
  exists: boolean
  other_user: PublicUser
  /** The peer no longer exists: history only, the composer is closed. */
  readonly: boolean
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

/**
 * The salt and cost this account's password has to be run through, before
 * anything can be sent (lib/kdf.ts). Answers for every username — a name with
 * no rotated account behind it gets a deterministic decoy — so nothing here
 * says whether an account exists.
 */
export function kdfParams(username: string): Promise<KdfParams> {
  return call('/api/auth/kdf', { method: 'POST', body: JSON.stringify({ username }) })
}

/**
 * What signing in hands back: the account, and the account key sealed under a
 * `wrapKey` only the browser that just derived it can produce (migration
 * 0014). Null for an account that has not published one yet.
 */
export interface LoginResult {
  user: SessionUser
  account_key: WrappedAccountKey | null
}

/** Sign in with the derived token. The password itself never goes. */
export function login(username: string, authToken: string): Promise<LoginResult> {
  return call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, auth_token: authToken }),
  })
}

/**
 * Sign in with the password itself, for an account that has not rotated
 * (migration 0013). Only ever called after `login` above was refused, which
 * means this password is already known not to open the account the new way —
 * see the note on the worker's login route for why that ordering is the whole
 * of what keeps this endpoint from enumerating accounts.
 */
export function loginLegacy(username: string, password: string): Promise<LoginResult> {
  return call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

/**
 * The one-time move off a password the server knows. Takes the current one in
 * the clear — the worker still holds a hash of it and has no other way to
 * check — plus everything derived from the new one.
 */
export function rotatePassword(body: {
  current_password: string
  auth_token: string
  kdf_salt: string
  kdf_iterations: number
  /** Sealed under the new `wrapKey`, in the same request as the salt. */
  account_key: WrappedAccountKey
}): Promise<{ ok: boolean }> {
  return call('/api/auth/rotate', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Publishes the key for an account that had none. Create-only on the worker's
 * side — a 409 means another tab won the race, and this one throws its
 * keypair away and reads back the winner's.
 */
export function publishAccountKey(key: WrappedAccountKey): Promise<{ ok: boolean }> {
  return call('/api/account/key', { method: 'PUT', body: JSON.stringify(key) })
}

export interface TempAccountResult {
  user: SessionUser
  /** Always null: a guest publishes its own, unwrapped. */
  account_key: null
}

/**
 * Guest signup: a throwaway account with no password at all. It deletes itself
 * when it expires — or the moment this browser signs out, whichever is first.
 * There is nothing to show and nothing to store: this tab's cookie is the only
 * way into it (worker/src/lib/accounts.ts).
 */
export function createTempAccount(): Promise<TempAccountResult> {
  return call('/api/auth/temp', { method: 'POST' })
}

export interface HealthResult {
  ok: boolean
  service: string
  /** Whether this instance offers guest accounts at all. */
  temp_accounts: boolean
}

export function health(): Promise<HealthResult> {
  return call('/api/health')
}

export function logout(): Promise<{ ok: boolean }> {
  return call('/api/auth/logout', { method: 'POST' })
}

/**
 * Own password. Neither the old nor the new one travels: both are derived here
 * (lib/kdf.ts) and only the tokens go. Signs every *other* device out — the
 * worker hands this tab a fresh cookie so it stays where it is.
 */
/**
 * The stored account key, in exchange for proof of the password. The one way
 * to reach the wrapped blob outside of signing in — see the worker's route for
 * why it is not a plain GET.
 */
export function passwordChallenge(
  currentAuthToken: string,
): Promise<{ account_key: WrappedAccountKey | null }> {
  return call('/api/auth/password/challenge', {
    method: 'POST',
    body: JSON.stringify({ current_auth_token: currentAuthToken }),
  })
}

export function changePassword(body: {
  current_auth_token: string
  auth_token: string
  kdf_salt: string
  kdf_iterations: number
  /** The same key, sealed under the new `wrapKey`. Null when there is none. */
  account_key: WrappedAccountKey | null
}): Promise<{ ok: boolean }> {
  return call('/api/auth/password', { method: 'PATCH', body: JSON.stringify(body) })
}

export function me(): Promise<{ user: SessionUser }> {
  return call('/api/auth/me')
}

/**
 * The key a message to this account has to be encrypted for (migration 0014).
 * Null when they have not published one — a live answer, not an error.
 */
export function userAccountKey(userId: string): Promise<{ public_key: string | null }> {
  return call(`/api/users/${encodeURIComponent(userId)}/key`)
}

// --- the directory this replaced ------------------------------------------

/** A device's published key, from before the account key (migration 0012). */
export interface PublicDevice {
  id: string
  public_key: string
  created_at: number
  last_seen_at: number
}

/**
 * The old per-browser directory, read-only. Nothing registers a device
 * anymore; this exists so a browser can still find the key that opens what it
 * received before the account key (lib/legacyEnvelope.ts), and goes when the
 * last v2 message expires.
 */
export function userDevices(userId: string): Promise<{ devices: PublicDevice[] }> {
  return call(`/api/users/${encodeURIComponent(userId)}/devices`)
}

export type PushPreview = 'generic' | 'full'

/**
 * Account-level preferences. The four appearance values travel together — the
 * appearance screen always knows the whole set, and a full write keeps the
 * worker free of read-modify-write. `theme_mode: null` means "follow the
 * system"; `push_preview` is left alone when omitted.
 */
export function updateSettings(prefs: {
  mode: ThemeMode | null
  light: string
  dark: string
  skin: string
  pushPreview?: PushPreview
}): Promise<{ user: SessionUser }> {
  return call('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      theme_mode: prefs.mode,
      theme_light: prefs.light,
      theme_dark: prefs.dark,
      skin: prefs.skin,
      ...(prefs.pushPreview ? { push_preview: prefs.pushPreview } : {}),
    }),
  })
}

export interface PresenceState {
  id: string
  online: boolean
  last_seen_at: number | null
}

export interface PresenceResult {
  /** Server clock, so a client with a skewed one still reads sane timestamps. */
  now: number
  window_ms: number
  heartbeat_ms: number
  users: PresenceState[]
}

/**
 * Heartbeat: says "I am here" and asks about the accounts on screen in the same
 * round trip. Driven by lib/presence.ts, which is the only caller.
 */
export function presence(ids: string[]): Promise<PresenceResult> {
  return call('/api/presence', { method: 'POST', body: JSON.stringify({ ids }) })
}

/**
 * Display name and profile picture. Both optional and independent — the name
 * form and the picture picker fire on their own, so only what changed is sent.
 * `null` clears the field; the picture is uploaded first (uploadAvatar) and
 * only its key travels here.
 */
export function updateProfile(patch: {
  display_name?: string | null
  avatar_key?: string | null
}): Promise<{ user: SessionUser }> {
  return call('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) })
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

/**
 * `purpose` picks the worker's rule set: a message attachment may be a video up
 * to 32MB, an avatar is a still image capped at 512KB and lands under the
 * `avatars/` prefix, which is what makes it readable outside the conversation.
 */
export function requestUploadUrl(
  mime: string,
  size: number,
  purpose: 'message' | 'avatar' = 'message',
  /** Required for an encrypted attachment, where `mime` says nothing. */
  kind?: 'image' | 'video',
): Promise<UploadUrlResult> {
  return call('/api/media/upload-url', {
    method: 'POST',
    body: JSON.stringify({ mime, size, purpose, ...(kind ? { kind } : {}) }),
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
  /** Guest accounts alive right now. */
  temp_users: number
  /** Deleted accounts still naming a thread someone else kept. */
  tombstones: number
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
  /** Plan ceilings shown as `used / total`. Null when the limit is off. */
  do_storage_limit_bytes: number | null
  bucket_limit_bytes: number | null
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
  is_temp: boolean
  expires_at: number | null
  /** Tombstone: the account is gone, the row only names old threads. */
  deleted: boolean
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
  /** When its next message expires; null when it holds none (PRD §3.9). */
  next_expiry_at: number | null
  /** How many are still unread, and so still on the seven-day ceiling. */
  unread: number
  unreachable: boolean
}

export interface PurgeResult {
  ok: boolean
  messages_deleted?: number
  media_deleted?: number
  conversations_purged?: number
  tombstones_removed?: number
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
  temp_accounts_deleted: number
  temp_conversations_deleted: number
  tombstones_removed: number
  orphan_media_deleted: number
  expired_media_deleted: number
}

export function adminCleanup(): Promise<CleanupReport> {
  return call('/api/admin/cleanup', { method: 'POST' })
}

export function adminReindexMedia(): Promise<{ ok: boolean; indexed: number }> {
  return call('/api/admin/media/reindex', { method: 'POST' })
}

/** One owner action (migration 0011). Reads leave no row — only changes do. */
export interface AuditEntry {
  id: string
  actor_id: string
  actor_name: string
  /** 'user.password_reset', 'user.delete', 'conversation.purge', … */
  action: string
  target_id: string | null
  target_name: string | null
  /** JSON object as a string; never message content or credentials. */
  details: string | null
  created_at: number
}

export function adminAudit(): Promise<{ entries: AuditEntry[] }> {
  return call('/api/admin/audit')
}

/** ws(s):// endpoint for a conversation (cookie rides the handshake). */
export function wsUrl(conversationId: string, otherUserId: string): string {
  const origin = API_URL !== '' ? API_URL : window.location.origin
  const base = origin.replace(/^http/, 'ws')
  return `${base}/api/ws/${conversationId}?with=${encodeURIComponent(otherUserId)}`
}
