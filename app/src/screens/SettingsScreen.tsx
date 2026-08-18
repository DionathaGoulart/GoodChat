// Settings (#/config): account-level preferences — profile, appearance,
// notifications, administration and the session.
//
// Appearance is a screen of its own (#/config/aparencia): it grew two axes,
// skins and themes, each with its own shelf of previews, and this screen is a
// list of unrelated switches rather than a place to compare looks.
//
// Push opt-in moved here from the conversation-list header: it is a setting,
// and the header was collecting toolbar buttons.

import { usePush } from '../hooks/usePush'
import { useSession } from '../hooks/useSession'
import { Panel } from '../components/Panel'
import { RetroIconButton } from '../components/RetroIconButton'
import { ProfileCard } from '../components/ProfileCard'
import { TempAccountBanner } from '../components/TempAccount'
import { navigate } from '../lib/router'

export function SettingsScreen() {
  const { user, logout, isOwner } = useSession()
  const push = usePush()

  if (!user) return null

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

      <ProfileCard />

      <Panel title="aparencia.cfg">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} aparência
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
      </Panel>

      {isOwner && (
        <Panel title="administracao.cfg">
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
        </Panel>
      )}

      <Panel title="sessao.cfg">
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
      </Panel>
    </main>
  )
}
