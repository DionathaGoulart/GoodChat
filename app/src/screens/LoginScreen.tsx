// Login (phase-2 endpoint). The form is a Panel, so the front door carries the
// same window chrome as the rest of the app; status tokens for errors, session
// persisted in the HttpOnly cookie set by the worker.

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, health } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { Panel } from '../components/Panel'

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'usuário ou senha inválidos'
    if (error.code === 'rate_limited') return 'muitas tentativas — aguarde alguns minutos'
    if (error.code === 'temp_accounts_full') return 'limite de convidados atingido — tente mais tarde'
    if (error.code === 'temp_accounts_disabled') return 'convidados desativados nesta instância'
    if (error.code === 'network_error') return 'servidor inacessível — backend na porta 8000?'
  }
  return 'erro inesperado ao entrar'
}

export function LoginScreen() {
  const { login, loginAsGuest } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [guestSubmitting, setGuestSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The instance decides whether guests exist at all (TEMP_ACCOUNTS_ENABLED);
  // a dead button would be worse than no button.
  const [guestsOffered, setGuestsOffered] = useState(false)

  useEffect(() => {
    let cancelled = false
    health()
      .then((result) => {
        if (!cancelled) setGuestsOffered(result.temp_accounts)
      })
      .catch(() => {
        // Offline or old worker: fall back to the invite-only screen.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  const onGuest = async () => {
    if (guestSubmitting) return
    setGuestSubmitting(true)
    setError(null)
    try {
      await loginAsGuest()
    } catch (err) {
      setError(errorMessage(err))
      setGuestSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="animate-enter w-full max-w-md">
        <p className="screen-kicker mb-3 font-mono text-xs font-bold uppercase tracking-widest text-accent">
          <span className="sigil">{'>'}</span> goodchat_login
        </p>
        <h1 className="screen-title mb-8 text-5xl font-black uppercase italic leading-[1.05] tracking-tighter underline decoration-accent decoration-4 underline-offset-4 sm:text-6xl">
          GoodChat
        </h1>

        <Panel
          title="login.sh"
          as="form"
          onSubmit={onSubmit}
        >
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
              username
            </span>
            <input
              type="text"
              className="input w-full font-mono"
              autoComplete="username"
              autoCapitalize="none"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
              password
            </span>
            <input
              type="password"
              className="input w-full font-mono"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

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
            disabled={submitting}
            className="btn btn-goodchat mt-2 w-full retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0 disabled:opacity-60"
          >
            {submitting ? (
              <>
                autenticando<span className="terminal-cursor">_</span>
              </>
            ) : (
              'Entrar'
            )}
          </button>
        </Panel>

        {guestsOffered && (
          <section className="mt-4 retro-border bg-base-200 p-4">
            <p className="section-label font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
              <span className="sigil">{'>'}</span> sem conta?
            </p>
            <p className="mt-1 text-sm leading-relaxed opacity-70">
              Entre como convidado: a conta dura 5 horas e depois some, levando junto
              as conversas que só existirem nela.
            </p>
            <button
              type="button"
              onClick={() => void onGuest()}
              disabled={guestSubmitting || submitting}
              className="btn btn-goodchat mt-3 w-full retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0 disabled:opacity-60"
            >
              {guestSubmitting ? (
                <>
                  criando conta<span className="terminal-cursor">_</span>
                </>
              ) : (
                'Entrar como convidado'
              )}
            </button>
          </section>
        )}

        <p className="mt-4 font-mono text-[8px] uppercase tracking-[0.2em] opacity-40 md:text-[10px]">
          contas permanentes criadas pelo operador
          {guestsOffered ? ' · convidados expiram em 5h' : ' · sem sign-up público'}
        </p>
      </div>
    </main>
  )
}
