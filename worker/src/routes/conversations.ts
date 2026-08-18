import { getAgentByName } from 'agents'
import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { conversationIdFor } from '../lib/conversation'
import { isOnline } from '../lib/presence'
import {
  PUBLIC_USER_COLUMNS,
  requireSession,
  sessionHeaders,
  type PublicUser,
} from '../lib/session'
import { retentionOr, type WireMessage } from '../protocol'

// Conversations REST (PRD §3.3). Rows are created lazily on first message
// (phase 4); these endpoints only read and resolve ids.

interface ConversationRow {
  id: string
  created_at: number | null
  last_message_at: number | null
  /** The pair's message window (migration 0008). */
  retention_ms: number
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

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.created_at, c.last_message_at, c.retention_ms,
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
    // What the tile's preview is allowed to outlive (PRD §3.9): the local copy
    // of this list drops a preview that is already past it, so a cached tile
    // cannot quote a message the server has deleted.
    retention_ms: retentionOr(row.retention_ms),
    other_user: {
      id: row.other_id,
      username: row.other_username,
      display_name: row.other_display_name,
      avatar_key: row.other_avatar_key,
      created_at: row.other_created_at,
      last_seen_at: row.other_last_seen_at,
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
  const existing = await env.DB.prepare(
    'SELECT retention_ms FROM conversations WHERE id = ?',
  )
    .bind(conversationId)
    .first<{ retention_ms: number }>()
  if (deleted && existing === null) return apiError('not_found', 404, 'user not found')

  const { disabled_at, deleted_at, ...publicUser } = row
  return json(
    {
      conversation_id: conversationId,
      exists: existing !== null,
      // The disappearing-message window (PRD §3.9), so the thread can label
      // itself before the socket is up. This is D1's mirror of what the
      // Durable Object holds; the `retention` frame on connect is the
      // authority and corrects it a round trip later — which only matters for
      // a window chosen before the conversation had a row at all.
      retention_ms: retentionOr(existing?.retention_ms),
      other_user: {
        ...publicUser,
        online: !deleted && isOnline(publicUser.last_seen_at, Date.now()),
        deleted,
      } satisfies PublicUser,
      readonly: deleted,
    },
    200,
    sessionHeaders(auth),
  )
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

