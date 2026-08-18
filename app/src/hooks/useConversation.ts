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

export interface ThreadMessage {
  /** Server id — null while the message is only local ('sending'). */
  id: string | null
  client_id: string
  sender_id: string
  msg_type: WireMessage['msg_type']
  body: string
  media_key: string | null
  created_at: number
  status: MessageStatus | 'sending'
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
  | { type: 'history'; messages: WireMessage[] }
  | { type: 'message'; frame: WireMessage }
  | { type: 'status'; id: string; client_id: string; status: MessageStatus; myId: string }
  | { type: 'peer_read'; upToMessageId: string; myId: string }
  | { type: 'optimistic'; message: ThreadMessage }
  | { type: 'expired'; ids: string[] }

function fromWire(m: WireMessage): ThreadMessage {
  return { ...m }
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
      return [...action.messages.map(fromWire), ...pending]
    }
    case 'message': {
      const frame = action.frame
      const index = messages.findIndex(
        (m) => m.sender_id === frame.sender_id && m.client_id === frame.client_id,
      )
      if (index >= 0) {
        const next = [...messages]
        // Keep the higher status if a message_status frame raced ahead of the echo.
        next[index] = upgrade(fromWire(frame), messages[index].status)
        return next
      }
      if (messages.some((m) => m.id === frame.id)) return messages
      return [...messages, fromWire(frame)]
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
  const lastReadSentRef = useRef<string | null>(null)
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
    lastReadSentRef.current = null
    setPeerTyping(false)
    setSynced(false)

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

    const handleFrame = (event: ServerEvent) => {
      switch (event.type) {
        case 'history':
          dispatch({ type: 'history', messages: event.messages })
          setSynced(true)
          return
        case 'message':
          if (event.sender_id === myId) pendingRef.current.delete(event.client_id)
          else clearPeerTyping()
          dispatch({ type: 'message', frame: event })
          return
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
          return
        case 'error':
          console.warn('ws error frame', event.error, event.message)
          // The server dropped that frame instead of processing it. Whatever
          // is still pending has to be offered again, after the bucket has had
          // time to refill — otherwise a long offline queue would sit at
          // 'sending' forever.
          if (event.error === 'rate_limited') scheduleFlush(2000)
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

    const connect = () => {
      if (disposed) return
      setConnection('connecting')
      const ws = new WebSocket(wsUrl(conversationId, otherUserId))
      wsRef.current = ws

      ws.onopen = () => {
        attempt = 0
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
        if (frame.success) handleFrame(frame.data)
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

  const sendEvent = useCallback(
    (msgType: WireMessage['msg_type'], body: string, mediaKey: string | null) => {
      const event: SendMessageEvent = {
        type: 'send_message',
        client_id: crypto.randomUUID(),
        msg_type: msgType,
        body,
        ...(mediaKey ? { media_key: mediaKey } : {}),
      }
      pendingRef.current.set(event.client_id, event)
      dispatch({
        type: 'optimistic',
        message: {
          id: null,
          client_id: event.client_id,
          sender_id: myId,
          msg_type: msgType,
          body,
          media_key: mediaKey,
          created_at: Date.now(),
          status: 'sending',
        },
      })
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
      // Not open: the queued event is flushed by the next onopen.
    },
    [myId],
  )

  const send = useCallback((body: string) => sendEvent('text', body, null), [sendEvent])

  // Media is already sitting in B2 when this fires — the message only
  // references the object key, so the optimistic bubble renders the real file.
  const sendMedia = useCallback(
    (msgType: 'image' | 'video', mediaKey: string) => sendEvent(msgType, '', mediaKey),
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
