// ConversationAgent — one Durable Object per conversation (idFromName = the
// deterministic conversation id). Holds both participants' live WebSockets,
// persists messages in the DO's internal SQLite (PRD §4.4), and broadcasts in
// real time (PRD §4.5). Hibernation is on (Agent default), so idle
// conversations cost nothing; per-connection identity lives in connection
// state, which survives hibernation via the WebSocket attachment.
//
// Trust model: the Worker route (routes/ws.ts) authenticates the session and
// verifies the user pair matches the conversation id before forwarding, then
// stamps x-goodchat-user-id / x-goodchat-peer-id. The DO additionally pins the
// pair in a `participants` table on first connect and rejects anyone else.

import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import { ensureConversation } from './lib/conversation'
import {
  ClientEventSchema,
  type SendMessageEvent,
  type ServerEvent,
  type WireMessage,
} from './protocol'

interface ConnState {
  userId: string
}

interface MessageRow {
  rowid: number
  id: string
  client_id: string
  sender_id: string
  type: WireMessage['msg_type']
  body: string
  media_key: string | null
  created_at: number
  status: WireMessage['status']
}

const HISTORY_LIMIT = 50

export class ConversationAgent extends Agent<Env> {
  static override options = { hibernate: true }

  // Raw-JSON clients: suppress the SDK's cf_agent_* protocol frames
  // (identity/state/MCP) so the only traffic is our protocol.ts shapes.
  override shouldSendProtocolMessages(): boolean {
    return false
  }

