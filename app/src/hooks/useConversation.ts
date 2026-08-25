// Live conversation state over one WebSocket (protocol.ts shapes).
// - reconnect with exponential backoff + jitter (0.5s → 10s cap)
// - `history` frame on (re)connect resyncs server state, keeping and
//   resending optimistic messages the server never acked (dedup by client_id
//   is server-side, so resending is safe — at-least-once)
// - optimistic send: local status 'sending' until the echo frame arrives
// - read receipts name the ids the thread actually showed somebody
//   (lib/readObserver.ts), because reading is what starts a message's last
//   three hours; typing is throttled out / expiry-timed in
// - retention (PRD §3.9): every message carries its own `expires_at`, a read
//   receipt moves it, `messages_expired` drops what the server just deleted,
//   and the list is filtered against those deadlines locally as well — a
//   message may expire while the tab is offline, and it must not be on screen
//   when it does

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { wsUrl } from '../lib/api'
import { readAccountKey, type AccountIdentity } from '../lib/accountKeys'
import { base64url } from '../lib/kdf'
import { createContentKey, openMessage, sealMessage, type Payload } from '../lib/e2ee'
import { getAccountKey, refreshKey } from '../lib/keyDirectory'
// The v1/v2 read path, and everything it drags with it. One import block, so
// the day retention makes it dead the deletion is obvious.
import { readDeviceKey, type DeviceIdentity } from '../lib/deviceKeys'
import { findCachedDevice, getDevices } from '../lib/deviceDirectory'
import { legacyAddressedTo, openLegacyMessage } from '../lib/legacyEnvelope'
import type { MediaSealing } from '../lib/media'
import { dismissNotifications } from '../lib/push'
import { readCachedMessages, writeCachedMessages } from '../lib/threadCache'
import {
  MAX_READ_IDS,
  ServerEventSchema,
  UNREAD_TTL_MS,
  isAccountEnvelope,
  type MessageStatus,
  type SendMessageEvent,
  type ServerEvent,
  type WireMessage,
} from '../lib/protocol'

export type ConnectionState = 'connecting' | 'online' | 'offline'

/**
 * Whether what this thread sends is actually encrypted.
 *
 * It exists because the honest answer is not always yes, and the failure is
 * otherwise silent. `seal` falls back to plaintext when this browser has no
 * identity (private mode, or a browser that refuses IndexedDB) or when the peer
 * has not opened a build that registers one — both legitimate during the
 * rollout, and both invisible: the message sends, the thread looks normal, and
 * nobody is told that the one property this product advertises is not in
 * effect. So the thread reports it and ThreadScreen says so.
 *
 * 'unknown' is the state before the directory has answered, and is deliberately
 * not rendered as either: claiming "not encrypted" for the half second before
 * the keys load would teach people to ignore the warning.
 */
export type EncryptionState = 'unknown' | 'on' | 'off'

export interface ThreadMessage {
  /** Server id — null while the message is only local ('sending'). */
  id: string | null
  client_id: string
  sender_id: string
  msg_type: WireMessage['msg_type']
  /** Always plaintext by the time it gets here — see `toThread`. */
  body: string
  media_key: string | null
  created_at: number
  /**
   * When the recipient read it, and the moment it is deleted (PRD §3.9). An
   * optimistic bubble carries the deadline it is *about* to get — the server
   * stamps its own a moment later, and the echo replaces this one.
   */
  read_at: number | null
  expires_at: number
  status: MessageStatus | 'sending'
  /**
   * This message was encrypted and could not be opened. The bubble says so
   * instead of showing nothing.
   */
  sealed?: boolean
  /**
   * Why, so the bubble can say something the person can act on:
   *
   * - `no-key` — this browser holds no key at all. A private window, or
   *   storage that refuses. The only one the person can fix, and the only one
   *   where every message in the thread looks like this.
   * - `unknown-sender` — the sender's key is not in the directory, so there is
   *   no public half left to run ECDH against.
   * - `undecryptable` — it was addressed to this account and still did not
   *   open. Corrupt, or an envelope that was moved (`messageAad` in
   *   lib/e2ee.ts).
   * - `predates-account-key` — a v1/v2 message, sealed to a *device* key this
   *   browser never held. The one placeholder that is still permanent, and the
   *   only one left of the four: it used to be the ordinary case for every
   *   message older than the browser, and it is now bounded by retention. It
   *   goes when the last v2 message expires.
   */
  sealedReason?: 'no-key' | 'unknown-sender' | 'undecryptable' | 'predates-account-key'
  /**
   * The server refused this send and will not be asked again — the instance
   * requires encryption and this device has no key, or the envelope did not
   * hold up. Local only: nothing on the wire carries it, and it exists so the
   * bubble can stop claiming to be on its way.
   */
  rejected?: boolean
  /**
   * The content key, kept only in memory and only for a media message — the
   * bubble needs it to decrypt the object it fetches from /api/media.
   */
  contentKey?: CryptoKey
  /** IV for the bucket object, from the envelope. */
  enc_media_iv?: string
  /** Plaintext bytes per chunk, when the object was written in chunks. */
  enc_media_chunk?: number
  /**
   * The attachment's real MIME, which only the encrypted payload carries — the
   * worker saw `application/octet-stream` and nothing more.
   */
  media_mime?: string
}

