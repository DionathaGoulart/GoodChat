// Local copies of an open conversation: what it resolves to, and the tail of
// its history.
//
// Opening a thread costs two waits, and this module removes both from the
// second visit onward:
//
//   - POST /api/conversations/resolve, which is what turns a user id into a
//     conversation id. Until it answers, ThreadScreen has no header and no
//     peer, so the whole screen is a skeleton;
//   - the WebSocket `history` frame, which is a connect plus a round trip after
//     that. Until it lands the thread is empty.
//
// Both copies are stale-while-revalidate, like lib/accountCache.ts and
// lib/conversationsCache.ts: they paint, the live answer replaces them. The
// same two rules apply, for the same reasons — scoped to an account id and
// dropped on logout, and never storing the `online` flag, which resolvePresence
// (lib/presence.ts) trusts verbatim until the first heartbeat lands.
//
// What is stored here is message text, which is the most private thing the app
// holds. That is a deliberate widening of what already sits in localStorage:
// the conversation list caches each thread's last message as its preview. It
// stays on the same terms — one account, cleared the moment that account signs
// out, and capped so it is a tail rather than an archive.

import type { PublicUser } from './api'
import type { ThreadMessage } from '../hooks/useConversation'

const RESOLVE_KEY = 'goodchat-threads'
const MESSAGES_KEY = 'goodchat-thread-messages'

/** Threads kept, most recently opened first. Older ones are evicted. */
const MAX_THREADS = 10

/** Per thread. A screenful is a handful; the rest arrives with `history`. */
const MAX_MESSAGES = 50

export interface CachedThread {
  conversationId: string
  otherUser: PublicUser
  readonly: boolean
}

interface Stored<T> {
  owner: string
  entries: Record<string, T>
}

/** Reads one bucket, or null when there is nothing to trust in it. */
function readBucket<T>(key: string, ownerId: string): Record<string, T> | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Stored<T>>
    if (parsed.owner !== ownerId || typeof parsed.entries !== 'object' || !parsed.entries) {
      return null
    }
    return parsed.entries
  } catch {
    return null
  }
}

/**
 * Writes `value` under `id`, newest first, and drops the tail past `max`.
 * Object key order is insertion order for string keys, which is what makes
 * rebuilding the record an eviction policy rather than just a rewrite.
 */
function writeBucket<T>(key: string, ownerId: string, id: string, value: T, max: number): void {
  const current = readBucket<T>(key, ownerId) ?? {}
  delete current[id]
  const entries = Object.entries({ [id]: value, ...current }).slice(0, max)
  try {
    localStorage.setItem(key, JSON.stringify({ owner: ownerId, entries: Object.fromEntries(entries) }))
  } catch {
    // Private mode / quota: the next open just goes back to the skeleton.
  }
}

export function readCachedThread(ownerId: string, userId: string): CachedThread | null {
  const entry = readBucket<CachedThread>(RESOLVE_KEY, ownerId)?.[userId]
  // Shape check, not validation: a copy from an older build can be missing the
  // fields the header indexes into.
  if (typeof entry?.conversationId !== 'string' || typeof entry.otherUser?.id !== 'string') {
    return null
  }
  return entry
}

export function writeCachedThread(ownerId: string, userId: string, thread: CachedThread): void {
  writeBucket<CachedThread>(
    RESOLVE_KEY,
    ownerId,
    userId,
    // See the note at the top: the flag is dropped, the timestamp is not.
    { ...thread, otherUser: { ...thread.otherUser, online: false } },
    MAX_THREADS,
  )
}

export function readCachedMessages(ownerId: string, conversationId: string): ThreadMessage[] | null {
  const entry = readBucket<ThreadMessage[]>(MESSAGES_KEY, ownerId)?.[conversationId]
  if (!Array.isArray(entry) || entry.length === 0) return null
  for (const message of entry) {
    if (typeof message?.client_id !== 'string' || typeof message?.sender_id !== 'string') return null
  }
  return entry
}

export function writeCachedMessages(
  ownerId: string,
  conversationId: string,
  messages: readonly ThreadMessage[],
): void {
  // Only what the server has acknowledged. An optimistic message is still owned
  // by the socket that is trying to send it — restoring one from storage would
  // resurrect a send nobody is retrying and show it as forever "sending".
  const acked = messages.filter((message) => message.status !== 'sending')
  if (acked.length === 0) return
  writeBucket(MESSAGES_KEY, ownerId, conversationId, acked.slice(-MAX_MESSAGES), MAX_THREADS)
}

/** Logout: the next account on this device must not read any of it. */
export function clearCachedThreads(): void {
  try {
    localStorage.removeItem(RESOLVE_KEY)
    localStorage.removeItem(MESSAGES_KEY)
  } catch {
    // Nothing to do — the copies are a cache, not state.
  }
}