  override onStart(): void {
    // Schema exactly PRD §4.4 (column `type` on disk, `msg_type` on the wire).
    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        client_id  TEXT NOT NULL,
        sender_id  TEXT NOT NULL,
        type       TEXT NOT NULL,
        body       TEXT NOT NULL,
        media_key  TEXT,
        created_at INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'sent',
        edited_at  INTEGER,
        deleted_at INTEGER
      )
    `
    // At-least-once dedup: one row per (sender, client_id).
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client
      ON messages (sender_id, client_id)
    `
    this.sql`
      CREATE TABLE IF NOT EXISTS participants (user_id TEXT PRIMARY KEY)
    `
  }

  // Internal HTTP surface (only reachable through Worker code — the public
  // router never forwards plain HTTP here). GET /summary powers the
  // conversation list: last message + unread count for the requesting user.
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('/summary')) {
      const userId = request.headers.get('x-goodchat-user-id')
      if (!userId) return new Response('unauthorized', { status: 401 })
      const last = this.sql<MessageRow>`
        SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status
        FROM messages WHERE deleted_at IS NULL ORDER BY rowid DESC LIMIT 1
      `
      const unread = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM messages
        WHERE sender_id != ${userId} AND status != 'read' AND deleted_at IS NULL
      `
      return Response.json({
        last_message: last.length > 0 ? toWire(last[0]) : null,
        unread_count: unread[0].n,
      })
    }
    return new Response('not found', { status: 404 })
  }

  override async onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): Promise<void> {
    const userId = ctx.request.headers.get('x-goodchat-user-id')
    const peerId = ctx.request.headers.get('x-goodchat-peer-id')
    if (!userId || !peerId || userId === peerId) {
      conn.close(1008, 'unauthorized')
      return
    }

    const participants = this.sql<{ user_id: string }>`SELECT user_id FROM participants`
    if (participants.length === 0) {
      this.sql`INSERT OR IGNORE INTO participants (user_id) VALUES (${userId})`
      this.sql`INSERT OR IGNORE INTO participants (user_id) VALUES (${peerId})`
    } else {
      const known = new Set(participants.map((p) => p.user_id))
      if (!known.has(userId) || !known.has(peerId)) {
        conn.close(1008, 'forbidden')
        return
      }
    }

    conn.setState({ userId })

    // Offline delivery: everything addressed to me that is still 'sent'
    // becomes 'delivered' now; the sender's live connections hear about it.
    const undelivered = this.sql<{ rowid: number; id: string; client_id: string }>`
      SELECT rowid, id, client_id FROM messages
      WHERE sender_id != ${userId} AND status = 'sent'
      ORDER BY rowid ASC
    `
    if (undelivered.length > 0) {
      this.sql`
        UPDATE messages SET status = 'delivered'
        WHERE sender_id != ${userId} AND status = 'sent'
      `
      for (const msg of undelivered) {
        this.sendToOthers(userId, {
          type: 'message_status',
          id: msg.id,
          client_id: msg.client_id,
          status: 'delivered',
        })
      }
    }

    // History: one contiguous window covering the last HISTORY_LIMIT messages
    // AND everything that was undelivered until a moment ago (may be older).
    const cutoff = this.sql<{ rowid: number }>`
      SELECT rowid FROM messages ORDER BY rowid DESC LIMIT 1 OFFSET ${HISTORY_LIMIT - 1}
    `
    let startRowid = cutoff.length > 0 ? cutoff[0].rowid : 0
    if (undelivered.length > 0 && undelivered[0].rowid < startRowid) {
      startRowid = undelivered[0].rowid
    }
    const rows = this.sql<MessageRow>`
      SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status
      FROM messages WHERE rowid >= ${startRowid} ORDER BY rowid ASC
    `
    this.send(conn, { type: 'history', messages: rows.map(toWire) })
  }

  override async onMessage(conn: Connection<ConnState>, raw: WSMessage): Promise<void> {
    const userId = conn.state?.userId
    if (typeof raw !== 'string' || !userId) return

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.send(conn, { type: 'error', error: 'invalid_json' })
      return
    }
    const event = ClientEventSchema.safeParse(parsed)
    if (!event.success) {
      this.send(conn, { type: 'error', error: 'invalid_message' })
      return
    }

    switch (event.data.type) {
      case 'send_message':
        await this.handleSend(conn, userId, event.data)
        return
      case 'typing':
        // Ephemeral, never persisted (PRD §3.4).
        this.sendToOthers(userId, { type: 'typing', user_id: userId })
        return
      case 'read_receipt':
        this.handleReadReceipt(conn, userId, event.data.up_to_message_id)
        return
    }
  }

  private async handleSend(
    conn: Connection<ConnState>,
    userId: string,
    event: SendMessageEvent,
  ): Promise<void> {
    const textual = event.msg_type === 'text' || event.msg_type === 'emoji' || event.msg_type === 'sticker'
    if (textual && event.body.trim() === '') {
      this.send(conn, { type: 'error', error: 'empty_body' })
      return
    }
    if (!textual && !event.media_key) {
      this.send(conn, { type: 'error', error: 'media_key_required' })
      return
    }

    // At-least-once + dedup: a resent client_id acks the existing row.
    const dup = this.sql<{ id: string; status: WireMessage['status'] }>`
      SELECT id, status FROM messages
      WHERE sender_id = ${userId} AND client_id = ${event.client_id}
    `
    if (dup.length > 0) {
      this.send(conn, {
        type: 'message_status',
        id: dup[0].id,
        client_id: event.client_id,
        status: dup[0].status,
      })
      return
    }

    const id = crypto.randomUUID()
    const now = Date.now()
    const peerId = this.peerOf(userId)
    const peerOnline = [...this.getConnections<ConnState>()].some(
      (c) => c.state?.userId === peerId,
    )
    const status: WireMessage['status'] = peerOnline ? 'delivered' : 'sent'

    this.sql`
      INSERT INTO messages (id, client_id, sender_id, type, body, media_key, created_at, status)
      VALUES (${id}, ${event.client_id}, ${userId}, ${event.msg_type}, ${event.body},
              ${event.media_key ?? null}, ${now}, ${status})
    `

    // Everyone gets the full frame; the sender reconciles by client_id
    // (your own `message` frame back == "sent", its status may already be
    // 'delivered' when the peer had a live connection).
    const frame: ServerEvent = {
      type: 'message',
      id,
      client_id: event.client_id,
      sender_id: userId,
      msg_type: event.msg_type,
      body: event.body,
      media_key: event.media_key ?? null,
      created_at: now,
      status,
    }
    for (const c of this.getConnections<ConnState>()) this.send(c, frame)

    // Lazy conversation row + last_message_at bump in D1 (phase-3 helper).
    // After the broadcast: D1 latency must not sit in the delivery path.
    try {
      await ensureConversation(this.env.DB, userId, peerId, now)
    } catch (error) {
      console.error('ensureConversation failed', error)
    }
  }

  private handleReadReceipt(
    conn: Connection<ConnState>,
    userId: string,
    upToMessageId: string,
  ): void {
    const target = this.sql<{ rowid: number }>`
      SELECT rowid FROM messages WHERE id = ${upToMessageId}
    `
    if (target.length === 0) {
      this.send(conn, { type: 'error', error: 'unknown_message' })
      return
    }
    // Only messages addressed to the reader can be marked read by them.
    this.sql`
      UPDATE messages SET status = 'read'
      WHERE sender_id != ${userId} AND rowid <= ${target[0].rowid} AND status != 'read'
    `
    this.sendToOthers(userId, {
      type: 'read_receipt',
      up_to_message_id: upToMessageId,
      user_id: userId,
    })
  }

  /** The other pinned participant. Connections exist only after pinning. */
  private peerOf(userId: string): string {
    const rows = this.sql<{ user_id: string }>`
      SELECT user_id FROM participants WHERE user_id != ${userId}
    `
    if (rows.length !== 1) throw new Error('conversation participants not pinned')
    return rows[0].user_id
  }

  /** Send to every connection not owned by `userId` (peer + none of my tabs). */
  private sendToOthers(userId: string, event: ServerEvent): void {
    for (const c of this.getConnections<ConnState>()) {
      if (c.state?.userId !== userId) this.send(c, event)
    }
  }

  private send(conn: Connection<ConnState>, event: ServerEvent): void {
    try {
      conn.send(JSON.stringify(event))
    } catch {
      // Connection already closing — nothing to do, close handler cleans up.
    }
  }
}

function toWire(row: MessageRow): WireMessage {
  return {
    id: row.id,
    client_id: row.client_id,
    sender_id: row.sender_id,
    msg_type: row.type,
    body: row.body,
    media_key: row.media_key,
    created_at: row.created_at,
    status: row.status,
  }
}