/**
 * The longest this thread will go without re-checking its own list against the
 * clock. Anything sooner is scheduled from the nearest deadline, so a message
 * leaves the screen the second it is due rather than up to a tick late; this is
 * only the ceiling for a thread whose next expiry is hours away.
 *
 * The server's `messages_expired` frame is what makes it immediate on a
 * connected tab. This is for the tab that is not.
 */
const EXPIRY_TICK_MS = 30_000

const STATUS_RANK: Record<ThreadMessage['status'], number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

type Action =
  | { type: 'reset'; messages: ThreadMessage[] }
  | { type: 'history'; messages: ThreadMessage[] }
  | { type: 'message'; frame: ThreadMessage }
  | { type: 'status'; id: string; client_id: string; status: MessageStatus; myId: string }
  | { type: 'peer_read'; reads: { id: string; read_at: number; expires_at: number }[] }
  | { type: 'optimistic'; message: ThreadMessage }
  | { type: 'expired'; ids: string[] }
  | { type: 'send_rejected'; myId: string }

/**
 * What this browser can open with. `account` is the key everything new is
 * sealed to; `device` is the leftover that opens v1/v2 and nothing else, and
 * it goes when they do.
 */
interface ThreadKeys {
  account: AccountIdentity | null
  device: DeviceIdentity | null
}

/**
 * Wire frame to what the thread renders, which is where decryption happens.
 *
 * A frame with no envelope is a plaintext message and passes straight through:
 * that is what carries the transition, and it costs nothing to keep forever —
 * everything written before encryption shipped is gone within seven days on its
 * own.
 */
async function toThread(
  m: WireMessage,
  keys: ThreadKeys,
  conversationId: string,
  myId: string,
): Promise<ThreadMessage> {
  const { enc, ...rest } = m
  if (!enc) return { ...rest }
  const sealed = (sealedReason: ThreadMessage['sealedReason']): ThreadMessage => ({
    ...rest,
    body: '',
    sealed: true,
    sealedReason,
  })
  const context = { conversationId, senderId: m.sender_id, clientId: m.client_id }

  const opened = isAccountEnvelope(enc)
    ? await (async () => {
        if (!keys.account) return null
        // Whose key sealed it: the peer's, or this account's own for a message
        // this person sent. Both come from outside the envelope — the thread
        // this frame arrived on and the sender the frame claims — so a server
        // that changed either to make a message say something it did not lands
        // on `undecryptable` rather than on a convincing bubble.
        const senderKey =
          m.sender_id === myId ? keys.account.publicKey : await getAccountKey(m.sender_id)
        if (!senderKey) return 'unknown-sender' as const
        return openMessage(keys.account, context, senderKey, m.body, enc)
      })()
    : await (async () => {
        // The v1/v2 path. Sealed to a device key, so it opens only in a browser
        // that held one — see lib/legacyEnvelope.ts.
        if (!keys.device || !legacyAddressedTo(enc, keys.device.id)) {
          return 'predates-account-key' as const
        }
        // Pulled on demand: most threads will never hold a v1/v2 message
        // again, and the directory it needs only shrinks. `findCachedDevice`
        // first so a thread full of them pays for one fetch, not one each.
        const via = enc.keys[keys.device.id]?.via ?? enc.sender_device
        let sender = findCachedDevice(via)
        if (!sender) {
          await Promise.all([getDevices(m.sender_id), getDevices(myId)])
          sender = findCachedDevice(via)
        }
        if (!sender) return 'unknown-sender' as const
        return openLegacyMessage(keys.device, context, sender.public_key, m.body, enc)
      })()

  if (opened === null) {
    return sealed(keys.account || keys.device ? 'undecryptable' : 'no-key')
  }
  if (typeof opened === 'string') return sealed(opened)

  return {
    ...rest,
    body: bodyOf(opened.payload, m.msg_type),
    ...(m.media_key
      ? {
          contentKey: opened.contentKey,
          enc_media_iv: enc.media_iv,
          enc_media_chunk: enc.media_chunk,
          media_mime: opened.payload.m,
        }
      : {}),
  }
}

