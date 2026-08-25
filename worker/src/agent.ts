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
// holds messages. Each row carries its own deadline in `expires_at`: seven days
// from when it was sent, pulled forward to three hours from when the recipient
// read it. Reading is therefore a write — the one client signal in this
// protocol that destroys something — which is why `handleReadReceipt` takes
// named ids and only ever moves a deadline *earlier*. Three things keep the
// clock honest:
//
//   - an alarm (`expireTick`) armed for the earliest `expires_at` in the table,
//     so a conversation nobody has open still empties itself;
//   - a sweep on every wake (`onStart`) and on every connect, so no request
//     can ever be answered with a message that should already be gone;
//   - a sweep on every read, because a read can make a message due within the
//     same second it was reported.
//
// D1 mirrors one number: the moment the next message expires (migration 0009),
// which is what lets the cron backstop find a conversation holding *an* expired
// message without waking every conversation in the instance (lib/cleanup.ts).
// `conversations.retention_ms` (migration 0008) is a tombstone — the window it
// held is not a thing anyone chooses anymore.

import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import { ensureConversation } from './lib/conversation'
import { isMessageMediaKey, isValidObjectKey } from './lib/media'
import { deleteMediaObjects } from './lib/mediaGc'
import { claimUpload } from './lib/mediaIndex'
import { DEFAULT_PUSH_PREVIEW, notifyUser, previewFor, previewPreferenceOf } from './lib/push'
import {
  ClientEventSchema,
  isAccountEnvelope,
  READ_TTL_MS,
  STICKER_ID_RE,
  UNREAD_TTL_MS,
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
  /** When the recipient read it, and when the row is deleted (PRD §3.9). */
  read_at: number | null
  expires_at: number
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
  /** When the next message expires; null when there is none (PRD §3.9). */
  next_expiry_at: number | null
  /** How many are still unread, and so still on the seven-day clock. */
  unread: number
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
        enc        TEXT,
        read_at    INTEGER,
        expires_at INTEGER
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
    // Same idiom for the per-message clock (PRD §3.9, the read-based rule).
    try {
      this.sql`ALTER TABLE messages ADD COLUMN read_at INTEGER`
    } catch {
      // Already there.
    }
    try {
      this.sql`ALTER TABLE messages ADD COLUMN expires_at INTEGER`
    } catch {
      // Already there.
    }
    this.backfillExpiry()
    // At-least-once dedup: one row per (sender, client_id).
    this.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_sender_client
      ON messages (sender_id, client_id)
    `
    this.sql`
      CREATE TABLE IF NOT EXISTS participants (user_id TEXT PRIMARY KEY)
    `
    // The expiry sweep is a range scan over this column on every wake, and
    // `MIN(expires_at)` — the moment the alarm is armed for — is its first row.
    this.sql`
      CREATE INDEX IF NOT EXISTS messages_expires_at ON messages (expires_at)
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
        SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status, read_at, expires_at, enc
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
    return {
      messages: totals[0].n,
      body_bytes: totals[0].bytes,
      storage_bytes: storageBytes,
      first_at: totals[0].first_at || null,
      last_at: totals[0].last_at || null,
      // The clock, made visible: what the alarm is armed for, and the only
      // way to see from outside that a conversation really is emptying itself.
      next_expiry_at: this.nextExpiryAt(),
      /** Unread messages are the only ones still holding their full seven days. */
      unread: this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL`[0]
        .n,
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

  /**
   * Gives a deadline to every row written before this file had one.
   *
   * Two rules, and the first one is the reason this is not a one-line UPDATE.
   * These messages were written under a *per-conversation* window that could be
   * as short as three hours, and the new rule is longer than that for anything
   * unread. Handing them `created_at + 7 days` would extend a promise already
   * made — so the old window is read one last time and used as a ceiling.
   *
   * The second: a message already marked read has no `read_at` to count from,
   * because the column did not exist when it was read. It gets `now`, which
   * grants a full three hours from this wake. That is a grace rather than an
   * accident — the alternative is a deploy that empties every open thread on
   * its first connect.
   *
   * Idempotent, and self-limiting: `expires_at` is NOT NULL on everything
   * written from here on, so after the first wake this matches no rows.
   */
  private backfillExpiry(): void {
    const pending = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM messages WHERE expires_at IS NULL
    `
    if (pending[0].n === 0) return

    const legacy = numberOrNull(this.setting('retention_ms'))
    const ceiling = Math.min(legacy ?? UNREAD_TTL_MS, UNREAD_TTL_MS)
    const now = Date.now()
    this.sql`
      UPDATE messages
      SET read_at = CASE WHEN status = 'read' THEN ${now} ELSE NULL END,
          expires_at = CASE
            WHEN status = 'read' THEN MIN(created_at + ${ceiling}, ${now + READ_TTL_MS})
            ELSE created_at + ${ceiling}
          END
      WHERE expires_at IS NULL
    `
    // The window is not a setting anymore. Its mirror flag goes with it, so a
    // build rolled back and forward again does not read a stale one.
    this.sql`DELETE FROM settings WHERE key IN ('retention_ms', 'retention_mirrored')`
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
   * Deletes every message whose deadline has passed and tells both participants
   * which ids went, so an open thread drops them without a reload.
   *
   * The bucket objects go too, in the background: a failed DELETE leaves the
   * media_objects row behind on purpose, and the scheduled cleanup retries it
   * (lib/cleanup.ts) — dropping the row first would leak the object forever.
   */
  private async sweepExpired(now = Date.now()): Promise<string[]> {
    const expired = this.sql<{ id: string; media_key: string | null }>`
      SELECT id, media_key FROM messages WHERE expires_at <= ${now}
    `
    if (expired.length === 0) return []

    this.sql`DELETE FROM messages WHERE expires_at <= ${now}`
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
   * Arms one alarm for the moment the next message is due. One schedule at a
   * time — its id is kept in `settings` because the SDK has no "find my
   * schedule by callback", and a stale one left behind would fire a second
   * sweep for nothing.
   *
   * Returns early when the alarm already points at exactly this moment, and
   * that guard is why it can now be called on every read. Under the old
   * whole-conversation window this ran on a handful of events; under a
   * per-message clock every read is a candidate to move the deadline, and a
   * cancel-plus-create per read receipt would be a schedule rewrite per glance.
   * `expiry_schedule_at` is what makes "already correct" answerable without
   * asking the SDK.
   *
   * Nothing left to expire means nothing scheduled: an empty conversation must
   * cost zero wake-ups.
   */
  private async armExpiryAlarm(): Promise<void> {
    const dueAt = this.nextExpiryAt()
    // D1 mirror of the same moment (migration 0009). It is what lets the cron
    // backstop find a conversation with *an* expired message instead of only
    // the ones whose whole history has aged out (lib/cleanup.ts). Attempted
    // whenever it is not known to have landed — the row is created lazily by
    // the first message, so the first tries can legitimately write nothing.
    if (this.setting('next_expiry_mirrored') !== String(dueAt)) {
      this.ctx.waitUntil(this.mirrorNextExpiry(dueAt))
    }

    const previous = this.setting('expiry_schedule_id')
    if (previous !== null && numberOrNull(this.setting('expiry_schedule_at')) === dueAt) {
      return
    }
    if (previous) {
      try {
        await this.cancelSchedule(previous)
      } catch (error) {
        console.error('cancelSchedule failed', this.name, error)
      }
      this.sql`DELETE FROM settings WHERE key IN ('expiry_schedule_id', 'expiry_schedule_at')`
    }
    if (dueAt === null) return

    // A second of floor: a due-in-the-past message (the sweep above could not
    // reach it only if the clock moved mid-run) must not schedule into the past.
    const when = new Date(Math.max(dueAt, Date.now() + 1000))
    try {
      const schedule = await this.schedule(when, 'expireTick')
      this.writeSetting('expiry_schedule_id', schedule.id)
      this.writeSetting('expiry_schedule_at', String(dueAt))
    } catch (error) {
      // The wake-time sweep and the cleanup backstop still catch this
      // conversation; only the precision of the deletion is lost.
      console.error('expiry schedule failed', this.name, error)
    }
  }

  /** When the next message expires; null when there is none. */
  private nextExpiryAt(): number | null {
    const next = this.sql<{ at: number | null }>`SELECT MIN(expires_at) AS at FROM messages`
    return next.length > 0 ? next[0].at : null
  }

  /**
   * Copies that moment into D1 (migration 0009). Null means "nothing left to
   * expire", which is what stops the backstop from waking an empty conversation
   * forever.
   *
   * The conversation row is created lazily by the first message and the alarm
   * is armed in the same breath, so the first write can legitimately update
   * nothing. The flag records what actually landed, which is what makes the
   * retry in `armExpiryAlarm` stop at the right time.
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
      SELECT rowid, id, client_id, sender_id, type, body, media_key, created_at, status, read_at, expires_at, enc
      FROM messages WHERE rowid >= ${startRowid} ORDER BY rowid ASC
    `
    this.send(conn, { type: 'history', messages: rows.map(toWire) })

    // The same rule `onMessage` applies below, read from the same expression,
    // so what the thread promises and what this object does cannot drift.
    this.send(conn, { type: 'policy', e2ee_required: this.e2eeRequired() })
  }

  /** Whether this instance refuses a message that arrives without an envelope. */
  private e2eeRequired(): boolean {
    return String(this.env.E2EE_REQUIRED) === 'true'
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
        await this.handleReadReceipt(userId, event.data.ids)
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
    // An envelope has to name the sender's own account among its recipients,
    // or the person could not read what they just sent — and it is the one
    // structural claim about `enc` this object can check without holding a
    // key.
    //
    // A v1/v2 envelope is checked the way it was written, against the sending
    // device. Nothing produces one anymore; the branch exists for as long as
    // the schema accepts them, and goes with them.
    if (event.enc) {
      const addressed = isAccountEnvelope(event.enc)
        ? userId in event.enc.keys
        : event.enc.sender_device in event.enc.keys
      if (!addressed) {
        this.send(conn, { type: 'error', error: 'invalid_envelope' })
        return
      }
    }
    // What used to sit here was a directory check: a *device* that registered
    // while this sender's tab was open would not be in the cached list the
    // browser sealed against, so the message had to be refused and sealed
    // again. With the account as the unit there is no such race — a person's
    // key does not change because they opened a new browser — and the check
    // that remains would be vacuous: a client that could not find the peer's
    // key does not send a half-addressed envelope, it sends plaintext, which
    // the rule below is what answers.
    //
    // The end of the transition: once every client encrypts, a plaintext
    // message is a client that should not be trusted rather than an old one.
    // Off by default — see the note in wrangler.jsonc for why turning it on is
    // a decision about the fleet and not about the code.
    if (!event.enc && this.e2eeRequired()) {
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

    // Unread from the moment it lands, so it starts on the seven-day ceiling.
    // Being delivered is not being read: a peer with a socket open in another
    // tab has been handed the bytes, not shown them to anybody.
    const expiresAt = now + UNREAD_TTL_MS

    const enc = event.enc ? JSON.stringify(event.enc) : null
    this.sql`
      INSERT INTO messages (id, client_id, sender_id, type, body, media_key, created_at, status,
                            read_at, expires_at, enc)
      VALUES (${id}, ${event.client_id}, ${userId}, ${event.msg_type}, ${event.body},
              ${event.media_key ?? null}, ${now}, ${status}, NULL, ${expiresAt}, ${enc})
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
      read_at: null,
      expires_at: expiresAt,
      enc: event.enc ?? null,
    }
    for (const c of this.getConnections<ConnState>()) this.send(c, frame)

    // Arms the clock on the first message of a conversation, and does nothing
    // on every message after it: this one is the furthest from due, so the
    // earliest deadline has not moved and `armExpiryAlarm` returns early.
    this.ctx.waitUntil(this.armExpiryAlarm())

    // Lazy conversation row + last_message_at bump in D1 (phase-3 helper).
    // After the broadcast: D1 latency must not sit in the delivery path.
    try {
      await ensureConversation(this.env.DB, userId, peerId, now)
      // The deadline the cleanup backstop scans by: the alarm above was armed
      // before this row existed, so its mirror wrote nothing. Retried here, and
      // the flag is what stops it from being a D1 write per message.
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

  /**
   * The reader reports what it actually showed somebody, and each named message
   * has its deadline pulled in to three hours from now (PRD §3.9).
   *
   * The one frame in this protocol that destroys data, so it is the one that
   * refuses the most. Only messages addressed to the reader count — a sender
   * that could report its own message read could delete it out of the other
   * side's thread. Only messages not already read count, so a second report of
   * the same id cannot restart a clock that is already running. And the new
   * deadline is a `min`, never an assignment: a message with two hours left
   * does not get three back because a second device rendered it.
   *
   * Unknown ids are ignored rather than refused. By the time a receipt arrives
   * the message it names may have expired, and that is an ordinary race, not a
   * client bug worth an error frame.
   */
  private async handleReadReceipt(userId: string, ids: string[]): Promise<void> {
    const now = Date.now()
    const wanted = new Set(ids)
    // One scan, filtered in memory: `IN (...)` needs a dynamic placeholder list
    // and this table holds at most a few days of one conversation.
    const targets = this.sql<{ id: string; expires_at: number }>`
      SELECT id, expires_at FROM messages
      WHERE sender_id != ${userId} AND read_at IS NULL
    `.filter((row) => wanted.has(row.id))
    if (targets.length === 0) return

    const reads = targets.map((row) => ({
      id: row.id,
      read_at: now,
      expires_at: Math.min(row.expires_at, now + READ_TTL_MS),
    }))
    for (const read of reads) {
      this.sql`
        UPDATE messages SET status = 'read', read_at = ${now}, expires_at = ${read.expires_at}
        WHERE id = ${read.id}
      `
    }

    // Everyone, the reader's own other tabs included: the row is shared, so the
    // countdown is shared, and a second browser of the reader's did not witness
    // the read that started it.
    //
    // One frame for the whole batch, and no `message_status` behind it. The tick
    // and the countdown are the same event — a receipt already says which
    // messages were read — and sending both would be a second frame per message
    // saying what this one already said, fifty of them for one scrollback.
    for (const conn of this.getConnections<ConnState>()) {
      this.send(conn, { type: 'read_receipt', user_id: userId, reads })
    }

    // A read can make a message due inside the same second — three hours is the
    // grant, not the floor, and a message with minutes left keeps them. Sweep
    // before arming so the alarm is set from what survived.
    await this.sweepExpired(now)
    await this.armExpiryAlarm()
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
    read_at: row.read_at,
    expires_at: row.expires_at,
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
