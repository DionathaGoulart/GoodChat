// Owner console (/api/admin/*). One role gate, one rule: an owner administers
// every account except another owner, and cannot destroy itself.
//
// What it answers, and why each number comes from where it does:
//   - message/D1 bytes per account: only the Durable Objects know the messages,
//     so each conversation is asked for its own stats and the totals are
//     attributed to the sender. `storage_bytes` is the DO's real page count —
//     the figure that maps to cost — and is reported per conversation, since
//     the two participants share one database.
//   - bucket bytes per account: from the media index (migration 0003), whose
//     `size` is the signed Content-Length B2 enforced on upload. No bucket
//     listing needed; the overview does list it once, to surface objects that
//     the index does not know about (pre-0003 uploads, the sticker pack).
//
// Destructive endpoints delete bucket objects before forgetting index rows, so
// a failed delete is retried by the next sweep instead of leaking.

import { getAgentByName } from 'agents'
import { z } from 'zod'
import type { ConversationStats } from '../agent'
import { runCleanup } from '../lib/cleanup'
import { apiError, json } from '../lib/http'
import { deleteObjects, listObjects, mediaConfig } from '../lib/media'
import { forgetKeys, keysForUser, usageByUser } from '../lib/mediaIndex'
import { hashPassword } from '../lib/password'
import {
  requireSession,
  revokeAllSessions,
  sessionHeaders,
  type AuthContext,
} from '../lib/session'
import { ROLES, canonicalUsername, validateCredentials } from '../lib/users'

/** DO stat requests in flight at once. */
const STATS_CONCURRENCY = 8

interface OwnerContext {
  auth: AuthContext
}

async function requireOwner(request: Request, env: Env): Promise<OwnerContext | Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth
  if (auth.user.role !== 'owner') return apiError('forbidden', 403, 'owner role required')
  return { auth }
}

interface UserRow {
  id: string
  username: string
  display_name: string | null
  created_at: number
  role: string
  created_by: string | null
  disabled_at: number | null
}

interface ConversationRow {
  id: string
  user_a: string
  user_b: string
  created_at: number | null
  last_message_at: number | null
}

// --- reads ---------------------------------------------------------------

/**
 * GET /api/admin/users — every account with its storage footprint.
 * One pass over the conversations gives both the per-account message totals
 * and the per-conversation rows the UI needs, so the DOs are asked once.
 */
export async function listAccounts(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const [users, conversations] = await Promise.all([
    allUsers(env),
    allConversations(env),
  ])
  const stats = await collectStats(env, conversations)
  const mediaUsage = await usageByUser(env.DB)

  const accounts = users.map((user) => {
    let messages = 0
    let bodyBytes = 0
    let conversationCount = 0
    let lastActivity: number | null = null

    for (const { conversation, stats: s } of stats) {
      if (conversation.user_a !== user.id && conversation.user_b !== user.id) continue
      conversationCount += 1
      if (s?.last_at && (lastActivity === null || s.last_at > lastActivity)) {
        lastActivity = s.last_at
      }
      const mine = s?.per_sender.find((sender) => sender.user_id === user.id)
      messages += mine?.messages ?? 0
      bodyBytes += mine?.body_bytes ?? 0
    }

    const media = mediaUsage.get(user.id) ?? { bytes: 0, count: 0 }
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      created_at: user.created_at,
      role: user.role,
      created_by: user.created_by,
      disabled: user.disabled_at !== null,
      conversations: conversationCount,
      messages,
      /** Message payload attributed to this account (D1/DO side). */
      db_bytes: bodyBytes,
      media_bytes: media.bytes,
      media_objects: media.count,
      total_bytes: bodyBytes + media.bytes,
      last_activity_at: lastActivity,
    }
  })

  return json({ users: accounts }, 200, sessionHeaders(owner.auth))
}

