// Time formatting shared by the guest-account surfaces (the countdown banner
// and the owner console's account badges) and by presence.

export const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "4h 12min", "12min", "menos de 1min", "expirada" once the clock ran out. */
export function formatRemaining(expiresAt: number, now: number): string {
  const remaining = expiresAt - now
  if (remaining <= 0) return 'expirada'
  const minutes = Math.floor(remaining / MINUTE_MS)
  if (minutes < 1) return 'menos de 1min'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}min` : `${minutes}min`
}

/**
 * How long ago something happened, one unit deep: "agora", "5min", "3h", "2d".
 * Used for "visto há …", where the point is the order of magnitude — nobody
 * needs to know a peer was last seen 4min 37s ago.
 */
export function formatSince(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE_MS) return 'agora'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}min`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`
  return `${Math.floor(elapsed / DAY_MS)}d`
}
