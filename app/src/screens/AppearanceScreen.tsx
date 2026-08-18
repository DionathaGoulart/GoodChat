// Appearance (#/config/aparencia): everything about how the app looks, in one
// place — the skin (geometry) and the theme (mode + palette).
//
// It used to be a single "tema" card inside the settings screen. Splitting it
// out is what let the skin exist: two independent axes need two shelves and
// their own previews, and settings is a list of unrelated switches, not a place
// to compare looks.
//
// Every choice is stored on the account (PATCH /api/settings), so it follows the
// person to every device instead of living in one browser's localStorage.

import { useState } from 'react'
import { ApiError } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { useTheme, type ThemePrefs } from '../hooks/useTheme'
import { SKINS, type SkinOption } from '../lib/skins'
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  type ModePreference,
  type PaletteOption,
} from '../lib/themes'
import { PaletteSwatch } from '../components/PaletteSwatch'
import { RetroIconButton } from '../components/RetroIconButton'
import { navigate } from '../lib/router'

const MODE_OPTIONS: { value: ModePreference; label: string; hint: string }[] = [
  { value: null, label: 'sistema', hint: 'segue o dispositivo' },
  { value: 'light', label: 'claro', hint: 'paleta clara sempre' },
  { value: 'dark', label: 'escuro', hint: 'paleta escura sempre' },
]

export function AppearanceScreen() {
  const { user, setTheme } = useSession()
  const { prefs, mode } = useTheme()
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
            ? 'servidor inacessível — aparência salva só neste dispositivo'
            : 'não deu pra salvar a aparência na conta',
        )
      })
      .finally(() => setSaving(false))
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} aparência
          </p>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            Aparência
          </h1>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            skin + tema · salvo na conta
          </p>
        </div>
        <RetroIconButton onClick={() => navigate({ name: 'settings' })}>← ajustes</RetroIconButton>
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
              {'>'} skins
            </h2>
            <p className="mt-1 text-sm opacity-70">
              A geometria: espessura das molduras, sombra dura ou brilho de CRT. As cores
              continuam sendo as do tema.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SKINS.map((skin) => (
              <SkinButton
                key={skin.id}
                skin={skin}
                selected={skin.id === prefs.skin}
                disabled={saving}
                onPick={() => {
                  if (skin.id !== prefs.skin) save({ ...prefs, skin: skin.id })
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="card card-border border-base-300 bg-base-200 retro-shadow">
        <div className="card-body gap-4">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} temas
            </h2>
            <p className="mt-1 text-sm opacity-70">
              Claro, escuro ou o que o dispositivo pedir — e qual paleta cada modo usa.
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
                  onClick={() => {
                    if (option.value !== prefs.mode) save({ ...prefs, mode: option.value })
                  }}
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
            title={mode === 'dark' ? 'paleta escura' : 'paleta clara'}
            options={mode === 'dark' ? DARK_PALETTES : LIGHT_PALETTES}
            selected={mode === 'dark' ? prefs.dark : prefs.light}
            disabled={saving}
            onPick={(id) => {
              const current = mode === 'dark' ? prefs.dark : prefs.light
              if (id !== current) save({ ...prefs, [mode]: id })
            }}
          />
        </div>
      </section>
    </main>
  )
}

/**
 * One skin option. The preview is not a picture of the skin — it *is* the skin:
 * `data-skin` on the swatch makes that little frame resolve the same tokens the
 * whole app would (styles/skins.css), so a preview can never fall out of sync
 * with what picking it does.
 */
function SkinButton({
  skin,
  selected,
  disabled,
  onPick,
}: {
  skin: SkinOption
  selected: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      className={`retro-border flex cursor-pointer items-center gap-3 px-3 py-3 text-left transition-all duration-300 hover:-translate-y-1 hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${
        selected ? 'bg-accent text-accent-content' : 'bg-base-100'
      }`}
    >
      <span
        data-skin={skin.id}
        aria-hidden="true"
        className="retro-border size-8 shrink-0 bg-base-100 retro-shadow-sm"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-[11px] font-black uppercase tracking-widest">
          {skin.label}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] opacity-60">
          {skin.hint}
        </span>
      </span>
    </button>
  )
}

/**
 * The palette shelf of the mode that is on screen — only that one. Each mode
 * keeps its own palette, and showing both shelves at once meant four of the
 * swatches previewed colors the app was not going to use until the mode
 * changed: the mode buttons above are the way to reach the other shelf, and
 * flipping them shows the palette applied instead of guessed.
 */
function PaletteGroup({
  title,
  options,
  selected,
  disabled,
  onPick,
}: {
  title: string
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
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">
          em uso agora
        </span>
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
