// GET /api/ws/:conversationId?with=<other user id> — authenticated WebSocket
// upgrade, forwarded to the conversation's Durable Object.
//
// Membership check without requiring the conversation row to exist (rows are
// created lazily on first message): the id is a deterministic hash of the
// pair, so recomputing conversationIdFor(me, with) and comparing proves the
// caller belongs to this conversation.

import { getAgentByName } from 'agents'
import { conversationIdFor } from '../lib/conversation'
import { apiError, isAllowedOrigin } from '../lib/http'
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

  // The one authenticated surface CORS never sees: a handshake is not a
  // cross-origin *fetch*, so nothing above applies the allowlist to it. The
  // cookie is SameSite=Strict, which browsers do enforce on handshakes too, so
  // this closes no hole that is open today — it removes the trap that is armed
  // for the day SameSite has to change. A missing Origin is not refused: only
  // browsers are required to send one, and a non-browser client could forge it
  // anyway (the smoke-test scripts connect with `ws`, without an Origin).
  const origin = request.headers.get('Origin')
  if (origin && !isAllowedOrigin(origin, url.origin, env)) {
    return apiError('forbidden', 403, 'origin not allowed')
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

  // A tombstone (migration 0004) is not an account anymore, but the thread it
  // leaves behind still belongs to whoever survived it: the socket opens in
  // read-only mode so the history loads and nothing new can be sent. Without an
  // existing conversation there is nothing to read, and the peer stays a 404.
  const other = await env.DB.prepare(
    'SELECT id, disabled_at, deleted_at FROM users WHERE id = ?',
  )
    .bind(withId)
    .first<{ id: string; disabled_at: number | null; deleted_at: number | null }>()
  if (!other) return apiError('not_found', 404, 'user not found')

  const readonly = other.deleted_at !== null
  if (!readonly && other.disabled_at !== null) {
    return apiError('not_found', 404, 'user not found')
  }

  if ((await conversationIdFor(auth.user.id, withId)) !== conversationId) {
    return apiError('forbidden', 403, 'conversation id does not match this user pair')
  }

  if (readonly) {
    const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?')
      .bind(conversationId)
      .first()
    if (!exists) return apiError('not_found', 404, 'user not found')
  }

  const agent = await getAgentByName(env.ConversationAgent, conversationId)
  // Copy the request so identity headers are always overwritten server-side —
  // never trusted from the client.
  const forwarded = new Request(request)
  forwarded.headers.set('x-goodchat-user-id', auth.user.id)
  forwarded.headers.set('x-goodchat-peer-id', withId)
  forwarded.headers.set('x-goodchat-readonly', readonly ? '1' : '0')
  return agent.fetch(forwarded)
}
