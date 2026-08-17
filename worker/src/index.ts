import { applySecurityHeaders, apiError, corsHeaders, json } from './lib/http'
import { runCleanup } from './lib/cleanup'
import { MEDIA_PATH_PREFIX } from './lib/media'
import {
  createAccount,
  deleteAccount,
  listAccounts,
  listAllConversations,
  overview,
  purgeAccountHistory,
  purgeConversation,
  reindexMedia,
  runCleanupNow,
  updateAccount,
} from './routes/admin'
import { tempAccountConfig } from './lib/accounts'
import { createTempSession, login, logout, me } from './routes/auth'
import { listConversations, resolveConversation } from './routes/conversations'
import { createUploadUrl, serveMedia } from './routes/media'
import { updateProfile } from './routes/profile'
import { subscribePush, unsubscribePush, vapidPublicKey } from './routes/push'
import { updateSettings } from './routes/settings'
import { lookupUsers } from './routes/users'
import { connectConversation } from './routes/ws'

export { ConversationAgent } from './agent'

/** `/api/admin/users/<id>/purge` → ["users", "<id>", "purge"]. */
function adminSegments(pathname: string): string[] {
  return pathname.slice('/api/admin/'.length).split('/').filter(Boolean)
}

async function routeAdmin(
  request: Request,
  env: Env,
  pathname: string,
): Promise<Response | null> {
  const method = request.method
  const [resource, id, action] = adminSegments(pathname)

  if (resource === 'overview' && !id && method === 'GET') return overview(request, env)
  if (resource === 'cleanup' && !id && method === 'POST') return runCleanupNow(request, env)
  if (resource === 'media' && id === 'reindex' && method === 'POST') return reindexMedia(request, env)

  if (resource === 'users') {
    if (!id) {
      if (method === 'GET') return listAccounts(request, env)
      if (method === 'POST') return createAccount(request, env)
    } else if (!action) {
      if (method === 'PATCH') return updateAccount(request, env, id)
      if (method === 'DELETE') return deleteAccount(request, env, id)
    } else if (action === 'purge' && method === 'POST') {
      return purgeAccountHistory(request, env, id)
    }
  }

  if (resource === 'conversations') {
    if (!id && method === 'GET') return listAllConversations(request, env)
    if (id && action === 'purge' && method === 'POST') return purgeConversation(request, env, id)
  }

  return null
}

async function route(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = url
  const method = request.method

  if (pathname === '/api/health' && method === 'GET') {
    // `temp_accounts` is what the login screen asks before offering the guest
    // button — the only piece of instance config a stranger may read.
    return json({
      ok: true,
      service: 'goodchat-worker',
      temp_accounts: tempAccountConfig(env).enabled,
    })
  }
  if (pathname === '/api/auth/login' && method === 'POST') return login(request, env)
  if (pathname === '/api/auth/temp' && method === 'POST') return createTempSession(request, env)
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env)
  if (pathname === '/api/auth/me' && method === 'GET') return me(request, env)
  if (pathname === '/api/settings' && method === 'PATCH') return updateSettings(request, env)
  if (pathname === '/api/profile' && method === 'PATCH') return updateProfile(request, env)
  if (pathname === '/api/users/lookup' && method === 'GET') return lookupUsers(request, env, url)
  if (pathname === '/api/conversations' && method === 'GET') return listConversations(request, env)
  if (pathname === '/api/conversations/resolve' && method === 'POST') {
    return resolveConversation(request, env)
  }
  if (pathname === '/api/media/upload-url' && method === 'POST') {
    return createUploadUrl(request, env)
  }
  if (pathname.startsWith(MEDIA_PATH_PREFIX) && method === 'GET') {
    return serveMedia(request, env, url, ctx)
  }
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') {
    return vapidPublicKey(request, env)
  }
  if (pathname === '/api/push/subscribe' && method === 'POST') return subscribePush(request, env)
  if (pathname === '/api/push/unsubscribe' && method === 'POST') {
    return unsubscribePush(request, env)
  }
  if (pathname.startsWith('/api/admin/')) {
    const response = await routeAdmin(request, env, pathname)
    if (response) return response
  }

  return apiError('not_found', 404)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    const https = url.protocol === 'https:'

    // WebSocket path bypasses everything below: a 101 upgrade response must be
    // returned untouched (rebuilding it would drop the socket), and WS
    // handshakes are subject to neither CORS nor document headers.
    if (url.pathname.startsWith('/api/ws/') && request.method === 'GET') {
      return connectConversation(request, env, url)
    }

    // Everything that is not the API is the SPA. It goes through the Worker
    // (assets.run_worker_first) instead of straight to the asset server so the
    // document carries the CSP and the rest of the security headers — a
    // header-less index.html is exactly the hole those headers exist to close.
    if (!url.pathname.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(request)
      const headers = new Headers(asset.headers)
      applySecurityHeaders(headers, { document: true, https })
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      })
    }

    const origin = request.headers.get('Origin')

    if (request.method === 'OPTIONS') {
      const headers = new Headers(corsHeaders(origin, url.origin, env))
      applySecurityHeaders(headers, { https })
      return new Response(null, { status: 204, headers })
    }

    const response = await route(request, env, url, ctx)
    // CORS and security headers applied centrally so route handlers only worry
    // about their payload.
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(corsHeaders(origin, url.origin, env))) {
      headers.set(key, value)
    }
    applySecurityHeaders(headers, { https })
    return new Response(response.body, { status: response.status, headers })
  },

  // Scheduled maintenance (see lib/cleanup.ts): expired sessions, stale rate
  // limit counters, orphaned uploads and — when enabled — media retention.
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(
      runCleanup(env)
        .then((report) => console.log('cleanup', report))
        .catch((error) => console.error('cleanup failed', error)),
    )
  },
} satisfies ExportedHandler<Env>
