import { apiError, corsHeaders, json } from './lib/http'
import { login, logout, me } from './routes/auth'
import { listConversations, resolveConversation } from './routes/conversations'
import { createUploadUrl } from './routes/media'
import { lookupUsers } from './routes/users'
import { connectConversation } from './routes/ws'

export { ConversationAgent } from './agent'

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url
  const method = request.method

  if (pathname === '/api/health' && method === 'GET') {
    return json({ ok: true, service: 'goodchat-worker' })
  }
  if (pathname === '/api/auth/login' && method === 'POST') return login(request, env)
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env)
  if (pathname === '/api/auth/me' && method === 'GET') return me(request, env)
  if (pathname === '/api/users/lookup' && method === 'GET') return lookupUsers(request, env, url)
  if (pathname === '/api/conversations' && method === 'GET') return listConversations(request, env)
  if (pathname === '/api/conversations/resolve' && method === 'POST') {
    return resolveConversation(request, env)
  }
  if (pathname === '/api/media/upload-url' && method === 'POST') {
    return createUploadUrl(request, env)
  }

  return apiError('not_found', 404)
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket path bypasses the CORS wrapper below: a 101 upgrade response
    // must be returned untouched (rebuilding it would drop the socket), and
    // WS handshakes are not subject to CORS anyway.
    if (url.pathname.startsWith('/api/ws/') && request.method === 'GET') {
      return connectConversation(request, env, url)
    }

    const origin = request.headers.get('Origin')

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    }

    const response = await route(request, env, url)
    // CORS applied centrally so route handlers only worry about their payload.
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      headers.set(key, value)
    }
    return new Response(response.body, { status: response.status, headers })
  },
} satisfies ExportedHandler<Env>
