// Owner audit trail (migration 0011).
//
// The instance owner can reset any non-owner password and then sign in as that
// person, which is enough to read every live conversation they have. The PRD
// says so (§3.6) and a self-hosted instance cannot be otherwise — but "the
// operator has access" and "nobody can tell whether the operator used it" are
// different properties, and only the first one is intended. A compromised owner
// session used to be indistinguishable from the owner at work.
//
// So every mutating admin call leaves a row: who, what, to whom, when. Reads
// leave nothing — this records changes, not curiosity.
//
// Never throws: an admin action that succeeded must not report failure because
// its log line did not land. A missing row is visible in the console (the trail
// has gaps), which is the honest failure mode.

import type { SessionUser } from './session'

export interface AuditEntry {
  id: string
  actor_id: string
  actor_name: string
  action: string
  target_id: string | null
  target_name: string | null
  /** Small JSON object; never content, credentials or hashes. */
  details: string | null
  created_at: number
}

export interface AuditTarget {
  id: string
  username: string
}

export async function recordAdminAction(
  db: D1Database,
  entry: {
    actor: Pick<SessionUser, 'id' | 'username'>
    action: string
    target?: AuditTarget | { id: string; username?: string } | null
    details?: Record<string, unknown> | null
  },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO admin_audit
           (id, actor_id, actor_name, action, target_id, target_name, details, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        crypto.randomUUID(),
        entry.actor.id,
        entry.actor.username,
        entry.action,
        entry.target?.id ?? null,
        entry.target?.username ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        Date.now(),
      )
      .run()
  } catch (error) {
    console.error('admin audit write failed', entry.action, error)
  }
}

/** Newest first, for the owner console. */
export async function recentAdminActions(db: D1Database, limit = 50): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT id, actor_id, actor_name, action, target_id, target_name, details, created_at
       FROM admin_audit ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 200))
    .all<AuditEntry>()
  return results
}
