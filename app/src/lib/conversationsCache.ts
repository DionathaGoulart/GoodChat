// Local copy of the conversation list, so a reload paints threads instead of a
// skeleton.
//
// Same idea as lib/accountCache.ts, one layer up: the account cache is what
// lets the app start on `authenticated` at all, and this is what gives that
// start something to show. Without it a warm boot still fell to
// ConversationListSkeleton for a full round trip, which is the one wait the
// person sees every single time they open the app.
//
// Two rules make it safe to keep:
//
//   - it is scoped to an account id. A device can hold more than one person's
//     session over its life, and a list of who someone talks to is not
//     something the next account on that browser may paint, even for a frame.
//     A mismatched owner is discarded, and logout drops the row entirely;
//   - a preview never outlives the message it previews. Each tile quotes the
//     conversation's last message, and messages expire (PRD §3.9), so both the
//     read and the write drop a preview already past its conversation's window
//     — otherwise the one place a deleted message could still be read would be
//     this cache;
//   - presence is not stored. resolvePresence (lib/presence.ts) trusts the
//     `online` flag on the payload until the first heartbeat lands, so a cached
//     `true` would claim somebody is around because they were around yesterday.
//     `last_seen_at` is kept instead: "visto há 3h" is computed against now, so
//     it ages into the truth on its own and the beat corrects it either way.
//
// It is a cache, not state: every read is a fetch away from being replaced, and
// anything unreadable is treated as absent.

import type { ConversationListItem } from './api'
import { retentionOr } from './protocol'

const STORAGE_KEY = 'goodchat-conversations'

/**
 * The list is ordered by recency, so a cap keeps the tail — the part nobody
 * scrolls to on the first paint — out of a storage area shared with the theme
 * and the account row.
 */
const MAX_ENTRIES = 50

/**
 * The same item with its preview removed when that message would already be
 * gone from the server. The tile falls back to "— sem mensagens —", which is
 * what the fresh list is about to say anyway.
 */
function withinWindow(item: ConversationListItem): ConversationListItem {
  const last = item.last_message
  if (!last) return item
  const cutoff = Date.now() - retentionOr(item.retention_ms)
  return last.created_at > cutoff ? item : { ...item, last_message: null }
}

interface StoredList {
  /** Account the list belongs to; anything else is another person's. */
  owner: string
  items: ConversationListItem[]
}

/** The stored copy for this account, or null when there is none to trust. */
export function readCachedConversations(ownerId: string): ConversationListItem[] | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<StoredList>
    if (parsed.owner !== ownerId || !Array.isArray(parsed.items)) return null
    // Shape check, not validation: a copy written by an older build can be
    // missing fields the tiles index into. One bad row voids the copy rather
    // than being filtered out — a half list is worse than a skeleton, because
    // it looks like a complete one.
    for (const item of parsed.items) {
      if (typeof item?.id !== 'string' || typeof item?.other_user?.id !== 'string') return null
    }
    return parsed.items.map(withinWindow)
  } catch {
    return null
  }
}

export function writeCachedConversations(
  ownerId: string,
  items: readonly ConversationListItem[],
): void {
  const stored: StoredList = {
    owner: ownerId,
    items: items.slice(0, MAX_ENTRIES).map((item) => ({
      ...withinWindow(item),
      // See the note at the top: the flag is dropped, the timestamp is not.
      other_user: { ...item.other_user, online: false },
    })),
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // Private mode / quota: the next boot just goes back to the skeleton.
  }
}

export function clearCachedConversations(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do — the copy is a cache, not state.
  }
}
