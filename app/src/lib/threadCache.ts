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
//
// ...and a fourth term, from the retention promise (PRD §3.9): a copy never
// outlives the message it copies. Both the read and the write drop anything
// already past the conversation's window, so a message the server deleted
// cannot come back from localStorage — not on the next open, and not on a
// device that was offline when it expired.
//
// Read and write only reach the thread being used, though, and the promise is
// not about the thread being used: a conversation nobody opens again would keep
// its text here forever. So `pruneCachedMessages` runs once per app boot over
// every bucket (useSession.tsx). It is cheap — ten threads of fifty messages is
// the whole store — and it is what makes the window true for the copies too.

import type { PublicUser } from './api'
import { DEFAULT_RETENTION_MS, retentionOr } from './protocol'
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
  /**
   * The conversation's message window. Cached with the thread because it is
   * what prunes the cached messages before they are ever painted; a copy from
   * a build that predates retention reads as the 7-day default.
   */
  retentionMs: number
  /**
   * Whether the conversation has ever held a message. It decides between a
   * loading state and nothing at all while `history` is in flight, so a copy
   * written before this field existed defaults to true: a spinner that turns
   * out to be unnecessary costs a round trip, an empty thread that was
   * actually full costs the messages.
   */
  exists: boolean
  /**
   * The peer's device set, as this device last saw it — a digest of their
   * public keys, not the keys themselves. It exists to answer one question on
   * open: has the other side's device list changed since last time? A change is
   * legitimate whenever they sign in somewhere new, and it is also exactly what
   * a server swapping a key would look like, so the thread says so and offers
   * the safety number rather than deciding which it was (components/
   * SafetyNumber.tsx).
   */
  peerFingerprint?: string
  /**
   * The peer's device set at the moment somebody said they had compared the
   * safety number out loud, or absent if nobody ever has.
   *
   * This is what turns the banner from noise into a signal. Before a
   * comparison, a new device on the other side is *news* — most people use
   * three browsers and sign into new ones constantly, and a red alarm every
   * time teaches exactly one lesson, which is to stop reading it. After a
   * comparison it is an *alarm*, because the person has a number they trusted
   * and the thing that number described has changed underneath them.
   *
   * Stored per peer rather than per device set, so re-verifying after a
   * legitimate change simply moves it forward.
   */
  verifiedFingerprint?: string
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
  return {
    ...entry,
    exists: entry.exists !== false,
    retentionMs: retentionOr(entry.retentionMs),
  }
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

/**
 * The tail of a thread, minus whatever has aged out since it was written.
 * `retentionMs` is the window the caller knows about (the cached thread, or
 * the live one); the default only applies to a call that has none yet, and it
 * is the longest window, so it can never keep something too long by mistake —
 * the server's `history` frame replaces all of this a connect later anyway.
 */
export function readCachedMessages(
  ownerId: string,
  conversationId: string,
  retentionMs: number = DEFAULT_RETENTION_MS,
): ThreadMessage[] | null {
  const entry = readBucket<ThreadMessage[]>(MESSAGES_KEY, ownerId)?.[conversationId]
  if (!Array.isArray(entry) || entry.length === 0) return null
  for (const message of entry) {
    if (typeof message?.client_id !== 'string' || typeof message?.sender_id !== 'string') return null
  }
  const cutoff = Date.now() - retentionOr(retentionMs)
  const live = entry.filter((message) => message.created_at > cutoff)
  return live.length > 0 ? live : null
}

export function writeCachedMessages(
  ownerId: string,
  conversationId: string,
  messages: readonly ThreadMessage[],
  retentionMs: number = DEFAULT_RETENTION_MS,
): void {
  // Only what the server has acknowledged. An optimistic message is still owned
  // by the socket that is trying to send it — restoring one from storage would
  // resurrect a send nobody is retrying and show it as forever "sending".
  //
  // ...and only what is still inside the window: writing an expired message
  // back would be this cache re-creating what the retention sweep just deleted.
  const cutoff = Date.now() - retentionOr(retentionMs)
  const acked = messages
    .filter((message) => message.status !== 'sending' && message.created_at > cutoff)
    // `contentKey` is a CryptoKey, which JSON.stringify flattens to `{}` — a
    // shape that looks usable and is not. It is runtime-only by nature: the key
    // came out of the message envelope, which is not cached either, so a media
    // bubble restored from here waits for `history` to hand it a real one
    // (hooks/useConversation.ts). Dropped rather than serialized, so nothing
    // downstream has to distinguish a key from the ghost of one.
    .map(({ contentKey: _contentKey, ...rest }) => rest)
  // An empty list is written, not skipped: "nothing left" is exactly the state
  // a thread reaches when its last message expires, and leaving the previous
  // copy in place would be the cache holding on to what the server deleted.
  writeBucket(MESSAGES_KEY, ownerId, conversationId, acked.slice(-MAX_MESSAGES), MAX_THREADS)
}

/**
 * Boot-time sweep of every cached thread, not just the one being opened.
 *
 * Each thread's window comes from the cached resolve entry (they share an
 * owner and are written together); a conversation with no entry falls back to
 * the longest window, which is also the one the server would enforce. A bucket
 * that empties out is written back empty rather than removed — same reasoning
 * as `writeCachedMessages`: "nothing left" is a real state.
 */
export function pruneCachedMessages(ownerId: string): void {
  const messages = readBucket<ThreadMessage[]>(MESSAGES_KEY, ownerId)
  if (!messages) return

  const windows = new Map<string, number>()
  for (const thread of Object.values(readBucket<CachedThread>(RESOLVE_KEY, ownerId) ?? {})) {
    if (typeof thread?.conversationId === 'string') {
      windows.set(thread.conversationId, retentionOr(thread.retentionMs))
    }
  }

  const now = Date.now()
  let changed = false
  const pruned: Record<string, ThreadMessage[]> = {}
  for (const [conversationId, entry] of Object.entries(messages)) {
    if (!Array.isArray(entry)) {
      changed = true
      continue
    }
    const cutoff = now - (windows.get(conversationId) ?? DEFAULT_RETENTION_MS)
    const live = entry.filter((message) => message?.created_at > cutoff)
    if (live.length !== entry.length) changed = true
    pruned[conversationId] = live
  }
  if (!changed) return

  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify({ owner: ownerId, entries: pruned }))
  } catch {
    // Private mode / quota: nothing to repair — the read path prunes too.
  }
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
