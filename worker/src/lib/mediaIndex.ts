// D1 side of the media pipeline (migration 0003): every presigned upload is
// recorded here before the client is allowed to PUT, and the Durable Object
// claims the row when the message referencing the key is persisted.
//
// Three consumers:
//   - routes/media.ts — authorization: is this session a participant of the
//     conversation the object belongs to?
//   - routes/admin.ts — bytes per account, without listing the bucket.
//   - lib/cleanup.ts  — unclaimed rows past the TTL are objects no message
//     will ever reference (upload finished, the send never happened).
//
// The row is written before the upload, so it can also describe an object that
// does not exist: a presign the client never used. Both cases are garbage and
// the sweep deletes them the same way — a DELETE on a missing key is a no-op.

/** An upload has this long to be referenced by a message before it is swept. */
export const UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000

export interface MediaObjectRow {
  key: string
  user_id: string
  conversation_id: string | null
  mime: string
  size: number
  created_at: number
  claimed_at: number | null
}

export async function recordUpload(
  db: D1Database,
  object: { key: string; userId: string; mime: string; size: number; now?: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO media_objects (key, user_id, conversation_id, mime, size, created_at, claimed_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, NULL)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(object.key, object.userId, object.mime, object.size, object.now ?? Date.now())
    .run()
}

/**
 * Binds an object to the conversation whose message references it. Only the
 * uploader can claim, and only once — a second sender cannot re-point someone
 * else's object at their own conversation to gain read access.
 */
export async function claimUpload(
  db: D1Database,
  key: string,
  userId: string,
  conversationId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE media_objects SET conversation_id = ?1, claimed_at = ?2
       WHERE key = ?3 AND user_id = ?4 AND claimed_at IS NULL`,
    )
    .bind(conversationId, now, key, userId)
    .run()
}

export function findObject(db: D1Database, key: string): Promise<MediaObjectRow | null> {
  return db
    .prepare(
      'SELECT key, user_id, conversation_id, mime, size, created_at, claimed_at FROM media_objects WHERE key = ?',
    )
    .bind(key)
    .first<MediaObjectRow>()
}

export interface MediaUsage {
  bytes: number
  count: number
}

/** Bytes and object count per account, for the owner panel. */
export async function usageByUser(db: D1Database): Promise<Map<string, MediaUsage>> {
  const { results } = await db
    .prepare(
      `SELECT user_id, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
       FROM media_objects GROUP BY user_id`,
    )
    .all<{ user_id: string; bytes: number; count: number }>()
  return new Map(results.map((row) => [row.user_id, { bytes: row.bytes, count: row.count }]))
}

/** Keys belonging to one conversation — what a history purge has to delete. */
export async function keysForConversation(
  db: D1Database,
  conversationId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT key FROM media_objects WHERE conversation_id = ?')
    .bind(conversationId)
    .all<{ key: string }>()
  return results.map((row) => row.key)
}

/** Keys uploaded by one account, claimed or not — what deleting it has to take. */
export async function keysForUser(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT key FROM media_objects WHERE user_id = ?')
    .bind(userId)
    .all<{ key: string }>()
  return results.map((row) => row.key)
}

export async function forgetKeys(db: D1Database, keys: string[]): Promise<void> {
  if (keys.length === 0) return
  // D1 caps bound parameters per statement; chunk well under it.
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50)
    const placeholders = chunk.map(() => '?').join(', ')
    await db
      .prepare(`DELETE FROM media_objects WHERE key IN (${placeholders})`)
      .bind(...chunk)
      .run()
  }
}
