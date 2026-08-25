// The account key directory, cached.
//
// Split out of lib/e2ee.ts rather than living beside it, because the two have
// opposite dependencies: this half is nothing but network, and that half is
// nothing but crypto. Keeping the crypto free of any value import from ./api is
// what lets it be executed and cross-checked outside a browser
// (worker/scripts/smoke-phase16.ts) — a bundler-free module is a testable one.
//
// This replaces lib/deviceDirectory.ts, and it is smaller in a way worth
// noticing: it answers with one key instead of a list, so there is no order to
// agree on, no fingerprint over a set, and no "did they add a browser" question
// to distinguish from "did their key change". A person's key is a person's key.
//
// Still cached, and for the same reason as before: a thread encrypts on every
// send and the answer changes only when somebody's key really changes — which
// is a fresh account or an owner's password reset, not an ordinary Tuesday.
// `refreshKey` forces it on connect, which is when a rotation would matter.

import { userAccountKey } from './api'

const DIRECTORY_TTL_MS = 5 * 60 * 1000

interface CachedKey {
  /** Null is a real answer: an account that has not published a key yet. */
  publicKey: string | null
  fetchedAt: number
}

const directory = new Map<string, CachedKey>()

export async function getAccountKey(userId: string, force = false): Promise<string | null> {
  const cached = directory.get(userId)
  if (!force && cached && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS) return cached.publicKey
  try {
    const { public_key } = await userAccountKey(userId)
    directory.set(userId, { publicKey: public_key, fetchedAt: Date.now() })
    return public_key
  } catch {
    // Offline, or the peer vanished. A stale key still encrypts correctly for
    // as long as it is theirs; no key at all means this message goes plaintext,
    // which the instance may refuse — and refusing is the honest answer.
    return cached?.publicKey ?? null
  }
}

export function refreshKey(userId: string): Promise<string | null> {
  return getAccountKey(userId, true)
}

/**
 * Seeds the cache from a payload that already carried the key — the
 * conversation list does, so opening a thread from it needs no round trip and
 * the tiles can decrypt their own previews.
 */
export function cacheAccountKey(userId: string, publicKey: string | null | undefined): void {
  if (!publicKey) return
  directory.set(userId, { publicKey, fetchedAt: Date.now() })
}

/** Logout, or a peer whose key should not be remembered any longer. */
export function forgetDirectory(): void {
  directory.clear()
}
