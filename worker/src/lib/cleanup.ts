// Scheduled maintenance (wrangler.jsonc `triggers.crons` → the `scheduled`
// handler in index.ts). Eight jobs, all idempotent and all bounded so one run
// never exceeds the Worker CPU budget — whatever is left over is picked up by
// the next tick.
//
//   1. expired sessions — requireSession only deletes the row it happens to
//      touch, so without this the table grows forever;
//   2. stale rate-limit counters — same story for login_attempts;
//   3. expired guest accounts — a temporary account past its `expires_at` and
//      everything only it could see (lib/accounts.ts). Its access already
//      ended the second the clock passed, so this run is about the data;
//   4. orphan tombstones — a deleted account whose last conversation went away
//      afterwards has nothing left to name;
//   5. orphan media — an upload that was presigned (or even completed) but
//      whose message never landed is unreachable bytes in the bucket. Nothing
//      else will ever find it: only the media index knows it exists;
//   6. instance-wide media cap — deletes claimed media older than
//      MEDIA_RETENTION_DAYS. OFF by default (unset/0) and orthogonal to the
//      per-conversation window below: this one is an operator's ceiling on the
//      bucket, not a product promise. Profile pictures are exempt: they are not
//      history, and a window that blanked everyone's avatar would be a bug;
//   7. conversation retention, media half — bucket objects whose conversation
//      window (migration 0008) has passed. The Durable Object deletes its own
//      objects the moment a message expires; this catches what a failed DELETE
//      left behind, and what belongs to a conversation nobody opens anymore;
//   8. conversation retention, message half — pokes the conversations that
//      hold at least one expired message so they empty themselves even if their
//      alarm was lost. `next_expiry_at` (migration 0009, mirrored by the DO) is
//      what makes "at least one" answerable from D1; `swept_at` keeps the same
//      idle threads from being poked again on every tick.

import { getAgentByName } from 'agents'
import { sweepExpiredTempAccounts, sweepOrphanTombstones } from './accounts'
import { mediaConfig } from './media'
import { deleteMediaObjects } from './mediaGc'
import { UNCLAIMED_TTL_MS } from './mediaIndex'
import { LOGIN_TRUST_TTL_MS, TRUSTED_KEY_PREFIX } from './ratelimit'

/** Objects deleted per run, per job. Bounds both CPU time and B2 calls. */
const MAX_DELETES_PER_RUN = 200

/**
 * Guest accounts torn down per run. Each one may destroy conversations and
 * delete bucket objects, so this is deliberately far below the object budget.
 */
const MAX_TEMP_ACCOUNTS_PER_RUN = 25
const MAX_TOMBSTONES_PER_RUN = 50

/**
 * Conversations woken per run by the retention backstop. Each one is a Durable
 * Object round trip, so this is small on purpose: the alarm inside the DO is
 * the mechanism, and this is only the net under it.
 */
const MAX_CONVERSATIONS_PER_RUN = 20

const LOGIN_ATTEMPT_TTL_MS = 60 * 60 * 1000

export interface CleanupReport {
  sessions_deleted: number
  login_attempts_deleted: number
  temp_accounts_deleted: number
  temp_conversations_deleted: number
  tombstones_removed: number
  orphan_media_deleted: number
  expired_media_deleted: number
  retention_media_deleted: number
  retention_conversations_swept: number
}

