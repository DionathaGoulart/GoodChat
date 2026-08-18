// Conversation list: search to start new threads, tiles with preview +
// unread badge (worker enriches via DO /summary) + whether the peer is online.
// Light polling keeps the list fresh while visible — real-time list updates are
// a phase-7+ debt. Presence is not part of that poll: it rides its own
// heartbeat (lib/presence.ts), which refreshes faster than the list does.
//
// The first paint comes from the local copy (lib/conversationsCache.ts), on the
// same stale-while-revalidate terms the session already runs on: an account
// restored from cache lands on its threads instead of on a skeleton, and the
// first poll overwrites them. The skeleton is now what a *cold* start shows —
// a device that has never listed, or one whose copy belongs to somebody else.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { listConversations } from '../lib/api'
import type { ConversationListItem } from '../lib/api'
import { readCachedConversations, writeCachedConversations } from '../lib/conversationsCache'
import { usePresence } from '../hooks/usePresence'
import { useSession } from '../hooks/useSession'
import { useTheme } from '../hooks/useTheme'
import { Panel } from '../components/Panel'
import { ConversationTile } from '../components/ConversationTile'
import { MoonIcon, SunIcon } from '../components/Icons'
import { ConversationListSkeleton } from '../components/Skeleton'
import { GuestCredentialsCard, TempAccountBanner } from '../components/TempAccount'
import { RetroIconButton } from '../components/RetroIconButton'
import { UserSearch } from '../components/UserSearch'
import { navigate } from '../lib/router'

const POLL_MS = 15_000

export function ConversationsScreen() {
  const { user, setTheme } = useSession()
  const { mode, toggleMode } = useTheme()
  // Read once, at mount: `user` is replaced by revalidation but keeps its id,
  // and re-reading on every render would fight the fetched list for the state.
  const [cached] = useState<ConversationListItem[] | null>(() =>
    user ? readCachedConversations(user.id) : null,
  )
  const [conversations, setConversations] = useState(cached)
  /**
   * Whether the server has answered once. An empty *cached* list is the one
   * copy that must not be believed on sight: a thread started on another device
   * would show "awaiting_first_contact" — not a stale detail like a nickname,
   * but a screen claiming the person has no conversations at all. So an empty
   * copy waits behind the skeleton, while a non-empty one paints at once.
   */
  const [settled, setSettled] = useState(cached === null)
  const [failed, setFailed] = useState(false)

  // One heartbeat asks about every peer on screen at once.
  const peerIds = useMemo(
    () => (conversations ?? []).map((item) => item.other_user.id),
    [conversations],
  )
  const presence = usePresence(peerIds)

  // The header toggle is a shortcut for the setting: flip locally for an
  // instant response, then persist it to the account. It only moves the mode —
  // each mode keeps whichever palette was chosen for it. A failed write is not
  // worth an error banner here — the settings screen owns that feedback.
  const flipTheme = useCallback(() => {
    void setTheme(toggleMode())
  }, [setTheme, toggleMode])

  const ownerId = user?.id
  const refresh = useCallback(() => {
    listConversations()
      .then(({ conversations }) => {
        setConversations(conversations)
        if (ownerId) writeCachedConversations(ownerId, conversations)
        setSettled(true)
        setFailed(false)
      })
      // The copy on screen stays: a poll that could not reach the server has
      // nothing truer to put in its place, and the banner says so.
      .catch(() => setFailed(true))
  }, [ownerId])

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
            aria-label={mode === 'light' ? 'ativar modo escuro' : 'ativar modo claro'}
            title={mode === 'light' ? 'modo escuro' : 'modo claro'}
            className="flex items-center justify-center"
          >
            {/* The icon is the mode the button switches *to* — a moon while the
                app is light, a sun while it is dark. */}
            {mode === 'light' ? <MoonIcon /> : <SunIcon />}
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

      <TempAccountBanner />
      <GuestCredentialsCard />

      <UserSearch />

      {failed && (
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          falha ao carregar conversas — tentando de novo em instantes
        </p>
      )}

      {conversations === null || (conversations.length === 0 && !settled) ? (
        <ConversationListSkeleton />
      ) : conversations.length === 0 ? (
        <Panel
          title="inbox.log"
          as="div"
          className="animate-enter"
          bodyClassName="gap-2"
        >
          <p className="font-mono text-xs font-bold uppercase tracking-widest text-accent">
            {'>'} awaiting_first_contact<span className="terminal-cursor">_</span>
          </p>
          <p className="text-sm font-medium leading-relaxed opacity-70">
            Nenhuma conversa ainda. Busque alguém por @username acima — a
            conversa é criada na primeira mensagem.
          </p>
        </Panel>
      ) : (
        <ul className="flex flex-col gap-3">
          {conversations.map((item) => (
            <li key={item.id}>
              <ConversationTile item={item} presence={presence.get(item.other_user.id)} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
