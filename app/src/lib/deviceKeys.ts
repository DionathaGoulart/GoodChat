// The per-browser key this build no longer creates.
//
// Identity used to live here: one ECDH P-256 pair per browser, private half
// never leaving it. Migration 0014 moved it to the account (lib/accountKeys.ts)
// — one key, wrapped under the password, readable from anywhere — and this
// module is what is left over: the ability to *read* the key a browser already
// has, so messages sealed before the change still open in the browser that
// received them.
//
// Nothing calls `createDeviceKey` anymore because there is nothing to create;
// nothing registers a key with the worker because the directory only drains.
// Retention caps a message at seven days, so seven days after the account key
// ships there is no v1/v2 envelope left, and this file goes with
// lib/legacyEnvelope.ts, its IndexedDB database, and the `devices` table.

const DB_NAME = 'goodchat-keys'
const DB_VERSION = 1
const STORE = 'identity'

/** One record per account, from back when this was the encryption identity. */
export interface DeviceIdentity {
  /** SHA-256 of the raw public key, truncated to 32 hex — see migration 0012. */
  id: string
  /** Raw P-256 public key, base64url. What the directory publishes. */
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

/** The stored identity for one account, or null when this device has none. */
export async function readDeviceKey(userId: string): Promise<DeviceIdentity | null> {
  try {
    const stored = await withStore<DeviceIdentity | undefined>('readonly', (store) =>
      store.get(userId),
    )
    // Shape check, not validation: a record from an older build can be missing
    // a field, and a half-read identity would fail later in a place with much
    // less context than this one.
    if (!stored || typeof stored.id !== 'string' || !(stored.privateKey instanceof CryptoKey)) {
      return null
    }
    return stored
  } catch {
    // Private mode, or a browser that refuses IndexedDB entirely. The caller
    // falls back to sending unencrypted, which the transition already allows.
    return null
  }
}

/**
 * Logout. The next account on this browser must not hold the previous one's
 * key, and there is nothing to preserve: the account key is what this browser
 * signs back in with, and it comes from the server.
 */
export async function wipeDeviceKeys(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.clear())
  } catch {
    // Nothing to do — a key that cannot be reached cannot be used either.
  }
}
