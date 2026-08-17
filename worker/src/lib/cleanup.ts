// Scheduled maintenance (wrangler.jsonc `triggers.crons` → the `scheduled`
// handler in index.ts). Six jobs, all idempotent and all bounded so one run
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
//   6. retention — deletes claimed media older than MEDIA_RETENTION_DAYS.
//      OFF by default (unset/0): silently deleting a conversation's photos is
//      a product decision, not a default. The bubbles degrade to an "expired"
//      placeholder when the object is gone. Profile pictures are exempt: they
//      are not history, and a retention window that blanked everyone's avatar
//      after N days would be a bug, not a policy.

import { sweepExpiredTempAccounts, sweepOrphanTombstones } from './accounts'
import { deleteObjects, mediaConfig } from './media'
import { UNCLAIMED_TTL_MS, forgetKeys } from './mediaIndex'

/** Objects deleted per run, per job. Bounds both CPU time and B2 calls. */
const MAX_DELETES_PER_RUN = 200

/**
 * Guest accounts torn down per run. Each one may destroy conversations and
 * delete bucket objects, so this is deliberately far below the object budget.
 */
const MAX_TEMP_ACCOUNTS_PER_RUN = 25
const MAX_TOMBSTONES_PER_RUN = 50

const LOGIN_ATTEMPT_TTL_MS = 60 * 60 * 1000

export interface CleanupReport {
  sessions_deleted: number
  login_attempts_deleted: number
  temp_accounts_deleted: number
  temp_conversations_deleted: number
  tombstones_removed: number
  orphan_media_deleted: number
  expired_media_deleted: number
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
  }

  const sessions = await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?')
    .bind(now)
    .run()
  report.sessions_deleted = sessions.meta.changes ?? 0

  const attempts = await env.DB.prepare('DELETE FROM login_attempts WHERE window_start <= ?')
    .bind(now - LOGIN_ATTEMPT_TTL_MS)
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

  const config = mediaConfig(env)
  if (!config) return report

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
 * Deletes the objects a query selects, then forgets exactly the keys the
 * bucket confirmed. A key whose DELETE failed stays indexed so the next run
 * retries it — dropping the row first would leak the object forever.
 */
async function sweep(env: Env, query: string, bindings: unknown[]): Promise<number> {
  const config = mediaConfig(env)
  if (!config) return 0

  const { results } = await env.DB.prepare(query)
    .bind(...bindings)
    .all<{ key: string }>()
  if (results.length === 0) return 0

  const deleted = await deleteObjects(config, results.map((row) => row.key))
  await forgetKeys(env.DB, deleted)
  return deleted.length
}
