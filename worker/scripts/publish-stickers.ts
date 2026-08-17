// Publishes the curated sticker pack (worker/assets/stickers/v1) to the media
// store: validates the manifest, then PUTs every asset + the manifest itself.
// Runs on plain Node ≥24 (type stripping), no build step.
//
//   npm run stickers:publish            → PUT to the fake-B2 dev server (9000)
//   MEDIA_PUT_BASE=<url> npm run ...    → any store that accepts plain PUT
//
// Real B2 note: the production bucket only accepts SigV4-signed PUTs — publish
// there with the b2 CLI (`b2 sync assets/stickers b2://<bucket>/stickers`) or
// extend this script with aws4fetch once the bucket exists (see .env.example).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { STICKER_ID_RE } from '../src/protocol.ts'

const PACK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'stickers',
  'v1',
)
const DEFAULT_PUT_BASE = 'http://localhost:9000/goodchat-media'

const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
}

interface StickerManifest {
  version: number
  base: string
  stickers: { id: string; file: string; label: string }[]
}

export async function loadManifest(): Promise<StickerManifest> {
  const manifest = JSON.parse(
    await readFile(path.join(PACK_DIR, 'manifest.json'), 'utf8'),
  ) as StickerManifest
  const files = new Set(await readdir(PACK_DIR))
  const seen = new Set<string>()
  for (const sticker of manifest.stickers) {
    if (!STICKER_ID_RE.test(sticker.id)) throw new Error(`invalid sticker id "${sticker.id}"`)
    if (seen.has(sticker.id)) throw new Error(`duplicate sticker id "${sticker.id}"`)
    seen.add(sticker.id)
    if (!files.has(sticker.file)) throw new Error(`missing asset file "${sticker.file}"`)
    if (!(path.extname(sticker.file) in CONTENT_TYPES)) {
      throw new Error(`unsupported asset extension "${sticker.file}"`)
    }
  }
  return manifest
}

/** PUT every pack asset + manifest under `<putBase>/<manifest.base>/`. */
export async function publishStickers(putBase: string = DEFAULT_PUT_BASE): Promise<string[]> {
  const manifest = await loadManifest()
  const uploads = [...manifest.stickers.map((s) => s.file), 'manifest.json']
  const published: string[] = []
  for (const file of uploads) {
    const key = `${manifest.base}/${file}`
    const body = await readFile(path.join(PACK_DIR, file))
    const response = await fetch(`${putBase}/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': CONTENT_TYPES[path.extname(file)] },
      body,
    })
    if (!response.ok) throw new Error(`PUT ${key} failed (${response.status})`)
    published.push(key)
  }
  return published
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const base = process.env.MEDIA_PUT_BASE ?? DEFAULT_PUT_BASE
  const keys = await publishStickers(base)
  console.log(`published ${keys.length} objects to ${base}:`)
  for (const key of keys) console.log(`  ${key}`)
}
