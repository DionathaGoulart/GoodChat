// How a message's remaining life is written out, and when it is written at all.
//
// The rule itself is two numbers (lib/protocol.ts): seven days from being sent,
// three hours from being read. This module is the part that faces a person, and
// its job is the opposite of the rule's — the rule has to be exact, this has to
// be calm. A thread where every bubble carries a ticking clock is a thread
// nobody wants to open, so almost none of them do:
//
//   - a message with more than fifteen minutes left says nothing unless it is
//     the newest one its sender read;
//   - under fifteen minutes every message says it, because at that point which
//     one goes first has stopped being trivia;
//   - under a minute it stops counting and says it is going, because a number
//     that lands on "some em 0min" reads as broken;
//   - over the last five minutes it fades, so the disappearance is felt as
//     something continuous rather than as a bubble that blinks out.
//
// Unread messages are the quiet case on purpose. Seven days is not news, and a
// bubble that says "some em 6d" every time somebody looks at the thread is the
// same noise as a countdown, one order of magnitude slower. It speaks only in
// the last two days, when "they still have not opened this" is worth knowing.

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Under this, every message shows its countdown rather than only the newest. */
export const URGENT_MS = 15 * MINUTE_MS

/** Under this, the bubble starts fading out. */
export const FADE_MS = 5 * MINUTE_MS

/** Under this, the countdown stops being a number. */
export const IMMINENT_MS = MINUTE_MS

/** How close to the seven-day ceiling an unread message starts saying so. */
export const UNREAD_NOTICE_MS = 2 * DAY_MS

export function remainingMs(expiresAt: number, now: number): number {
  return Math.max(0, expiresAt - now)
}

/**
 * `2h58`, `14min`, `40s` — the longest unit and the one under it, never three,
 * and never a unit that has run out. Rounded down throughout: a message that
 * says two hours has at least two hours, which is the direction an expiry
 * promise has to round.
 */
export function remainingLabel(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS)
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
    return hours > 0 ? `${days}d${hours}h` : `${days}d`
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS)
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
    return minutes > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${hours}h`
  }
  if (ms >= MINUTE_MS) return `${Math.floor(ms / MINUTE_MS)}min`
  return `${Math.floor(ms / SECOND_MS)}s`
}

/**
 * What a read message's meta line says, or null when it should stay quiet.
 *
 * `prominent` is the caller's answer to "is this the newest read message in its
 * run" — the one bubble allowed to speak while there is still plenty of time.
 */
export function readCountdown(
  expiresAt: number,
  now: number,
  prominent: boolean,
): string | null {
  const left = remainingMs(expiresAt, now)
  if (left <= 0) return 'sumindo…'
  if (left < IMMINENT_MS) return 'sumindo…'
  if (left > URGENT_MS && !prominent) return null
  return `some em ${remainingLabel(left)}`
}

/**
 * What an unread message says to the person who sent it, or null. Only in the
 * last two days, and phrased as the condition rather than as a countdown: what
 * is running out is the other person's chance to see it at all.
 */
export function unreadCountdown(expiresAt: number, now: number): string | null {
  const left = remainingMs(expiresAt, now)
  if (left <= 0) return 'sumindo…'
  if (left > UNREAD_NOTICE_MS) return null
  return `some em ${remainingLabel(left)} se ninguém abrir`
}

/**
 * Opacity for the last five minutes: 1 down to 0.4, linear. Not lower — a
 * bubble faded past reading is a message deleted early, and the promise is
 * three hours of being readable, not two hours and fifty-five minutes.
 */
export function fadeFor(expiresAt: number, now: number): number {
  const left = remainingMs(expiresAt, now)
  if (left >= FADE_MS) return 1
  return 0.4 + 0.6 * (left / FADE_MS)
}

/**
 * How long until the display would say something different. Drives one timer
 * for a whole thread (hooks/useExpiryClock.ts) instead of one per bubble.
 */
export function tickFor(nextExpiryAt: number | null, now: number): number {
  if (nextExpiryAt === null) return 30 * SECOND_MS
  const left = remainingMs(nextExpiryAt, now)
  if (left > 10 * MINUTE_MS) return 30 * SECOND_MS
  if (left > IMMINENT_MS) return 5 * SECOND_MS
  return SECOND_MS
}
