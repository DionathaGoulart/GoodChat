// Guest-account surfaces: the countdown that tells you how long this account
// still exists, and the one-time credentials card shown right after signup.
//
// Both are deliberately loud. A guest account deletes itself and takes its
// conversations with it — that has to be impossible to miss, and the password
// is never recoverable once the tab is gone.

import { useEffect, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { MINUTE_MS, formatRemaining } from '../lib/time'
import { RetroIconButton } from './RetroIconButton'

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

/**
 * The credentials, shown once. The worker returns the password a single time,
 * so this card is the only chance to write it down — it stays until dismissed.
 */
export function GuestCredentialsCard() {
  const { guestCredentials, forgetGuestCredentials } = useSession()
  if (!guestCredentials) return null

  return (
    <section className="animate-enter card card-border border-accent bg-base-200 retro-shadow">
      <div className="card-body gap-3">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
          {'>'} anote suas credenciais
        </h2>
        <p className="text-sm leading-relaxed opacity-70">
          Servem para voltar nesta conta de outro navegador enquanto ela durar. A senha
          não é mostrada de novo.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-sm">
          <dt className="text-[10px] uppercase tracking-[0.2em] opacity-50">user</dt>
          <dd className="font-bold select-all">{guestCredentials.username}</dd>
          <dt className="text-[10px] uppercase tracking-[0.2em] opacity-50">senha</dt>
          <dd className="font-bold select-all">{guestCredentials.password}</dd>
        </dl>
        <RetroIconButton className="self-start" onClick={forgetGuestCredentials}>
          anotei
        </RetroIconButton>
      </div>
    </section>
  )
}
