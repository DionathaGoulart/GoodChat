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
//
// Retention (PRD §3.9) lives here too, because this is the only place that
// holds messages. Each message dies `retention_ms` after it was written — the
// row here and the bucket object it referenced — and the window is one shared
// setting per conversation, changeable by either participant. Three things
// keep the clock honest:
//
//   - an alarm (`expireTick`) armed for the moment the oldest message ages
//     out, so a conversation nobody has open still empties itself;
//   - a sweep on every wake (`onStart`) and on every connect, so no request
//     can ever be answered with a message that should already be gone;
//   - a sweep the instant the window is shortened, so choosing "3 horas" on a
//     week-old thread deletes what is already past it right away.
//
// D1 mirrors two numbers, and only those: the window (migration 0008), which
// the resolve endpoint needs before a socket exists, and the moment the oldest
// surviving message ages out (migration 0009), which is what lets the cron
// backstop find a conversation holding *an* expired message rather than only
// the ones whose entire history has aged out (lib/cleanup.ts).

import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import { ensureConversation } from './lib/conversation'
import { isMessageMediaKey, isValidObjectKey } from './lib/media'
import { deleteMediaObjects } from './lib/mediaGc'
import { claimUpload } from './lib/mediaIndex'
import { DEFAULT_PUSH_PREVIEW, notifyUser, previewFor, previewPreferenceOf } from './lib/push'
import {
  ClientEventSchema,
  STICKER_ID_RE,
  retentionOr,
  type RetentionMs,
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
  /** The encryption envelope, stored verbatim as JSON. Null = plaintext. */
  enc: string | null
}

const HISTORY_LIMIT = 50

/** Shape returned by GET /stats — consumed by routes/admin.ts. */
export interface ConversationStats {
  messages: number
  body_bytes: number
  storage_bytes: number
  first_at: number | null
  last_at: number | null
  /** The conversation's message window (PRD §3.9). */
  retention_ms: number
  /** When the oldest surviving message ages out; null when there is none. */
  next_expiry_at: number | null
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

  /**
   * The SDK's state channel is not part of this conversation's protocol, and
   * closing it is not optional: the base class handles an incoming
   * `cf_agent_state` frame *before* `onMessage` ever runs, so such a frame
   * would write client-controlled JSON into this object's SQLite without
   * passing the token bucket in `consumeToken` — the only rate limit a socket
   * has. The row also outlives a purge (`purge()` deletes messages, not
   * settings) and the retention sweep, which is exactly what this product
   * promises not to do.
   *
   * `validateStateChange` runs before the write and a throw aborts it, so this
   * is where the channel closes. Nothing here calls `setState`, hence
   * everything but "server" is refused rather than filtered.
   */
  override validateStateChange(_nextState: unknown, source: Connection | 'server'): void {
    if (source !== 'server') {
      throw new Error('state updates are not part of this protocol')
    }
  }

  override async onStart(): Promise<void> {
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
        deleted_at INTEGER,
        enc        TEXT
      )
    `
    // Objects created before end-to-end encryption already have the table, and
    // CREATE TABLE IF NOT EXISTS will not add a column to one. There is no
    // migration runner inside a Durable Object and PRAGMA is not available to
    // ask, so the idiom is to try and let the duplicate-column error be the
    // answer. Cheap: this runs once per wake, on a table of at most a few
    // hundred rows.
    try {
      this.sql`ALTER TABLE messages ADD COLUMN enc TEXT`
    } catch {
      // Already there.
    }
    // At-least-once dedup: one row per (sender, client_id).
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client
      ON messages (sender_id, client_id)
    `
    this.sql`
      CREATE TABLE IF NOT EXISTS participants (user_id TEXT PRIMARY KEY)
    `
    // The expiry sweep is a range scan over this column on every wake.
    this.sql`
      CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at)
    `
    // Conversation-level settings. One row per key so a second setting does
    // not need a migration inside the DO.
    this.sql`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)
    `

