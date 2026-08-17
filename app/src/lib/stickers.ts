// Curated sticker pack (PRD §3.5): versioned static assets in B2, described
// by a manifest JSON. The pack is pinned to v1 here; bumping the pack means
// publishing stickers/v2 and updating PACK_BASE.

import { useEffect, useState } from 'react'
import { mediaUrl } from './media'

const PACK_BASE = 'stickers/v1'

export interface Sticker {
  id: string
  file: string
  label: string
}

interface StickerManifest {
  version: number
  base: string
  stickers: Sticker[]
}

export interface StickerPack {
  stickers: Sticker[]
  byId: Map<string, Sticker>
}

let cached: Promise<StickerPack> | null = null

function fetchPack(): Promise<StickerPack> {
  if (!cached) {
    cached = fetch(mediaUrl(`${PACK_BASE}/manifest.json`))
      .then((response) => {
        if (!response.ok) throw new Error(`manifest fetch failed (${response.status})`)
        return response.json() as Promise<StickerManifest>
      })
      .then((manifest) => ({
        stickers: manifest.stickers,
        byId: new Map(manifest.stickers.map((s) => [s.id, s])),
      }))
    // A failed fetch must not poison the cache for the whole session.
    cached.catch(() => {
      cached = null
    })
  }
  return cached
}

export function stickerAssetUrl(sticker: Sticker): string {
  return mediaUrl(`${PACK_BASE}/${sticker.file}`)
}

/** Loads (and memoizes) the pack; `pack` stays null while loading/on error. */
export function useStickerPack(): { pack: StickerPack | null; error: boolean } {
  const [pack, setPack] = useState<StickerPack | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(false)
    fetchPack()
      .then((loaded) => {
        if (!cancelled) setPack(loaded)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { pack, error }
}
