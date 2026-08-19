// Presence: "is this person online right now".
//
// The model is one column (users.last_seen_at, migration 0007) and one rule:
// online means seen inside ONLINE_WINDOW_MS. The client beats every
// HEARTBEAT_MS while its tab is visible, so the window is two beats wide —
// one lost request must not blink someone offline, and a closed tab must not
// keep them online for longer than the window.
//
// Why not the conversation's Durable Object, which already knows who is
// connected: it only knows about its own thread. Someone reading the
// conversation list is online and has no socket open anywhere, and the answer
// the list needs is per account, not per thread. A timestamp in D1 is the one
// place both surfaces can read.

/** How long a heartbeat stands for. Two client beats wide, on purpose. */
export const ONLINE_WINDOW_MS = 60_000

/** Beat interval the client is expected to keep (app/src/lib/presence.ts). */
export const HEARTBEAT_MS = 25_000

/** Cap on how many peers one heartbeat may ask about. */
export const MAX_PRESENCE_IDS = 64

/**
 * Granularity of the timestamp handed back to a caller. The presence endpoint
 * takes any account id, conversation or not, so a raw `last_seen_at` polled
 * every 25s is an activity graph of anybody on the instance — far more than the
 * boolean the interface renders. Rounded down to the minute it still answers
 * "online" (the window is a minute wide) and stops resolving sleep schedules.
 */
export const LAST_SEEN_GRANULARITY_MS = 60_000

/**
 * Every surface that reports `last_seen_at` runs it through here — presence,
 * search, the conversation list, resolve — so there is one answer to "how
 * precisely does this instance publish when somebody was last around".
 */
export function coarseLastSeen(lastSeenAt: number | null | undefined): number | null {
  if (typeof lastSeenAt !== 'number') return null
  return Math.floor(lastSeenAt / LAST_SEEN_GRANULARITY_MS) * LAST_SEEN_GRANULARITY_MS
}

export interface PresenceState {
  id: string
  online: boolean
  last_seen_at: number | null
}

export function isOnline(lastSeenAt: number | null | undefined, now: number): boolean {
  return typeof lastSeenAt === 'number' && now - lastSeenAt < ONLINE_WINDOW_MS
}

/** Records that this account is alive right now. One write per heartbeat. */
export async function touchPresence(db: D1Database, userId: string, now: number): Promise<void> {
  await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId).run()
}

/**
 * Presence for a set of accounts. Unknown ids are simply absent from the
 * result — a deleted account is not offline, it is gone, and the caller
 * already renders that case from the tombstone flag.
 */
export async function presenceOf(
  db: D1Database,
  ids: readonly string[],
  now: number,
): Promise<PresenceState[]> {
  const unique = [...new Set(ids)].slice(0, MAX_PRESENCE_IDS)
  if (unique.length === 0) return []

  const placeholders = unique.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT id, last_seen_at FROM users
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .bind(...unique)
    .all<{ id: string; last_seen_at: number | null }>()

  return results.map((row) => ({
    id: row.id,
    // Computed from the exact value, reported from the rounded one.
    online: isOnline(row.last_seen_at, now),
    last_seen_at: coarseLastSeen(row.last_seen_at),
  }))
}
