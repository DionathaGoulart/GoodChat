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
// A guest account is excluded: it has no password at all (worker/src/lib/
// accounts.ts), dies in a few hours, and its key never left the browser — there
// is nothing here to rotate.
//
// Neither password travels. Both are run through the account KDF in this tab
// and only the derived tokens are posted (lib/kdf.ts), which is what keeps the
// worker from ever holding something that could unwrap a message. The new salt
// goes with the new token, in one request, because a hash stored against the
// wrong salt is an account nobody can sign in to.

import { useState } from 'react'
import { ApiError, changePassword, kdfParams } from '../lib/api'
import { MIN_PASSWORD_LENGTH, deriveAccountSecrets, newKdfParams } from '../lib/kdf'
import { useSession } from '../hooks/useSession'
import { Panel } from './Panel'
import { PasswordStrength } from './PasswordStrength'
import { RetroIconButton } from './RetroIconButton'

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'servidor inacessível — tenta de novo'
    if (error.code === 'invalid_credentials') return 'senha atual incorreta'
    if (error.code === 'rate_limited') return 'muitas tentativas — espera um pouco'
    if (error.code === 'rotation_required') return 'esta conta precisa migrar a senha primeiro'
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
    // Two derivations, and the order matters only for the first: the current
    // password has to be run against the salt the account is *stored* under,
    // which is what /api/auth/kdf answers, while the new one gets a fresh salt
    // that travels with it.
    void (async () => {
      const currentParams = await kdfParams(user.username)
      const nextParams = newKdfParams()
      const [currentSecrets, nextSecrets] = [
        await deriveAccountSecrets(current, currentParams),
        await deriveAccountSecrets(next, nextParams),
      ]
      return changePassword({
        current_auth_token: currentSecrets.authToken,
        auth_token: nextSecrets.authToken,
        kdf_salt: nextParams.salt,
        kdf_iterations: nextParams.iterations,
      })
    })()
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
          A senha não sai deste navegador — o servidor guarda só um derivado dela.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {field('current-password', 'senha atual', current, setCurrent, 'current-password')}
        {field('new-password', 'nova senha', next, setNext, 'new-password')}
        <PasswordStrength password={next} />
        {field('confirm-password', 'repetir a nova', confirm, setConfirm, 'new-password')}
      </div>

      <RetroIconButton
        disabled={!ready}
        onClick={save}
        className={`self-start ${ready ? 'bg-accent text-accent-content' : ''}`}
      >
        {busy ? 'derivando …' : 'trocar senha'}
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
