// Settings (#/config): account-level preferences. The theme picked here is
// stored on the account, so it follows the person to every device instead of
// living in one browser's localStorage.
//
// Push opt-in moved here from the conversation-list header: it is a setting,
// and the header was collecting toolbar buttons.

import { useState } from 'react'
import { ApiError } from '../lib/api'
import { usePush } from '../hooks/usePush'
import { useSession } from '../hooks/useSession'
import { useTheme, type ThemePrefs } from '../hooks/useTheme'
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  type ModePreference,
  type PaletteOption,
} from '../lib/themes'
import { RetroIconButton } from '../components/RetroIconButton'
import { PaletteSwatch } from '../components/PaletteSwatch'
import { TempAccountBanner } from '../components/TempAccount'
import { navigate } from '../lib/router'

const MODE_OPTIONS: { value: ModePreference; label: string; hint: string }[] = [
  { value: null, label: 'sistema', hint: 'segue o dispositivo' },
  { value: 'light', label: 'claro', hint: 'paleta clara sempre' },
  { value: 'dark', label: 'escuro', hint: 'paleta escura sempre' },
]

export function SettingsScreen() {
  const { user, setTheme, logout, isOwner } = useSession()
  const { prefs, mode } = useTheme()
  const push = usePush()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!user) return null

  const save = (next: ThemePrefs) => {
    if (saving) return
    setSaving(true)
    setError(null)
    setTheme(next)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 0
            ? 'servidor inacessível — tema salvo só neste dispositivo'
            : 'não deu pra salvar o tema na conta',
        )
      })
      .finally(() => setSaving(false))
  }

  const pickMode = (value: ModePreference) => {
    if (value !== prefs.mode) save({ ...prefs, mode: value })
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

      <TempAccountBanner />

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

          <div className="grid grid-cols-3 gap-2">
            {MODE_OPTIONS.map((option) => {
              const selected = option.value === prefs.mode
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={selected}
                  disabled={saving}
                  onClick={() => pickMode(option.value)}
                  className={`retro-border flex cursor-pointer flex-col gap-1 px-3 py-3 text-left transition-all duration-300 hover:-translate-y-1 hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                    selected ? 'bg-accent text-accent-content' : 'bg-base-100'
                  }`}
                >
                  <span className="font-mono text-xs font-black uppercase tracking-widest">
                    {option.label}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] opacity-60">
                    {option.hint}
                  </span>
                </button>
              )
            })}
          </div>

          <PaletteGroup
            title="paleta clara"
            active={mode === 'light'}
            options={LIGHT_PALETTES}
            selected={prefs.light}
            disabled={saving}
            onPick={(id) => id !== prefs.light && save({ ...prefs, light: id })}
          />
          <PaletteGroup
            title="paleta escura"
            active={mode === 'dark'}
            options={DARK_PALETTES}
            selected={prefs.dark}
            disabled={saving}
            onPick={(id) => id !== prefs.dark && save({ ...prefs, dark: id })}
          />
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

/**
 * One mode's palette shelf. Both shelves are always shown, even though only
 * one is on screen right now: picking the dark palette while sitting in the
 * light one is the normal case, and hiding it behind the mode switch would
 * mean toggling the whole app just to preview a color.
 */
function PaletteGroup({
  title,
  active,
  options,
  selected,
  disabled,
  onPick,
}: {
  title: string
  active: boolean
  options: readonly PaletteOption[]
  selected: string
  disabled: boolean
  onPick: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">
          {title}
        </h3>
        {active && (
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
            em uso agora
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((palette) => {
          const isSelected = palette.id === selected
          return (
            <button
              key={palette.id}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onPick(palette.id)}
              className={`retro-border flex cursor-pointer items-center gap-3 px-3 py-2 text-left transition-all duration-300 hover:-translate-y-1 hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${
                isSelected ? 'bg-accent text-accent-content' : 'bg-base-100'
              }`}
            >
              <PaletteSwatch palette={palette} />
              <span className="font-mono text-[11px] font-black uppercase tracking-widest">
                {palette.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
