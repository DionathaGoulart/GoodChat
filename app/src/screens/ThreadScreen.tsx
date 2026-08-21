// Thread: resolve the deterministic conversation id for the peer, then run
// the live WebSocket. Read receipts fire when the tab is visible so unread
// badges stay truthful.
//
// The header used to report my own socket ("link: online"), which said nothing
// about the person being written to. It now reports *their* presence
// (lib/presence.ts) — with one exception: while my own link is down I cannot
// know theirs, so the link state is what gets shown instead of a stale "online".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, resolveConversation } from '../lib/api'
import { readCachedThread, writeCachedThread } from '../lib/threadCache'
import type { PublicUser } from '../lib/api'
import type { RetentionMs } from '../lib/protocol'
import { retentionLabel, retentionShort } from '../lib/retention'
import { useConversation } from '../hooks/useConversation'
import type { ConnectionState } from '../hooks/useConversation'
import { usePresence } from '../hooks/usePresence'
import { useSession } from '../hooks/useSession'
import { presenceText, resolvePresence } from '../lib/presence'
import { Avatar } from '../components/Avatar'
import { Composer } from '../components/Composer'
import { MessageBubble } from '../components/MessageBubble'
import { PresenceMarker } from '../components/Presence'
import { RetentionDialog } from '../components/RetentionDialog'
import { SafetyNumberDialog } from '../components/SafetyNumber'
import { devicesFingerprint } from '../lib/e2ee'
import { getDevices } from '../lib/deviceDirectory'
import { RetroIconButton } from '../components/RetroIconButton'
import { MessagesSkeleton, ThreadSkeleton } from '../components/Skeleton'
import { WindowDots } from '../components/WindowDots'
import { navigate } from '../lib/router'

/** Shown only while the socket is not up — see the note at the top. */
const LINK_LABEL: Record<Exclude<ConnectionState, 'online'>, { text: string; className: string }> = {
  connecting: { text: 'link: connecting', className: 'text-warning' },
  offline: { text: 'link: offline', className: 'text-error' },
}

export function ThreadScreen({ userId }: { userId: string }) {
  const { user } = useSession()
  const myId = user?.id
  // The local copy (lib/threadCache.ts) is what the header and the thread paint
  // while resolve is in flight — a conversation opened before starts with its
  // peer already on screen instead of with a skeleton. `readonly` is the one
  // field a stale copy can get wrong (the peer's account expired since), and it
  // only ever opens a composer that the server refuses anyway; the answer
  // closes it a round trip later.
  const [resolved, setResolved] = useState<{
    conversationId: string
    otherUser: PublicUser
    readonly: boolean
    exists: boolean
    retentionMs: number
  } | null>(() => (myId ? readCachedThread(myId, userId) : null))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setResolved(myId ? readCachedThread(myId, userId) : null)
    setError(null)
    resolveConversation(userId)
      .then((result) => {
        if (cancelled) return
        const next = {
          conversationId: result.conversation_id,
          otherUser: result.other_user,
          // The peer's account is gone: history stays, the composer closes.
          readonly: result.readonly,
          // The row is created by the first message, so this is the answer to
          // "does this thread hold anything" — known a whole socket connect
          // before `history` could say so.
          exists: result.exists,
          // D1's mirror of the message window. It labels the header and prunes
          // the cached tail; the socket's `retention` frame confirms it.
          retentionMs: result.retention_ms,
        }
        setResolved(next)
        if (myId) writeCachedThread(myId, userId, next)
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
  }, [userId, myId])

  if (!user) return null

  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col items-start gap-4 screen-pad">
        <p className="border-2 border-error bg-error/10 p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {error}
        </p>
        <RetroIconButton onClick={() => navigate({ name: 'list' })}>← voltar</RetroIconButton>
      </main>
    )
  }

  if (!resolved) {
    return (
      <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-4 screen-pad">
        <ThreadSkeleton />
      </main>
    )
  }

  return (
    <LiveThread
      conversationId={resolved.conversationId}
      otherUser={resolved.otherUser}
      myId={user.id}
      myName={user.username}
      readonly={resolved.readonly}
      hasHistory={resolved.exists}
      initialRetentionMs={resolved.retentionMs}
    />
  )
}