/** GET /api/admin/conversations — every thread, with who is in it and its size. */
export async function listAllConversations(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const [users, conversations] = await Promise.all([allUsers(env), allConversations(env)])
  const byId = new Map(users.map((user) => [user.id, user]))
  const stats = await collectStats(env, conversations)

  return json(
    {
      conversations: stats.map(({ conversation, stats: s }) => ({
        id: conversation.id,
        created_at: conversation.created_at,
        last_message_at: conversation.last_message_at,
        participants: [conversation.user_a, conversation.user_b].map((id) => ({
          id,
          username: byId.get(id)?.username ?? '(conta removida)',
        })),
        messages: s?.messages ?? 0,
        body_bytes: s?.body_bytes ?? 0,
        storage_bytes: s?.storage_bytes ?? 0,
        media_objects: s?.media.length ?? 0,
        unreachable: s === null,
      })),
    },
    200,
    sessionHeaders(owner.auth),
  )
}

/** GET /api/admin/overview — instance totals, including what the bucket really holds. */
export async function overview(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const conversations = await allConversations(env)
  const stats = await collectStats(env, conversations)
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled_users,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM media_objects) AS media_objects,
       (SELECT COALESCE(SUM(size), 0) FROM media_objects) AS media_bytes,
       (SELECT COUNT(*) FROM media_objects WHERE claimed_at IS NULL) AS unclaimed_objects,
       (SELECT COALESCE(SUM(size), 0) FROM media_objects WHERE claimed_at IS NULL) AS unclaimed_bytes`,
  ).first<{
    users: number
    disabled_users: number
    sessions: number
    media_objects: number
    media_bytes: number
    unclaimed_objects: number
    unclaimed_bytes: number
  }>()

  const bucket = await bucketTotals(env)

  return json(
    {
      users: counts?.users ?? 0,
      disabled_users: counts?.disabled_users ?? 0,
      sessions: counts?.sessions ?? 0,
      conversations: conversations.length,
      messages: stats.reduce((sum, entry) => sum + (entry.stats?.messages ?? 0), 0),
      do_storage_bytes: stats.reduce((sum, entry) => sum + (entry.stats?.storage_bytes ?? 0), 0),
      indexed_media_objects: counts?.media_objects ?? 0,
      indexed_media_bytes: counts?.media_bytes ?? 0,
      unclaimed_objects: counts?.unclaimed_objects ?? 0,
      unclaimed_bytes: counts?.unclaimed_bytes ?? 0,
      // Null when B2 is not configured or the listing failed — the difference
      // against indexed_media_bytes is what a reindex would pick up.
      bucket_objects: bucket?.objects ?? null,
      bucket_bytes: bucket?.bytes ?? null,
      retention_days: Number(env.MEDIA_RETENTION_DAYS ?? 0) || null,
      legacy_media_reads: env.MEDIA_LEGACY_READS === 'deny' ? 'deny' : 'allow',
    },
    200,
    sessionHeaders(owner.auth),
  )
}

// --- account management --------------------------------------------------

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  display_name: z.string().trim().min(1).max(64).optional(),
})

/** POST /api/admin/users — the owner panel's replacement for the CLI. */
export async function createAccount(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const parsed = await parseBody(request, CreateUserSchema)
  if (parsed instanceof Response) return parsed

  const username = canonicalUsername(parsed.username)
  const invalid = validateCredentials(username, parsed.password)
  if (invalid) return apiError('invalid_request', 400, invalid)

  const existing = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
    .bind(username)
    .first()
  if (existing) return apiError('username_taken', 409, 'username already exists')

  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO users (id, username, display_name, avatar_url, password_hash, created_at, role, created_by)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'user', ?6)`,
  )
    .bind(
      id,
      username,
      parsed.display_name ?? username,
      await hashPassword(parsed.password),
      Date.now(),
      owner.auth.user.id,
    )
    .run()

  return json({ id, username }, 201, sessionHeaders(owner.auth))
}

