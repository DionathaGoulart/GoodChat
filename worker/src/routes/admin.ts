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
//
// Every mutating call also writes one row to `admin_audit` (migration 0011) and
// the account whose password an owner resets is told about it by push. The
// power here is intentional; using it silently is not.

import { getAgentByName } from 'agents'
import { z } from 'zod'
import type { ConversationStats } from '../agent'
import { sweepOrphanTombstones } from '../lib/accounts'
import { recentAdminActions, recordAdminAction } from '../lib/audit'
import { runCleanup } from '../lib/cleanup'
import { apiError, json } from '../lib/http'
import { listObjects, mediaConfig } from '../lib/media'
import { deleteMediaObjects } from '../lib/mediaGc'
import { keysForUser, usageByUser } from '../lib/mediaIndex'
import { hashPassword } from '../lib/password'
import { notifyUser } from '../lib/push'
import { destroyConversation, purgeConversationHistory } from '../lib/purge'
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
  /** Guest account (migration 0004): 1 when temporary. */
  is_temp: number
  expires_at: number | null
  /** Set on a tombstone: the account is gone, the row names old threads. */
  deleted_at: number | null
}

interface ConversationRow {
  id: string
  user_a: string
  user_b: string
  created_at: number | null
  last_message_at: number | null
  /** D1's mirror of when the next message expires (migration 0009) — the
      fallback when the conversation's DO cannot be reached. */
  next_expiry_at: number | null
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
      is_temp: user.is_temp === 1,
      expires_at: user.expires_at,
      /** Tombstone: kept only so a surviving thread still has a name. */
      deleted: user.deleted_at !== null,
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
        // When the next message here dies (PRD §3.9). D1 mirrors it too, but
        // the DO is the authority and it is already being asked.
        next_expiry_at: s?.next_expiry_at ?? conversation.next_expiry_at,
        unread: s?.unread ?? 0,
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
  const now = Date.now()
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users,
       (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL AND deleted_at IS NULL) AS disabled_users,
       (SELECT COUNT(*) FROM users WHERE is_temp = 1 AND deleted_at IS NULL AND expires_at > ?1) AS temp_users,
       (SELECT COUNT(*) FROM users WHERE deleted_at IS NOT NULL) AS tombstones,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM media_objects) AS media_objects,
       (SELECT COALESCE(SUM(size), 0) FROM media_objects) AS media_bytes,
       (SELECT COUNT(*) FROM media_objects WHERE claimed_at IS NULL) AS unclaimed_objects,
       (SELECT COALESCE(SUM(size), 0) FROM media_objects WHERE claimed_at IS NULL) AS unclaimed_bytes`,
  )
    .bind(now)
    .first<{
      users: number
      disabled_users: number
      temp_users: number
      tombstones: number
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
      /** Guest accounts alive right now — the TEMP_ACCOUNTS_MAX cap's input. */
      temp_users: counts?.temp_users ?? 0,
      /** Deleted accounts still naming a thread somebody else kept. */
      tombstones: counts?.tombstones ?? 0,
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
      // What the console divides the two storage numbers by. Nothing enforces
      // these — they are the plan's ceiling, so the owner sees how much room is
      // left instead of a bare number.
      do_storage_limit_bytes: limitBytes(env.DO_STORAGE_LIMIT_GB, 5),
      bucket_limit_bytes: limitBytes(env.B2_STORAGE_LIMIT_GB, 10),
      retention_days: Number(env.MEDIA_RETENTION_DAYS ?? 0) || null,
      // Mirrors routes/media.ts exactly: only the literal "allow" opens the
      // legacy door, so anything else — including unset — is "deny". Reported
      // the other way round, the console told an operator the door was open on
      // an instance where it was shut, and vice versa on a fresh deploy.
      legacy_media_reads: env.MEDIA_LEGACY_READS === 'allow' ? 'allow' : 'deny',
    },
    200,
    sessionHeaders(owner.auth),
  )
}

/** GiB, matching how the console formats bytes. */
const GIB = 1024 ** 3

/**
 * Reads a storage ceiling expressed in GB. "0" (or anything unparseable) turns
 * the quota off and the console falls back to showing the raw usage.
 */
function limitBytes(value: string | undefined, fallbackGb: number): number | null {
  const gb = value === undefined || value.trim() === '' ? fallbackGb : Number(value)
  if (!Number.isFinite(gb) || gb <= 0) return null
  return Math.round(gb * GIB)
}

// --- account management --------------------------------------------------

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  display_name: z.string().trim().min(1).max(64).optional(),
})

/**
 * POST /api/admin/users — the owner panel's replacement for the CLI.
 *
 * The owner types the password, so the owner knows it, so the server knows it:
 * this account starts on the legacy side of migration 0013 with `must_rotate`
 * set, and the person replaces it with one only they know the first time they
 * sign in. There is no way around that from here — deriving `authToken` needs
 * the password, and if this route had it the whole point would be gone.
 */
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
    `INSERT INTO users (id, username, display_name, avatar_key, password_hash, created_at, role, created_by, must_rotate)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'user', ?6, 1)`,
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

  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'user.create',
    target: { id, username },
  })

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

  // Placeholders are numbered off `bindings`, not off `sets`: the password
  // branch adds three assignments that bind nothing (`= NULL`, `= 1`), so the
  // two lengths stopped agreeing the moment it did.
  const sets: string[] = []
  const bindings: unknown[] = []
  const placeholder = () => `?${bindings.length + 1}`
  if (parsed.display_name !== undefined) {
    sets.push(`display_name = ${placeholder()}`)
    bindings.push(parsed.display_name)
  }
  if (parsed.password !== undefined) {
    sets.push(`password_hash = ${placeholder()}`)
    bindings.push(await hashPassword(parsed.password))
    // A password the owner chose is a password the server knows, which is the
    // legacy shape by definition — so the account goes back to it, salt and
    // all, and the person is made to replace it on their next sign-in
    // (migration 0013). `kdf_salt IS NULL` alongside `must_rotate = 1` is the
    // invariant; writing one without the other would leave an account whose
    // stored salt no longer describes its stored hash, which is an account
    // nobody can sign in to.
    sets.push('kdf_salt = NULL', 'kdf_iterations = NULL', 'must_rotate = 1')
  }
  if (parsed.disabled !== undefined) {
    sets.push(`disabled_at = ${placeholder()}`)
    bindings.push(parsed.disabled ? Date.now() : null)
  }
  if (parsed.role !== undefined) {
    sets.push(`role = ${placeholder()}`)
    bindings.push(parsed.role)
  }
  if (sets.length === 0) return apiError('invalid_request', 400, 'nothing to update')

  const where = placeholder()
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ${where}`)
    .bind(...bindings, target.id)
    .run()

  // A new password or a disable must not leave old cookies working.
  if (parsed.password !== undefined || parsed.disabled === true) {
    await revokeAllSessions(env.DB, target.id)
  }

  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    // The password reset gets its own code: it is the one edit that hands
    // somebody else's account over, and a console filter on "who was taken
    // over" should not have to read a details blob to find it.
    action: parsed.password !== undefined ? 'user.password_reset' : 'user.update',
    target,
    details: {
      fields: Object.keys(parsed).sort(),
      ...(parsed.disabled !== undefined ? { disabled: parsed.disabled } : {}),
      ...(parsed.role !== undefined ? { role: parsed.role } : {}),
    },
  })

  // What the account owner would otherwise see is being signed out, which
  // reads as an expired session rather than as somebody else holding their
  // credentials. Skipped when an owner resets its own password.
  if (parsed.password !== undefined && target.id !== owner.auth.user.id) {
    await notifyUser(env, target.id, {
      title: 'GoodChat',
      body: `a senha da sua conta foi redefinida por @${owner.auth.user.username}`,
      url: '/#/config',
      tag: 'account-security',
    })
  }

  return json({ ok: true }, 200, sessionHeaders(owner.auth))
}

