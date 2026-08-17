import { Agent } from 'agents'

// Placeholder Agent so the DO binding + SQLite migration are live from day one.
// Real implementation (WebSocket protocol, message persistence) lands in phase 4.
export class ConversationAgent extends Agent<Env> {}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

export default {
  async fetch(request, _env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, service: 'goodchat-worker' })
    }

    return json({ error: 'not_found' }, 404)
  },
} satisfies ExportedHandler<Env>
