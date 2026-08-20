import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { coarseLastSeen, isOnline } from '../lib/presence'
import { HOUR_MS, LOOKUP_QUOTA_PER_HOUR, consumeQuota } from '../lib/ratelimit'
import { PUBLIC_USER_COLUMNS, requireSession, sessionHeaders, type PublicUser } from '../lib/session'

// User discovery (PRD §3.2): exact/prefix match on @username only.
// Visibility model is Option A — every account in the closed instance is
// visible to every authenticated user. The caller is excluded from results
// (no conversation with oneself).
//
// ...with one exception, which is what keeps Option A from meaning "the whole
// directory is public". A guest account (POST /api/auth/temp) is minted by
// anybody, so a prefix search from one is a free enumeration of every account
// on the instance: thirty-six single-letter queries and the list is out. So a
// guest gets exact match only — it has to already know the handle it is looking
// for, which is the case guest accounts exist for (someone was given a link and
// a name). A permanent account, which only the owner can create, keeps the
// prefix search.
//
// The quota is the other half: exact match still enumerates, just slowly, and
// the search box is debounced so a real person never comes close to it.

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

  const quota = await consumeQuota(
    env.DB,
    `lookup:${auth.user.id}`,
    LOOKUP_QUOTA_PER_HOUR,
    HOUR_MS,
  )
  if (!quota.allowed) {
    return apiError('rate_limited', 429, 'too many searches, try again later', {
      'Retry-After': String(quota.retryAfterSeconds),
    })
  }

  // "_" is a valid username char but a LIKE wildcard — escape it (and "%", "\").
  const pattern = `${q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
  // Disabled accounts are invisible: nobody can start a thread with one. Same
  // for tombstones (migration 0004) — the row only exists to name a thread the
  // other side kept, not to be found or talked to.
  const match = auth.user.is_temp
    ? { clause: 'username = ?1', binding: q }
    : { clause: "username LIKE ?1 ESCAPE '\\'", binding: pattern }
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_USER_COLUMNS}
     FROM users
     WHERE ${match.clause} AND id != ?2
       AND disabled_at IS NULL AND deleted_at IS NULL
     ORDER BY username
     LIMIT ${MAX_RESULTS}`,
  )
    .bind(match.binding, auth.user.id)
    .all<PublicUser>()

  // Search results carry presence too: knowing whether someone is around is
  // part of deciding to message them.
  const now = Date.now()
  const users = results.map((row) => ({
    ...row,
    online: isOnline(row.last_seen_at, now),
    // Reported at minute granularity, like every other presence surface.
    last_seen_at: coarseLastSeen(row.last_seen_at),
  }))

  return json({ users }, 200, sessionHeaders(auth))
}
