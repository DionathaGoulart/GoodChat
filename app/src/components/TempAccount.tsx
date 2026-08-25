// The guest-account countdown: how long this account still exists.
//
// Deliberately loud. A guest account deletes itself and takes its conversations
// with it — that has to be impossible to miss.
//
// There used to be a credentials card beside this one. There are no
// credentials anymore: a guest account has no password, so it cannot be
// reopened from another browser and there is nothing to write down. The tab is
// the account, and signing out ends it now rather than at the deadline below
// (worker/src/routes/auth.ts).

import { useEffect, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { MINUTE_MS, formatRemaining } from '../lib/time'

/** Re-renders once a minute — the countdown never needs finer than that. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/**
 * Countdown strip for the signed-in guest. Renders nothing for permanent
 * accounts, so screens can drop it in unconditionally.
 */
export function TempAccountBanner() {
  const { user } = useSession()
  const now = useNow()
  if (!user?.is_temp || user.expires_at === null) return null

  return (
    <p className="retro-border bg-warning/15 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-warning-content">
      conta temporária · some em {formatRemaining(user.expires_at, now)} — as conversas
      que só existirem aqui vão junto
    </p>
  )
}
