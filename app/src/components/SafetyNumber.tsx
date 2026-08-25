// The safety number, and the one thing it is for.
//
// Everything else about end-to-end encryption is closed by the crypto: the
// server stores ciphertext, holds no private key, and cannot open a message.
// But it is also the thing that publishes the device directory, so it could add
// a device of its own to somebody's list and be handed a copy of every message
// sent to them. No amount of encryption fixes that, because the encryption
// would be working perfectly — to the wrong recipient.
//
// What fixes it is two people comparing a number that neither the server nor
// anyone in the middle can influence: it is derived from the device keys
// themselves (lib/e2ee.ts), so a directory that was tampered with produces a
// different number on the two sides. Comparing it out of band — out loud, in
// person, over a call — is the only step in this whole system that a server
// cannot participate in.
//
// The number changes whenever either side adds or loses a device, and that is
// correct rather than noisy: a new device really is a new party that can read
// the conversation. Which is also why the banner exists — nobody compares
// numbers spontaneously, so the app says when there is a reason to.
//
// And why this dialog can be told the comparison happened. A number nobody
// checked is decoration: the thread has nothing to compare a later change
// against, so every change has to be reported at the same volume, and a warning
// that fires for every new browser is one people learn to dismiss. Recording
// the comparison is what lets the thread separate "@alice signed in somewhere
// new" from "the keys moved after you checked them" — the first is ordinary,
// the second is the only thing this whole mechanism was built to surface.
//
// It is deliberately not called "verify": nothing here verifies anything. The
// person did, out of band, and this is a note that they said so.

import { useEffect, useState } from 'react'
import type { PublicUser } from '../lib/api'
import { safetyNumber } from '../lib/e2ee'
import { getAccountKey } from '../lib/keyDirectory'
import { Modal } from './Modal'
import { RetroIconButton } from './RetroIconButton'

export function SafetyNumberDialog({
  myId,
  otherUser,
  verified,
  onVerify,
  onClose,
}: {
  myId: string
  otherUser: PublicUser
  /** The set on screen is already the one somebody said they compared. */
  verified: boolean
  onVerify: () => void | Promise<void>
  onClose: () => void
}) {
  const [number, setNumber] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Forced: this is the moment somebody is deciding whether to trust the
        // directory, so a cached copy of it is exactly the wrong thing to show.
        const [mine, theirs] = await Promise.all([
          getAccountKey(myId, true),
          getAccountKey(otherUser.id, true),
        ])
        if (cancelled) return
        if (!mine || !theirs) {
          setFailed(true)
          return
        }
        setNumber(await safetyNumber(mine, theirs))
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [myId, otherUser.id])

  return (
    <Modal onCancel={onClose}>
      <div>
        <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
          <span className="sigil">{'>'}</span> número de segurança
        </h2>
        <p className="mt-1 text-sm opacity-70">
          Compare estes números com @{otherUser.username} por fora do app — pessoalmente,
          por ligação, por qualquer caminho que não seja esta conversa. Se forem iguais,
          ninguém está no meio.
        </p>
      </div>

      {failed ? (
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {'não foi possível calcular — um dos lados ainda não publicou uma chave'}
        </p>
      ) : number === null ? (
        <div className="skeleton h-20 w-full" />
      ) : (
        <p className="retro-border bg-base-200 p-3 text-center font-mono text-sm leading-relaxed tracking-[0.15em] break-words">
          {number}
        </p>
      )}

      <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
        muda quando qualquer um dos dois entra num aparelho novo
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Only offered once there is a number to have compared. Marking a
            failed or still-loading dialog as checked would record a claim about
            nothing, and that claim is what every later warning is measured
            against. */}
        {number !== null &&
          (verified ? (
            <p className="mr-auto font-mono text-[10px] uppercase tracking-[0.2em] text-success">
              conferido
            </p>
          ) : (
            <RetroIconButton
              className="mr-auto"
              onClick={() => {
                void onVerify()
                onClose()
              }}
            >
              já conferi este número
            </RetroIconButton>
          ))}
        <RetroIconButton onClick={onClose}>fechar</RetroIconButton>
      </div>
    </Modal>
  )
}
