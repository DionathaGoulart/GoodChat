// Thread: resolve the deterministic conversation id for the peer, then run
// the live WebSocket.
//
// It also owns the two halves of the disappearing-message rule (PRD §3.9) that
// only a screen can own: deciding what this device actually *showed* somebody,
// which is what a read receipt now means and what starts a message's last three
// hours (lib/readObserver.ts), and one clock for every countdown in the thread
// (hooks/useExpiryClock.ts) instead of a timer per bubble.
//
// The header used to report my own socket ("link: online"), which said nothing
// about the person being written to. It now reports *their* presence
// (lib/presence.ts) — with one exception: while my own link is down I cannot
// know theirs, so the link state is what gets shown instead of a stale "online".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, resolveConversation } from '../lib/api'
import { readCachedThread, writeCachedThread } from '../lib/threadCache'
import type { PublicUser } from '../lib/api'
import { READ_TTL_MS } from '../lib/protocol'
import { URGENT_MS, remainingLabel, remainingMs } from '../lib/expiry'
import { ReadObserver } from '../lib/readObserver'
import { useConversation } from '../hooks/useConversation'
import type { ConnectionState, ThreadMessage } from '../hooks/useConversation'
import { useExpiryClock } from '../hooks/useExpiryClock'
import { usePresence } from '../hooks/usePresence'
import { useSession } from '../hooks/useSession'
import { presenceText, resolvePresence } from '../lib/presence'
import { Avatar } from '../components/Avatar'
import { Composer } from '../components/Composer'
import { MessageBubble } from '../components/MessageBubble'
import { PresenceMarker } from '../components/Presence'
import { SafetyNumberDialog } from '../components/SafetyNumber'
import { keyFingerprint } from '../lib/e2ee'
import { getAccountKey } from '../lib/keyDirectory'
import { RetroIconButton } from '../components/RetroIconButton'
import { MessagesSkeleton, ThreadSkeleton } from '../components/Skeleton'
import { WindowDots } from '../components/WindowDots'
import { navigate } from '../lib/router'

/** Shown only while the socket is not up — see the note at the top. */
const LINK_LABEL: Record<Exclude<ConnectionState, 'online'>, { text: string; className: string }> = {
  connecting: { text: 'link: connecting', className: 'text-warning' },
  offline: { text: 'link: offline', className: 'text-error' },
}

/** The rule, in the one sentence it fits in. */
const EXPIRY_RULE = 'mensagens somem 3h depois de lidas — e em 7 dias se ninguém abrir'

/** Somebody has been told the rule on this device. */
const RULE_SEEN_KEY = 'goodchat-expiry-rule-seen'

/** How long the collapse-out runs — must match `.msg-leaving` in index.css. */
const VANISH_MS = 220

function ruleSeen(): boolean {
  try {
    return localStorage.getItem(RULE_SEEN_KEY) === '1'
  } catch {
    // Private mode: the line shows every session, which is the harmless side.
    return false
  }
}

function markRuleSeen(): void {
  try {
    localStorage.setItem(RULE_SEEN_KEY, '1')
  } catch {
    // Nothing to do — the line is a courtesy, not state.
  }
}

/**
 * The list to paint, which for a fifth of a second is longer than the list that
 * exists: a message the server just deleted stays on screen while it collapses
 * out of the column (`.msg-leaving`).
 *
 * Deliberately not a "keep it a moment longer" for anything else. The message
 * is gone from state the instant it expires — this holds a corpse for the
 * length of an animation and nothing reads from it.
 */
