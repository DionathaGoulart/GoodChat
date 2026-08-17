// Deterministic conversation identity (PRD §3.3): a conversation is the
// unordered pair of user ids, so id = SHA-256("v1:<min>:<max>") truncated to
// 128 bits (32 hex chars). Same pair in any order → same id, no lookup needed.
//
// Rows in `conversations` are created lazily on first persisted message
// (phase 4 calls ensureConversation from the DO path); resolve/list endpoints
// never insert.

export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export async function conversationIdFor(userA: string, userB: string): Promise<string> {
  const [a, b] = orderPair(userA, userB)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`v1:${a}:${b}`),
  )
  return toHex(new Uint8Array(digest)).slice(0, 32)
}

/**
 * Lazy creation + activity bump, in one statement. Inserts the conversation
 * row if missing, otherwise advances `last_message_at` (never backwards).
 * Returns the conversation id.
 */
export async function ensureConversation(
  db: D1Database,
  userA: string,
  userB: string,
  lastMessageAt: number,
): Promise<string> {
  if (userA === userB) throw new Error('cannot create a conversation with oneself')
  const [a, b] = orderPair(userA, userB)
  const id = await conversationIdFor(a, b)
  await db
    .prepare(
      `INSERT INTO conversations (id, user_a, user_b, created_at, last_message_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(id) DO UPDATE SET
         last_message_at = MAX(COALESCE(conversations.last_message_at, 0), excluded.last_message_at)`,
    )
    .bind(id, a, b, lastMessageAt)
    .run()
  return id
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
