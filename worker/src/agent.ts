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
import { claimUpload } from './lib/mediaIndex'
import { notifyUser, previewFor } from './lib/push'
import {
  ClientEventSchema,
  STICKER_ID_RE,
  type SendMessageEvent,
  type ServerEvent,
  type WireMessage,
} from './protocol'

interface ConnState {
  userId: string
  /**
   * The peer's account is gone (a tombstone — see migration 0004). The thread
   * is still readable, but there is nobody left to answer, so sends are
   * refused instead of piling up messages no one will ever collect.
   */
  readonly?: boolean
}

// Per-connection token buckets. An authenticated client is still untrusted:
// without this, one socket can fill the DO's SQLite, burn CPU and fan out push
// notifications as fast as it can write frames. Persisted messages are the
// expensive kind; typing/read frames are cheap but still broadcast, so they
// get a looser bucket of their own.
//
// State is in memory on purpose: a hibernating DO has no live socket to abuse,
// and waking up with full buckets is the correct starting point.
interface TokenBucket {
  tokens: number
  updatedAt: number
}

const RATE_LIMITS = {
  message: { capacity: 20, perSecond: 2 },
  signal: { capacity: 40, perSecond: 8 },
} as const

/** Consecutive refusals before the socket is closed rather than answered. */
const MAX_RATE_VIOLATIONS = 20

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

/** Shape returned by GET /stats — consumed by routes/admin.ts. */
export interface ConversationStats {
  messages: number
  body_bytes: number
  storage_bytes: number
  first_at: number | null
  last_at: number | null
  per_sender: { user_id: string; messages: number; body_bytes: number }[]
  media: { key: string; user_id: string }[]
  participants: string[]
}

export class ConversationAgent extends Agent<Env> {
  static override options = { hibernate: true }

  /** connection id → its two buckets plus a violation counter. */
  private readonly rateState = new Map<
    string,
    { message: TokenBucket; signal: TokenBucket; violations: number }
  >()

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
  // router never forwards plain HTTP here).
  //   GET  /summary  conversation list: last message + unread for one user
  //   GET  /stats    owner panel: message/byte counts, media keys, disk size
  //   POST /purge    owner action: wipe this conversation's history
  //   POST /destroy  no participant left: wipe the history and the storage
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

    if (request.method === 'GET' && url.pathname.endsWith('/stats')) {
      return Response.json(this.stats())
    }

    if (request.method === 'POST' && url.pathname.endsWith('/purge')) {
      return Response.json(this.purge())
    }

    if (request.method === 'POST' && url.pathname.endsWith('/destroy')) {
      return Response.json(await this.wipe())
    }

