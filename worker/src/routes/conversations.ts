import { getAgentByName } from 'agents'
import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { conversationIdFor } from '../lib/conversation'
import { coarseLastSeen, isOnline } from '../lib/presence'
import { CONVERSATIONS_QUOTA_PER_HOUR, HOUR_MS, consumeQuota } from '../lib/ratelimit'
import {
  PUBLIC_USER_COLUMNS,
  requireSession,
  sessionHeaders,
  type PublicUser,
} from '../lib/session'
import type { WireMessage } from '../protocol'

// Conversations REST (PRD §3.3). Rows are created lazily on first message
// (phase 4); these endpoints only read and resolve ids.

interface ConversationRow {
  id: string
  created_at: number | null
  last_message_at: number | null
  other_id: string
  other_username: string
  other_display_name: string | null
  other_avatar_key: string | null
  other_created_at: number
  /** Last heartbeat of the peer (migration 0007) — presence for the list. */
  other_last_seen_at: number | null
  /** Set when the peer account is a tombstone (migration 0004). */
  other_deleted_at: number | null
}

export async function listConversations(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  // One call wakes every conversation's Durable Object (see fetchSummary), so
  // this is the endpoint where an authenticated loop costs the most.
  const quota = await consumeQuota(
    env.DB,
    `conversations:${auth.user.id}`,
    CONVERSATIONS_QUOTA_PER_HOUR,
    HOUR_MS,
  )
  if (!quota.allowed) {
    return apiError('rate_limited', 429, 'too many requests, try again later', {
      'Retry-After': String(quota.retryAfterSeconds),
    })
  }

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.created_at, c.last_message_at,
            u.id AS other_id, u.username AS other_username,
            u.display_name AS other_display_name, u.avatar_key AS other_avatar_key,
            u.created_at AS other_created_at, u.last_seen_at AS other_last_seen_at,
            u.deleted_at AS other_deleted_at
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.user_a = ?1 THEN c.user_b ELSE c.user_a END
     WHERE c.user_a = ?1 OR c.user_b = ?1
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
  )
    .bind(auth.user.id)
    .all<ConversationRow>()

  // The peers' device keys, inline rather than through N calls to
  // /api/users/:id/devices. The tile preview is an encrypted message like any
  // other, so the list cannot be rendered without them — and this is the one
  // request that already knows exactly which peers the caller may see, so
  // carrying them here costs one query instead of one round trip per thread.
  const devicesByUser = await peerDevices(
    env,
    results.map((row) => row.other_id),
  )

  // Preview + unread live in each conversation's DO (phase-3 handoff deferred
  // them here). Fetched in parallel; a failing DO degrades to nulls instead of
  // breaking the list.
  const summaries = await Promise.all(
    results.map((row) => fetchSummary(env, row.id, auth.user.id)),
  )

  // One clock for the whole list, so two tiles cannot disagree about who is
  // online because a millisecond passed between them.
  const now = Date.now()
  const conversations = results.map((row, i) => ({
    id: row.id,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
    last_message: summaries[i]?.last_message ?? null,
    unread_count: summaries[i]?.unread_count ?? 0,
    /** What a message to this peer is encrypted for (migration 0012). */
    peer_devices: devicesByUser.get(row.other_id) ?? [],
    other_user: {
      id: row.other_id,
      username: row.other_username,
      display_name: row.other_display_name,
      avatar_key: row.other_avatar_key,
      created_at: row.other_created_at,
      last_seen_at: coarseLastSeen(row.other_last_seen_at),
      // A tombstone is not offline, it is gone — the tile says so instead.
      online: row.other_deleted_at === null && isOnline(row.other_last_seen_at, now),
      // The thread survives its owner: the client renders it read-only.
      deleted: row.other_deleted_at !== null,
    } satisfies PublicUser,
  }))

  return json({ conversations }, 200, sessionHeaders(auth))
}

const ResolveSchema = z.object({ user_id: z.string().min(1).max(64) })

/**
 * POST /api/conversations/resolve — deterministic id for "me + user_id",
 * without creating anything. `exists` tells whether the row was already
 * materialized by a first message.
 *
 * A tombstoned peer (migration 0004) resolves only when the thread already
 * exists, and comes back flagged: the client opens it read-only. Starting a
 * new conversation with a deleted account is a 404, same as a disabled one.
 */
export async function resolveConversation(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = ResolveSchema.safeParse(body)
  if (!parsed.success) return apiError('invalid_request', 400, 'user_id is required')
  if (parsed.data.user_id === auth.user.id) {
    return apiError('invalid_request', 400, 'cannot start a conversation with yourself')
  }

  const row = await env.DB.prepare(
    `SELECT ${PUBLIC_USER_COLUMNS}, disabled_at, deleted_at FROM users WHERE id = ?`,
  )
    .bind(parsed.data.user_id)
    .first<PublicUser & { disabled_at: number | null; deleted_at: number | null }>()
  if (!row) return apiError('not_found', 404, 'user not found')

  const deleted = row.deleted_at !== null
  if (!deleted && row.disabled_at !== null) return apiError('not_found', 404, 'user not found')

  const conversationId = await conversationIdFor(auth.user.id, row.id)
  const existing = await env.DB.prepare('SELECT id FROM conversations WHERE id = ?')
    .bind(conversationId)
    .first<{ id: string }>()
  if (deleted && existing === null) return apiError('not_found', 404, 'user not found')

  const { disabled_at, deleted_at, ...publicUser } = row
  return json(
    {
      conversation_id: conversationId,
      exists: existing !== null,
      other_user: {
        ...publicUser,
        online: !deleted && isOnline(publicUser.last_seen_at, Date.now()),
        last_seen_at: coarseLastSeen(publicUser.last_seen_at),
        deleted,
      } satisfies PublicUser,
      readonly: deleted,
    },
    200,
    sessionHeaders(auth),
  )
}

/**
 * Device keys for a set of peers, in one query. Chunked well under D1's bound
 * parameter cap, like lib/mediaIndex.ts `forgetKeys` does for the same reason.
 */
async function peerDevices(
  env: Env,
  userIds: readonly string[],
): Promise<Map<string, { id: string; public_key: string }[]>> {
  const unique = [...new Set(userIds)]
  const byUser = new Map<string, { id: string; public_key: string }[]>()
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50)
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, public_key FROM devices
       WHERE user_id IN (${placeholders}) ORDER BY id`,
    )
      .bind(...chunk)
      .all<{ id: string; user_id: string; public_key: string }>()
    for (const row of results) {
      const list = byUser.get(row.user_id) ?? []
      list.push({ id: row.id, public_key: row.public_key })
      byUser.set(row.user_id, list)
    }
  }
  return byUser
}

interface ConversationSummary {
  last_message: WireMessage | null
  unread_count: number
}

async function fetchSummary(
  env: Env,
  conversationId: string,
  userId: string,
): Promise<ConversationSummary | null> {
  try {
    const agent = await getAgentByName(env.ConversationAgent, conversationId)
    const response = await agent.fetch('https://do/summary', {
      headers: { 'x-goodchat-user-id': userId },
    })
    if (!response.ok) return null
    return await response.json<ConversationSummary>()
  } catch (error) {
    console.error('conversation summary failed', conversationId, error)
    return null
  }
}

