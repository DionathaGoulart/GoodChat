// Unsent composer text, per conversation.
//
// sessionStorage, not localStorage, and that is the whole design: a draft is
// something the person is in the middle of, not something they saved. It has to
// survive leaving the thread for the list and coming back, and a reload — both
// of which unmount the composer and used to throw the text away — but it must
// not still be sitting there tomorrow, or on the next tab, waiting to be sent
// into a conversation nobody remembers starting.
//
// This is the app's only use of sessionStorage. Everything else that outlives a
// render is a cache of something the server owns (lib/accountCache.ts,
// conversationsCache.ts, threadCache.ts) and belongs in localStorage; a draft is
// the opposite — the server has never seen it.

const PREFIX = 'goodchat-draft:'

export function readDraft(conversationId: string): string {
  try {
    return sessionStorage.getItem(PREFIX + conversationId) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(conversationId: string, body: string): void {
  try {
    // An empty draft is an absent one: leaving a blank key behind would make
    // "never typed" and "typed and erased" two states with the same meaning.
    if (body.length === 0) sessionStorage.removeItem(PREFIX + conversationId)
    else sessionStorage.setItem(PREFIX + conversationId, body)
  } catch {
    // Private mode / quota: the composer just goes back to forgetting.
  }
}

/** Logout: unsent text is the last thing the next account here should inherit. */
export function clearDrafts(): void {
  try {
    // Backwards: removing an entry reindexes the ones after it, so a forward
    // walk would step over every key that follows a draft it just deleted.
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key)
    }
  } catch {
    // Nothing to do — drafts die with the tab anyway.
  }
}
