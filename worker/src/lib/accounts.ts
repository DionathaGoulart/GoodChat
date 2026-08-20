// Temporary accounts (migration 0004) and the deletion rule that makes them
// safe for the person on the other side.
//
// Creation: POST /api/auth/temp mints a random username + password, sets
// `expires_at = now + TEMP_ACCOUNT_TTL_HOURS`, and signs the browser in. The
// credentials are shown once and never recoverable — the account is meant to
// die.
//
// Deletion is the interesting half. "Delete the account and everything it
// owns" would take the other side's history with it, which is wrong: a
// permanent account that talked to a guest keeps its conversation. So:
//
//   - conversation whose peer is still alive → kept, untouched. Messages and
//     media stay exactly as they are; media follows the conversation, not the
//     account that uploaded it.
//   - conversation whose peer is already a tombstone (or gone) → nobody is
//     left to read it: the DO wipes its storage, the bucket objects go, and
//     the D1 row goes. This is the "two guests talked, the second one to
//     expire takes the thread with it" case.
//   - uploads that never became a message → always deleted, they are garbage
//     by definition. Same for the profile picture: it belongs to the account,
//     not to any thread, so nothing survives it — and leaving it behind would
//     also pin the `users` row forever (see removeIfUnreferenced).
//   - sessions and push subscriptions → always deleted, explicitly: the FK
//     cascade never fires because the row survives as a tombstone.
//
// The `users` row itself is hard-deleted when nothing references it anymore
// (no conversations, no media objects); otherwise it stays as a tombstone —
// stripped of credentials and personal fields — so the surviving side's
// conversation list still has a name to render. See migration 0004.

import { hashPassword } from './password'
import { destroyConversation } from './purge'
import { deleteMediaObjects } from './mediaGc'

/** Defaults for the TEMP_* vars (wrangler.jsonc), used when they are unset. */
const DEFAULT_TTL_HOURS = 5
const DEFAULT_MAX_LIVE = 100
const DEFAULT_PER_IP_HOUR = 3

/** Username/password alphabet: no vowels-turned-slurs, no 0/O/1/l/i mixups. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const USERNAME_RANDOM_CHARS = 9
const PASSWORD_CHARS = 16
/** Collisions are astronomically unlikely; the retry is here for correctness. */
const USERNAME_ATTEMPTS = 5

export interface TempAccountConfig {
  enabled: boolean
  ttlMs: number
  maxLive: number
  perIpPerHour: number
}

export function tempAccountConfig(env: Env): TempAccountConfig {
  return {
    // Read as a plain string on purpose: `wrangler types` narrows a var to the
    // literal currently in wrangler.jsonc, and this is the switch an operator
    // flips at deploy time — comparing against the other value is the point,
    // not a mistake.
    enabled: String(env.TEMP_ACCOUNTS_ENABLED) !== 'false',
    ttlMs: positive(env.TEMP_ACCOUNT_TTL_HOURS, DEFAULT_TTL_HOURS) * 60 * 60 * 1000,
    maxLive: positive(env.TEMP_ACCOUNTS_MAX, DEFAULT_MAX_LIVE),
    perIpPerHour: positive(env.TEMP_ACCOUNTS_PER_IP_HOUR, DEFAULT_PER_IP_HOUR),
  }
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? '')
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export interface TempAccount {
  id: string
  username: string
  /** Plaintext, returned exactly once — never stored, never recoverable. */
  password: string
  expiresAt: number
}

