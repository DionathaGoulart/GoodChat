// Time formatting shared by the guest-account surfaces (the countdown banner
// and the owner console's account badges).

export const MINUTE_MS = 60_000

/** "4h 12min", "12min", "menos de 1min", "expirada" once the clock ran out. */
export function formatRemaining(expiresAt: number, now: number): string {
  const remaining = expiresAt - now
  if (remaining <= 0) return 'expirada'
  const minutes = Math.floor(remaining / MINUTE_MS)
  if (minutes < 1) return 'menos de 1min'
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}min` : `${minutes}min`
}
