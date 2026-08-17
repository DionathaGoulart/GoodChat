import { useEffect, useState } from 'react'

type Theme = 'goodchat-light' | 'goodchat-dark'
type ApiStatus = 'CHECKING' | 'ONLINE' | 'OFFLINE'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

// Temporary theme demo page — replaced by the real app in phase 5.
function App() {
  const [theme, setTheme] = useState<Theme>('goodchat-light')
  const [apiStatus, setApiStatus] = useState<ApiStatus>('CHECKING')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    fetch(`${API_URL}/api/health`)
      .then((r) => setApiStatus(r.ok ? 'ONLINE' : 'OFFLINE'))
      .catch(() => setApiStatus('OFFLINE'))
  }, [])

  return (
    <div className="min-h-screen p-6 sm:p-8 md:p-12">
      <div className="terminal-scanline opacity-10" aria-hidden="true" />

      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="font-mono text-accent text-xs font-bold uppercase tracking-widest sm:text-base">
            {'>'} goodchat_theme_demo
          </p>
          <h1 className="text-4xl font-black uppercase italic leading-[1.05] tracking-tighter underline decoration-accent decoration-4 underline-offset-4 sm:text-5xl md:text-6xl md:decoration-8 md:underline-offset-8">
            GoodChat
          </h1>
          <p className="text-base font-medium leading-relaxed text-base-content/70 sm:text-lg">
            Prova visual do tema retro — cantos retos, bordas 2px, sombra dura,
            JetBrains Mono em tudo.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="btn btn-goodchat retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0"
            onClick={() =>
              setTheme(theme === 'goodchat-light' ? 'goodchat-dark' : 'goodchat-light')
            }
          >
            Trocar tema
          </button>
          <button
            type="button"
            className="btn btn-goodchat-outline retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0"
          >
            Secundário
          </button>
          <span className="badge h-auto gap-0 border-base-300 bg-accent px-3 py-1 text-[10px] font-black uppercase tracking-widest text-accent-content">
            {theme}
          </span>
        </div>

        <div className="card card-border border-base-300 bg-base-200 retro-shadow">
          <div className="card-body gap-4">
            <h2 className="text-xl font-black uppercase tracking-tighter">
              Card com retro-shadow
          </h2>
            <p className="font-medium leading-relaxed text-base-content/70">
              Superfície elevada (base-200), borda base-300, radius 0. Bolhas de
              mensagem, modais e o container de login herdam este tratamento.
            </p>
            <div className="flex flex-col gap-2">
              <div className="max-w-xs self-start retro-border bg-base-100 p-3 retro-shadow-sm">
                <p className="text-sm">Mensagem recebida fica assim.</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
                  10:42 · delivered
                </p>
              </div>
              <div className="max-w-xs self-end retro-border bg-accent p-3 text-accent-content retro-shadow-sm">
                <p className="text-sm">E a enviada fica assim.</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
                  10:43 · read
                </p>
              </div>
            </div>
            <p className="font-mono text-sm">
              composer_
              <span className="terminal-cursor">█</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <span className="badge h-auto border-base-300 bg-info px-2 py-1 text-[10px] font-black uppercase tracking-widest text-info-content">
            info
          </span>
          <span className="badge h-auto border-base-300 bg-success px-2 py-1 text-[10px] font-black uppercase tracking-widest text-success-content">
            success
          </span>
          <span className="badge h-auto border-base-300 bg-warning px-2 py-1 text-[10px] font-black uppercase tracking-widest text-warning-content">
            warning
          </span>
          <span className="badge h-auto border-base-300 bg-error px-2 py-1 text-[10px] font-black uppercase tracking-widest text-error-content">
            error
          </span>
        </div>

        <footer className="flex flex-wrap gap-4 text-[8px] uppercase tracking-[0.2em] opacity-40 md:text-[10px]">
          <span>goodchat_v0.1</span>
          <span>
            link:{' '}
            <span
              className={
                apiStatus === 'ONLINE'
                  ? 'text-success'
                  : apiStatus === 'OFFLINE'
                    ? 'text-error'
                    : ''
              }
            >
              {apiStatus}
            </span>
          </span>
          <span>enc: none_yet</span>
        </footer>
      </div>
    </div>
  )
}

export default App
