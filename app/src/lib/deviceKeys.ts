// This device's encryption identity: one ECDH P-256 keypair, generated here,
// and the private half never leaves this browser.
//
// IndexedDB rather than localStorage, and that is the entire reason this module
// exists instead of being three lines in e2ee.ts. localStorage stores strings,
// which means a private key would have to be exported to bytes to be saved —
// and anything that can be exported can be read by any script that runs on this
// origin. IndexedDB stores structured clones, and a `CryptoKey` is one, so the
// key can be written and read back while staying `extractable: false`: it is a
// handle the browser will use for ECDH and refuse to serialize. That is the
// difference between "the key is on this device" and "the key is in a variable".
//
// P-256 rather than X25519 because `deriveBits` over P-256 is in every
// WebCrypto implementation the app already targets, and this file is also read
// by the service worker (sw.js decrypts push previews), which has the same
// requirement and no bundler.
//
// No backup, on purpose. There is no recovery phrase and nothing wrapped on the
// server, because retention caps a message's life at seven days: a device that
// loses this key loses at most a week, and a new device simply starts reading
// from the moment it registers. See docs/architecture.md.

const DB_NAME = 'goodchat-keys'
const DB_VERSION = 1
const STORE = 'identity'

/**
 * One record per account. The key is account-scoped rather than browser-scoped
 * so that signing in as somebody else on this machine cannot decrypt the
 * previous account's messages — and so `wipeDeviceKey` on logout is a delete of
 * one row rather than a guess.
 */
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

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The device id is a digest of the key rather than a random value, which is
 * what makes it a commitment: the same id can only ever mean the same key, so a
 * key that was swapped shows up as a *different device* instead of the same
 * device with new bytes. Both the change banner and the safety number rely on
 * that (lib/e2ee.ts).
 */
export async function deviceIdFor(publicKeyRaw: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicKeyRaw)
  let hex = ''
  for (const byte of new Uint8Array(digest).slice(0, 16)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
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
 * Creates this device's identity and stores it. Called once per account per
 * browser; `ensureDeviceKey` is the entry point that decides whether it runs.
 */
export async function createDeviceKey(userId: string): Promise<DeviceIdentity | null> {
  try {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
    const identity: DeviceIdentity = {
      id: await deviceIdFor(raw),
      publicKey: base64url(raw),
      privateKey: pair.privateKey,
      createdAt: Date.now(),
    }
    await withStore('readwrite', (store) => store.put(identity, userId))
    return identity
  } catch {
    return null
  }
}

/** The identity for this account, creating it on first use. */
export async function ensureDeviceKey(userId: string): Promise<DeviceIdentity | null> {
  return (await readDeviceKey(userId)) ?? (await createDeviceKey(userId))
}

/**
 * Logout. The next account on this device must not hold the previous one's key,
 * and there is nothing to preserve: history is at most seven days old and this
 * device will generate a fresh identity when it signs back in.
 */
export async function wipeDeviceKeys(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.clear())
  } catch {
    // Nothing to do — a key that cannot be reached cannot be used either.
  }
}

/** Imports a peer's published key for `deriveBits`. */
export function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromBase64url(publicKey) as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
}
