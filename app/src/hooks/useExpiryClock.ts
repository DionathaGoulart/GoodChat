// One clock for a whole thread.
//
// Every bubble in a thread is counting down, and the obvious implementation —
// an interval per bubble — is fifty timers waking a phone up in lockstep to
// re-render fifty components that mostly have nothing new to say. This is one
// timer, and it sleeps for as long as the *nearest* deadline allows: half a
// minute while everything is hours away, a second only when something is about
// to go (lib/expiry.ts, `tickFor`).
//
// It also stops entirely when the tab is hidden. A backgrounded tab has nobody
// reading its countdowns, and the browser throttles the timer anyway; what
// matters is that the first thing it does on becoming visible again is jump
// straight to the real time rather than resume from where it fell asleep.

import { useEffect, useState } from 'react'
import { tickFor } from '../lib/expiry'

export function useExpiryClock(nextExpiryAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Firing on the way *into* hidden as well as out of it is deliberate: it
    // re-runs this effect, which is what clears the timer for as long as the
    // tab stays there.
    const wake = () => setNow(Date.now())
    document.addEventListener('visibilitychange', wake)
    const timer =
      document.visibilityState === 'visible'
        ? window.setTimeout(wake, tickFor(nextExpiryAt, now))
        : undefined
    return () => {
      document.removeEventListener('visibilitychange', wake)
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [nextExpiryAt, now])

  return now
}
