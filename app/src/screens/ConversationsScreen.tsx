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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listConversations } from '../lib/api'
import type { ConversationListItem } from '../lib/api'
import { readCachedConversations, writeCachedConversations } from '../lib/conversationsCache'
import { usePresence } from '../hooks/usePresence'
import { readDeviceKey } from '../lib/deviceKeys'
import { openMessage } from '../lib/e2ee'
import { cacheDevices, findCachedDevice, getDevices } from '../lib/deviceDirectory'
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

/**
 * Poll cadence. It starts fast and backs off while the answer keeps coming
 * back the same, because an idle tab is the common case and it was spending a
 * request every 15s to be told nothing had happened — and each of those costs
 * the worker a Durable Object round trip per conversation, not just a query.
 *
 * Anything that suggests the person is back — the tab becoming visible, the
 * window taking focus — drops it to the floor again, so the cost of backing
 * off is never paid by someone who is actually looking at the screen.
 */
const MIN_POLL_MS = 15_000
const MAX_POLL_MS = 60_000

/**
 * What "the same answer" means: the threads, their last message and their
 * unread counts. Deliberately not the whole payload — presence rides along in
 * it and moves every heartbeat (worker/src/lib/presence.ts), so comparing
 * everything would mean the list never looked idle and never backed off.
 */
function signatureOf(conversations: readonly ConversationListItem[]): string {
  return conversations.map((c) => `${c.id}:${c.last_message_at}:${c.unread_count}`).join('|')
}

/**
 * Replaces each encrypted preview with its plaintext, and seeds the device
 * directory from the keys the same payload carried — which is also what makes
 * opening a thread from this list need no round trip before it can send.
 *
 * A preview this device cannot open keeps its `enc` and loses its body, which
 * is what `ConversationTile` renders as "[mensagem cifrada]". Expected for
 * anything sent before this browser registered a key.
 */
async function openPreviews(
  myId: string,
  conversations: readonly ConversationListItem[],
): Promise<ConversationListItem[]> {
  for (const item of conversations) {
    if (item.peer_devices) cacheDevices(item.other_user.id, item.peer_devices)
  }
  const identity = await readDeviceKey(myId)
  if (!identity) return [...conversations]
  // My own devices too: the last message in a thread is often one I sent, and
  // opening it means running ECDH against my own other device's key.
  await getDevices(myId)

  return Promise.all(
    conversations.map(async (item) => {
      const last = item.last_message
      if (!last?.enc) return item
      const sender = findCachedDevice(last.enc.sender_device)
      const opened = sender
        ? await openMessage(
            identity,
            { conversationId: item.id, senderId: last.sender_id, clientId: last.client_id },
            sender.public_key,
            last.body,
            last.enc,
          )
        : null
      return {
        ...item,
        last_message: {
          ...last,
          body: opened ? (opened.payload.t ?? opened.payload.s ?? '') : '',
          enc: opened ? null : last.enc,
        },
      }
    }),
  )
}

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
  const signatureRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)

  /** Resolves to whether this answer differed from the last one. */
  const refresh = useCallback((): Promise<boolean> => {
    // Overlapping polls would let a wake-up and a scheduled tick both fire, and
    // the slower one would land second with the older list.
    if (inFlightRef.current) return Promise.resolve(false)
    inFlightRef.current = true
    return listConversations()
      .then(async ({ conversations }) => {
        // Previews arrive encrypted like every other message, so they are
        // opened here — once, on the way in — rather than in the tile, which
        // renders synchronously and would have to hold a decrypted copy of its
        // own. The peer keys ride along in the same payload (worker
        // routes/conversations.ts), so this costs no extra round trip.
        conversations = ownerId ? await openPreviews(ownerId, conversations) : conversations
        setConversations(conversations)
        if (ownerId) writeCachedConversations(ownerId, conversations)
        setSettled(true)
        setFailed(false)
        const signature = signatureOf(conversations)
        const changed = signature !== signatureRef.current
        signatureRef.current = signature
        return changed
      })
      // The copy on screen stays: a poll that could not reach the server has
      // nothing truer to put in its place, and the banner says so. It counts as
      // "unchanged" so a server that is down is backed away from rather than
      // hammered at the floor interval.
      .catch(() => {
        setFailed(true)
        return false
      })
      .finally(() => {
        inFlightRef.current = false
      })
  }, [ownerId])

  useEffect(() => {
    let disposed = false
    let delay = MIN_POLL_MS
    let timer: number | undefined

    // Always clears first, so a wake-up landing next to a scheduled tick
    // replaces the pending timer instead of adding a second one.
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, delay)
    }

    const tick = () => {
      // A hidden tab is not someone waiting for the list. Skip the request but
      // keep the chain alive, so becoming visible again is not the only way
      // back — the wake-up below may never fire on a tab that was never hidden
      // in the browser's sense (a covered window, a second monitor).
      if (document.visibilityState !== 'visible') {
        schedule()
        return
      }
      void refresh().then((changed) => {
        if (disposed) return
        delay = changed ? MIN_POLL_MS : Math.min(delay * 2, MAX_POLL_MS)
        schedule()
      })
    }

    // Coming back is the strongest signal there is that the list matters right
    // now: ask immediately and start counting from the floor again.
    const wake = () => {
      if (document.visibilityState !== 'visible') return
      delay = MIN_POLL_MS
      void refresh().then(() => {
        if (!disposed) schedule()
      })
    }

    void refresh().then(() => {
      if (!disposed) schedule()
    })
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [refresh])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 screen-pad sm:gap-6">
      {/* Wraps rather than squeezes: at 360px the two toolbar chips left the
          title about 110px, which the terminal skin's prompt and block caret
          spill out of. Below that width the chips take a row of their own. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="screen-kicker font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> conversas
          </p>
          <h1 className="screen-title text-3xl font-black uppercase italic tracking-tighter sm:text-4xl">
            GoodChat
          </h1>
          {user && (
            <p className="screen-meta mt-1 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
              logado como @{user.username}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
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
          <p className="prompt-line font-mono text-xs font-bold uppercase tracking-widest text-accent">
            <span className="sigil">{'>'}</span> awaiting_first_contact<span className="terminal-cursor">_</span>
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