/**
 * DELETE /api/admin/users/:id — removes the account and everything it owns:
 * every conversation it took part in, its bucket objects, sessions and push
 * subscriptions (the last two cascade from the foreign key).
 *
 * This is the blunt one, on purpose: the owner asking for an account to
 * disappear takes the other side's copy of those threads with it. The guest
 * expiry (lib/accounts.ts) is the careful one — it keeps every conversation
 * whose other participant is still around.
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

  const { results } = await env.DB.prepare(
    'SELECT id FROM conversations WHERE user_a = ?1 OR user_b = ?1',
  )
    .bind(target.id)
    .all<{ id: string }>()

  const totals: PurgeResult = {
    conversations_purged: 0,
    messages_deleted: 0,
    media_deleted: 0,
  }
  for (const row of results) {
    const result = await destroyConversation(env, row.id)
    totals.conversations_purged += 1
    totals.messages_deleted += result.messages_deleted
    totals.media_deleted += result.media_deleted
  }

  // Whatever the conversations did not cover: uploads that never became a
  // message, and objects from threads purged earlier.
  const ownKeys = await keysForUser(env.DB, target.id)
  totals.media_deleted += await deleteMediaObjects(
    env,
    ownKeys,
    new URL(request.url).origin,
  )

  // `users.created_by` is a foreign key back into this table (migration 0003)
  // and it has no ON DELETE clause, so an account that provisioned others
  // cannot be deleted while they point at it — the DELETE below would fail
  // *after* every conversation was already destroyed, leaving an account alive
  // with no history and no audit row. It only bites for a demoted ex-owner
  // (manageableTarget refuses live owners), which is exactly the case worth
  // surviving. The provenance is worth less than the deletion completing.
  await env.DB.prepare('UPDATE users SET created_by = NULL WHERE created_by = ?')
    .bind(target.id)
    .run()
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run()
  // The peers of the destroyed threads may have been tombstones kept alive
  // only by them.
  const tombstonesRemoved = await sweepOrphanTombstones(env, 50)

  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'user.delete',
    target,
    details: { ...totals, tombstones_removed: tombstonesRemoved },
  })

  return json(
    { ok: true, ...totals, tombstones_removed: tombstonesRemoved },
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
  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'user.purge_history',
    target,
    details: result as unknown as Record<string, unknown>,
  })
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
  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'conversation.purge',
    target: { id: conversationId },
    details: result as unknown as Record<string, unknown>,
  })
  return json({ ok: true, ...result }, 200, sessionHeaders(owner.auth))
}

// --- maintenance ---------------------------------------------------------

/** POST /api/admin/cleanup — runs the cron's work now. */
export async function runCleanupNow(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner
  const report = await runCleanup(env)
  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'maintenance.cleanup',
    details: report as unknown as Record<string, unknown>,
  })
  return json(report, 200, sessionHeaders(owner.auth))
}