const UpdateUserSchema = z.object({
  display_name: z.string().trim().min(1).max(64).optional(),
  password: z.string().min(1).max(256).optional(),
  disabled: z.boolean().optional(),
  role: z.enum(ROLES).optional(),
})

/** PATCH /api/admin/users/:id — rename, reset password, disable, promote. */
export async function updateAccount(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const target = await manageableTarget(env, owner.auth, userId, { allowSelf: true })
  if (target instanceof Response) return target

  const parsed = await parseBody(request, UpdateUserSchema)
  if (parsed instanceof Response) return parsed

  // Self-protection: an owner that disables or demotes itself locks the
  // instance out of its own console, with no other way back in.
  if (target.id === owner.auth.user.id && (parsed.disabled === true || parsed.role === 'user')) {
    return apiError('invalid_request', 400, 'an owner cannot disable or demote itself')
  }
  if (parsed.password !== undefined) {
    const invalid = validateCredentials(target.username, parsed.password)
    if (invalid) return apiError('invalid_request', 400, invalid)
  }

  const sets: string[] = []
  const bindings: unknown[] = []
  if (parsed.display_name !== undefined) {
    sets.push(`display_name = ?${sets.length + 1}`)
    bindings.push(parsed.display_name)
  }
  if (parsed.password !== undefined) {
    sets.push(`password_hash = ?${sets.length + 1}`)
    bindings.push(await hashPassword(parsed.password))
  }
  if (parsed.disabled !== undefined) {
    sets.push(`disabled_at = ?${sets.length + 1}`)
    bindings.push(parsed.disabled ? Date.now() : null)
  }
  if (parsed.role !== undefined) {
    sets.push(`role = ?${sets.length + 1}`)
    bindings.push(parsed.role)
  }
  if (sets.length === 0) return apiError('invalid_request', 400, 'nothing to update')

  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${sets.length + 1}`)
    .bind(...bindings, target.id)
    .run()

  // A new password or a disable must not leave old cookies working.
  if (parsed.password !== undefined || parsed.disabled === true) {
    await revokeAllSessions(env.DB, target.id)
  }

  return json({ ok: true }, 200, sessionHeaders(owner.auth))
}

/**
 * DELETE /api/admin/users/:id — removes the account and everything it owns:
 * conversation histories it took part in, its bucket objects, sessions and
 * push subscriptions (the last two cascade from the foreign key).
 */
export async function deleteAccount(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const target = await manageableTarget(env, owner.auth, userId)
  if (target instanceof Response) return target

  const purged = await purgeUserHistory(env, target.id)
  const ownKeys = await keysForUser(env.DB, target.id)
  const config = mediaConfig(env)
  if (config && ownKeys.length > 0) {
    await forgetKeys(env.DB, await deleteObjects(config, ownKeys))
  }

  await env.DB.prepare('DELETE FROM conversations WHERE user_a = ?1 OR user_b = ?1')
    .bind(target.id)
    .run()
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run()

  return json(
    { ok: true, ...purged, media_deleted: purged.media_deleted + ownKeys.length },
    200,
    sessionHeaders(owner.auth),
  )
}

/** POST /api/admin/users/:id/purge — wipes histories, keeps the account. */
export async function purgeAccountHistory(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const target = await manageableTarget(env, owner.auth, userId, { allowSelf: true })
  if (target instanceof Response) return target

  const result = await purgeUserHistory(env, target.id)
  return json({ ok: true, ...result }, 200, sessionHeaders(owner.auth))
}

/** POST /api/admin/conversations/:id/purge — wipes one thread. */
export async function purgeConversation(
  request: Request,
  env: Env,
  conversationId: string,
): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  if (!/^[0-9a-f]{32}$/.test(conversationId)) {
    return apiError('invalid_request', 400, 'malformed conversation id')
  }
  const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?')
    .bind(conversationId)
    .first()
  if (!exists) return apiError('not_found', 404)

  const result = await purgeConversationHistory(env, conversationId)
  return json({ ok: true, ...result }, 200, sessionHeaders(owner.auth))
}

// --- maintenance ---------------------------------------------------------

/** POST /api/admin/cleanup — runs the cron's work now. */
export async function runCleanupNow(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner
  return json(await runCleanup(env), 200, sessionHeaders(owner.auth))
}

/**
 * POST /api/admin/media/reindex — backfills the media index from the Durable
 * Objects for objects uploaded before migration 0003. Once this reports no
 * missing keys, MEDIA_LEGACY_READS can be flipped to "deny" and the media
 * proxy stops trusting unguessable keys entirely.
 */
export async function reindexMedia(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner

  const conversations = await allConversations(env)
  const stats = await collectStats(env, conversations)
  const { results } = await env.DB.prepare('SELECT key FROM media_objects').all<{ key: string }>()
  const known = new Set(results.map((row) => row.key))

  const config = mediaConfig(env)
  let indexed = 0
  const now = Date.now()

  for (const { conversation, stats: s } of stats) {
    for (const object of s?.media ?? []) {
      if (known.has(object.key)) continue
      known.add(object.key)
      // The bucket knows the real size; without B2 configured the row still
      // gets created (size 0) so authorization works — only accounting suffers.
      const size = config ? await objectSize(env, object.key) : 0
      await env.DB.prepare(
        `INSERT INTO media_objects (key, user_id, conversation_id, mime, size, created_at, claimed_at)
         VALUES (?1, ?2, ?3, 'application/octet-stream', ?4, ?5, ?5)
         ON CONFLICT(key) DO NOTHING`,
      )
        .bind(object.key, object.user_id, conversation.id, size, now)
        .run()
      indexed += 1
    }
  }

  return json({ ok: true, indexed }, 200, sessionHeaders(owner.auth))
}

// --- helpers -------------------------------------------------------------

async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, parsed.error.issues[0]?.message ?? 'invalid body')
  }
  return parsed.data
}

/**
 * Resolves the target of an admin action and enforces the hierarchy: an owner
 * never administers another owner. Destructive actions additionally refuse the
 * caller's own account (`allowSelf` opens the non-destructive ones).
 */
async function manageableTarget(
  env: Env,
  auth: AuthContext,
  userId: string,
  { allowSelf = false } = {},
): Promise<UserRow | Response> {
  const target = await env.DB.prepare(
    'SELECT id, username, display_name, created_at, role, created_by, disabled_at FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<UserRow>()
  if (!target) return apiError('not_found', 404, 'user not found')
  if (target.id === auth.user.id && !allowSelf) {
    return apiError('forbidden', 403, 'cannot perform this action on your own account')
  }
  if (target.role === 'owner' && target.id !== auth.user.id) {
    return apiError('forbidden', 403, 'owners cannot administer other owners')
  }
  return target
}

function allUsers(env: Env): Promise<UserRow[]> {
  return env.DB.prepare(
    `SELECT id, username, display_name, created_at, role, created_by, disabled_at
     FROM users ORDER BY username`,
  )
    .all<UserRow>()
    .then(({ results }) => results)
}

function allConversations(env: Env): Promise<ConversationRow[]> {
  return env.DB.prepare(
    'SELECT id, user_a, user_b, created_at, last_message_at FROM conversations',
  )
    .all<ConversationRow>()
    .then(({ results }) => results)
}

interface StatsEntry {
  conversation: ConversationRow
  stats: ConversationStats | null
}

/** Asks every conversation's DO for its stats, bounded concurrency. */
async function collectStats(env: Env, conversations: ConversationRow[]): Promise<StatsEntry[]> {
  const entries: StatsEntry[] = []
  for (let i = 0; i < conversations.length; i += STATS_CONCURRENCY) {
    const batch = conversations.slice(i, i + STATS_CONCURRENCY)
    const resolved = await Promise.all(
      batch.map(async (conversation) => ({
        conversation,
        stats: await conversationStats(env, conversation.id),
      })),
    )
    entries.push(...resolved)
  }
  return entries
}

async function conversationStats(env: Env, id: string): Promise<ConversationStats | null> {
  try {
    const agent = await getAgentByName(env.ConversationAgent, id)
    const response = await agent.fetch('https://do/stats')
    if (!response.ok) return null
    return await response.json<ConversationStats>()
  } catch (error) {
    console.error('conversation stats failed', id, error)
    return null
  }
}

interface PurgeResult {
  conversations_purged: number
  messages_deleted: number
  media_deleted: number
}

async function purgeUserHistory(env: Env, userId: string): Promise<PurgeResult> {
  const { results } = await env.DB.prepare(
    'SELECT id FROM conversations WHERE user_a = ?1 OR user_b = ?1',
  )
    .bind(userId)
    .all<{ id: string }>()

  const total: PurgeResult = {
    conversations_purged: 0,
    messages_deleted: 0,
    media_deleted: 0,
  }
  for (const row of results) {
    const result = await purgeConversationHistory(env, row.id)
    total.conversations_purged += 1
    total.messages_deleted += result.messages_deleted
    total.media_deleted += result.media_deleted
  }
  return total
}

/**
 * Wipes one conversation: the DO's messages first (it hands back the media
 * keys it referenced), then the bucket objects, then the index rows for the
 * keys the bucket confirmed gone. The D1 `conversations` row stays — the pair
 * can keep talking, they just have no history.
 */
async function purgeConversationHistory(
  env: Env,
  conversationId: string,
): Promise<{ messages_deleted: number; media_deleted: number }> {
  let messagesDeleted = 0
  const keys = new Set<string>()

  try {
    const agent = await getAgentByName(env.ConversationAgent, conversationId)
    const response = await agent.fetch('https://do/purge', { method: 'POST' })
    if (response.ok) {
      const result = await response.json<{ deleted: number; media_keys: string[] }>()
      messagesDeleted = result.deleted
      for (const key of result.media_keys) keys.add(key)
    }
  } catch (error) {
    console.error('conversation purge failed', conversationId, error)
  }

  // The index catches objects the DO no longer remembers (a previous partial
  // purge, or an upload claimed by a message that was already gone).
  const { results } = await env.DB.prepare(
    'SELECT key FROM media_objects WHERE conversation_id = ?',
  )
    .bind(conversationId)
    .all<{ key: string }>()
  for (const row of results) keys.add(row.key)

  const config = mediaConfig(env)
  if (!config || keys.size === 0) return { messages_deleted: messagesDeleted, media_deleted: 0 }

  const deleted = await deleteObjects(config, [...keys])
  await forgetKeys(env.DB, deleted)
  return { messages_deleted: messagesDeleted, media_deleted: deleted.length }
}

/** Walks the whole `media/` prefix. Only the overview pays for this. */
async function bucketTotals(env: Env): Promise<{ objects: number; bytes: number } | null> {
  const config = mediaConfig(env)
  if (!config) return null
  try {
    let objects = 0
    let bytes = 0
    let token: string | undefined
    // Bounded: 20 pages of 1000 keys is far past what this instance can hold.
    for (let page = 0; page < 20; page += 1) {
      const result = await listObjects(config, 'media/', token)
      for (const object of result.objects) {
        objects += 1
        bytes += object.size
      }
      if (!result.nextToken) break
      token = result.nextToken
    }
    return { objects, bytes }
  } catch (error) {
    console.error('bucket listing failed', error)
    return null
  }
}

/** Size of a single object, for the reindex backfill. 0 when unknown. */
async function objectSize(env: Env, key: string): Promise<number> {
  const config = mediaConfig(env)
  if (!config) return 0
  try {
    const result = await listObjects(config, key)
    return result.objects.find((object) => object.key === key)?.size ?? 0
  } catch {
    return 0
  }
}
