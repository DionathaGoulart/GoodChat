// Live conversation state over one WebSocket (protocol.ts shapes).
// - reconnect with exponential backoff + jitter (0.5s → 10s cap)
// - `history` frame on (re)connect resyncs server state, keeping and
//   resending optimistic messages the server never acked (dedup by client_id
//   is server-side, so resending is safe — at-least-once)
// - optimistic send: local status 'sending' until the echo frame arrives
// - read receipts sent when the thread reports visibility (unread badge
//   source of truth; receipt *rendering* is phase 7)

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { wsUrl } from '../lib/api'
import {
  ServerEventSchema,
  type MessageStatus,
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

const STATUS_RANK: Record<ThreadMessage['status'], number> = {
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

type Action =
  | { type: 'reset' }
  | { type: 'history'; messages: WireMessage[] }
  | { type: 'message'; frame: WireMessage }
  | { type: 'status'; id: string; client_id: string; status: MessageStatus; myId: string }
  | { type: 'peer_read'; upToMessageId: string; myId: string }
  | { type: 'optimistic'; message: ThreadMessage }

function fromWire(m: WireMessage): ThreadMessage {
  return { ...m }
}

function upgrade(current: ThreadMessage, status: ThreadMessage['status']): ThreadMessage {
  return STATUS_RANK[status] > STATUS_RANK[current.status] ? { ...current, status } : current
}

function reduce(messages: ThreadMessage[], action: Action): ThreadMessage[] {
  switch (action.type) {
    case 'reset':
      return []
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
  }
}

export function useConversation(
  conversationId: string,
  otherUserId: string,
  myId: string,
): {
  messages: ThreadMessage[]
  connection: ConnectionState
  send: (body: string) => void
  sendMedia: (msgType: 'image' | 'video', mediaKey: string) => void
  markRead: (upToMessageId: string) => void
} {
  const [messages, dispatch] = useReducer(reduce, [])
  const connectionRef = useRef<ConnectionState>('connecting')
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef(new Map<string, SendMessageEvent>())
  const lastReadSentRef = useRef<string | null>(null)

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
    dispatch({ type: 'reset' })
    pendingRef.current.clear()
    lastReadSentRef.current = null

    const handleFrame = (event: ServerEvent) => {
      switch (event.type) {
        case 'history':
          dispatch({ type: 'history', messages: event.messages })
          return
        case 'message':
          if (event.sender_id === myId) pendingRef.current.delete(event.client_id)
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
          // Rendered in phase 7.
          return
        case 'error':
          console.warn('ws error frame', event.error, event.message)
          return
      }
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
        for (const event of pendingRef.current.values()) ws.send(JSON.stringify(event))
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

  const markRead = useCallback((upToMessageId: string) => {
    if (lastReadSentRef.current === upToMessageId) return
    const ws = wsRef.current
    if (ws?.readyState !== WebSocket.OPEN) return
    lastReadSentRef.current = upToMessageId
    ws.send(JSON.stringify({ type: 'read_receipt', up_to_message_id: upToMessageId }))
  }, [])

  return { messages, connection: connectionRef.current, send, sendMedia, markRead }
}
