// How the message window (PRD §3.9) is written out for a person.
//
// The values themselves live in lib/protocol.ts, shared with the worker; this
// module is only the wording, in the two lengths the UI needs: a compact one
// for the thread header, where it sits next to the peer's presence, and a full
// one for the dialog, where it is the thing being chosen.

import { RETENTION_OPTIONS_MS, type RetentionMs } from './protocol'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** `7d`, `12h` — the header badge. */
export function retentionShort(ms: RetentionMs): string {
  return ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${ms / HOUR_MS}h`
}

/** `7 dias`, `12 horas` — the dialog. */
export function retentionLabel(ms: RetentionMs): string {
  if (ms % DAY_MS === 0) {
    const days = ms / DAY_MS
    return days === 1 ? '1 dia' : `${days} dias`
  }
  const hours = ms / HOUR_MS
  return hours === 1 ? '1 hora' : `${hours} horas`
}

/** The catalog, longest first — the default (and maximum) reads as the top. */
export const RETENTION_CHOICES: readonly RetentionMs[] = [...RETENTION_OPTIONS_MS].reverse()
