// Thread: resolve the deterministic conversation id for the peer, then run
// the live WebSocket. Header shows LINK status (terminal motif); read
// receipts fire when the tab is visible so unread badges stay truthful.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, resolveConversation } from '../lib/api'
import type { PublicUser } from '../lib/api'
import { useConversation } from '../hooks/useConversation'
import type { ConnectionState } from '../hooks/useConversation'
import { useSession } from '../hooks/useSession'
import { Avatar } from '../components/Avatar'
import { Composer } from '../components/Composer'
import { MessageBubble } from '../components/MessageBubble'
import { RetroIconButton } from '../components/RetroIconButton'
import { ThreadSkeleton } from '../components/Skeleton'
import { WindowDots } from '../components/WindowDots'
import { navigate } from '../lib/router'

const LINK_LABEL: Record<ConnectionState, { text: string; className: string }> = {
  online: { text: 'link: online', className: 'text-success' },
  connecting: { text: 'link: connecting', className: 'text-warning' },
  offline: { text: 'link: offline', className: 'text-error' },
}

export function ThreadScreen({ userId }: { userId: string }) {
  const { user } = useSession()
  const [resolved, setResolved] = useState<{
    conversationId: string
    otherUser: PublicUser
    readonly: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResolved(null)
    setError(null)
    resolveConversation(userId)
      .then((result) => {
        if (cancelled) return
        setResolved({
          conversationId: result.conversation_id,
          otherUser: result.other_user,
          // The peer's account is gone: history stays, the composer closes.
          readonly: result.readonly,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof ApiError && err.code === 'not_found'
            ? 'usuário não encontrado'
            : 'falha ao abrir a conversa',
        )
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (!user) return null

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-start gap-4 p-6">
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
        <RetroIconButton onClick={() => navigate({ name: 'list' })}>← voltar</RetroIconButton>
      </main>
    )
  }

  if (!resolved) {
    return (
      <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <ThreadSkeleton />
      </main>
    )
  }

  return (
    <LiveThread
      conversationId={resolved.conversationId}
      otherUser={resolved.otherUser}
      myId={user.id}
      readonly={resolved.readonly}
    />
  )
}

function LiveThread({
  conversationId,
  otherUser,
  myId,
  readonly,
}: {
  conversationId: string
  otherUser: PublicUser
  myId: string
  readonly: boolean
}) {
  const { messages, connection, peerTyping, send, sendMedia, sendSticker, sendTyping, markRead } =
    useConversation(conversationId, otherUser.id, myId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const lastPeerMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.sender_id !== myId && m.id !== null) return m.id
    }
    return null
  }, [messages, myId])

  // Read receipt whenever the newest peer message is (or becomes) visible.
  useEffect(() => {
    if (lastPeerMessageId === null) return
    const fire = () => {
      if (document.visibilityState === 'visible') markRead(lastPeerMessageId)
    }
    fire()
    document.addEventListener('visibilitychange', fire)
    return () => document.removeEventListener('visibilitychange', fire)
  }, [lastPeerMessageId, markRead])

  // Auto-scroll: follow the tail unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const link = LINK_LABEL[connection]

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="retro-border flex items-center gap-3 bg-base-200 p-3 retro-shadow-sm">
        <WindowDots />
        <RetroIconButton onClick={() => navigate({ name: 'list' })} aria-label="voltar à lista">
          ←
        </RetroIconButton>
        <Avatar user={otherUser} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black uppercase tracking-tight">
            {readonly ? 'conta expirada' : (otherUser.display_name ?? otherUser.username)}
          </p>
          <p className="truncate font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
            {readonly ? 'somente leitura' : `@${otherUser.username}`}
          </p>
        </div>
        <p
          className={`shrink-0 font-mono text-[8px] uppercase tracking-[0.2em] md:text-[10px] ${link.className}`}
        >
          {link.text}
        </p>
      </header>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1"
      >
        {messages.length === 0 && (
          <p className="mt-8 self-center font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
            {'>'} sem mensagens — diga oi<span className="terminal-cursor">_</span>
          </p>
        )}
        {messages.map((message) => (
          <MessageBubble
            key={message.client_id}
            message={message}
            mine={message.sender_id === myId}
          />
        ))}
      </div>

      {/* Fixed-height slot so the hint never shifts the layout (styleguide §6:
          micro-text + blinking cursor, no bouncing dots). */}
      <p
        className="h-4 shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-accent"
        aria-live="polite"
      >
        {peerTyping && (
          <>
            @{otherUser.username} digitando<span className="terminal-cursor">_</span>
          </>
        )}
      </p>

      {readonly ? (
        <p className="retro-border shrink-0 bg-base-200 p-3 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] opacity-60">
          esta conta não existe mais — o histórico fica, mas não dá pra responder
        </p>
      ) : (
        <Composer
          onSend={send}
          onSendMedia={sendMedia}
          onSendSticker={sendSticker}
          onTyping={sendTyping}
        />
      )}
    </main>
  )
}
