// The key directory — the one server-side piece of end-to-end encryption.
//
// The server's entire job here is to hand out a public key. It never sees a
// private key, never sees a content key, and never sees a plaintext message.
// What it can still do is lie: it serves the directory, so it could hand out a
// key of its own in somebody's place and receive a copy of everything sent to
// them. That is not closed by anything on this side — it is closed by the
// safety number the two clients compare (app/src/lib/e2ee.ts), which is
// derived from exactly the two keys this route returns.
//
// It used to return a *list*: identity was per browser (migration 0012), so a
// message had to be encrypted once per device and both sides had to agree on
// the list byte for byte to compute the same safety number. Migration 0014
// made the account the unit, and the list collapsed to one key — which is why
// registration is gone from this file. Nothing publishes a device key anymore;
// `PUT /api/account/key` and the password routes are the only writers, and
// they write to `users`.
//
// Reads are scoped the way presence is (lib/presence.ts): you may look up the
// key of somebody you already have a conversation with. Starting a new thread
// needs their key before any message exists, so a caller may also read the key
// of an account it could legitimately open a thread with — which is any live,
// non-tombstoned account, exactly what /api/conversations/resolve answers for.

import { apiError, json } from '../lib/http'
import { requireSession, sessionHeaders } from '../lib/session'

/**
 * GET /api/users/:id/key — the public key a message to this account has to be
 * encrypted for. Null when they have not published one, which is a live answer
 * and not an error: a client that gets null sends plaintext, and the instance
 * decides whether it will carry that.
 */
export async function readUserKey(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  // Your own key is always readable: the sender wraps the content key for its
  // own account too, or a person could not read what they sent.
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

  const row = await env.DB.prepare('SELECT account_public_key FROM users WHERE id = ?')
    .bind(userId)
    .first<{ account_public_key: string | null }>()

  return json({ public_key: row?.account_public_key ?? null }, 200, sessionHeaders(auth))
}

// --- the directory this replaced ------------------------------------------

/** A device's published key, from before the account key (migration 0012). */
export interface DeviceRow {
  id: string
  public_key: string
  created_at: number
  last_seen_at: number
}

/**
 * GET /api/users/:id/devices — the old per-browser directory, read-only.
 *
 * Nothing registers a device anymore, so this list only shrinks: it exists so
 * a browser that received messages before the account key can still find the
 * public key that opens them (app/src/lib/legacyEnvelope.ts). Retention caps a
 * message at seven days, so seven days after that shipped this route, the
 * `devices` table and the cleanup sweep that drains it all go together.
 */
export async function listDevices(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  const { results } = await env.DB.prepare(
    `SELECT id, public_key, created_at, last_seen_at
     FROM devices WHERE user_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<DeviceRow>()

  return json({ devices: results }, 200, sessionHeaders(auth))
}