    // A note on what "deleted" means at this layer, because it is not what the
    // rest of this file promises. A plain DELETE frees the page, it does not
    // overwrite it, so a deleted message stays legible in the database file
    // until something reuses the space. Both SQLite answers to that are closed
    // to a Durable Object: `VACUUM` fails ("cannot VACUUM from within a
    // transaction", the DO runs its SQL inside one) and
    // `PRAGMA secure_delete = ON` fails ("not authorized", the runtime blocks
    // pragmas outright). Neither is worth retrying — they cannot succeed here.
    //
    // What this does mean is bounded: the file is Cloudflare-managed storage
    // with no read path out of it, not for the operator and not through any API
    // in this Worker, so the residue is unreachable rather than merely deleted.
    // Making it truly unreadable is what end-to-end encryption would buy, and
    // it is the argument for it — see docs/architecture.md.

    // Waking up is the one moment this object is guaranteed to run code, so it
    // is where the clock is caught up: delete whatever aged out while it slept
    // and re-arm the alarm. Awaited rather than backgrounded — a connect that
    // raced ahead of it would be served messages that should not exist.
    await this.expireTick()
  }

  // Internal HTTP surface (only reachable through Worker code — the public
  // router never forwards plain HTTP here).
  //   GET  /summary  conversation list: last message + unread for one user
  //   GET  /stats    owner panel: message/byte counts, media keys, disk size
  //   POST /purge    owner action: wipe this conversation's history
  //   POST /destroy  no participant left: wipe the history and the storage
  //   POST /expire   cleanup backstop: run the retention sweep now
  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname.endsWith('/summary')) {
      const userId = request.headers.get('x-goodchat-user-id')
      if (!userId) return new Response('unauthorized', { status: 401 })
      const last = this.sql<MessageRow>`
        SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status, enc
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
      const result = this.purge()
      // The history is gone, so the alarm and D1's `next_expiry_at` are both
      // pointing at a message that no longer exists. Re-arming clears them —
      // otherwise the cron would wake this object once for nothing.
      this.ctx.waitUntil(this.armExpiryAlarm())
      return Response.json(result)
    }

    if (request.method === 'POST' && url.pathname.endsWith('/destroy')) {
      return Response.json(await this.wipe())
    }

    // Reaching this object is already the point: `onStart` swept on the way in
    // and re-armed the alarm. The call still runs a tick of its own so a
    // conversation that was awake but somehow un-armed is fixed too, and so the
    // caller gets a count worth logging.
    if (request.method === 'POST' && url.pathname.endsWith('/expire')) {
      return Response.json(await this.expireTick())
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
    const retention = this.retention()
    return {
      messages: totals[0].n,
      body_bytes: totals[0].bytes,
      storage_bytes: storageBytes,
      first_at: totals[0].first_at || null,
      last_at: totals[0].last_at || null,
      retention_ms: retention,
      // The clock, made visible: what the alarm is armed for, and the only
      // way to see from outside that a conversation really is emptying itself.
      next_expiry_at: totals[0].first_at ? totals[0].first_at + retention : null,
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

  // --- retention (PRD §3.9) ---------------------------------------------

  /** The window this conversation runs on. Unset means nobody chose: 7 days. */
  private retention(): RetentionMs {
    return retentionOr(numberOrNull(this.setting('retention_ms')))
  }

  private setting(key: string): string | null {
    const rows = this.sql<{ value: string }>`SELECT value FROM settings WHERE key = ${key}`
    return rows.length > 0 ? rows[0].value : null
  }

  private writeSetting(key: string, value: string): void {
    this.sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${key}, ${value})`
  }

  /**
   * One tick of the clock: delete what aged out, then arm the alarm for the
   * next message due. Public because the alarm calls it by name, and because
   * the cleanup backstop pokes it over the internal HTTP surface.
   */
  async expireTick(): Promise<{ expired: number }> {
    const expired = await this.sweepExpired()
    await this.armExpiryAlarm()
    return { expired: expired.length }
  }

  /**
   * Deletes every message older than the window and tells both participants
   * which ids went, so an open thread drops them without a reload.
   *
   * The bucket objects go too, in the background: a failed DELETE leaves the
   * media_objects row behind on purpose, and the scheduled cleanup retries it
   * (lib/cleanup.ts) — dropping the row first would leak the object forever.
   */
  private async sweepExpired(now = Date.now()): Promise<string[]> {
    const cutoff = now - this.retention()
    const expired = this.sql<{ id: string; media_key: string | null }>`
      SELECT id, media_key FROM messages WHERE created_at <= ${cutoff}
    `
    if (expired.length === 0) return []

    this.sql`DELETE FROM messages WHERE created_at <= ${cutoff}`
    const ids = expired.map((row) => row.id)
    for (const conn of this.getConnections<ConnState>()) {
      this.send(conn, { type: 'messages_expired', ids })
    }

    const keys = expired
      .map((row) => row.media_key)
      .filter((key): key is string => key !== null)
    if (keys.length > 0) this.ctx.waitUntil(this.deleteMedia(keys))
    return ids
  }

  /**
   * Bucket object, index row and edge copy, in that order (lib/mediaGc.ts).
   * The DO has no incoming `Request` to take an origin from — the eviction
   * relies on `PUBLIC_ORIGIN`, which is why that var exists.
   */
  private async deleteMedia(keys: string[]): Promise<void> {
    try {
      await deleteMediaObjects(this.env, keys)
    } catch (error) {
      console.error('retention media delete failed', this.name, error)
    }
  }

  /**
   * Arms one alarm for the moment the oldest surviving message ages out. One
   * schedule at a time — its id is kept in `settings` because the SDK has no
   * "find my schedule by callback", and a stale one left behind would fire a
   * second sweep for nothing.
   *
   * Nothing left to expire means nothing scheduled: an empty conversation must
   * cost zero wake-ups.
   */
  private async armExpiryAlarm(): Promise<void> {
    const previous = this.setting('expiry_schedule_id')
    if (previous) {
      try {
        await this.cancelSchedule(previous)
      } catch (error) {
        console.error('cancelSchedule failed', this.name, error)
      }
      this.sql`DELETE FROM settings WHERE key = 'expiry_schedule_id'`
    }

    const dueAt = this.nextExpiryAt()
    // D1 mirror of the same moment (migration 0009). It is what lets the cron
    // backstop find a conversation with *an* expired message instead of only
    // the ones whose whole history has aged out (lib/cleanup.ts).
    this.ctx.waitUntil(this.mirrorNextExpiry(dueAt))
    if (dueAt === null) return

    // A second of floor: a due-in-the-past message (the sweep above could not
    // reach it only if the clock moved mid-run) must not schedule into the past.
    const when = new Date(Math.max(dueAt, Date.now() + 1000))
    try {
      const schedule = await this.schedule(when, 'expireTick')
      this.writeSetting('expiry_schedule_id', schedule.id)
    } catch (error) {
      // The wake-time sweep and the cleanup backstop still catch this
      // conversation; only the precision of the deletion is lost.
      console.error('expiry schedule failed', this.name, error)
    }
  }

  /**
   * Either participant retunes the window. Both are told at once, and a
   * *shorter* window is applied to the history immediately — the point of
   * choosing "3 horas" on a week-old thread is that the week-old part goes.
   */
  private async handleSetRetention(userId: string, retentionMs: RetentionMs): Promise<void> {
    const previous = this.retention()
    this.writeSetting('retention_ms', String(retentionMs))
    // Re-mirror even when the value is unchanged: this is also the moment a
    // D1 row that did not exist at the last attempt may have appeared.
    this.sql`DELETE FROM settings WHERE key = 'retention_mirrored'`

    for (const conn of this.getConnections<ConnState>()) {
      this.send(conn, { type: 'retention', retention_ms: retentionMs, changed_by: userId })
    }

    if (retentionMs < previous) await this.sweepExpired()
    await this.armExpiryAlarm()
    this.ctx.waitUntil(this.mirrorRetention(retentionMs))
  }

  /** When the oldest surviving message ages out; null when there is none. */
  private nextExpiryAt(): number | null {
    const oldest = this.sql<{ at: number | null }>`SELECT MIN(created_at) AS at FROM messages`
    const at = oldest.length > 0 ? oldest[0].at : null
    return at === null ? null : at + this.retention()
  }

  /**
   * Copies that moment into D1 (migration 0009). Null means "nothing left to
   * expire", which is what stops the backstop from waking an empty conversation
   * forever.
   *
   * Same lazy-row problem as the retention mirror, and the same answer: the
   * conversation row is created by the first message, and the alarm is armed in
   * the same breath — so the first write can legitimately update nothing. The
   * flag records what actually landed, which is what makes the retry in
   * handleSend stop at the right time.
   */
  private async mirrorNextExpiry(at: number | null): Promise<void> {
    try {
      const result = await this.env.DB.prepare(
        'UPDATE conversations SET next_expiry_at = ?1 WHERE id = ?2',
      )
        .bind(at, this.name)
        .run()
      if ((result.meta.changes ?? 0) > 0) {
        this.writeSetting('next_expiry_mirrored', String(at))
      }
    } catch (error) {
      console.error('next expiry mirror failed', this.name, error)
    }
  }

  /**
   * Copies the window into D1 (migration 0008), where the resolve endpoint and
   * the cleanup sweep can see it. The row is created lazily by the first
   * message, so this can legitimately update nothing — the flag is only set
   * once a row actually took the value, which is what makes the retry in
   * handleSend stop at the right time.
   */
  private async mirrorRetention(retentionMs: number): Promise<void> {
    try {
      const result = await this.env.DB.prepare(
        'UPDATE conversations SET retention_ms = ?1 WHERE id = ?2',
      )
        .bind(retentionMs, this.name)
        .run()
      if ((result.meta.changes ?? 0) > 0) {
        this.writeSetting('retention_mirrored', String(retentionMs))
      }
    } catch (error) {
      console.error('retention mirror failed', this.name, error)
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

    // Nothing past the window may reach a client, so the sweep runs before the
    // history is read rather than on a timer the connect could beat. Usually a
    // single indexed range scan that matches nothing.
    await this.expireTick()

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
      SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status, enc
      FROM messages WHERE rowid >= ${startRowid} ORDER BY rowid ASC
    `
    this.send(conn, { type: 'history', messages: rows.map(toWire) })

    // Straight after the history, so the thread can label the window it just
    // painted. `changed_by: null` — this frame reports, it does not announce.
    this.send(conn, {
      type: 'retention',
      retention_ms: this.retention(),
      changed_by: null,
    })
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
      case 'set_retention':
        await this.handleSetRetention(userId, event.data.retention_ms)
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
    // An envelope has to name the sender's own device among its recipients or
    // the sender's other tabs could never read what it just sent — and, more
    // usefully here, it is the one structural claim about `enc` this object can
    // check without holding a key.
    if (event.enc && !(event.enc.sender_device in event.enc.keys)) {
      this.send(conn, { type: 'error', error: 'invalid_envelope' })
      return
    }
    // The end of the transition: once every client encrypts, a plaintext
    // message is a client that should not be trusted rather than an old one.
    // Off by default — see the note in wrangler.jsonc for why turning it on is
    // a decision about the fleet and not about the code.
    if (!event.enc && String(this.env.E2EE_REQUIRED) === 'true') {
      this.send(conn, {
        type: 'error',
        error: 'encryption_required',
        message: 'esta instância só aceita mensagens criptografadas',
      })
      return
    }
    // The wire schema only bounds the length; the key shape is what the media
    // proxy validates on every read (lib/media.ts). Checking it here too keeps
    // sender-controlled junk out of the other side's thread — and out of the
    // `claimUpload` write it would otherwise trigger.
    //
    // `media/` specifically, not merely a well-formed key: every other prefix
    // carries different rules, and a message attachment that lands under one
    // of them escapes all three. An `avatars/` object is readable by any
    // session once claimed (routes/media.ts), is cached for a year instead of
    // the shortest window (lib/media.ts `maxAgeFor`), and is skipped by both
    // media sweeps (`NOT LIKE 'avatars/%'` in lib/cleanup.ts) — so a client
    // that presigned with `purpose: "avatar"` and sent the key here would have
    // published a permanent, instance-wide copy of a disappearing message.
    //
    // Both checks: the prefix says which rules apply, `isValidObjectKey` is
    // what refuses traversal inside it (`media/../avatars/x`).
    if (
      event.media_key !== undefined &&
      !(isValidObjectKey(event.media_key) && isMessageMediaKey(event.media_key))
    ) {
      this.send(conn, { type: 'error', error: 'invalid_media_key' })
      return
    }
    // Only checkable while the body is readable. On an encrypted message the id
    // is inside the ciphertext, so the check moves to the side that turns it
    // into a URL — the recipient, in app/src/components/MessageBubble.tsx —
    // which is a stricter place for it than here ever was: it now also covers a
    // sender that skipped this Worker entirely.
    if (!event.enc && event.msg_type === 'sticker' && !STICKER_ID_RE.test(event.body)) {
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

    const enc = event.enc ? JSON.stringify(event.enc) : null
    this.sql`
      INSERT INTO messages (id, client_id, sender_id, type, body, media_key, created_at, status, enc)
      VALUES (${id}, ${event.client_id}, ${userId}, ${event.msg_type}, ${event.body},
              ${event.media_key ?? null}, ${now}, ${status}, ${enc})
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
      enc: event.enc ?? null,
    }
    for (const c of this.getConnections<ConnState>()) this.send(c, frame)

    // The message that starts a conversation is the one that arms its clock.
    // Only then: re-arming per message would cancel and rewrite a schedule that
    // is already pointing at the right message (the oldest one, which a new
    // message never is).
    if (this.setting('expiry_schedule_id') === null) {
      this.ctx.waitUntil(this.armExpiryAlarm())
    }

    // Lazy conversation row + last_message_at bump in D1 (phase-3 helper).
    // After the broadcast: D1 latency must not sit in the delivery path.
    try {
      await ensureConversation(this.env.DB, userId, peerId, now)
      // The window may have been chosen before this conversation had a row to
      // write it to. The flag stops this from being a write per message.
      const retention = this.retention()
      if (this.setting('retention_mirrored') !== String(retention)) {
        this.ctx.waitUntil(this.mirrorRetention(retention))
      }
      // Same for the deadline the cleanup backstop scans by: the alarm was
      // armed before this row existed. The oldest message does not move, so
      // after it lands once this comparison is false on every later send.
      const dueAt = this.nextExpiryAt()
      if (this.setting('next_expiry_mirrored') !== String(dueAt)) {
        this.ctx.waitUntil(this.mirrorNextExpiry(dueAt))
      }
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
      this.ctx.waitUntil(this.pushToPeer(userId, peerId, event, id))
    }
  }

  private async pushToPeer(
    senderId: string,
    peerId: string,
    event: SendMessageEvent,
    messageId: string,
  ): Promise<void> {
    try {
      const sender = await this.env.DB.prepare('SELECT username FROM users WHERE id = ?')
        .bind(senderId)
        .first<{ username: string }>()
      // The notification outlives the message: it sits in the device's
      // notification centre, which knows nothing about the retention window.
      // So the *recipient* decides how much of the body may go there
      // (migration 0010) — and the default is none of it.
      const preference = await previewPreferenceOf(this.env.DB, peerId)
      // An encrypted body is base64 to this Worker, so `previewFor` can only
      // ever produce the generic line for one. The text still reaches the
      // device when the recipient asked for it — as ciphertext the service
      // worker decrypts (lib/push.ts), which is how the feature survives
      // encryption instead of being traded away for it.
      const encrypted = event.enc
      await notifyUser(
        this.env,
        peerId,
        {
          title: `@${sender?.username ?? 'goodchat'}`,
          body: previewFor(
            event.msg_type,
            event.body,
            encrypted ? DEFAULT_PUSH_PREVIEW : preference,
          ),
          url: `/#/t/${senderId}`,
          tag: this.name,
        },
        // Only when this recipient actually wants a preview: a device that asked
        // for the generic line has no reason to be handed the ciphertext at all.
        // Which message, not the message. The device reads it back through the
        // API and decrypts it there — see EncryptedPreview in lib/push.ts for
        // why the ciphertext stopped travelling in the notification. `this.name`
        // is the conversation id: it is the name routes/ws.ts resolves this
        // agent by.
        encrypted && preference === 'full'
          ? { conversation_id: this.name, message_id: messageId }
          : undefined,
      )
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

/** A `settings` value read back as a number — null when unset or garbage. */
function numberOrNull(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
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
    // Stored as the JSON text the sender supplied and handed back untouched:
    // this object has no key material and nothing to say about it. A row that
    // fails to parse is reported as plaintext, which renders as unreadable
    // rather than as a broken frame.
    enc: row.enc ? (safeParseEnvelope(row.enc) ?? null) : null,
  }
}

function safeParseEnvelope(raw: string): WireMessage['enc'] {
  try {
    return JSON.parse(raw) as WireMessage['enc']
  } catch {
    return null
  }
}
