// Password change, in the settings screen.
//
// Why it exists: until now the only way to replace a password was to ask the
// owner to reset it, which means the operator ends up knowing the new one — the
// exact shape this product spends the rest of its design avoiding. Somebody who
// thinks their password leaked has to be able to fix that themselves.
//
// The current password is required by the worker, so a borrowed session cannot
// be turned into a stolen account. Saving signs every *other* device out; this
// tab keeps its session, which is why the copy says so before the button rather
// than after it.
//
// A guest account is excluded: its password was shown once at signup, it dies
// with the account in a few hours, and there is nothing to protect by rotating
// it. TempAccountBanner is where that account's credentials live.

import { useState } from 'react'
import { ApiError, changePassword } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { Panel } from './Panel'
import { RetroIconButton } from './RetroIconButton'

/** Mirrors MIN_PASSWORD_LENGTH in worker/src/lib/users.ts. */
const MIN_PASSWORD_LENGTH = 8

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'servidor inacessível — tenta de novo'
    if (error.code === 'invalid_credentials') return 'senha atual incorreta'
    if (error.code === 'rate_limited') return 'muitas tentativas — espera um pouco'
    if (error.code === 'invalid_request') return error.message
  }
  return 'não deu pra trocar a senha'
}

export function PasswordCard() {
  const { user } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (!user || user.is_temp) return null

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm.length > 0 && next !== confirm
  const ready =
    current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm && !busy

  const save = () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    setNotice(null)
    changePassword(current, next)
      .then(() => {
        setNotice('senha trocada — os outros dispositivos foram desconectados')
        setCurrent('')
        setNext('')
        setConfirm('')
      })
      .catch((err: unknown) => setError(messageFor(err)))
      .finally(() => setBusy(false))
  }

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    autoComplete: string,
  ) => (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-60"
      >
        {label}
      </label>
      <input
        id={id}
        type="password"
        value={value}
        maxLength={256}
        disabled={busy}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
        }}
        className="input input-bordered min-w-0 border-2 border-base-300 bg-base-100 font-mono text-sm disabled:opacity-40"
      />
    </div>
  )

  return (
    <Panel title="senha.cfg">
      <div>
        <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
          <span className="sigil">{'>'}</span> senha
        </h2>
        <p className="mt-1 text-sm opacity-70">
          Trocar a senha desconecta todos os outros dispositivos. Este continua conectado.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {field('current-password', 'senha atual', current, setCurrent, 'current-password')}
        {field('new-password', 'nova senha', next, setNext, 'new-password')}
        {field('confirm-password', 'repetir a nova', confirm, setConfirm, 'new-password')}
      </div>

      <RetroIconButton
        disabled={!ready}
        onClick={save}
        className={`self-start ${ready ? 'bg-accent text-accent-content' : ''}`}
      >
        {busy ? 'salvando …' : 'trocar senha'}
      </RetroIconButton>

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
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
      )}
      {notice && (
        <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-success">
          {notice}
        </p>
      )}
    </Panel>
  )
}