    return new Response('not found', { status: 404 })
  }

  /**
   * Storage accounting for one conversation. `storage_bytes` is the DO's real
   * SQLite page count — the number that matters for cost — while the per-sender
   * byte totals are message payload only, which is what attributes usage to an
   * account. Media lives in the bucket and is counted from the D1 index, but
   * the keys are reported here too so a purge can delete objects that predate
   * that index.
   */
  private stats(): ConversationStats {
    const totals = this.sql<{ n: number; bytes: number; first_at: number; last_at: number }>`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(LENGTH(body)), 0) AS bytes,
             COALESCE(MIN(created_at), 0) AS first_at,
             COALESCE(MAX(created_at), 0) AS last_at
      FROM messages
    `
    const perSender = this.sql<{ sender_id: string; n: number; bytes: number }>`
      SELECT sender_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes
      FROM messages GROUP BY sender_id
    `
    const media = this.sql<{ media_key: string; sender_id: string }>`
      SELECT media_key, sender_id FROM messages WHERE media_key IS NOT NULL
    `
    let storageBytes = 0
    try {
      storageBytes = this.ctx.storage.sql.databaseSize
    } catch {
      // Not every runtime build exposes it; payload bytes are the fallback.
      storageBytes = totals[0].bytes
    }
    return {
      messages: totals[0].n,
      body_bytes: totals[0].bytes,
      storage_bytes: storageBytes,
      first_at: totals[0].first_at || null,
      last_at: totals[0].last_at || null,
      per_sender: perSender.map((row) => ({
        user_id: row.sender_id,
        messages: row.n,
        body_bytes: row.bytes,
      })),
      media: media.map((row) => ({ key: row.media_key, user_id: row.sender_id })),
      participants: this.sql<{ user_id: string }>`SELECT user_id FROM participants`.map(
        (row) => row.user_id,
      ),
    }
  }

  /**
   * Wipes every message. `participants` survives so the pinned pair keeps
   * rejecting outsiders on the next connect. Live sockets are told to reload
   * their (now empty) history instead of being left showing deleted messages.
   */
  private purge(): { deleted: number; media_keys: string[] } {
    const media = this.sql<{ media_key: string }>`
      SELECT media_key FROM messages WHERE media_key IS NOT NULL
    `
    const before = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages`
    this.sql`DELETE FROM messages`
    for (const conn of this.getConnections<ConnState>()) {
      this.send(conn, { type: 'history', messages: [] })
    }
    return { deleted: before[0].n, media_keys: media.map((row) => row.media_key) }
  }

  /**
   * Last participant gone: nothing here is reachable anymore. The messages go
   * the same way a purge takes them (so the caller gets the media keys to
   * delete from the bucket), then the whole storage goes, `participants`
   * included — a fresh DO under this name would start empty anyway.
   *
   * Not the SDK's own `destroy()`: that one aborts the isolate on the next
   * tick, which would race the response this route still has to return.
   */
  private async wipe(): Promise<{ deleted: number; media_keys: string[] }> {
    const result = this.purge()
    for (const conn of this.getConnections<ConnState>()) {
      conn.close(1000, 'conversation removed')
    }
    try {
      await this.ctx.storage.deleteAll()
    } catch (error) {
      // The purge already emptied the messages; a runtime without deleteAll
      // only leaves empty tables behind, not data.
      console.error('storage deleteAll failed', this.name, error)
    }
    return result
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

    // Set by routes/ws.ts when the peer account no longer exists.
    conn.setState({ userId, readonly: ctx.request.headers.get('x-goodchat-readonly') === '1' })

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

    if (!this.consumeToken(conn, event.data.type === 'send_message' ? 'message' : 'signal')) {
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
    if (conn.state?.readonly) {
      this.send(conn, {
        type: 'error',
        error: 'peer_unavailable',
        message: 'esta conta não existe mais',
      })
      return
    }

    const textual = event.msg_type === 'text' || event.msg_type === 'emoji' || event.msg_type === 'sticker'
    if (textual && event.body.trim() === '') {
      this.send(conn, { type: 'error', error: 'empty_body' })
      return
    }
    if (!textual && !event.media_key) {
      this.send(conn, { type: 'error', error: 'media_key_required' })
      return
    }
    if (event.msg_type === 'sticker' && !STICKER_ID_RE.test(event.body)) {
      this.send(conn, { type: 'error', error: 'invalid_sticker' })
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

    // Claim the object for this conversation: that is what turns the media
    // proxy's check from "unguessable key" into "participant of this thread",
    // and what takes the row out of the orphan sweep's reach.
    if (event.media_key) {
      this.ctx.waitUntil(
        claimUpload(this.env.DB, event.media_key, userId, this.name, now).catch((error) => {
          console.error('claimUpload failed', error)
        }),
      )
    }

    // Web Push when the recipient has no live connection (phase 8). Off the
    // frame-processing path — the push service round-trip must not block the
    // sender's next frame. notifyUser never throws.
    if (!peerOnline) {
      this.ctx.waitUntil(this.pushToPeer(userId, peerId, event))
    }
  }

  private async pushToPeer(
    senderId: string,
    peerId: string,
    event: SendMessageEvent,
  ): Promise<void> {
    try {
      const sender = await this.env.DB.prepare('SELECT username FROM users WHERE id = ?')
        .bind(senderId)
        .first<{ username: string }>()
      await notifyUser(this.env, peerId, {
        title: `@${sender?.username ?? 'goodchat'}`,
        body: previewFor(event.msg_type, event.body),
        url: `/#/t/${senderId}`,
        tag: this.name,
      })
    } catch (error) {
      console.error('pushToPeer failed', error instanceof Error ? error.message : error)
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

  override async onClose(conn: Connection<ConnState>): Promise<void> {
    this.rateState.delete(conn.id)
  }

  /**
   * Token bucket for one connection and one frame class. Returns false when
   * the frame must be dropped — the client is told once per refusal, and a
   * client that keeps hammering past MAX_RATE_VIOLATIONS gets disconnected
   * instead of answered (an error frame per abusive frame is itself a cost).
   */
  private consumeToken(conn: Connection<ConnState>, kind: 'message' | 'signal'): boolean {
    const now = Date.now()
    let state = this.rateState.get(conn.id)
    if (!state) {
      state = {
        message: { tokens: RATE_LIMITS.message.capacity, updatedAt: now },
        signal: { tokens: RATE_LIMITS.signal.capacity, updatedAt: now },
        violations: 0,
      }
      this.rateState.set(conn.id, state)
    }

    const limit = RATE_LIMITS[kind]
    const bucket = state[kind]
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsedSeconds * limit.perSecond)
    bucket.updatedAt = now

    if (bucket.tokens < 1) {
      state.violations += 1
      if (state.violations > MAX_RATE_VIOLATIONS) {
        this.rateState.delete(conn.id)
        conn.close(1008, 'rate limited')
        return false
      }
      this.send(conn, {
        type: 'error',
        error: 'rate_limited',
        message: 'muitas mensagens em pouco tempo',
      })
      return false
    }

    bucket.tokens -= 1
    state.violations = 0
    return true
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
