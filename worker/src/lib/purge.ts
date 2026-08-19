// Conversation teardown, shared by the owner console (routes/admin.ts) and the
// temporary-account sweep (lib/accounts.ts).
//
// Two levels:
//   - purge:   the messages go, the pair stays. `conversations` keeps its row
//              and the Durable Object keeps its pinned participants, so the two
//              can keep talking with a clean slate.
//   - destroy: nobody is left to read the thread. The DO wipes its own storage,
//              the D1 row goes, and the bucket objects go with it.
//
// Both delete through lib/mediaGc.ts, which takes the bucket object, its index
// row and the edge copy in that order: a failed DELETE leaves the row behind so
// the next sweep retries it, instead of leaking an object nothing remembers —
// and no cached copy of a purged photo is left servable at the same URL.

import { getAgentByName } from 'agents'
import { deleteMediaObjects } from './mediaGc'

export interface ConversationPurgeResult {
  messages_deleted: number
  media_deleted: number
}

interface AgentPurgeResponse {
  deleted: number
  media_keys: string[]
}

/** Calls the DO's internal purge/destroy route. Null when it is unreachable. */
async function askAgent(
  env: Env,
  conversationId: string,
  path: 'purge' | 'destroy',
): Promise<AgentPurgeResponse | null> {
  try {
    const agent = await getAgentByName(env.ConversationAgent, conversationId)
    const response = await agent.fetch(`https://do/${path}`, { method: 'POST' })
    if (!response.ok) return null
    return await response.json<AgentPurgeResponse>()
  } catch (error) {
    console.error(`conversation ${path} failed`, conversationId, error)
    return null
  }
}

/**
 * Deletes every bucket object attached to a conversation: the keys the DO
 * remembered plus the keys the media index attributes to the thread (a
 * previous partial purge, or an upload whose message is already gone).
 */
async function deleteConversationMedia(
  env: Env,
  conversationId: string,
  fromMessages: string[],
): Promise<number> {
  const keys = new Set(fromMessages)
  const { results } = await env.DB.prepare(
    'SELECT key FROM media_objects WHERE conversation_id = ?',
  )
    .bind(conversationId)
    .all<{ key: string }>()
  for (const row of results) keys.add(row.key)

  return deleteMediaObjects(env, [...keys])
}

/**
 * Wipes one conversation's history. The `conversations` row stays — the pair
 * can keep talking, they just have no history.
 */
export async function purgeConversationHistory(
  env: Env,
  conversationId: string,
): Promise<ConversationPurgeResult> {
  const purged = await askAgent(env, conversationId, 'purge')
  const mediaDeleted = await deleteConversationMedia(env, conversationId, purged?.media_keys ?? [])
  return { messages_deleted: purged?.deleted ?? 0, media_deleted: mediaDeleted }
}

/**
 * Removes a conversation for good: the DO drops its own storage, the bucket
 * objects go, and the D1 row goes. Only called when no live account is left to
 * read it (lib/accounts.ts).
 */
export async function destroyConversation(
  env: Env,
  conversationId: string,
): Promise<ConversationPurgeResult> {
  const destroyed = await askAgent(env, conversationId, 'destroy')
  const mediaDeleted = await deleteConversationMedia(
    env,
    conversationId,
    destroyed?.media_keys ?? [],
  )
  await env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conversationId).run()
  return { messages_deleted: destroyed?.deleted ?? 0, media_deleted: mediaDeleted }
}
