// Live conversation state over one WebSocket (protocol.ts shapes).
// - reconnect with exponential backoff + jitter (0.5s → 10s cap)
// - `history` frame on (re)connect resyncs server state, keeping and
//   resending optimistic messages the server never acked (dedup by client_id
//   is server-side, so resending is safe — at-least-once)
// - optimistic send: local status 'sending' until the echo frame arrives
// - read receipts sent when the thread reports visibility (unread badge
//   source of truth); typing is throttled out / expiry-timed in
// - retention (PRD §3.9): the conversation's message window arrives on connect
//   and on every change, `messages_expired` drops what the server just deleted,
//   and the list is filtered against the window locally as well — a message may
//   age out while the tab is offline, and it must not be on screen when it does

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { wsUrl } from '../lib/api'
import { base64url, readDeviceKey, type DeviceIdentity } from '../lib/deviceKeys'
import {
  createContentKey,
  isAddressedTo,
  openMessage,
  sealMessage,
  type Payload,
} from '../lib/e2ee'
import { findCachedDevice, getDevices, refreshDevices } from '../lib/deviceDirectory'
import { dismissNotifications } from '../lib/push'
import { readCachedMessages, writeCachedMessages } from '../lib/threadCache'
import {
  ServerEventSchema,
  retentionOr,
  type MessageStatus,
  type RetentionMs,
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
  status: MessageStatus | 'sending'
  /**
   * This message was encrypted and this device could not open it. Expected,
   * not exceptional: it is what every message sent before this browser
   * registered its key looks like, and what a message from a device that has
   * since rotated looks like. The bubble says so instead of showing nothing.
   */
  sealed?: boolean
  /**
   * Why, so the bubble can say something the person can act on. One placeholder
   * for four situations meant the only honest reading of it was "something is
   * wrong somewhere", which is the least useful thing a message can say:
   *
   * - `no-key` — this browser holds no identity. A private window, or storage
   *   that was cleared. The only one of the four the person can fix, and the
   *   only one where every message in the thread looks like this.
   * - `not-addressed` — sent before this browser registered. Ordinary, and
   *   permanent: no key for it was ever wrapped.
   * - `unknown-sender` — the sending device is gone from the directory, so
   *   there is no public key left to run ECDH against.
   * - `undecryptable` — it was addressed here and still did not open. Corrupt,
   *   or an envelope that was moved (see `messageAad` in lib/e2ee.ts).
   */
  sealedReason?: 'no-key' | 'not-addressed' | 'unknown-sender' | 'undecryptable'
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
 * How often the thread re-checks its own list against the window. Coarse on
 * purpose: expiry is a privacy promise measured in hours, and the server frame
 * is what makes it immediate when the tab is connected. This tick is for the
 * tab that is not.
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
  | { type: 'peer_read'; upToMessageId: string; myId: string }
  | { type: 'optimistic'; message: ThreadMessage }
  | { type: 'expired'; ids: string[] }
  | { type: 'send_rejected'; myId: string }

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
  identity: DeviceIdentity | null,
  conversationId: string,
): Promise<ThreadMessage> {
  const { enc, ...rest } = m
  if (!enc) return { ...rest }
  const sealed = (sealedReason: ThreadMessage['sealedReason']): ThreadMessage => ({
    ...rest,
    body: '',
    sealed: true,
    sealedReason,
  })
  if (!identity) return sealed('no-key')
  if (!isAddressedTo(enc, identity.id)) return sealed('not-addressed')

  const sender = findCachedDevice(enc.sender_device)
  if (!sender) return sealed('unknown-sender')
  // Both halves of the binding come from outside the envelope — the thread this
  // frame arrived on, and the sender the frame claims. A server that changed
  // either one to make a message say something it did not lands on
  // `undecryptable` here rather than on a convincing bubble.
  const opened = await openMessage(
    identity,
    { conversationId, senderId: m.sender_id, clientId: m.client_id },
    sender.public_key,
    m.body,
    enc,
  )
  if (!opened) return sealed('undecryptable')

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
      const index = messages.findIndex((m) => m.id === action.upToMessageId)
      if (index < 0) return messages
      return messages.map((m, i) =>
        i <= index && m.sender_id === action.myId ? upgrade(m, 'read') : m,
      )
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
  /** The window the caller already knows about (resolve, or the local copy). */
  initialRetentionMs: number,
): {
  messages: ThreadMessage[]
  /** The server has said what this thread holds — see the state below. */
  synced: boolean
  connection: ConnectionState
  /** Whether what this thread sends is actually encrypted — see the type. */
  encryption: EncryptionState
  /** Why the server refused the last send, or null when it refused nothing. */
  sendRejected: string | null
  peerTyping: boolean
  /** How long a message in this conversation lives (PRD §3.9). */
  retentionMs: RetentionMs
  /** The last change either side made, for the thread to announce. */
  retentionChange: { retentionMs: RetentionMs; changedBy: string } | null
  send: (body: string) => void
  sendMedia: (msgType: 'image' | 'video', mediaKey: string) => void
  sendSticker: (stickerId: string) => void
  sendTyping: () => void
  markRead: (upToMessageId: string) => void
  /** Retunes the window for both participants. False when the socket is down. */
  setRetention: (retentionMs: RetentionMs) => boolean
} {
  // Seeded from the local copy: a thread opened before paints its tail at once
  // and the `history` frame replaces it a connect later. `history` is a full
  // resync, not a merge, so a stale copy cannot survive into the live state —
  // the worst it can do is show the last screenful for the length of a connect.
  // The window is state and a ref: the render needs it, and so do the socket
  // effect's callbacks, which must not be torn down and rebuilt every time it
  // changes.
  const [retentionMs, setRetentionMs] = useState<RetentionMs>(() =>
    retentionOr(initialRetentionMs),
  )
  const retentionRef = useRef(retentionMs)
  retentionRef.current = retentionMs
  // The caller's value, for the socket effect to start each conversation from
  // — the screen switches threads without remounting, so the window has to be
  // re-seeded rather than carried over from the thread that was open before.
  const initialRetentionRef = useRef(initialRetentionMs)
  initialRetentionRef.current = initialRetentionMs
  const [retentionChange, setRetentionChange] = useState<{
    retentionMs: RetentionMs
    changedBy: string
  } | null>(null)

  const [messages, dispatch] = useReducer(
    reduce,
    null,
    () => readCachedMessages(myId, conversationId, retentionOr(initialRetentionMs)) ?? [],
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
   * The *unsealed* form of everything still pending, plus how it was sealed.
   *
   * `pendingRef` deliberately holds the encrypted event, so an ordinary resend
   * after a reconnect does not re-encrypt against a directory that has since
   * moved. `stale_directory` is the one case that has to do exactly that, and
   * a ciphertext cannot be re-addressed — so the plaintext is kept beside it,
   * for as long as the message is in flight and no longer.
   *
   * The media `sealing` is carried through unchanged on purpose: the object is
   * already in the bucket under that content key, so re-sealing the body has to
   * reuse it rather than mint a new one and orphan the upload.
   */
  const unsealedRef = useRef(
    new Map<
      string,
      {
        plain: SendMessageEvent
        sealing?: { contentKey: CryptoKey; mediaIv: Uint8Array; mime: string; chunk: number }
        /** Re-seals so far. One is a race; a second is a device we cannot address. */
        attempts: number
      }
    >(),
  )
  const lastReadSentRef = useRef<string | null>(null)
  /**
   * `seal`, reachable from inside the socket effect.
   *
   * The effect is declared above `seal` and must not list it: rebuilding the
   * effect tears the WebSocket down and puts it back, and re-sealing one
   * refused message is not a reason to reconnect a thread. The ref is written
   * on every render, so what `resealPending` calls is always current.
   */
  const sealRef = useRef<(
    event: SendMessageEvent,
    sealing?: { contentKey: CryptoKey; mediaIv: Uint8Array; mime: string; chunk: number },
  ) => Promise<SendMessageEvent | null>>(() => Promise.resolve(null))
  /**
   * This device's encryption identity. Null means it has none — private mode,
   * or a browser that refuses IndexedDB — and everything below degrades to
   * plaintext rather than refusing to open the thread.
   */
  const identityRef = useRef<DeviceIdentity | null>(null)
  const [encryption, setEncryption] = useState<EncryptionState>('unknown')
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
    const startRetention = retentionOr(initialRetentionRef.current)
    setRetentionMs(startRetention)
    setRetentionChange(null)
    dispatch({
      type: 'reset',
      messages: readCachedMessages(myId, conversationId, startRetention) ?? [],
    })
    pendingRef.current.clear()
    unsealedRef.current.clear()
    lastReadSentRef.current = null
    setPeerTyping(false)
    setSynced(false)
    setEncryption('unknown')
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
          const identity = identityRef.current
          dispatch({
            type: 'history',
            messages: await Promise.all(
              event.messages.map((m) => toThread(m, identity, conversationId)),
            ),
          })
          setSynced(true)
          return
        }
        case 'message': {
          if (event.sender_id === myId) {
            pendingRef.current.delete(event.client_id)
            unsealedRef.current.delete(event.client_id)
          } else clearPeerTyping()
          dispatch({
            type: 'message',
            frame: await toThread(event, identityRef.current, conversationId),
          })
          return
        }
        case 'message_status':
          pendingRef.current.delete(event.client_id)
          unsealedRef.current.delete(event.client_id)
          dispatch({
            type: 'status',
            id: event.id,
            client_id: event.client_id,
            status: event.status,
            myId,
          })
          return
        case 'read_receipt':
          dispatch({ type: 'peer_read', upToMessageId: event.up_to_message_id, myId })
          return
        case 'typing':
          showPeerTyping()
          return
        case 'retention':
          setRetentionMs(retentionOr(event.retention_ms))
          // A frame that only states the window (connect) is not an event;
          // only a real change is worth telling the person about.
          if (event.changed_by !== null) {
            setRetentionChange({
              retentionMs: retentionOr(event.retention_ms),
              changedBy: event.changed_by,
            })
          }
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
          // A device registered between this tab's last directory refresh and
          // the send. Nothing was stored, so the fix is to address the message
          // again and offer it again — not to tell anybody, because from where
          // the person is sitting nothing went wrong.
          //
          // Once. A second refusal after a forced refresh is not a race any
          // more: it is a device whose public key `sealMessage` could not use,
          // and refusing forever would leave the thread unable to send at all.
          // The message then goes as it is, readable by every device that could
          // be addressed — which is the same outcome as before this check.
          if (event.error === 'stale_directory' && event.client_id) {
            void resealPending(event.client_id)
            return
          }
          // Anything else is a refusal, not a delay: retrying would be refused
          // the same way. Stop offering the queue, say why, and let the bubbles
          // stop pretending they are on their way — a message that reads
          // "enviando_" forever is the failure mode this whole banner exists to
          // prevent.
          pendingRef.current.clear()
          unsealedRef.current.clear()
          setSendRejected(event.message ?? event.error)
          dispatch({ type: 'send_rejected', myId })
          return
      }
    }

    /**
     * Seals one pending message again against a freshly fetched directory and
     * puts it back on the wire under the same client id — which the Durable
     * Object dedups on, and which the envelope is now bound to (`messageAad`),
     * so the re-sealed body is a different ciphertext for the same message
     * rather than a second message.
     */
    const resealPending = async (clientId: string) => {
      const held = unsealedRef.current.get(clientId)
      if (!held) return
      const giveUp = held.attempts >= 1
      held.attempts += 1
      if (!giveUp) {
        await Promise.all([refreshDevices(otherUserId), refreshDevices(myId)])
        if (disposed) return
        const resealed = await sealRef.current(held.plain, held.sealing)
        if (disposed) return
        if (resealed) pendingRef.current.set(clientId, resealed)
      }
      const event = pendingRef.current.get(clientId)
      const ws = wsRef.current
      if (!event) return
      if (giveUp) {
        // Out of re-seals. Strip the envelope only if there is none — an
        // unsealable peer is the plaintext path, which E2EE_REQUIRED may well
        // refuse, and that refusal is the honest answer rather than a silent
        // downgrade.
        console.warn('directory still stale after a re-seal; sending as addressed')
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
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

    // The identity and both device directories, refreshed on every connect —
    // which is exactly when a peer's new browser would need to start receiving
    // messages, and when one of ours would.
    const loadKeys = async () => {
      const identity = await readDeviceKey(myId)
      identityRef.current = identity
      const [peers] = await Promise.all([refreshDevices(otherUserId), refreshDevices(myId)])
      if (disposed) return
      // Exactly the two conditions `seal` checks, so the indicator cannot claim
      // something the send path does not do.
      setEncryption(identity && peers.length > 0 ? 'on' : 'off')
    }

    /**
     * The keys go through the same queue as the frames rather than beside them.
     * `history` lands within a millisecond of the socket opening, and a frame
     * opened before the identity and both directories are in hand decrypts to
     * nothing: the bubble renders as "[mensagem de antes deste dispositivo]"
     * and stays that way until something forces another history, because the
     * reducer has no reason to revisit a message it already placed. Failing to
     * load them must not wedge the queue either — an unencrypted thread still
     * has frames to deliver.
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
        // A receipt sent on a dying socket may be lost — resend after reconnect.
        lastReadSentRef.current = null
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
      sealing?: { contentKey: CryptoKey; mediaIv: Uint8Array; mime: string; chunk: number },
    ): Promise<SendMessageEvent | null> => {
      const identity = identityRef.current ?? (await readDeviceKey(myId))
      if (!identity) return null
      identityRef.current = identity

      const [peers, mine] = await Promise.all([getDevices(otherUserId), getDevices(myId)])
      // Only this device registered: nobody on the other side can read it yet.
      if (peers.length === 0) return null

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
        [...peers, ...mine],
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
      sealing?: { contentKey: CryptoKey; mediaIv: Uint8Array; mime: string; chunk: number },
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
        unsealedRef.current.set(clientId, { plain, sealing, attempts: 0 })
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
        // Not open: the queued event is flushed by the next onopen.
      })()
    },
    [myId, seal],
  )

  sealRef.current = seal

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
      sealing?: { contentKey: CryptoKey; mediaIv: Uint8Array; mime: string; chunk: number },
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
   * Both participants share one window, so this is a request to the server
   * rather than local state: the `retention` frame it broadcasts is what moves
   * the UI, on this device and on theirs.
   */
  const setRetention = useCallback((next: RetentionMs) => {
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ type: 'set_retention', retention_ms: next }))
    return true
  }, [])

  const markRead = useCallback((upToMessageId: string) => {
    if (lastReadSentRef.current === upToMessageId) return
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    lastReadSentRef.current = upToMessageId
    ws.send(JSON.stringify({ type: 'read_receipt', up_to_message_id: upToMessageId }))
  }, [])

  // Keeping the local copy fresh. A ref holds the latest list so the debounce
  // can collapse a burst — an echo, its status upgrade and the peer's typing
  // all land within a second of each other — into one JSON.stringify instead of
  // one per frame.
  // A message can age out while the thread is open, and it can age out while
  // the tab is offline — where no `messages_expired` frame can reach it. So the
  // window is also applied here, on every render, against a clock that ticks
  // slowly on its own so nothing lingers on screen just because the
  // conversation went quiet.
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), EXPIRY_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const live = useMemo(() => {
    const cutoff = clock - retentionMs
    return messages.some((m) => m.created_at <= cutoff)
      ? messages.filter((m) => m.created_at > cutoff)
      : messages
  }, [messages, clock, retentionMs])

  const latestRef = useRef(live)
  latestRef.current = live

  useEffect(() => {
    const timer = window.setTimeout(
      () => writeCachedMessages(myId, conversationId, latestRef.current, retentionRef.current),
      500,
    )
    return () => window.clearTimeout(timer)
  }, [live, myId, conversationId])

  // Leaving the thread inside that second must not lose the tail: the debounce
  // above cancels on cleanup, so the way out writes for itself. Keyed on the
  // conversation, not on the messages, so it runs on unmount and not on every
  // frame.
  useEffect(() => {
    return () =>
      writeCachedMessages(myId, conversationId, latestRef.current, retentionRef.current)
  }, [myId, conversationId])

  return {
    messages: live,
    synced,
    connection: connectionRef.current,
    encryption,
    sendRejected,
    peerTyping,
    retentionMs,
    retentionChange,
    send,
    sendMedia,
    sendSticker,
    sendTyping,
    markRead,
    setRetention,
  }
}