function useVanishing(
  conversationId: string,
  messages: ThreadMessage[],
): { message: ThreadMessage; leaving: boolean }[] {
  const previousRef = useRef(messages)
  const [leaving, setLeaving] = useState<ThreadMessage[]>([])
  const timersRef = useRef<number[]>([])

  // Switching threads is not fifty messages expiring at once. Without this the
  // whole previous conversation would collapse out on top of the new one.
  useEffect(() => {
    previousRef.current = []
    setLeaving([])
  }, [conversationId])

  useEffect(() => {
    const present = new Set(messages.map((m) => m.client_id))
    const gone = previousRef.current.filter((m) => !present.has(m.client_id))
    previousRef.current = messages
    if (gone.length === 0) return
    setLeaving((current) => [...current, ...gone])
    // Not cleaned up when this effect re-runs: the next message to arrive would
    // otherwise cancel the removal of the one still collapsing, and leave it on
    // screen for good. Only unmount clears them, below.
    const timer = window.setTimeout(() => {
      const ids = new Set(gone.map((m) => m.client_id))
      setLeaving((current) => current.filter((m) => !ids.has(m.client_id)))
      timersRef.current = timersRef.current.filter((t) => t !== timer)
    }, VANISH_MS)
    timersRef.current.push(timer)
  }, [messages])

  useEffect(() => () => timersRef.current.forEach((timer) => window.clearTimeout(timer)), [])

  return useMemo(() => {
    if (leaving.length === 0) return messages.map((message) => ({ message, leaving: false }))
    return [
      ...messages.map((message) => ({ message, leaving: false })),
      ...leaving.map((message) => ({ message, leaving: true })),
    ].sort((a, b) => a.message.created_at - b.message.created_at)
  }, [messages, leaving])
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
        }
        setResolved(next)
        // Merged onto what is already stored, not written over it. The record
        // has two other fields with a different owner — the peer's last-seen
        // key fingerprint and the one somebody said they compared — and this
        // write used to drop both on every open. That is not a stale cache, it
        // is the two things they exist for: "conferido" never survived leaving
        // the thread, and the key-changed banner had nothing left to compare
        // against, so it never fired for anybody.
        if (myId) writeCachedThread(myId, userId, { ...readCachedThread(myId, userId), ...next })
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
}: {
  conversationId: string
  otherUser: PublicUser
  myId: string
  /** My own handle — the nick the terminal skin prints on my own log lines. */
  myName: string
  readonly: boolean
  /** The conversation has held a message before, so `history` has one to bring. */
  hasHistory: boolean
}) {
  const {
    messages,
    synced,
    connection,
    peerTyping,
    nextExpiryAt,
    encryption,
    e2eeRequired,
    sendRejected,
    send,
    sendMedia,
    sendSticker,
    sendTyping,
    markRead,
  } = useConversation(conversationId, otherUser.id, myId)
  const [safetyOpen, setSafetyOpen] = useState(false)
  /**
   * The peer's key is not the one this browser last saw here.
   *
   * One state where there used to be two. While identity was per browser this
   * fired every time either person signed in somewhere new, so it had to
   * separate "they opened a new browser" (ordinary, and constant) from "the set
   * moved after you compared the number" (an alarm) — and the ordinary one was
   * frequent enough to teach people to dismiss both. An account has one key,
   * and the only things that replace it are a fresh account and an owner's
   * password reset. So it is rare, it is one banner, and it means what it says.
   */
  const [keyChanged, setKeyChanged] = useState(false)
  /** The peer's current key is the one somebody compared out loud. */
  const [verified, setVerified] = useState(false)
  /**
   * Whether the rule is on screen. Once per device by default — it is a fact
   * about the product, not an event, and a banner that reappears on every open
   * is a banner people learn to look past. The header's ⏳ brings it back for
   * anyone who wants it again.
   */
  const [ruleShown, setRuleShown] = useState(() => !ruleSeen())
  const presence = usePresence(useMemo(() => [otherUser.id], [otherUser.id]))
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // Compared on open, and only on open: a change is worth one banner, not a
  // re-render every time the directory cache refreshes.
  useEffect(() => {
    if (!myId || readonly) return
    let cancelled = false
    void (async () => {
      // Forced, for the same reason the safety-number dialog forces it: the
      // question here is "did this change", and the directory cache is five
      // minutes of "it did not" (lib/keyDirectory.ts). Reading it meant that a
      // key replaced *since the last look* — which is the whole window a
      // targeted swap lives in — produced no banner at all, while the messages
      // below quietly stopped opening. One request per thread open.
      const key = await getAccountKey(otherUser.id, true)
      if (cancelled || !key) return
      const fingerprint = await keyFingerprint(key)
      if (cancelled) return
      const seen = readCachedThread(myId, otherUser.id)
      setVerified(seen?.verifiedFingerprint === fingerprint)
      // No stored fingerprint is a first look, not a change: announcing one
      // would fire for every thread the first time this build runs, which is
      // the fastest way to teach somebody to ignore the banner.
      if (seen?.peerFingerprint && seen.peerFingerprint !== fingerprint) setKeyChanged(true)
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
    const key = await getAccountKey(otherUser.id)
    if (!key) return
    const fingerprint = await keyFingerprint(key)
    const seen = readCachedThread(myId, otherUser.id)
    if (seen) {
      writeCachedThread(myId, otherUser.id, {
        ...seen,
        peerFingerprint: fingerprint,
        verifiedFingerprint: fingerprint,
      })
    }
    setVerified(true)
    setKeyChanged(false)
  }, [myId, otherUser.id])

  // One observer per open thread, and one clock for every countdown in it.
  const observerRef = useRef<ReadObserver | null>(null)
  const markReadRef = useRef(markRead)
  markReadRef.current = markRead
  /**
   * One ref callback per message id, kept for as long as the thread is open.
   *
   * Not an inline arrow. React calls a changed ref callback with null and then
   * with the element again, which through `ReadObserver.watch` is a dwell reset
   * — so a fresh closure per render would mean the countdown to "read" restarts
   * on every re-render, and this component re-renders on a clock. A message
   * would then never be reported at exactly the moments the clock ticks
   * fastest.
   */
  const watchRefs = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const watchRef = useCallback((id: string) => {
    let ref = watchRefs.current.get(id)
    if (!ref) {
      ref = (element: HTMLElement | null) => observerRef.current?.watch(id, element)
      watchRefs.current.set(id, ref)
    }
    return ref
  }, [])

  useEffect(() => {
    const observer = new ReadObserver((ids) => markReadRef.current(ids))
    observerRef.current = observer
    watchRefs.current = new Map()
    return () => {
      observer.dispose()
      observerRef.current = null
    }
    // Rebuilt per conversation, not per frame: it carries the set of ids it has
    // already reported, and throwing that away on every new message would let a
    // message be named twice.
  }, [conversationId])

  const now = useExpiryClock(nextExpiryAt)

  /**
   * Whether this bubble is one the observer may watch.
   *
   * Everything here is a reason it must not be. My own message is not mine to
   * read. One already read has a clock running and nothing left to start. And a
   * sealed one is a placeholder — reporting it would delete a message on the
   * strength of a bubble that said "[mensagem de antes deste dispositivo]".
   */
  const watchable = useCallback(
    (message: ThreadMessage) =>
      message.id !== null &&
      message.sender_id !== myId &&
      message.read_at === null &&
      !message.sealed &&
      // A video scrolled past is a poster frame; it reports itself on play.
      message.msg_type !== 'video',
    [myId],
  )

  /**
   * The one message allowed to count down while it still has hours left: the
   * newest one that has been read. Everything under fifteen minutes speaks for
   * itself (lib/expiry.ts) — this is about the thread having a single visible
   * clock the rest of the time instead of forty.
   */
  const prominentId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].read_at !== null) return messages[i].client_id
    }
    return null
  }, [messages])

  const rows = useVanishing(conversationId, messages)

  // The rule is worth one look, not one per open. Dismissed on a timer rather
  // than with an ✕: it is a sentence, and asking somebody to close a sentence
  // is more work than reading it.
  useEffect(() => {
    if (!ruleShown) return
    markRuleSeen()
    const timer = window.setTimeout(() => setRuleShown(false), 9000)
    return () => window.clearTimeout(timer)
  }, [ruleShown])

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
          right edge and taking the expiry chip with it. */}
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
              ? e2eeRequired
                ? 'mensagens não estão sendo entregues nesta conversa'
                : 'esta conversa não está criptografada'
              : verified
                ? 'número de segurança desta conversa, já conferido'
                : 'número de segurança desta conversa'
          }
        >
          {encryption === 'off' ? '🔓' : verified ? '🔐' : '🔒'}
        </RetroIconButton>
        {/* The thread's own clock. It reads "3h" — the rule — until something
            is actually about to go, and then it reads that instead: with a
            message inside its last fifteen minutes, "how long do I have" has
            stopped being a rule and become a number. */}
        <RetroIconButton
          className="shrink-0"
          onClick={() => setRuleShown(true)}
          aria-label={EXPIRY_RULE}
        >
          ⏳
          <span className="hidden xs:inline">
            {' '}
            {nextExpiryAt !== null && remainingMs(nextExpiryAt, now) <= URGENT_MS
              ? remainingLabel(remainingMs(nextExpiryAt, now))
              : remainingLabel(READ_TTL_MS)}
          </span>
        </RetroIconButton>
        <p
          className={`hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] sm:block ${status.className}`}
        >
          {status.text}
        </p>
      </header>

      {ruleShown && (
        <p className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center font-mono text-[10px] font-bold uppercase leading-relaxed tracking-[0.2em] text-accent">
          {EXPIRY_RULE}
          {/* Said out loud because the browser cannot enforce it and the app
              must not imply otherwise: this is a promise about what the server
              keeps, not about what the other person remembers. */}
          <span className="block opacity-60">o servidor não guarda — a outra pessoa ainda lembra</span>
        </p>
      )}

      {/* Two different facts, and for a while only the first one was said.
          Without a key on the other side this thread cannot encrypt — and on an
          instance that requires encryption, that means nothing typed here is
          being delivered at all. Announcing only "not encrypted" while messages
          silently fail is the worse half of the truth, and it is the half the
          person can do nothing with. `e2eeRequired` is null until the socket
          says, so neither line is claimed before it is known. */}
      {encryption === 'off' && !readonly && e2eeRequired === true && (
        <p className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center font-mono text-[10px] font-bold uppercase leading-relaxed tracking-[0.2em] text-error">
          @{otherUser.username} precisa abrir o app uma vez para receber mensagens
          <span className="block opacity-70">
            nada enviado aqui está sendo entregue
          </span>
        </p>
      )}
      {encryption === 'off' && !readonly && e2eeRequired === false && (
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

      {/* Rare on purpose, and therefore worth reading. A key changes when the
          account is new or when the owner reset its password — never because
          somebody opened another browser, which is what used to fire this. */}
      {keyChanged && (
        <div className="animate-enter shrink-0 retro-border bg-base-200 p-2 text-center">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
            a chave de @{otherUser.username} mudou
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] opacity-50">
            conta nova, ou senha redefinida pelo dono
          </p>
          <button
            type="button"
            onClick={() => {
              setKeyChanged(false)
              setSafetyOpen(true)
            }}
            className="mt-1 cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] underline opacity-70 hover:opacity-100"
          >
            conferir o número de segurança
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
        {/* An emptied thread is the normal end state of this product, not a
            failure, and an empty column reads as one. Only once the server has
            said so: before `history` lands, "nothing here" is not known. */}
        {messages.length === 0 && synced && hasHistory && (
          <p className="animate-enter m-auto max-w-xs text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.2em] opacity-40">
            nada aqui — o que foi dito já passou
          </p>
        )}
        {rows.map(({ message, leaving }) => (
          // The wrapper is always here, and is a box only while the message is
          // collapsing out. Rendering it conditionally would change the element
          // under a stable key, which remounts the bubble — and a remount
          // replays `animate-enter`, so the message would fade *in* while the
          // row it sits in was folding shut.
          <div
            key={message.client_id}
            aria-hidden={leaving || undefined}
            className={
              leaving
                ? `msg-leaving ${message.sender_id === myId ? 'self-end' : 'self-start'}`
                : 'contents'
            }
          >
            <MessageBubble
              message={message}
              mine={message.sender_id === myId}
              sender={message.sender_id === myId ? myName : otherUser.username}
              now={now}
              prominent={message.client_id === prominentId}
              watch={watchable(message) && message.id ? watchRef(message.id) : undefined}
              onOpened={
                message.id !== null && message.sender_id !== myId && message.read_at === null
                  ? () => observerRef.current?.report(message.id!)
                  : undefined
              }
            />
          </div>
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

    </main>
  )
}