export async function runCleanup(env: Env, now = Date.now()): Promise<CleanupReport> {
  const report: CleanupReport = {
    sessions_deleted: 0,
    login_attempts_deleted: 0,
    temp_accounts_deleted: 0,
    temp_conversations_deleted: 0,
    tombstones_removed: 0,
    orphan_media_deleted: 0,
    expired_media_deleted: 0,
    retention_media_deleted: 0,
    retention_conversations_swept: 0,
  }

  const sessions = await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .bind(now)
    .run()
  report.sessions_deleted = sessions.meta.changes ?? 0

  // Two clocks in one table: failure counters die in an hour, while the rows
  // that vouch for an address the account has signed in from before (see
  // lib/ratelimit.ts) are meant to last, and expire on their own TTL.
  const attempts = await env.DB.prepare(
    `DELETE FROM login_attempts
     WHERE (key NOT LIKE ?1 AND window_start <= ?2)
        OR (key LIKE ?1 AND window_start <= ?3)`,
  )
    .bind(`${TRUSTED_KEY_PREFIX}%`, now - LOGIN_ATTEMPT_TTL_MS, now - LOGIN_TRUST_TTL_MS)
    .run()
  report.login_attempts_deleted = attempts.meta.changes ?? 0

  // Before the media sweeps: tearing an account down is what turns its claimed
  // objects into deletable ones (or leaves them attached to a thread that
  // survived it).
  const temp = await sweepExpiredTempAccounts(env, now, MAX_TEMP_ACCOUNTS_PER_RUN)
  report.temp_accounts_deleted = temp.temp_accounts_deleted
  report.temp_conversations_deleted = temp.conversations_deleted
  report.tombstones_removed =
    temp.tombstones_removed + (await sweepOrphanTombstones(env, MAX_TOMBSTONES_PER_RUN))

  // Message expiry does not depend on the bucket being configured: the rows
  // are what the promise is about, and the DO deletes its own objects.
  report.retention_conversations_swept = await sweepExpiredConversations(env, now)

  const config = mediaConfig(env)
  if (!config) return report

  report.retention_media_deleted = await sweep(
    env,
    `SELECT m.key FROM media_objects m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.claimed_at IS NOT NULL
       AND m.created_at <= ?1 - c.retention_ms
       AND m.key NOT LIKE 'avatars/%'
     ORDER BY m.created_at LIMIT ?2`,
    [now, MAX_DELETES_PER_RUN],
  )

  report.orphan_media_deleted = await sweep(
    env,
    `SELECT key FROM media_objects
     WHERE claimed_at IS NULL AND created_at < ?1
     ORDER BY created_at LIMIT ?2`,
    [now - UNCLAIMED_TTL_MS, MAX_DELETES_PER_RUN],
  )

  const retentionDays = Number(env.MEDIA_RETENTION_DAYS ?? 0)
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    report.expired_media_deleted = await sweep(
      env,
      `SELECT key FROM media_objects
       WHERE claimed_at IS NOT NULL AND created_at < ?1
         AND key NOT LIKE 'avatars/%'
       ORDER BY created_at LIMIT ?2`,
      [now - retentionDays * 24 * 60 * 60 * 1000, MAX_DELETES_PER_RUN],
    )
  }

  return report
}

/**
 * Wakes the conversations that hold at least one expired message and asks each
 * one to run its own sweep — the DO is the only thing that can delete its
 * messages, and it is also what tells any live socket they are gone.
 *
 * The selection is per *message*, not per conversation: a thread whose alarm
 * was lost (the DO logs `expiry schedule failed` and carries on) keeps taking
 * new messages, and a rule based on `last_message_at` would hold its oldest
 * ones alive until the newest one aged out — nearly twice the promised window
 * on a busy thread. `next_expiry_at` is the DO's own mirror of when its oldest
 * surviving message ages out, so `next_expiry_at <= now` means exactly "there
 * is something here to delete".
 *
 * Conversations that predate migration 0009 have no mirror yet: the old
 * whole-history rule still catches them, and the first sweep writes the column.
 *
 * `swept_at` is written after a successful pass so an idle thread costs one
 * round trip, not one per tick.
 */
async function sweepExpiredConversations(env: Env, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM conversations
     WHERE last_message_at IS NOT NULL
       AND (swept_at IS NULL OR swept_at < last_message_at OR swept_at < next_expiry_at)
       AND (
         (next_expiry_at IS NOT NULL AND next_expiry_at <= ?1)
         OR (next_expiry_at IS NULL AND last_message_at <= ?1 - retention_ms)
       )
     ORDER BY COALESCE(next_expiry_at, last_message_at) LIMIT ?2`,
  )
    .bind(now, MAX_CONVERSATIONS_PER_RUN)
    .all<{ id: string }>()

  let swept = 0
  for (const row of results) {
    try {
      const agent = await getAgentByName(env.ConversationAgent, row.id)
      const response = await agent.fetch('https://do/expire', { method: 'POST' })
      if (!response.ok) continue
      await env.DB.prepare('UPDATE conversations SET swept_at = ?1 WHERE id = ?2')
        .bind(now, row.id)
        .run()
      swept += 1
    } catch (error) {
      // Left unmarked on purpose: the next tick tries this conversation again.
      console.error('retention sweep failed', row.id, error)
    }
  }
  return swept
}

/**
 * Deletes the objects a query selects, then forgets exactly the keys the
 * bucket confirmed — index row and edge copy alike (lib/mediaGc.ts). A key
 * whose DELETE failed stays indexed so the next run retries it: dropping the
 * row first would leak the object forever.
 */
async function sweep(env: Env, query: string, bindings: unknown[]): Promise<number> {
  const { results } = await env.DB.prepare(query)
    .bind(...bindings)
    .all<{ key: string }>()
  if (results.length === 0) return 0

  return deleteMediaObjects(env, results.map((row) => row.key))
}
