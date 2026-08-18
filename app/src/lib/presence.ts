// Presence store: one heartbeat for the whole tab.
//
// Every screen that shows whether someone is online registers the ids it cares
// about (`watch`), and a single timer POSTs them all to /api/presence. That is
// what keeps presence at one request per HEARTBEAT_MS no matter how many tiles
// are on screen — and the same request is what marks *me* online, so being in a
// thread, reading the list or just having the tab open all count.
//
// The store is a module singleton read through useSyncExternalStore, like
// hooks/useTheme: the state is not owned by any one screen, and a thread and
// the list behind it must never disagree about who is around.
//
// Beats only fire while the tab is visible. A hidden tab is not "someone
// online" — it is a tab — and the window (worker/src/lib/presence.ts) is short
// enough that closing the app shows up as offline within a minute.

import { presence as fetchPresence } from './api'
import { formatSince } from './time'

/** Matches HEARTBEAT_MS in the worker; the window there is two beats wide. */
const HEARTBEAT_MS = 25_000

export interface Presence {
  online: boolean
  last_seen_at: number | null
}

let snapshot: ReadonlyMap<string, Presence> = new Map()
const listeners = new Set<() => void>()
/** id → how many mounted watchers want it. */
const watched = new Map<string, number>()
let timer: number | null = null
let inFlight = false
let beatScheduled = false

function emit(): void {
  listeners.forEach((notify) => notify())
}

/**
 * Replaces the snapshot only when something actually changed: getSnapshot has
 * to return a stable reference, or React re-renders forever.
 */
function apply(rows: readonly { id: string; online: boolean; last_seen_at: number | null }[]): void {
  const next = new Map(snapshot)
  let changed = false
  for (const row of rows) {
    const current = next.get(row.id)
    if (current?.online === row.online && current?.last_seen_at === row.last_seen_at) continue
    next.set(row.id, { online: row.online, last_seen_at: row.last_seen_at })
    changed = true
  }
  if (!changed) return
  snapshot = next
  emit()
}

async function beat(): Promise<void> {
  if (inFlight || document.visibilityState !== 'visible') return
  inFlight = true
  try {
    const result = await fetchPresence([...watched.keys()])
    apply(result.users)
  } catch {
    // Server unreachable: keep the last known state. The thread header shows
    // its own link status, which is the honest thing to show when the network
    // is the problem rather than the peer.
  } finally {
    inFlight = false
  }
}

/** Coalesces the "a new id showed up" beats a mounting screen would fire. */
function scheduleBeat(): void {
  if (beatScheduled) return
  beatScheduled = true
  window.setTimeout(() => {
    beatScheduled = false
    void beat()
  }, 0)
}

/**
 * Starts the heartbeat. Called once per authenticated session
 * (hooks/useSession) — the returned function stops it on logout.
 */
export function startHeartbeat(): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void beat()
  }
  void beat()
  timer = window.setInterval(() => void beat(), HEARTBEAT_MS)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisible)
    snapshot = new Map()
    watched.clear()
    emit()
  }
}

/** Registers interest in these ids; the returned function releases it. */
function watch(ids: readonly string[]): () => void {
  let fresh = false
  for (const id of ids) {
    const count = watched.get(id) ?? 0
    if (count === 0) fresh = true
    watched.set(id, count + 1)
  }
  // A screen that just mounted should not wait a full interval for its answer.
  if (fresh) scheduleBeat()

  return () => {
    for (const id of ids) {
      const count = watched.get(id) ?? 0
      if (count <= 1) watched.delete(id)
      else watched.set(id, count - 1)
    }
  }
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

function getSnapshot(): ReadonlyMap<string, Presence> {
  return snapshot
}

export { getSnapshot as presenceSnapshot, subscribe as subscribePresence, watch as watchPresence }

/**
 * What to show for an account: the live value when a beat has answered for it,
 * otherwise whatever the REST payload that listed the account already said.
 * That fallback is what makes the first paint correct instead of "offline until
 * the first beat".
 */
export function resolvePresence(
  live: Presence | undefined,
  fallback: { online?: boolean; last_seen_at?: number | null },
): Presence {
  return live ?? { online: fallback.online ?? false, last_seen_at: fallback.last_seen_at ?? null }
}

/** "online", or "visto há 5min" / "offline" when there is no recent beat. */
export function presenceText(presence: Presence, now: number): string {
  if (presence.online) return 'online'
  if (presence.last_seen_at === null) return 'offline'
  return `visto há ${formatSince(presence.last_seen_at, now)}`
}