/** The payload's one meaningful string for this message type. */
function bodyOf(payload: Payload, msgType: WireMessage['msg_type']): string {
  if (msgType === 'sticker') return payload.s ?? ''
  return payload.t ?? ''
}

/** The locally-known plaintext of a message, to survive a failed re-open. */
function pick(message: ThreadMessage): Partial<ThreadMessage> {
  return {
    body: message.body,
    sealed: false,
    contentKey: message.contentKey,
    enc_media_iv: message.enc_media_iv,
    enc_media_chunk: message.enc_media_chunk,
    media_mime: message.media_mime,
  }
}

function upgrade(current: ThreadMessage, status: ThreadMessage['status']): ThreadMessage {
  return STATUS_RANK[status] > STATUS_RANK[current.status] ? { ...current, status } : current
}

function reduce(messages: ThreadMessage[], action: Action): ThreadMessage[] {
  switch (action.type) {
    case 'reset':
      // Not to nothing: back to whatever the local copy holds for the thread
      // being opened (lib/threadCache.ts). The socket effect resets on every
      // conversation change, so returning [] here would throw the seed away a
      // tick after the first render used it.
      return action.messages
    case 'history': {
      const acked = new Set(action.messages.map((m) => `${m.sender_id}:${m.client_id}`))
      const pending = messages.filter(
        (m) => m.status === 'sending' && !acked.has(`${m.sender_id}:${m.client_id}`),
      )
      return [...action.messages, ...pending]
    }
    case 'message': {
      const frame = action.frame
      const index = messages.findIndex(
        (m) => m.sender_id === frame.sender_id && m.client_id === frame.client_id,
      )
      if (index >= 0) {
        const next = [...messages]
        // Keep the higher status if a message_status frame raced ahead of the echo.
        // The local copy keeps its own body: this device wrote that plaintext
        // and its own echo is addressed to it anyway, but an envelope that
        // failed to open must never blank a bubble the person is looking at.
        const merged = frame.sealed && messages[index].body ? { ...frame, ...pick(messages[index]) } : frame
        next[index] = upgrade(merged, messages[index].status)
        return next
      }
      if (messages.some((m) => m.id === frame.id)) return messages
      return [...messages, frame]
    }
    case 'status':
      return messages.map((m) =>
        m.id === action.id || (m.client_id === action.client_id && m.sender_id === action.myId)
          ? upgrade({ ...m, id: m.id ?? action.id }, action.status)
          : m,
      )
    case 'peer_read': {
      // Named ids, and each one brings the deadline it just earned. The status
      // is raised here too rather than waiting for the `message_status` frame
      // behind it — they describe the same event, and the tick and the
      // countdown appearing a beat apart would read as two separate things
      // happening.
      const byId = new Map(action.reads.map((read) => [read.id, read]))
      if (!messages.some((m) => m.id !== null && byId.has(m.id))) return messages
      return messages.map((m) => {
        const read = m.id === null ? undefined : byId.get(m.id)
        if (!read) return m
        return upgrade({ ...m, read_at: read.read_at, expires_at: read.expires_at }, 'read')
      })
    }
    case 'optimistic':
      return [...messages, action.message]
    case 'expired': {
      // The server deleted these for good (retention). Dropped by server id:
      // a message that never got one cannot be old enough to expire.
      const gone = new Set(action.ids)
      const kept = messages.filter((m) => m.id === null || !gone.has(m.id))
      return kept.length === messages.length ? messages : kept
    }
    case 'send_rejected': {
      // Everything still in flight, not one message: the server names the
      // reason but not the frame, and every refusal this handles is a property
      // of the connection rather than of a single body — what stops one send
      // stops the queue behind it.
      let changed = false
      const next = messages.map((m) => {
        if (m.sender_id !== action.myId || m.status !== 'sending' || m.rejected) return m
        changed = true
        return { ...m, rejected: true }
      })
      return changed ? next : messages
    }
  }
}