/** GET /api/admin/audit — the trail itself (migration 0011). */
export async function listAuditLog(request: Request, env: Env): Promise<Response> {
  const owner = await requireOwner(request, env)
  if (owner instanceof Response) return owner
  return json({ entries: await recentAdminActions(env.DB) }, 200, sessionHeaders(owner.auth))
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

  await recordAdminAction(env.DB, {
    actor: owner.auth.user,
    action: 'media.reindex',
    details: { indexed },
  })

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
    `SELECT id, username, display_name, created_at, role, created_by, disabled_at,
            is_temp, expires_at, deleted_at
     FROM users ORDER BY username`,
  )
    .all<UserRow>()
    .then(({ results }) => results)
}

function allConversations(env: Env): Promise<ConversationRow[]> {
  return env.DB.prepare(
    'SELECT id, user_a, user_b, created_at, last_message_at, next_expiry_at FROM conversations',
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
 * Walks the bucket. Only the overview pays for this.
 *
 * Every prefix, not just `media/`: the console shows this number against the
 * plan's ceiling and next to `indexed_media_bytes`, and the gap between the two
 * is what tells an operator a reindex is due. Counting only message attachments
 * understated the bill by every profile picture and the whole sticker pack, and
 * made the gap read as "the index is fine" when it was not.
 */
const BUCKET_PREFIXES = ['media/', 'avatars/', 'stickers/']

async function bucketTotals(env: Env): Promise<{ objects: number; bytes: number } | null> {
  const config = mediaConfig(env)
  if (!config) return null
  try {
    let objects = 0
    let bytes = 0
    for (const prefix of BUCKET_PREFIXES) {
      let token: string | undefined
      // Bounded: 20 pages of 1000 keys is far past what this instance can hold.
      for (let page = 0; page < 20; page += 1) {
        const result = await listObjects(config, prefix, token)
        for (const object of result.objects) {
          objects += 1
          bytes += object.size
        }
        if (!result.nextToken) break
        token = result.nextToken
      }
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
