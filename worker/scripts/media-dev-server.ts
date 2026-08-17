// Local stand-in for Backblaze B2 during development (no B2 account needed):
// an S3-shaped HTTP server that accepts `PUT /<bucket>/<key>` and serves the
// bytes back on `GET /<bucket>/<key>` with the stored Content-Type and open
// CORS. Signatures are NOT verified — dev only. Point the worker at it via
// worker/.dev.vars and the app via VITE_MEDIA_URL (see the .env.example files).
//
//   npm run media:dev            (defaults to port 9000)
//
// Files land in worker/.media-dev/ (gitignored), so uploads survive restarts.
// Also imported by smoke-phase6.ts, which starts it in-process.

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.media-dev')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Every stored object under `dir`, as bucket-relative keys (skips *.meta.json). */
async function walkKeys(dir: string, base: string): Promise<string[]> {
  const keys: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return keys
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      keys.push(...(await walkKeys(full, base)))
    } else if (!entry.name.endsWith('.meta.json')) {
      keys.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return keys
}

/** `/bucket/a/b.jpg` → safe relative path, or null for traversal attempts. */
function safePath(root: string, urlPath: string): string | null {
  const clean = decodeURIComponent(urlPath).replace(/^\/+/, '')
  if (clean.length === 0) return null
  const resolved = path.resolve(root, clean)
  if (!resolved.startsWith(root + path.sep)) return null
  return resolved
}

export function startMediaDevServer(
  port: number,
  rootDir: string = DEFAULT_ROOT,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const urlPath = url.pathname
    const target = safePath(rootDir, urlPath)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    // ListObjectsV2 on the bucket root (`GET /<bucket>?list-type=2&prefix=…`):
    // the owner panel and the cleanup sweep read the bucket through it.
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const bucketDir = safePath(rootDir, urlPath)
      const prefix = url.searchParams.get('prefix') ?? ''
      const keys = bucketDir ? (await walkKeys(bucketDir, bucketDir)).sort() : []
      const matching = keys.filter((key) => key.startsWith(prefix))
      const contents = await Promise.all(
        matching.map(async (key) => {
          const info = await stat(path.join(bucketDir as string, key))
          return (
            `<Contents><Key>${xmlEscape(key)}</Key>` +
            `<Size>${info.size}</Size>` +
            `<LastModified>${new Date(info.mtimeMs).toISOString()}</LastModified></Contents>`
          )
        }),
      )
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
        `<IsTruncated>false</IsTruncated><KeyCount>${contents.length}</KeyCount>` +
        `${contents.join('')}</ListBucketResult>`
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/xml' })
      res.end(body)
      return
    }

    if (!target) {
      res.writeHead(400, CORS_HEADERS)
      res.end('bad key')
      return
    }

    if (req.method === 'DELETE') {
      // S3 semantics: deleting a missing key succeeds.
      await rm(target, { force: true })
      await rm(`${target}.meta.json`, { force: true })
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.concat(chunks))
      await writeFile(
        `${target}.meta.json`,
        JSON.stringify({ contentType: req.headers['content-type'] ?? 'application/octet-stream' }),
      )
      res.writeHead(200, CORS_HEADERS)
      res.end()
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        const meta = JSON.parse(await readFile(`${target}.meta.json`, 'utf8')) as {
          contentType: string
        }
        const full = await readFile(target)
        // Range support mirrors B2: the Worker proxies video seeks through.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
        const start = range?.[1] ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), full.byteLength - 1) : full.byteLength - 1
        const partial = range !== null && start <= end && start < full.byteLength
        const body = partial ? full.subarray(start, end + 1) : full
        res.writeHead(partial ? 206 : 200, {
          ...CORS_HEADERS,
          'Content-Type': meta.contentType,
          'Content-Length': body.byteLength,
          'Accept-Ranges': 'bytes',
          ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${full.byteLength}` } : {}),
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch {
        res.writeHead(404, CORS_HEADERS)
        res.end('not found')
      }
      return
    }

    res.writeHead(405, CORS_HEADERS)
    res.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.MEDIA_DEV_PORT ?? 9000)
  await startMediaDevServer(port)
  console.log(`media dev server (fake B2) on http://localhost:${port} → ${DEFAULT_ROOT}`)
}
