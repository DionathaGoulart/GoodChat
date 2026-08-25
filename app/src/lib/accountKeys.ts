// The account's encryption identity: one ECDH P-256 keypair, the same one in
// every browser the person signs into.
//
// This replaces the per-device key (lib/deviceKeys.ts), and the difference is
// where the private half comes from. A device key was generated here and could
// only ever be here, which is why a new browser started blind. An account key
// is generated once, encrypted under a key derived from the password
// (`wrapKey` — lib/kdf.ts), and stored on the server in that form. Signing in
// anywhere unwraps it. The server cannot: it stopped seeing the password in
// migration 0013, and `wrapKey` has no other source.
//
// What lands in IndexedDB is the same shape the device key used, and for the
// same reason. localStorage stores strings, so a private key would have to be
// exported to bytes to be saved — and anything exportable is readable by any
// script on this origin. IndexedDB stores structured clones, and a `CryptoKey`
// is one, so the unwrapped key can be written and read back while staying
// `extractable: false`: a handle the browser will run ECDH with and refuse to
// serialize. It is used, never copied.
//
// That last property is the premise the whole design rests on, and it was
// measured rather than assumed — Chrome 151/macOS, read back from IndexedDB:
// `exportKey` rejects in all three formats, and `deriveBits` with the *stored*
// key produces a secret that matches the one derived against the published
// public half. See the plan.
//
// P-256 rather than X25519 because `deriveBits` over P-256 is in every
// WebCrypto the app targets, and this file's format is also read by the
// service worker (public/sw.js decrypts push previews), which has no bundler.
//
// There is no recovery and there is no escrow, by construction. Lose the
// password and the wrapped blob on the server is a ciphertext with no key —
// the history goes with it. That is the cost of the server not being able to
// read anything, and it is stated in the rotation screen before anyone commits
// to it.

import { base64url, fromBase64url } from './kdf'

const DB_NAME = 'goodchat-account'
const DB_VERSION = 1
const STORE = 'identity'

/** What travels between the client and `users` (migration 0014). */
export interface WrappedAccountKey {
  /** Raw P-256 public key, base64url. The half the directory publishes. */
  public_key: string
  /**
   * PKCS#8 of the private half, AES-GCM under `wrapKey`, base64url. Null for a
   * guest, whose key was never wrapped because there is no password behind it.
   */
  wrapped: string | null
  iv: string | null
}

/**
 * One record per account, keyed by user id — so signing in as somebody else on
 * this machine cannot reach the previous account's key, and logout is a delete
 * of one row rather than a guess.
 */
export interface AccountIdentity {
  /**
   * The account this key belongs to — the same value the record is stored
   * under. Duplicated inside the record because the service worker reads the
   * store with `getAll()`, which hands back values without their keys, and
   * because every caller that has the identity needs the id in the same
   * breath: it is what the envelope's key map is keyed by.
   */
  accountId: string
  /**
   * SHA-256 of the raw public key, truncated to 32 hex.
   *
   * A digest rather than a random value, which is what makes it a commitment:
   * one id can only ever mean one key, so a key that was swapped shows up as a
   * different id instead of the same id with new bytes. The safety number and
   * the key-changed banner both rely on that.
   */
  id: string
  publicKey: string
  /** Non-extractable. Usable for deriveBits, impossible to serialize out. */
  privateKey: CryptoKey
  createdAt: number
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb unavailable'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexeddb write failed'))
    })
  } finally {
    db.close()
  }
}

