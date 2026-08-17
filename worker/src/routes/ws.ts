// GET /api/ws/:conversationId?with=<other user id> — authenticated WebSocket
// upgrade, forwarded to the conversation's Durable Object.
//
// Membership check without requiring the conversation row to exist (rows are
// created lazily on first message): the id is a deterministic hash of the
// pair, so recomputing conversationIdFor(me, with) and comparing proves the
// caller belongs to this conversation.

import { getAgentByName } from 'agents'
import { conversationIdFor } from '../lib/conversation'
import { apiError } from '../lib/http'
import { requireSession } from '../lib/session'

const CONVERSATION_ID_RE = /^[0-9a-f]{32}$/

export async function connectConversation(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return apiError('invalid_request', 426, 'websocket upgrade required')
  }

  // Browsers send cookies on WS handshakes — same session middleware works.
  // (A refreshed sliding cookie cannot ride a 101 response; REST calls carry it.)
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  const conversationId = url.pathname.slice('/api/ws/'.length)
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return apiError('invalid_request', 400, 'malformed conversation id')
  }

  const withId = url.searchParams.get('with')
  if (!withId) {
    return apiError('invalid_request', 400, '`with` query param (other user id) is required')
  }
  if (withId === auth.user.id) {
    return apiError('invalid_request', 400, 'cannot open a conversation with yourself')
  }

  const other = await env.DB.prepare(
    'SELECT id FROM users WHERE id = ? AND disabled_at IS NULL',
  )
    .bind(withId)
    .first()
  if (!other) return apiError('not_found', 404, 'user not found')

  if ((await conversationIdFor(auth.user.id, withId)) !== conversationId) {
    return apiError('forbidden', 403, 'conversation id does not match this user pair')
  }

  const agent = await getAgentByName(env.ConversationAgent, conversationId)
  // Copy the request so identity headers are always overwritten server-side —
  // never trusted from the client.
  const forwarded = new Request(request)
  forwarded.headers.set('x-goodchat-user-id', auth.user.id)
  forwarded.headers.set('x-goodchat-peer-id', withId)
  return agent.fetch(forwarded)
}