/** How many temporary accounts are alive right now (the cap's input). */
export async function liveTempAccounts(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE is_temp = 1 AND deleted_at IS NULL AND expires_at > ?`,
    )
    .bind(now)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function createTempAccount(
  db: D1Database,
  ttlMs: number,
  now = Date.now(),
): Promise<TempAccount> {
  const password = randomString(PASSWORD_CHARS)
  const passwordHash = await hashPassword(password)
  const expiresAt = now + ttlMs

  for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
    const id = crypto.randomUUID()
    const username = `temp_${randomString(USERNAME_RANDOM_CHARS)}`
    try {
      await db
        .prepare(
          `INSERT INTO users
             (id, username, display_name, avatar_key, password_hash, created_at,
              role, created_by, is_temp, expires_at)
           VALUES (?1, ?2, NULL, NULL, ?3, ?4, 'user', NULL, 1, ?5)`,
        )
        .bind(id, username, passwordHash, now, expiresAt)
        .run()
      return { id, username, password, expiresAt }
    } catch (error) {
      // Only a username collision is retryable; anything else is a real fault.
      if (!String(error).includes('UNIQUE')) throw error
    }
  }
  throw new Error('could not allocate a temporary username')
}

export interface AccountDeletionReport {
  /** Threads left intact because the other account is still alive. */
  conversations_kept: number
  /** Threads removed because no live account was left to read them. */
  conversations_deleted: number
  messages_deleted: number
  media_deleted: number
  /** Rows actually removed from `users` (this account and freed tombstones). */
  accounts_removed: number
}

/**
 * Deletes one account without touching the history of the accounts it talked
 * to. See the module header for the full rule.
 */
export async function deleteAccountKeepingPeers(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<AccountDeletionReport> {
  const report: AccountDeletionReport = {
    conversations_kept: 0,
    conversations_deleted: 0,
    messages_deleted: 0,
    media_deleted: 0,
    accounts_removed: 0,
  }

  // LEFT JOIN: a conversation whose peer row is already gone (deleted by the
  // owner console, which removes rows outright) counts as "no one left".
  const { results: threads } = await env.DB.prepare(
    `SELECT c.id AS conversation_id, peer.id AS peer_id, peer.deleted_at AS peer_deleted_at
     FROM conversations c
     LEFT JOIN users peer
       ON peer.id = CASE WHEN c.user_a = ?1 THEN c.user_b ELSE c.user_a END
     WHERE c.user_a = ?1 OR c.user_b = ?1`,
  )
    .bind(userId)
    .all<{ conversation_id: string; peer_id: string | null; peer_deleted_at: number | null }>()

  const orphanedPeers = new Set<string>()
  for (const thread of threads) {
    const peerAlive = thread.peer_id !== null && thread.peer_deleted_at === null
    if (peerAlive) {
      report.conversations_kept += 1
      continue
    }
    const result = await destroyConversation(env, thread.conversation_id)
    report.conversations_deleted += 1
    report.messages_deleted += result.messages_deleted
    report.media_deleted += result.media_deleted
    if (thread.peer_id !== null) orphanedPeers.add(thread.peer_id)
  }

  report.media_deleted += await deletePersonalUploads(env, userId)

  // No cascade fires for a tombstone, and a live cookie must not outlive the
  // account it authenticates.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run()
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId).run()

  if (await removeIfUnreferenced(env.DB, userId)) {
    report.accounts_removed += 1
  } else {
    await tombstone(env.DB, userId, now)
  }

  // A peer that was only kept alive as a tombstone for this conversation can
  // finally go.
  for (const peerId of orphanedPeers) {
    if (await removeIfUnreferenced(env.DB, peerId, { tombstonesOnly: true })) {
      report.accounts_removed += 1
    }
  }

  return report
}

/**
 * Objects that belong to the account rather than to a thread: uploads that
 * never became a message, and the profile picture. Both are garbage regardless
 * of who survives — nobody else's history references them.
 */
async function deletePersonalUploads(env: Env, userId: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT key FROM media_objects
     WHERE user_id = ? AND (claimed_at IS NULL OR key LIKE 'avatars/%')`,
  )
    .bind(userId)
    .all<{ key: string }>()
  if (results.length === 0) return 0
  return deleteMediaObjects(env, results.map((row) => row.key))
}

/**
 * Hard-deletes the `users` row when nothing points at it anymore. Returns
 * false when something still does, in which case the caller leaves (or keeps)
 * a tombstone. `tombstonesOnly` guards the peer pass: a live account is never
 * removed by someone else's deletion.
 */