export async function accountIdFor(publicKeyRaw: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicKeyRaw)
  let hex = ''
  for (const byte of new Uint8Array(digest).slice(0, 16)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** The stored identity for one account, or null when this browser holds none. */
export async function readAccountKey(userId: string): Promise<AccountIdentity | null> {
  try {
    const stored = await withStore<AccountIdentity | undefined>('readonly', (store) =>
      store.get(userId),
    )
    // Shape check, not validation: a record from an older build can be missing
    // a field, and a half-read identity would fail later somewhere with much
    // less context than this.
    if (
      !stored ||
      typeof stored.id !== 'string' ||
      typeof stored.accountId !== 'string' ||
      !(stored.privateKey instanceof CryptoKey)
    ) {
      return null
    }
    return stored
  } catch {
    // Private mode, or a browser that refuses IndexedDB. The caller degrades to
    // sending unencrypted, which the transition still allows.
    return null
  }
}

async function store(userId: string, identity: AccountIdentity): Promise<void> {
  await withStore('readwrite', (s) => s.put(identity, userId))
}

/**
 * Generates the account's keypair and returns both what to keep and what to
 * publish.
 *
 * The pair is generated extractable, which looks wrong for two lines and is
 * exactly what wrapping requires: the private half has to be exported to
 * PKCS#8 before it can be encrypted. It is then imported back with
 * `extractable: false` — so the handle that survives this function, and the
 * one that reaches IndexedDB, is not the one that could be exported. The
 * exportable original is dropped with the stack frame.
 *
 * `wrapKey` null is the guest case: no password means nothing to wrap under,
 * so the private half stays in this browser and only the public half is
 * published. That is not a weaker guest, it is a guest with exactly one
 * device, which is what a guest is.
 */
export async function createAccountKey(
  userId: string,
  wrapKey: CryptoKey | null,
): Promise<{ identity: AccountIdentity; published: WrappedAccountKey } | null> {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey)

    let wrapped: string | null = null
    let iv: string | null = null
    if (wrapKey) {
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        wrapKey,
        pkcs8,
      )
      wrapped = base64url(ciphertext)
      iv = base64url(nonce)
    }

    const identity: AccountIdentity = {
      accountId: userId,
      id: await accountIdFor(raw),
      publicKey: base64url(raw),
      privateKey: await importPrivate(pkcs8),
      createdAt: Date.now(),
    }
    await store(userId, identity)
    return { identity, published: { public_key: base64url(raw), wrapped, iv } }
  } catch {
    return null
  }
}

/**
 * Opens the wrapped key the server handed back at sign-in and puts it in this
 * browser.
 *
 * Returns null when it does not open, which has exactly one ordinary cause: a
 * password that was reset by the owner, so the blob was sealed under a
 * `wrapKey` nobody derives anymore. The caller mints a fresh pair, and the
 * history sealed to the old one is gone — see the reset path.
 */
export async function adoptAccountKey(
  userId: string,
  wrapKey: CryptoKey,
  published: WrappedAccountKey,
): Promise<AccountIdentity | null> {
  if (!published.wrapped || !published.iv) return null
  try {
    const pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(published.iv) as BufferSource },
      wrapKey,
      fromBase64url(published.wrapped) as BufferSource,
    )
    const identity: AccountIdentity = {
      accountId: userId,
      id: await accountIdFor(fromBase64url(published.public_key).buffer as ArrayBuffer),
      publicKey: published.public_key,
      privateKey: await importPrivate(pkcs8),
      createdAt: Date.now(),
    }
    await store(userId, identity)
    return identity
  } catch {
    return null
  }
}

/**
 * Re-seals the key this browser holds under a different `wrapKey`, for a
 * password that is about to change.
 *
 * It cannot go through `createAccountKey`: the private half in IndexedDB is
 * non-extractable, on purpose, so there is nothing to export and re-encrypt.
 * The caller has to hand over the PKCS#8 it held from the moment the key was
 * created or unwrapped — which is why both of those return through a path that
 * keeps it, and why this takes bytes rather than a `CryptoKey`.
 */
export async function wrapAccountKey(
  pkcs8: ArrayBuffer,
  publicKey: string,
  wrapKey: CryptoKey,
): Promise<WrappedAccountKey> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    wrapKey,
    pkcs8,
  )
  return { public_key: publicKey, wrapped: base64url(ciphertext), iv: base64url(nonce) }
}

/**
 * The PKCS#8 behind the stored key, for a rewrap — obtained by unwrapping the
 * server's copy again rather than by exporting the stored handle, which is
 * impossible by design.
 */
export async function unwrapPkcs8(
  wrapKey: CryptoKey,
  published: WrappedAccountKey,
): Promise<ArrayBuffer | null> {
  if (!published.wrapped || !published.iv) return null
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(published.iv) as BufferSource },
      wrapKey,
      fromBase64url(published.wrapped) as BufferSource,
    )
  } catch {
    return null
  }
}

function importPrivate(pkcs8: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])
}

/**
 * Logout. The next account on this browser must not hold the previous one's
 * key, and nothing is lost by dropping it: the wrapped copy is on the server
 * and the next sign-in unwraps it again. That is the whole difference from the
 * device key this replaced, which could only ever be here.
 */
export async function wipeAccountKeys(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.clear())
  } catch {
    // A key that cannot be reached cannot be used either.
  }
}
