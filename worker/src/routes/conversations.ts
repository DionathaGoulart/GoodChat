import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { conversationIdFor } from '../lib/conversation'
import { requireSession, type AuthContext, type SessionUser } from '../lib/session'

// Conversations REST (PRD §3.3). Rows are created lazily on first message
// (phase 4); these endpoints only read and resolve ids.

interface ConversationRow {
  id: string
  created_at: number | null
  last_message_at: number | null
  other_id: string
  other_username: string
  other_display_name: string | null
  other_avatar_url: string | null
  other_created_at: number
}

export async function listConversations(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.created_at, c.last_message_at,
            u.id AS other_id, u.username AS other_username,
            u.display_name AS other_display_name, u.avatar_url AS other_avatar_url,
            u.created_at AS other_created_at
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.user_a = ?1 THEN c.user_b ELSE c.user_a END
     WHERE c.user_a = ?1 OR c.user_b = ?1
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
  )
    .bind(auth.user.id)
    .all<ConversationRow>()

  const conversations = results.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
    other_user: {
      id: row.other_id,
      username: row.other_username,
      display_name: row.other_display_name,
      avatar_url: row.other_avatar_url,
      created_at: row.other_created_at,
    } satisfies SessionUser,
  }))

  return json({ conversations }, 200, sessionHeaders(auth))
}

const ResolveSchema = z.object({ user_id: z.string().min(1).max(64) })

/**
 * POST /api/conversations/resolve — deterministic id for "me + user_id",
 * without creating anything. `exists` tells whether the row was already
 * materialized by a first message.
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

  const other = await env.DB.prepare(
    'SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?',
  )
    .bind(parsed.data.user_id)
    .first<SessionUser>()
  if (!other) return apiError('not_found', 404, 'user not found')

  const conversationId = await conversationIdFor(auth.user.id, other.id)
  const existing = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?')
    .bind(conversationId)
    .first()

  return json(
    { conversation_id: conversationId, exists: existing !== null, other_user: other },
    200,
    sessionHeaders(auth),
  )
}

function sessionHeaders(auth: AuthContext): HeadersInit | undefined {
  return auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined
}
