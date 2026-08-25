// The account key, from the server's side — which is: three opaque strings
// (migration 0014).
//
// It holds the public half so peers can encrypt to it, and the private half
// encrypted under a key derived from a password it has not seen since
// migration 0013. There is no code here that touches a plaintext key, and
// there is nowhere one could come from.
//
// One route, and it only ever writes a key where there is none. Publishing is
// not a way to *replace* a key: doing that would make a stolen session enough
// to cut somebody off from their own history — the old messages are sealed to
// the old public key and nothing can re-seal them. Replacement happens only on
// the password routes (routes/auth.ts), which prove the password first.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import { requireSession, sessionHeaders } from '../lib/session'

/**
 * Raw P-256 public key, base64url — 65 bytes encodes to 88 characters. The
 * bounds are generous rather than exact so a future curve is not rejected here
 * for the wrong reason; the client is the only side that has to parse these.
 */
export const AccountKeySchema = z.object({
  public_key: z.string().min(1).max(256),
  /**
   * PKCS#8 under AES-GCM, base64url — a P-256 private key is 138 bytes, plus
   * the tag, plus base64's third. Nullable for a guest: no password means
   * nothing to wrap under, so the private half stays in the one browser that
   * account will ever have and the server holds no copy at all.
   */
  wrapped: z.string().min(1).max(1024).nullable(),
  iv: z.string().min(1).max(64).nullable(),
})
export type AccountKeyInput = z.infer<typeof AccountKeySchema>

/** What a client is handed back after signing in, or null when it has none. */
export interface PublishedAccountKey {
  public_key: string
  wrapped: string | null
  iv: string | null
}

/**
 * Both halves or neither. A public key stored against somebody else's wrapped
 * private half is an account that encrypts into a void — and unlike most bad
 * writes, that one is not visible until a message fails to open days later.
 */
export function accountKeyShapeError(key: AccountKeyInput): string | null {
  if ((key.wrapped === null) !== (key.iv === null)) {
    return 'wrapped and iv must be given together'
  }
  return null
}

export function readAccountKey(row: {
  account_public_key: string | null
  account_key_wrapped: string | null
  account_key_iv: string | null
}): PublishedAccountKey | null {
  if (!row.account_public_key) return null
  return {
    public_key: row.account_public_key,
    wrapped: row.account_key_wrapped,
    iv: row.account_key_iv,
  }
}

/**
 * PUT /api/account/key — publish the key an account did not have.
 *
 * Create-only, enforced in the WHERE clause rather than by reading first: two
 * tabs of a fresh sign-in can race here, and the loser has to be told it lost
 * instead of quietly overwriting a key the winner has already started
 * receiving messages under.
 *
 * 409 rather than 200-with-no-op for the same reason. The client that loses
 * has generated a keypair it must now throw away, and it can only know that if
 * it is told — it re-reads the winner's key and unwraps that one.
 */
export async function publishAccountKey(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return apiError('invalid_request', 400, 'body must be JSON')
  }
  const parsed = AccountKeySchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, parsed.error.issues[0]?.message ?? 'invalid body')
  }
  const shape = accountKeyShapeError(parsed.data)
  if (shape) return apiError('invalid_request', 400, shape)

  // A guest is the one account allowed to publish a public key with no wrapped
  // private half — it has no password, so there is nothing to wrap under. For
  // anybody else that shape would mean a key nobody can ever open from another
  // browser, which is the entire thing this migration exists to end.
  if (parsed.data.wrapped === null && !auth.user.is_temp) {
    return apiError('invalid_request', 400, 'a permanent account must wrap its key')
  }

  const row = await env.DB.prepare(
    `UPDATE users
     SET account_public_key = ?1, account_key_wrapped = ?2, account_key_iv = ?3
     WHERE id = ?4 AND account_public_key IS NULL
     RETURNING id`,
  )
    .bind(parsed.data.public_key, parsed.data.wrapped, parsed.data.iv, auth.user.id)
    .first<{ id: string }>()
  if (!row) {
    return apiError('account_key_exists', 409, 'this account already published a key')
  }

  return json({ ok: true }, 200, sessionHeaders(auth))
}
