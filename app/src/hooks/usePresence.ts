// Reading the presence store (lib/presence.ts) from a screen.
//
// The hook does two things at once: it registers the ids on screen with the
// shared heartbeat for as long as the component is mounted, and it subscribes
// to the store so a beat re-renders whoever is showing those accounts.

import { useEffect, useSyncExternalStore } from 'react'
import {
  presenceSnapshot,
  subscribePresence,
  watchPresence,
  type Presence,
} from '../lib/presence'

export type { Presence }

/**
 * Presence for the given accounts, keyed by id. An id the heartbeat has not
 * answered for yet is simply absent — callers fall back to whatever the REST
 * payload that listed the account already said.
 *
 * The ids are joined into the effect's dependency so a caller can pass a fresh
 * array every render (which `conversations.map` always does) without
 * re-registering on every one of them.
 */
export function usePresence(ids: readonly string[]): ReadonlyMap<string, Presence> {
  const key = ids.join(',')
  useEffect(() => watchPresence(key === '' ? [] : key.split(',')), [key])
  return useSyncExternalStore(subscribePresence, presenceSnapshot, presenceSnapshot)
}
