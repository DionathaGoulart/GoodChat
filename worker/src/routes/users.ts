import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { requireSession, type SessionUser } from '../lib/session'

// User discovery (PRD §3.2): exact/prefix match on @username only.
// Visibility model is Option A — every account in the closed instance is
// visible to every authenticated user. The caller is excluded from results
// (no conversation with oneself).

const LookupSchema = z.object({ q: z.string().trim().min(1).max(64) })

const MAX_RESULTS = 20

export async function lookupUsers(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  const parsed = LookupSchema.safeParse({ q: url.searchParams.get('q') ?? '' })
  if (!parsed.success) {
    return apiError('invalid_request', 400, 'q must be a non-empty string')
  }

  // Accept "@bob" and "bob" alike; usernames are stored lowercase.
  const q = parsed.data.q.replace(/^@/, '').toLowerCase()
  if (q.length === 0) return apiError('invalid_request', 400, 'q must be a non-empty string')

  // "_" is a valid username char but a LIKE wildcard — escape it (and "%", "\").
  const pattern = `${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  const { results } = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, created_at
     FROM users
     WHERE username LIKE ?1 ESCAPE '\\' AND id != ?2
     ORDER BY username
     LIMIT ${MAX_RESULTS}`,
  )
    .bind(pattern, auth.user.id)
    .all<SessionUser>()

  return json(
    { users: results },
    200,
    auth.refreshedCookie ? { 'Set-Cookie': auth.refreshedCookie } : undefined,
  )
}
