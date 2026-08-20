// The device key directory, cached.
//
// Split out of lib/e2ee.ts rather than living beside it, because the two have
// opposite dependencies: this half is nothing but network, and that half is
// nothing but crypto. Keeping the crypto free of any value import from ./api is
// what lets it be executed and cross-checked outside a browser
// (worker/scripts/smoke-phase16.ts) — a bundler-free module is a testable one.

import { userDevices, type PublicDevice } from './api'

// Cached because a thread encrypts on every keystroke-to-send and the answer
// changes only when somebody installs the app somewhere new. Short TTL, and
// `refreshDevices` forces it on connect, which is when a peer's new device
// would matter.

const DIRECTORY_TTL_MS = 5 * 60 * 1000

interface CachedDirectory {
  devices: PublicDevice[]
  fetchedAt: number
}

const directory = new Map<string, CachedDirectory>()

export async function getDevices(userId: string, force = false): Promise<PublicDevice[]> {
  const cached = directory.get(userId)
  if (!force && cached && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS) return cached.devices
  try {
    const { devices } = await userDevices(userId)
    directory.set(userId, { devices, fetchedAt: Date.now() })
    return devices
  } catch {
    // Offline, or the peer vanished. A stale list still encrypts correctly for
    // the devices it names; an empty one means this message goes plaintext,
    // which the transition allows.
    return cached?.devices ?? []
  }
}

export function refreshDevices(userId: string): Promise<PublicDevice[]> {
  return getDevices(userId, true)
}

/**
 * Seeds the cache from a payload that already carried the keys — the
 * conversation list does, so opening a thread from it needs no round trip and
 * the tiles can decrypt their own previews.
 */
export function cacheDevices(userId: string, devices: readonly PublicDevice[]): void {
  if (devices.length === 0) return
  directory.set(userId, { devices: [...devices], fetchedAt: Date.now() })
}

/** Logout, or a peer whose keys should not be remembered any longer. */
export function forgetDirectory(): void {
  directory.clear()
}

/** Finds one device's public key across every directory currently cached. */
export function findCachedDevice(deviceId: string): PublicDevice | null {
  for (const entry of directory.values()) {
    const match = entry.devices.find((device) => device.id === deviceId)
    if (match) return match
  }
  return null
}