export function useConversation(
  conversationId: string,
  otherUserId: string,
  myId: string,
): {
  messages: ThreadMessage[]
  /** The server has said what this thread holds — see the state below. */
  synced: boolean
  connection: ConnectionState
  /** Whether what this thread sends is actually encrypted — see the type. */
  encryption: EncryptionState
  /**
   * Whether this instance refuses to carry an unencrypted message. Null until
   * the socket has said. Together with `encryption === 'off'` this is the
   * difference between "this is not private" and "this is not being delivered".
   */
  e2eeRequired: boolean | null
  /** Why the server refused the last send, or null when it refused nothing. */
  sendRejected: string | null
  peerTyping: boolean
  send: (body: string) => void
  sendMedia: (msgType: 'image' | 'video', mediaKey: string, sealing?: MediaSealing) => void
  sendSticker: (stickerId: string) => void
  sendTyping: () => void
  /**
   * Reports messages as read, which is what starts their last three hours
   * (PRD §3.9). Ids only — never a watermark, and never a message this device
   * did not actually paint (lib/readObserver.ts).
   *
   * False means the socket was not up and nothing went out, which is the
   * caller's cue to offer the same ids again shortly.
   */
  markRead: (ids: string[]) => boolean
  /** When the next message in this thread expires; null when it holds none. */
  nextExpiryAt: number | null
} {
  // Seeded from the local copy: a thread opened before paints its tail at once
  // and the `history` frame replaces it a connect later. `history` is a full
  // resync, not a merge, so a stale copy cannot survive into the live state —
  // the worst it can do is show the last screenful for the length of a connect.
  const [messages, dispatch] = useReducer(
    reduce,
    null,
    () => readCachedMessages(myId, conversationId) ?? [],
  )
  /**
   * Whether the `history` frame has landed for this conversation. It is the
   * only way to tell an empty thread from one that has not answered yet —
   * `messages.length === 0` means both, and the thread used to say "no
   * messages" during every connect.
   */
  const [synced, setSynced] = useState(false)
  const connectionRef = useRef<ConnectionState>('connecting')
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef(new Map<string, SendMessageEvent>())
  /**
   * Ids already reported on this connection. `ReadObserver` never names one
   * twice either, but it is rebuilt whenever the thread's message list changes
   * shape, and a receipt sent on a dying socket has to be offered again — so
   * the guard against double-reporting lives on both sides of the call.
   */
  const readSentRef = useRef(new Set<string>())
  /**
   * What this browser can open with. Both halves null means it holds no key at
   * all — private mode, or a browser that refuses IndexedDB — and everything
   * below degrades to plaintext rather than refusing to open the thread.
   */
  const keysRef = useRef<ThreadKeys>({ account: null, device: null })
  const [encryption, setEncryption] = useState<EncryptionState>('unknown')
  /**
   * Whether this instance refuses an unencrypted message, as the Durable Object
   * itself reported it on connect. Null until it has: before that the thread
   * says nothing, for the same reason `encryption` starts 'unknown' — a wrong
   * claim about delivery is worse than a late one.
   */
  const [e2eeRequired, setE2eeRequired] = useState<boolean | null>(null)
  /**
   * The server's reason for refusing a send, or null. Kept as the message the
   * server wrote rather than a code the screen has to translate: the only
   * refusal a person can act on today is "this instance requires encryption",
   * and that sentence is already written where the rule lives (worker/src/
   * agent.ts).
   */
  const [sendRejected, setSendRejected] = useState<string | null>(null)
  const [peerTyping, setPeerTyping] = useState(false)
  const typingTimerRef = useRef<number | undefined>(undefined)
  const lastTypingSentRef = useRef(0)

  const setConnection = useCallback(
    (state: ConnectionState) => {
      if (connectionRef.current === state) return
      connectionRef.current = state
      forceRender()
    },
    [forceRender],
  )

  useEffect(() => {
    let disposed = false
    let attempt = 0
    let timer: number | undefined
    let flushTimer: number | undefined
    dispatch({
      type: 'reset',
      messages: readCachedMessages(myId, conversationId) ?? [],
    })
    pendingRef.current.clear()
    readSentRef.current = new Set()
    setPeerTyping(false)
    setSynced(false)
    setEncryption('unknown')
    setE2eeRequired(null)
    setSendRejected(null)

    // Peer typing is ephemeral: each frame re-arms a short expiry, and a real
    // message from the peer clears it immediately.
    const showPeerTyping = () => {
      setPeerTyping(true)
      window.clearTimeout(typingTimerRef.current)
      typingTimerRef.current = window.setTimeout(() => setPeerTyping(false), 4000)
    }
    const clearPeerTyping = () => {
      window.clearTimeout(typingTimerRef.current)
      setPeerTyping(false)
    }

    const handleFrame = async (event: ServerEvent) => {
      switch (event.type) {
        case 'history': {
          // Nothing is asked for anymore. A browser signing in used to hold a
          // key no envelope named, so it sent `request_keys` and waited for a
          // person on another machine to say yes; the account key means it
          // already holds what opens all of this.
          dispatch({
            type: 'history',
            messages: await Promise.all(
              event.messages.map((m) => toThread(m, keysRef.current, conversationId, myId)),
            ),
          })
          setSynced(true)
          return
        }
        case 'message': {
          if (event.sender_id === myId) pendingRef.current.delete(event.client_id)
          else clearPeerTyping()
          dispatch({
            type: 'message',
            frame: await toThread(event, keysRef.current, conversationId, myId),
          })
          return
        }
        case 'message_status':
          pendingRef.current.delete(event.client_id)
          dispatch({
            type: 'status',
            id: event.id,
            client_id: event.client_id,
            status: event.status,
            myId,
          })
          return
        case 'read_receipt':
          // Sent to every connection, this device's own included: a second tab
          // of mine did not witness the read that started these clocks.
          dispatch({ type: 'peer_read', reads: event.reads })
          return
        case 'typing':
          showPeerTyping()
          return
        case 'policy':
          setE2eeRequired(event.e2ee_required)
          return
        case 'messages_expired':
          dispatch({ type: 'expired', ids: event.ids })
          // The push notification for this thread previewed messages that no
          // longer exist; the notification centre has no window of its own.
          dismissNotifications(conversationId)
          return
        case 'error':
          console.warn('ws error frame', event.error, event.message)
          // The server dropped that frame instead of processing it. Whatever
          // is still pending has to be offered again, after the bucket has had
          // time to refill — otherwise a long offline queue would sit at
          // 'sending' forever.
          if (event.error === 'rate_limited') {
            scheduleFlush(2000)
            return
          }
          // Anything else is a refusal, not a delay: retrying would be refused
          // the same way. Stop offering the queue, say why, and let the bubbles
          // stop pretending they are on their way — a message that reads
          // "enviando_" forever is the failure mode this whole banner exists to
          // prevent.
          pendingRef.current.clear()
          setSendRejected(event.message ?? event.error)
          dispatch({ type: 'send_rejected', myId })
          return
      }
    }

    // Pending sends are flushed a few at a time. The server rate-limits each
    // connection (20 messages burst, 2/s sustained), so dumping a 30-message
    // offline queue in one go would get the tail refused. 4 per 2.5s is 1.6/s,
    // deliberately under the refill rate, so a long queue drains without ever
    // tripping the limit. Resending is safe by construction: the DO dedups on
    // (sender, client_id), so a frame that did land is acked, not duplicated.
    const FLUSH_CHUNK = 4
    const FLUSH_INTERVAL_MS = 2500

    // Cursor over the queue rather than always restarting from the head: an
    // ack that is slow to arrive must not keep the first chunk hogging every
    // window while the tail never gets offered.
    let flushCursor = 0

    const flushPending = () => {
      flushTimer = undefined
      const ws = wsRef.current
      if (disposed || ws?.readyState !== WebSocket.OPEN) return
      const queued = [...pendingRef.current.values()]
      if (queued.length === 0) {
        flushCursor = 0
        return
      }
      if (flushCursor >= queued.length) flushCursor = 0
      const batch = queued.slice(flushCursor, flushCursor + FLUSH_CHUNK)
      for (const event of batch) ws.send(JSON.stringify(event))
      flushCursor += batch.length
      if (queued.length > batch.length) scheduleFlush(FLUSH_INTERVAL_MS)
    }

    const scheduleFlush = (delayMs: number) => {
      if (disposed || flushTimer !== undefined || pendingRef.current.size === 0) return
      flushTimer = window.setTimeout(flushPending, delayMs)
    }

    let frameQueue: Promise<void> = Promise.resolve()

    // This account's key and the peer's, refreshed on every connect — which is
    // when a rotation on either side would matter, and the only thing that
    // rotates a key now is a fresh account or an owner's password reset.
    //
    // The old device key is read alongside it, and only so that history from
    // before the account key still opens in the browser that received it
    // (lib/legacyEnvelope.ts). Its directory is pulled lazily, by `toThread`,
    // because most threads will never contain a v1/v2 message again.
    const loadKeys = async () => {
      const [account, device] = await Promise.all([readAccountKey(myId), readDeviceKey(myId)])
      keysRef.current = { account, device }
      const peer = await refreshKey(otherUserId)
      if (disposed) return
      // Exactly the two conditions `seal` checks, so the indicator cannot claim
      // something the send path does not do.
      setEncryption(account && peer ? 'on' : 'off')
    }

    /**
     * The keys go through the same queue as the frames rather than beside them.
     * `history` lands within a millisecond of the socket opening, and a frame
     * opened before the keys are in hand decrypts to nothing: the bubble
     * renders as a placeholder and stays that way until something forces
     * another history, because the reducer has no reason to revisit a message
     * it already placed. Failing to load them must not wedge the queue either —
     * an unencrypted thread still has frames to deliver.
     */
    const queueKeys = () => {
      frameQueue = frameQueue.then(loadKeys).catch((error: unknown) => {
        console.warn('key load failed', error)
      })
    }

    const connect = () => {
      if (disposed) return
      setConnection('connecting')
      const ws = new WebSocket(wsUrl(conversationId, otherUserId))
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
        queueKeys()
        // A receipt sent on a dying socket may be lost — the thread reports
        // what is on screen again once this one is up.
        readSentRef.current = new Set()
        setConnection('online')
        window.clearTimeout(flushTimer)
        flushTimer = undefined
        flushCursor = 0
        flushPending()
      }
      ws.onmessage = (raw: MessageEvent) => {
        if (typeof raw.data !== 'string') return
        let parsed: unknown
        try {
          parsed = JSON.parse(raw.data)
        } catch {
          return
        }
        const frame = ServerEventSchema.safeParse(parsed)
        // Chained rather than fired off: decryption made frame handling async,
        // and two messages that decrypt at different speeds must still be
        // dispatched in the order they arrived — otherwise a `message` that
        // overtook its own `history` would be dropped by the reset that follows.
        if (frame.success) {
          frameQueue = frameQueue.then(() => handleFrame(frame.data)).catch((error: unknown) => {
            console.warn('frame handling failed', error)
          })
        }
      }
      ws.onclose = () => {
        if (disposed) return
        setConnection('offline')
        const delay = Math.min(10_000, 500 * 2 ** attempt) + Math.random() * 250
        attempt += 1
        timer = window.setTimeout(connect, delay)
      }
      ws.onerror = () => ws.close()
    }

    queueKeys()
    connect()
    return () => {
      disposed = true
      window.clearTimeout(timer)
      window.clearTimeout(flushTimer)
      window.clearTimeout(typingTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [conversationId, otherUserId, myId, setConnection])

  /**
   * One send.
   *
   * The optimistic bubble is dispatched first and in plaintext, because that is
   * what this device already knows and what the person expects to see the
   * instant they hit enter — encryption is a round of ECDH per recipient device
   * and has no business sitting between a keypress and the screen. The wire
   * frame is built after, and it is the encrypted one that goes into
   * `pendingRef`: a resend after reconnect must not re-encrypt against a
   * directory that has moved on, and the DO dedups on (sender, client_id)
   * either way.
   *
   * Encrypting to nobody is the transition case, and it is deliberate rather
   * than a failure: a peer who has not opened this build yet has no device in
   * the directory, so the message goes plaintext and their client renders it
   * exactly as it always did. Phase 6 is where that stops being allowed.
   */
  /**
   * Turns a plaintext frame into an encrypted one, or returns null when this
   * message has to go in the clear — no identity on this device, or a peer with
   * nothing in the directory yet.
   */
  const seal = useCallback(
    async (
      event: SendMessageEvent,
      sealing?: MediaSealing,
    ): Promise<SendMessageEvent | null> => {
      const identity = keysRef.current.account ?? (await readAccountKey(myId))
      if (!identity) return null
      keysRef.current = { ...keysRef.current, account: identity }

      const peerKey = await getAccountKey(otherUserId)
      // The peer has published no key: a guest mid-signup, or an account that
      // has not rotated. Nothing on the other side can read this yet, so it
      // goes in the clear and the instance decides whether it will carry that.
      if (!peerKey) return null

      const payload: Payload =
        event.msg_type === 'sticker'
          ? { s: event.body }
          : sealing
            ? { m: sealing.mime, ...(event.body ? { t: event.body } : {}) }
            : { t: event.body }

      const contentKey = sealing?.contentKey ?? (await createContentKey())
      const { body, enc } = await sealMessage(
        identity,
        { conversationId, senderId: myId, clientId: event.client_id },
        { accountId: otherUserId, publicKey: peerKey },
        payload,
        contentKey,
        sealing?.mediaIv,
        sealing?.chunk,
      )
      return { ...event, body, enc }
    },
    [conversationId, myId, otherUserId],
  )

  const sendEvent = useCallback(
    (
      msgType: WireMessage['msg_type'],
      body: string,
      mediaKey: string | null,
      sealing?: MediaSealing,
    ) => {
      const clientId = crypto.randomUUID()
      dispatch({
        type: 'optimistic',
        message: {
          id: null,
          client_id: clientId,
          sender_id: myId,
          msg_type: msgType,
          body,
          media_key: mediaKey,
          created_at: Date.now(),
          // What the server is about to stamp. Carried so the local list has
          // one rule for every bubble instead of a special case for the one
          // that has not been acked yet; the echo replaces it either way.
          read_at: null,
          expires_at: Date.now() + UNREAD_TTL_MS,
          status: 'sending',
          // The sender's own bubble decrypts through the same path as everyone
          // else's, so it needs the same three values rather than a shortcut
          // that would only ever be exercised here.
          ...(sealing
            ? {
                contentKey: sealing.contentKey,
                enc_media_iv: base64url(sealing.mediaIv),
                enc_media_chunk: sealing.chunk,
                media_mime: sealing.mime,
              }
            : {}),
        },
      })

      void (async () => {
        const plain: SendMessageEvent = {
          type: 'send_message',
          client_id: clientId,
          msg_type: msgType,
          body,
          ...(mediaKey ? { media_key: mediaKey } : {}),
        }
        const event = (await seal(plain, sealing)) ?? plain
        pendingRef.current.set(clientId, event)
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
        // Not open: the queued event is flushed by the next onopen.
      })()
    },
    [myId, seal],
  )

  const send = useCallback((body: string) => sendEvent('text', body, null), [sendEvent])

  /**
   * Media is already sitting in B2 when this fires — encrypted there, under the
   * content key this call now has to reuse so the message and its object open
   * with the same key.
   */
  const sendMedia = useCallback(
    (
      msgType: 'image' | 'video',
      mediaKey: string,
      sealing?: MediaSealing,
    ) => sendEvent(msgType, '', mediaKey, sealing),
    [sendEvent],
  )

  const sendSticker = useCallback((stickerId: string) => sendEvent('sticker', stickerId, null), [
    sendEvent,
  ])

  // Ephemeral by design: throttled to one frame per 2.5s and never queued —
  // a typing hint that survives a reconnect would be a lie.
  const sendTyping = useCallback(() => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (now - lastTypingSentRef.current < 2500) return
    lastTypingSentRef.current = now
    ws.send(JSON.stringify({ type: 'typing' }))
  }, [])

  /**
   * Reports read messages, in frames of at most `MAX_READ_IDS`.
   *
   * Refused rather than queued when the socket is down — the caller holds the
   * ids and offers them again (lib/readObserver.ts), which keeps the retry
   * beside the thing that knows what is still on screen.
   */
  const markRead = useCallback((ids: string[]) => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return false
    const fresh = ids.filter((id) => !readSentRef.current.has(id))
    if (fresh.length === 0) return true
    for (const id of fresh) readSentRef.current.add(id)
    for (let i = 0; i < fresh.length; i += MAX_READ_IDS) {
      ws.send(JSON.stringify({ type: 'read_receipt', ids: fresh.slice(i, i + MAX_READ_IDS) }))
    }
    return true
  }, [])

  // Keeping the local copy fresh. A ref holds the latest list so the debounce
  // can collapse a burst — an echo, its status upgrade and the peer's typing
  // all land within a second of each other — into one JSON.stringify instead of
  // one per frame.
  // A message can expire while the thread is open, and it can expire while the
  // tab is offline — where no `messages_expired` frame can reach it. So the
  // deadlines are applied here too, against a clock that wakes for the nearest
  // one rather than on a fixed interval: an expiry is a moment somebody is
  // watching for, and "up to thirty seconds late" is exactly the kind of late
  // that makes a promise look approximate.
  const [clock, setClock] = useState(() => Date.now())

  const live = useMemo(
    () =>
      messages.some((m) => m.expires_at <= clock)
        ? messages.filter((m) => m.expires_at > clock)
        : messages,
    [messages, clock],
  )

  // Taken from what is still on screen, not from `messages`.
  //
  // The reducer only drops a message when the server says so, so between an
  // expiry and the frame that reports it the raw list still holds a deadline
  // that has already passed — and a timer armed for a moment in the past fires
  // at its floor, over and over. On a tab with no socket to deliver that frame
  // there is nothing to end it: the thread would re-render four times a second
  // for as long as it stayed open.
  const nextExpiryAt = useMemo(
    () =>
      live.reduce<number | null>(
        (soonest, m) => (soonest === null || m.expires_at < soonest ? m.expires_at : soonest),
        null,
      ),
    [live],
  )

  useEffect(() => {
    const delay =
      nextExpiryAt === null
        ? EXPIRY_TICK_MS
        : Math.min(EXPIRY_TICK_MS, Math.max(250, nextExpiryAt - Date.now()))
    const timer = window.setTimeout(() => setClock(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [nextExpiryAt, clock])

  const latestRef = useRef(live)
  latestRef.current = live

  useEffect(() => {
    const timer = window.setTimeout(
      () => writeCachedMessages(myId, conversationId, latestRef.current),
      500,
    )
    return () => window.clearTimeout(timer)
  }, [live, myId, conversationId])

  // Leaving the thread inside that second must not lose the tail: the debounce
  // above cancels on cleanup, so the way out writes for itself. Keyed on the
  // conversation, not on the messages, so it runs on unmount and not on every
  // frame.
  useEffect(() => {
    return () => writeCachedMessages(myId, conversationId, latestRef.current)
  }, [myId, conversationId])

  return {
    messages: live,
    synced,
    connection: connectionRef.current,
    encryption,
    e2eeRequired,
    sendRejected,
    peerTyping,
    send,
    sendMedia,
    sendSticker,
    sendTyping,
    markRead,
    /** The moment the next message here dies, for the thread's own clock. */
    nextExpiryAt,
  }
}
