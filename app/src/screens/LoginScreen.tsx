// Login (phase-2 endpoint). Card retro-border + retro-shadow, status tokens
// for errors, session persisted in the HttpOnly cookie set by the worker.

import { useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError } from '../lib/api'
import { useSession } from '../hooks/useSession'

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials') return 'usuário ou senha inválidos'
    if (error.code === 'rate_limited') return 'muitas tentativas — aguarde alguns minutos'
    if (error.code === 'network_error') return 'servidor inacessível — backend na porta 8000?'
  }
  return 'erro inesperado ao entrar'
}

export function LoginScreen() {
  const { login } = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="animate-enter w-full max-w-md">
        <p className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-accent">
          {'>'} goodchat_login
        </p>
        <h1 className="mb-8 text-5xl font-black uppercase italic leading-[1.05] tracking-tighter underline decoration-accent decoration-4 underline-offset-4 sm:text-6xl">
          GoodChat
        </h1>

        <form
          className="card card-border border-base-300 bg-base-200 retro-shadow"
          onSubmit={onSubmit}
        >
          <div className="card-body gap-4">
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
          </div>
        </form>

        <p className="mt-4 font-mono text-[8px] uppercase tracking-[0.2em] opacity-40 md:text-[10px]">
          contas criadas pelo operador · sem sign-up público
        </p>
      </div>
    </main>
  )
}
