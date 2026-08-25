// The one screen an account sees exactly once: pick a new password, because
// the old one is a password the server was told.
//
// Every account that existed before the client-side KDF shipped is here on its
// next sign-in, and so is every account the owner console has reset since
// (migration 0013). The worker cannot migrate them on its own — deriving the
// new hash needs the password, which is precisely what it must stop having —
// so the move happens in front of the person, once, and then never again.
//
// It is a full screen rather than a card in settings, and it is not
// dismissable, because `must_rotate` is not a suggestion: until it clears, the
// account has no key of its own (migration 0014) and nothing it receives can
// be sealed to it. Letting somebody past this would be letting them into a
// thread where their own messages come back unreadable.
//
// Why a *new* password rather than the same one re-derived: the old one
// reached the server in the clear, twice — once on the sign-in that got here,
// and once more in the field below, which is the only way the worker can check
// that the person typing is the account holder. It is spent. The new one is
// derived in this tab and the worker only ever sees `authToken`.

import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../lib/api'
import { MIN_PASSWORD_LENGTH } from '../lib/kdf'
import { useSession } from '../hooks/useSession'
import { Panel } from '../components/Panel'
import { PasswordStrength } from '../components/PasswordStrength'

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'senha atual incorreta'
    if (error.code === 'rate_limited') return 'muitas tentativas — aguarde alguns minutos'
    if (error.code === 'rotation_not_required') return 'esta conta já está no formato novo'
    if (error.code === 'network_error') return 'servidor inacessível — backend na porta 8000?'
  }
  return 'não deu pra trocar a senha'
}

export function RotatePasswordScreen() {
  const { user, rotatePassword, logout } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && next !== confirm
  const ready =
    current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm && !busy

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await rotatePassword(current, next)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    autoComplete: string,
  ) => (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
        {label}
      </span>
      <input
        id={id}
        type="password"
        className="input w-full font-mono"
        autoComplete={autoComplete}
        maxLength={256}
        disabled={busy}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )

  return (
    <main className="flex min-h-dvh items-center justify-center screen-pad">
      <div className="animate-enter w-full max-w-md">
        <p className="screen-kicker mb-3 font-mono text-xs font-bold uppercase tracking-widest text-accent">
          <span className="sigil">{'>'}</span> goodchat_rotate
        </p>
        <h1 className="screen-title mb-6 text-4xl font-black uppercase italic leading-[1.05] tracking-tighter underline decoration-accent decoration-4 underline-offset-4">
          troque a senha
        </h1>

        <p className="mb-4 text-sm leading-relaxed opacity-70">
          A senha de <span className="font-mono font-bold">@{user?.username}</span> foi
          criada num formato em que o servidor sabia qual era. Agora ela não sai mais
          daqui — o servidor guarda só um derivado, e é essa senha que abre as suas
          conversas. Escolha uma nova para concluir.
        </p>
        <p className="mb-4 retro-border bg-base-200 p-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.15em] text-warning">
          não há como recuperar. perdeu a senha, perdeu o histórico.
        </p>

        <Panel title="rotate.sh" as="form" onSubmit={onSubmit}>
          {field('current-password', 'senha atual', current, setCurrent, 'current-password')}
          {field('new-password', 'nova senha', next, setNext, 'new-password')}
          <PasswordStrength password={next} />
          {field('confirm-password', 'repetir a nova', confirm, setConfirm, 'new-password')}

          {tooShort && (
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
              mínimo de {MIN_PASSWORD_LENGTH} caracteres
            </p>
          )}
          {mismatch && (
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
              as duas não batem
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="border-2 border-error bg-error/10 p-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!ready}
            className="btn btn-goodchat mt-2 w-full retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0 disabled:opacity-60"
          >
            {busy ? (
              <>
                derivando<span className="terminal-cursor">_</span>
              </>
            ) : (
              'Trocar e entrar'
            )}
          </button>
        </Panel>

        {/* The way out that is not "finish this". Not a dismissal — the flag
            outlives the session, so signing out and back in lands here again. */}
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-4 cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] underline opacity-40 hover:opacity-100"
        >
          sair
        </button>
      </div>
    </main>
  )
}