async function removeIfUnreferenced(
  db: D1Database,
  userId: string,
  { tombstonesOnly = false } = {},
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE user_a = ?1 OR user_b = ?1) AS conversations,
         (SELECT COUNT(*) FROM media_objects WHERE user_id = ?1) AS media,
         (SELECT deleted_at FROM users WHERE id = ?1) AS deleted_at`,
    )
    .bind(userId)
    .first<{ conversations: number; media: number; deleted_at: number | null }>()
  if (!row) return false
  if (row.conversations > 0 || row.media > 0) return false
  if (tombstonesOnly && row.deleted_at === null) return false

  const result = await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
  return (result.meta.changes ?? 0) > 0
}

/**
 * Strips the row down to what the surviving side's conversation list needs: an
 * id and a name that reads as gone. The username is derived from the id (so it
 * is unique and stable if this runs twice) and frees the original handle for
 * reuse.
 */
async function tombstone(db: D1Database, userId: string, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET
         username = ?2,
         display_name = NULL,
         avatar_key = NULL,
         password_hash = NULL,
         theme_mode = NULL,
         theme_light = NULL,
         theme_dark = NULL,
         skin = NULL,
         last_seen_at = NULL,
         deleted_at = ?3,
         disabled_at = COALESCE(disabled_at, ?3),
         expires_at = NULL
       WHERE id = ?1`,
    )
    .bind(userId, tombstoneUsername(userId), now)
    .run()
}

export function tombstoneUsername(userId: string): string {
  return `deleted_${userId.replaceAll('-', '').slice(0, 12)}`
}

export interface TempSweepReport {
  temp_accounts_deleted: number
  conversations_deleted: number
  tombstones_removed: number
}

/**
 * Deletes temporary accounts whose time is up. Bounded per run: whatever is
 * left over is picked up by the next tick. Access is already gone before this
 * runs — requireSession refuses an account past `expires_at` — so a late sweep
 * only delays the cleanup, never extends the account.
 */
export async function sweepExpiredTempAccounts(
  env: Env,
  now: number,
  limit: number,
): Promise<TempSweepReport> {
  const report: TempSweepReport = {
    temp_accounts_deleted: 0,
    conversations_deleted: 0,
    tombstones_removed: 0,
  }

  const { results } = await env.DB.prepare(
    `SELECT id FROM users
     WHERE is_temp = 1 AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?1
     ORDER BY expires_at LIMIT ?2`,
  )
    .bind(now, limit)
    .all<{ id: string }>()

  for (const row of results) {
    try {
      const result = await deleteAccountKeepingPeers(env, row.id, now)
      report.temp_accounts_deleted += 1
      report.conversations_deleted += result.conversations_deleted
      report.tombstones_removed += result.accounts_removed
    } catch (error) {
      console.error('temp account deletion failed', row.id, error)
    }
  }
  return report
}

/**
 * Tombstones whose last reference disappeared after they were created — the
 * owner console purged the conversation, or the surviving account was deleted
 * through another path. Nothing reads them anymore, so the row goes.
 */
export async function sweepOrphanTombstones(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT u.id FROM users u
     WHERE u.deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.user_a = u.id OR c.user_b = u.id)
       AND NOT EXISTS (SELECT 1 FROM media_objects m WHERE m.user_id = u.id)
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>()

  let removed = 0
  for (const row of results) {
    const result = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(row.id).run()
    removed += result.meta.changes ?? 0
  }
  return removed
}

function randomString(length: number): string {
  // Rejection sampling: 256 is not a multiple of the alphabet size, so plain
  // modulo would make the first characters of the alphabet more likely.
  const limit = 256 - (256 % ALPHABET.length)
  let out = ''
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length))
    for (const byte of bytes) {
      if (byte >= limit) continue
      out += ALPHABET[byte % ALPHABET.length]
      if (out.length === length) break
    }
  }
  return out
}
