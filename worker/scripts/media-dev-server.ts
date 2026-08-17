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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.media-dev')

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
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
    const urlPath = (req.url ?? '/').split('?')[0]
    const target = safePath(rootDir, urlPath)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    if (!target) {
      res.writeHead(400, CORS_HEADERS)
      res.end('bad key')
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