function LiveThread({
  conversationId,
  otherUser,
  myId,
  myName,
  readonly,
  hasHistory,
  initialRetentionMs,
}: {
  conversationId: string
  otherUser: PublicUser
  myId: string
  /** My own handle — the nick the terminal skin prints on my own log lines. */
  myName: string
  readonly: boolean
  /** The conversation has held a message before, so `history` has one to bring. */
  hasHistory: boolean
  /** The message window as resolve reported it, until the socket confirms. */
  initialRetentionMs: number
}) {
  const {
    messages,
    synced,
    connection,
    peerTyping,
    retentionMs,
    retentionChange,
    encryption,
    sendRejected,
    send,
    sendMedia,
    sendSticker,
    sendTyping,
    markRead,
    setRetention,
  } = useConversation(conversationId, otherUser.id, myId, initialRetentionMs)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [safetyOpen, setSafetyOpen] = useState(false)
  /**
   * The peer's device set changed since this device last opened the thread.
   * Legitimate whenever they signed in somewhere new — and indistinguishable,
   * from here, from a directory that was tampered with, which is the reason to
   * say it out loud instead of absorbing it silently (components/
   * SafetyNumber.tsx).
   */
  /**
   * What the directory comparison found, or null. `new-device` is a statement,
   * `since-verified` is a warning — see the effect below for why they are not
   * the same banner.
   */
  const [keysChanged, setKeysChanged] = useState<'new-device' | 'since-verified' | null>(null)
  /** The peer's current device set is the one somebody compared out loud. */
  const [verified, setVerified] = useState(false)
  const [retentionNotice, setRetentionNotice] = useState<string | null>(null)
  const presence = usePresence(useMemo(() => [otherUser.id], [otherUser.id]))
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // Compared on open, and only on open: a change is worth one banner, not a
  // re-render every time the directory cache refreshes.
  //
  // Two different findings come out of the same comparison, and conflating them
  // is what made this banner ignorable. A device the person has never verified
  // against is *news* — most people sign into a new browser every few weeks and
  // an alarm each time trains them to dismiss it. A device set that has moved
  // since they compared the number out loud is an *alarm*, because they are
  // holding a number that no longer describes the conversation.
  useEffect(() => {
    if (!myId || readonly) return
    let cancelled = false
    void (async () => {
      const devices = await getDevices(otherUser.id)
      if (cancelled || devices.length === 0) return
      const fingerprint = await devicesFingerprint(devices)
      if (cancelled) return
      const seen = readCachedThread(myId, otherUser.id)
      setVerified(seen?.verifiedFingerprint === fingerprint)
      // No stored fingerprint is a first look, not a change: announcing one
      // would fire for every thread the first time this build runs, which is
      // the fastest way to teach somebody to ignore the banner.
      if (seen?.verifiedFingerprint && seen.verifiedFingerprint !== fingerprint) {
        setKeysChanged('since-verified')
      } else if (seen?.peerFingerprint && seen.peerFingerprint !== fingerprint) {
        setKeysChanged('new-device')
      }
      if (seen) writeCachedThread(myId, otherUser.id, { ...seen, peerFingerprint: fingerprint })
    })()
    return () => {
      cancelled = true
    }
  }, [myId, otherUser.id, readonly])

  /**
   * Records that somebody compared the number out loud. Written against the set
   * as it is *now* rather than as it was when the dialog opened, because the
   * dialog forces a directory refresh before it shows anything — the number on
   * screen is the current one by construction.
   */
  const markVerified = useCallback(async () => {
    if (!myId) return
    const devices = await getDevices(otherUser.id)
    if (devices.length === 0) return
    const fingerprint = await devicesFingerprint(devices)
    const seen = readCachedThread(myId, otherUser.id)
    if (seen) {
      writeCachedThread(myId, otherUser.id, {
        ...seen,
        peerFingerprint: fingerprint,
        verifiedFingerprint: fingerprint,
      })
    }
    setVerified(true)
    setKeysChanged(null)
  }, [myId, otherUser.id])

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

  // Either side can retune the window, so a change is announced rather than
  // just applied — a thread that silently starts deleting faster would be the
  // one surprise this feature must not spring on anyone. The line clears
  // itself; it is news, not state.
  useEffect(() => {
    if (retentionChange === null) return
    const who = retentionChange.changedBy === myId ? 'você' : `@${otherUser.username}`
    setRetentionNotice(
      `${who} definiu o prazo em ${retentionLabel(retentionChange.retentionMs)}`,
    )
    const timer = window.setTimeout(() => setRetentionNotice(null), 8000)
    return () => window.clearTimeout(timer)
  }, [retentionChange, myId, otherUser.username])

  // Auto-scroll: follow the tail unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // Whose status the header reports: the peer's, unless my own link is the
  // thing that is broken. A dead account has no presence to report at all.
  const peerState = resolvePresence(presence.get(otherUser.id), otherUser)
  const status = readonly
    ? { text: 'conta expirada', className: 'opacity-60' }
    : connection !== 'online'
      ? LINK_LABEL[connection]
      : peerState.online
        ? { text: 'online', className: 'text-success' }
        : { text: presenceText(peerState, Date.now()), className: 'opacity-60' }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-3xl flex-col gap-3 screen-pad sm:gap-4">
      {/* Six things wanted this row and a phone fits four: the window dots are
          decoration and go, and the status moves under the handle instead of
          claiming a column of its own — at 360px it was being pushed off the
          right edge and taking the retention button with it. */}
      <header className="thread-bar retro-border flex items-center gap-2 bg-base-200 p-2 retro-shadow-sm sm:gap-3 sm:p-3">
        <WindowDots className="hidden sm:flex" />
        <RetroIconButton
          className="shrink-0"
          onClick={() => navigate({ name: 'list' })}
          aria-label="voltar à lista"
        >
          ←
        </RetroIconButton>
        <PresenceMarker
          online={!readonly && peerState.online}
          label={readonly ? 'conta expirada' : presenceText(peerState, Date.now())}
        >
          <Avatar user={otherUser} />
        </PresenceMarker>
        <div className="min-w-0 flex-1">
          <p className="thread-name truncate text-sm font-black uppercase tracking-tight">
            {readonly ? 'conta expirada' : (otherUser.display_name ?? otherUser.username)}
          </p>
          {/* One line, two candidates, and a 360px header only has room for
              one: the phone keeps the status, since the handle is either the
              name already above it or a second spelling of it. */}
          <p className="flex min-w-0 items-baseline gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] sm:tracking-[0.2em]">
            <span className="hidden truncate opacity-60 sm:inline">
              {readonly ? 'somente leitura' : `@${otherUser.username}`}
            </span>
            <span className={`truncate sm:hidden ${status.className}`}>{status.text}</span>
          </p>
        </div>
        <RetroIconButton
          className="shrink-0"
          onClick={() => setSafetyOpen(true)}
          aria-label={
            encryption === 'off'
              ? 'esta conversa não está criptografada'
              : verified
                ? 'número de segurança desta conversa, já conferido'
                : 'número de segurança desta conversa'
          }
        >
          {encryption === 'off' ? '🔓' : verified ? '🔐' : '🔒'}
        </RetroIconButton>
        <RetroIconButton
          className="shrink-0"
          onClick={() => setPickerOpen(true)}
          aria-label={`prazo das mensagens: ${retentionLabel(retentionMs)}`}
        >
          ⏳<span className="hidden xs:inline"> {retentionShort(retentionMs)}</span>
        </RetroIconButton>
        <p
          className={`hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] sm:block ${status.className}`}
        >
          {status.text}
        </p>
      </header>

      {retentionNotice && (
        <p className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
          {retentionNotice}
        </p>
      )}

      {/* Not a warning about something that went wrong — a statement of what is
          true right now. During the rollout the peer may simply not have opened
          the app since it started registering keys, and that is a fact worth
          seeing before typing something, not after. */}
      {encryption === 'off' && !readonly && (
        <p className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-warning">
          esta conversa não está criptografada
        </p>
      )}

      {/* The server refused the send. Worth its own line rather than only the
          bubble's "não enviada": the reason lives on the connection, not on the
          message, so it is the same answer for everything typed next — and
          silence here is what makes somebody believe a message went out
          (hooks/useConversation.ts). */}
      {sendRejected && (
        <p className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {sendRejected}
        </p>
      )}

      {keysChanged && (
        <div className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center">
          <p
            className={`font-mono text-[10px] font-bold uppercase tracking-[0.2em] ${
              keysChanged === 'since-verified' ? 'text-error' : 'opacity-60'
            }`}
          >
            {keysChanged === 'since-verified'
              ? `os aparelhos de @${otherUser.username} mudaram depois de você conferir`
              : `@${otherUser.username} entrou num aparelho novo`}
          </p>
          <button
            type="button"
            onClick={() => {
              setKeysChanged(null)
              setSafetyOpen(true)
            }}
            className="mt-1 cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] underline opacity-70 hover:opacity-100"
          >
            {keysChanged === 'since-verified'
              ? 'conferir o número de novo'
              : 'conferir o número de segurança'}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="thread-log flex flex-1 flex-col gap-3 overflow-y-auto pr-1"
      >
        {/* Nothing at all for a thread that is genuinely empty — the composer
            below already says what to do with it. The skeleton is only for the
            wait: the conversation is known to hold messages and `history` has
            not arrived yet, which is a socket connect plus a round trip. */}
        {messages.length === 0 && !synced && hasHistory && <MessagesSkeleton />}
        {messages.map((message) => (
          <MessageBubble
            key={message.client_id}
            message={message}
            mine={message.sender_id === myId}
            sender={message.sender_id === myId ? myName : otherUser.username}
          />
        ))}
      </div>

      {/* Fixed-height slot so the hint never shifts the layout (styleguides/retro.md §6:
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
          conversationId={conversationId}
          onSend={send}
          onSendMedia={sendMedia}
          onSendSticker={sendSticker}
          onTyping={sendTyping}
        />
      )}

      {safetyOpen && (
        <SafetyNumberDialog
          myId={myId}
          otherUser={otherUser}
          verified={verified}
          onVerify={markVerified}
          onClose={() => setSafetyOpen(false)}
        />
      )}

      {pickerOpen && (
        <RetentionDialog
          current={retentionMs}
          peerName={otherUser.username}
          // The window is shared state on the server: with no socket there is
          // nothing to agree with, so the grid is read-only until it is back.
          disabled={connection !== 'online'}
          onSelect={(next: RetentionMs) => {
            if (setRetention(next)) setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </main>
  )
}
