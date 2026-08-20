// Settings (#/config): account-level preferences — profile, appearance,
// notifications, administration and the session.
//
// Appearance is a screen of its own (#/config/aparencia): it grew two axes,
// skins and themes, each with its own shelf of previews, and this screen is a
// list of unrelated switches rather than a place to compare looks.
//
// Push opt-in moved here from the conversation-list header: it is a setting,
// and the header was collecting toolbar buttons.

import { useState } from 'react'
import type { PushPreview } from '../lib/api'
import { usePush } from '../hooks/usePush'
import { useSession } from '../hooks/useSession'
import { Panel } from '../components/Panel'
import { RetroIconButton } from '../components/RetroIconButton'
import { ProfileCard } from '../components/ProfileCard'
import { PasswordCard } from '../components/PasswordCard'
import { TempAccountBanner } from '../components/TempAccount'
import { navigate } from '../lib/router'

export function SettingsScreen() {
  const { user, logout, isOwner, setPushPreview } = useSession()
  const push = usePush()
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState(false)

  if (!user) return null

  const preview: PushPreview = user.push_preview === 'full' ? 'full' : 'generic'

  const choosePreview = (next: PushPreview) => {
    if (next === preview || previewBusy) return
    setPreviewBusy(true)
    setPreviewError(false)
    setPushPreview(next)
      .catch(() => setPreviewError(true))
      .finally(() => setPreviewBusy(false))
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 screen-pad sm:gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="screen-kicker font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> configurações
          </p>
          <h1 className="screen-title text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            Ajustes
          </h1>
          <p className="screen-meta mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            @{user.username}
            {isOwner && ' · owner'}
          </p>
        </div>
        <RetroIconButton onClick={() => navigate({ name: 'list' })}>← voltar</RetroIconButton>
      </header>

      <TempAccountBanner />

      <ProfileCard />

      <PasswordCard />

      <Panel title="aparencia.cfg">
        <div>
          <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> aparência
          </h2>
          <p className="mt-1 text-sm opacity-70">
            Skins e temas. Salvo na sua conta — vale em qualquer dispositivo onde você
            entrar.
          </p>
        </div>
        <RetroIconButton
          className="self-start"
          onClick={() => navigate({ name: 'appearance' })}
        >
          abrir aparência
        </RetroIconButton>
      </Panel>

      <Panel title="notificacoes.cfg">
        <div>
          <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> notificações
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

        {/* The one copy of a message the retention window cannot reach: a
            preview shown on the lock screen stays in the system's notification
            centre long after the message is deleted. Hence the choice, and
            hence "genérico" as the default. */}
        <div className="border-t-2 border-base-content/10 pt-4">
          <h3 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> prévia
          </h3>
          <p className="mt-1 text-sm opacity-70">
            {preview === 'full'
              ? 'A notificação mostra o começo da mensagem. Ela fica na central de notificações do aparelho, que não conhece a janela da conversa — o texto pode sobreviver à mensagem apagada.'
              : 'A notificação mostra só quem mandou. Nenhum trecho da conversa sai do app.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RetroIconButton
              onClick={() => choosePreview('generic')}
              disabled={previewBusy}
              className={preview === 'generic' ? 'bg-accent text-accent-content' : ''}
            >
              genérico
            </RetroIconButton>
            <RetroIconButton
              onClick={() => choosePreview('full')}
              disabled={previewBusy}
              className={preview === 'full' ? 'bg-accent text-accent-content' : ''}
            >
              mostrar trecho
            </RetroIconButton>
          </div>
          {previewError && (
            <p className="mt-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
              não deu para salvar — tente de novo
            </p>
          )}
        </div>
      </Panel>

      {isOwner && (
        <Panel title="administracao.cfg">
          <div>
            <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
              <span className="sigil">{'>'}</span> administração
            </h2>
            <p className="mt-1 text-sm opacity-70">
              Contas, uso de armazenamento e limpeza de histórico.
            </p>
          </div>
          <RetroIconButton className="self-start" onClick={() => navigate({ name: 'admin' })}>
            abrir painel
          </RetroIconButton>
        </Panel>
      )}

      <Panel title="sessao.cfg">
        <div>
          <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> sessão
          </h2>
          <p className="mt-1 text-sm opacity-70">
            Encerra a sessão neste dispositivo e remove as notificações dele.
          </p>
        </div>
        <RetroIconButton className="self-start" onClick={() => void logout()}>
          sair
        </RetroIconButton>
      </Panel>
    </main>
  )
}
