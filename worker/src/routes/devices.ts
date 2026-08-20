// The device key directory (migration 0012) — the one server-side piece of
// end-to-end encryption.
//
// The server's entire job here is to hand out public keys. It never sees a
// private key, never sees a content key, and never sees a plaintext message.
// What it can still do is lie: it serves the directory, so it could add a
// device of its own to somebody's list and receive a copy of everything sent
// to them. That is not closed by anything on this side — it is closed by the
// safety number the two clients compare (app/src/lib/e2ee.ts), which is
// derived from exactly the list this route returns. Which is why the list is
// returned whole and sorted, rather than filtered or paginated: the clients
// have to be able to agree on it byte for byte.
//
// Reads are scoped the same way presence is (lib/presence.ts): you may look up
// the devices of somebody you already have a conversation with. Starting a new
// thread needs the peer's keys before any message exists, so a caller may also
// read the directory of an account it could legitimately open a thread with —
// which is any live, non-tombstoned account, exactly what
// /api/conversations/resolve already answers for.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { requireSession, sessionHeaders } from '../lib/session'

/** SHA-256 of the raw public key, truncated — see migration 0012. */
const DEVICE_ID_RE = /^[0-9a-f]{32}$/

/**
 * Raw P-256 public key, base64url. 65 bytes uncompressed encodes to 88
 * characters; the bound is generous rather than exact so a future curve does
 * not need a migration to be rejected here for the wrong reason.
 */
const PUBLIC_KEY_MAX = 256

const RegisterSchema = z.object({
  id: z.string().regex(DEVICE_ID_RE, 'device id must be 32 hex chars'),
  public_key: z.string().min(1).max(PUBLIC_KEY_MAX),
})

export interface DeviceRow {
  id: string
  public_key: string
  created_at: number
  last_seen_at: number
}

/**
 * POST /api/devices — register this browser's key, or say it is still here.
 *
 * Idempotent, and the id is what makes it safe: because the id is a digest of
 * the key, a conflicting id means the same key, so the upsert can only ever
 * refresh `last_seen_at`. A different key is a different row. The server does
 * not verify that the id matches the key — it does not have to, since a client
 * that lies only breaks its own ability to be found by the digest its peers
 * compute for the safety number.
 */
export async function registerDevice(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, parsed.error.issues[0]?.message ?? 'invalid body')
  }

  const now = Date.now()
  // The WHERE guard is the whole security of this statement: without it,
  // presenting an id that already belongs to somebody else would move their
  // device row onto this account. It can only fire if two accounts hold the
  // same keypair, which means one of them copied it — pathological, but the
  // guard costs nothing and RETURNING is what keeps the answer honest instead
  // of reporting success for a write that did not happen.
  const row = await env.DB.prepare(
    `INSERT INTO devices (id, user_id, public_key, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET last_seen_at = ?4
     WHERE devices.user_id = ?2
     RETURNING id`,
  )
    .bind(parsed.data.id, auth.user.id, parsed.data.public_key, now)
    .first<{ id: string }>()
  if (!row) return apiError('device_taken', 409, 'this device id belongs to another account')

  return json({ ok: true, id: row.id }, 200, sessionHeaders(auth))
}

/**
 * GET /api/users/:id/devices — the public keys a message to this account has
 * to be encrypted for.
 *
 * Sorted by id so both sides of a conversation hash the same list into the
 * same safety number without having to agree on an order first.
 */
export async function listDevices(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  // Your own devices are always readable: the sender wraps the content key for
  // its own other devices too, or the desktop could not read what the phone
  // sent.
  if (userId !== auth.user.id) {
    const target = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND disabled_at IS NULL AND deleted_at IS NULL',
    )
      .bind(userId)
      .first<{ id: string }>()
    // 404 rather than 403, matching resolve: whether an id exists is itself
    // information, and this route must not become a better oracle than the
    // endpoints that already refuse to be one.
    if (!target) return apiError('not_found', 404, 'user not found')
  }

  const { results } = await env.DB.prepare(
    `SELECT id, public_key, created_at, last_seen_at
     FROM devices WHERE user_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<DeviceRow>()

  return json({ devices: results }, 200, sessionHeaders(auth))
}
