// The old per-browser directory, read-only.
//
// Replaced by lib/keyDirectory.ts, which answers with one key per account
// instead of a list per account. What is left here is what opening a v1/v2
// message needs (lib/legacyEnvelope.ts): the public key of the *device* that
// sealed it. Nothing registers a device anymore, so this only ever shrinks,
// and seven days of retention after the account key shipped it is dead along
// with the module it serves.

import { userDevices, type PublicDevice } from './api'

// Still cached, though nothing is racing it anymore: the list cannot grow, so
// a stale copy is only ever missing rows that were swept for going quiet.

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

/** Finds one device's public key across every directory currently cached. */
export function findCachedDevice(deviceId: string): PublicDevice | null {
  for (const entry of directory.values()) {
    const match = entry.devices.find((device) => device.id === deviceId)
    if (match) return match
  }
  return null
}

