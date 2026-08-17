// Conversation list: search to start new threads, tiles with preview +
// unread badge (worker enriches via DO /summary). Light polling keeps the
// list fresh while visible — real-time list updates are a phase-7+ debt.

import { useCallback, useEffect, useState } from 'react'
import { listConversations } from '../lib/api'
import type { ConversationListItem } from '../lib/api'
import { useSession } from '../hooks/useSession'
import { useTheme } from '../hooks/useTheme'
import { ConversationTile } from '../components/ConversationTile'
import { RetroIconButton } from '../components/RetroIconButton'
import { UserSearch } from '../components/UserSearch'
import { navigate } from '../lib/router'

const POLL_MS = 15_000

export function ConversationsScreen() {
  const { user, setTheme } = useSession()
  const { theme, toggle } = useTheme()
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  // The header toggle is a shortcut for the setting: flip locally for an
  // instant response, then persist it to the account. A failed write is not
  // worth an error banner here — the settings screen owns that feedback.
  const flipTheme = useCallback(() => {
    void setTheme(toggle())
  }, [setTheme, toggle])

  const refresh = useCallback(() => {
    listConversations()
      .then(({ conversations }) => {
        setConversations(conversations)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-6 sm:p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} conversas
          </p>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            GoodChat
          </h1>
          {user && (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
              logado como @{user.username}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <RetroIconButton
            onClick={flipTheme}
            aria-label="alternar tema"
            title={theme === 'goodchat-light' ? 'modo escuro' : 'modo claro'}
          >
            {theme === 'goodchat-light' ? 'dark' : 'light'}
          </RetroIconButton>
          <RetroIconButton
            onClick={() => navigate({ name: 'settings' })}
            aria-label="configurações"
            title="configurações, notificações e sessão"
          >
            config
          </RetroIconButton>
        </div>
      </header>

      <UserSearch />

      {failed && (
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          falha ao carregar conversas — tentando de novo em instantes
        </p>
      )}

      {conversations === null ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
          carregando conversas<span className="terminal-cursor">_</span>
        </p>
      ) : conversations.length === 0 ? (
        <div className="animate-enter card card-border border-base-300 bg-base-200 retro-shadow">
          <div className="card-body gap-2">
            <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
              {'>'} awaiting_first_contact<span className="terminal-cursor">_</span>
            </p>
            <p className="text-sm font-medium leading-relaxed opacity-70">
              Nenhuma conversa ainda. Busque alguém por @username acima — a
              conversa é criada na primeira mensagem.
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {conversations.map((item) => (
            <li key={item.id}>
              <ConversationTile item={item} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
