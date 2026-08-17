// Settings (#/config): account-level preferences. The theme picked here is
// stored on the account, so it follows the person to every device instead of
// living in one browser's localStorage.
//
// Push opt-in moved here from the conversation-list header: it is a setting,
// and the header was collecting toolbar buttons.

import { useState } from 'react'
import { ApiError } from '../lib/api'
import type { Theme } from '../lib/api'
import { usePush } from '../hooks/usePush'
import { useSession } from '../hooks/useSession'
import { RetroIconButton } from '../components/RetroIconButton'
import { navigate } from '../lib/router'

type Preference = Theme | 'system'

const THEME_OPTIONS: { value: Preference; label: string; hint: string }[] = [
  { value: 'system', label: 'sistema', hint: 'segue o tema do dispositivo' },
  { value: 'goodchat-light', label: 'claro', hint: 'cream / crimson' },
  { value: 'goodchat-dark', label: 'escuro', hint: 'noir / rose' },
]

export function SettingsScreen() {
  const { user, setTheme, logout, isOwner } = useSession()
  const push = usePush()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null
  const current: Preference = user.theme ?? 'system'

  const pick = (preference: Preference) => {
    if (saving || preference === current) return
    setSaving(true)
    setError(null)
    setTheme(preference === 'system' ? null : preference)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 0
            ? 'servidor inacessível — tema salvo só neste dispositivo'
            : 'não deu pra salvar o tema na conta',
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} configurações
          </p>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            Ajustes
          </h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            @{user.username}
            {isOwner && ' · owner'}
          </p>
        </div>
        <RetroIconButton onClick={() => navigate({ name: 'list' })}>← voltar</RetroIconButton>
      </header>

      {error && (
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
      )}

      <section className="card card-border border-base-300 bg-base-200 retro-shadow">
        <div className="card-body gap-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} tema
            </h2>
            <p className="mt-1 text-sm opacity-70">
              Salvo na sua conta — vale em qualquer dispositivo onde você entrar.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {THEME_OPTIONS.map((option) => {
              const selected = option.value === current
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={saving}
                  onClick={() => pick(option.value)}
                  className={`retro-border flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-all duration-300 hover:-translate-y-1 hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected ? 'bg-accent text-accent-content' : 'bg-base-100'
                  }`}
                >
                  <span className="font-mono text-xs font-black uppercase tracking-widest">
                    {option.label}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
                    {selected ? 'ativo' : option.hint}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      <section className="card card-border border-base-300 bg-base-200 retro-shadow">
        <div className="card-body gap-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} notificações
            </h2>
            <p className="mt-1 text-sm opacity-70">
              {push.state === 'unsupported'
                ? 'Este navegador não suporta web push.'
                : push.state === 'denied'
                  ? 'Permissão bloqueada no navegador — libere nas configurações do site.'
                  : push.state === 'unavailable'
                    ? 'Push não configurado no servidor.'
                    : 'Avisa quando chegar mensagem com o app fechado.'}
            </p>
          </div>
          <RetroIconButton
            onClick={push.toggle}
            disabled={
              push.state === 'loading' ||
              push.state === 'denied' ||
              push.state === 'unsupported' ||
              push.state === 'unavailable' ||
              push.busy
            }
            className={`self-start ${push.state === 'on' ? 'bg-accent text-accent-content' : ''}`}
          >
            {push.busy || push.state === 'loading'
              ? 'aguarde …'
              : push.state === 'on'
                ? 'desativar'
                : 'ativar'}
          </RetroIconButton>
        </div>
      </section>

      {isOwner && (
        <section className="card card-border border-base-300 bg-base-200 retro-shadow">
          <div className="card-body gap-4">
            <div>
              <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
                {'>'} administração
              </h2>
              <p className="mt-1 text-sm opacity-70">
                Contas, uso de armazenamento e limpeza de histórico.
              </p>
            </div>
            <RetroIconButton className="self-start" onClick={() => navigate({ name: 'admin' })}>
              abrir painel
            </RetroIconButton>
          </div>
        </section>
      )}

      <section className="card card-border border-base-300 bg-base-200 retro-shadow">
        <div className="card-body gap-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} sessão
            </h2>
            <p className="mt-1 text-sm opacity-70">
              Encerra a sessão neste dispositivo e remove as notificações dele.
            </p>
          </div>
          <RetroIconButton className="self-start" onClick={() => void logout()}>
            sair
          </RetroIconButton>
        </div>
      </section>
    </main>
  )
}
