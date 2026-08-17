// Shared HTTP helpers: CORS, security headers, JSON responses with a uniform
// error shape.
//
// CORS policy: allowlist, not reflection. Cookie auth needs
// Access-Control-Allow-Credentials, and the spec forbids that together with a
// literal "*", so an origin is echoed only when it is this Worker's own origin
// or one of ALLOWED_ORIGINS (comma-separated, for the Vite dev server on 5173).
// Reflecting an arbitrary Origin alongside Allow-Credentials is not exploitable
// while the cookie is SameSite=Strict, but it arms a trap for the day that
// changes — the allowlist removes the trap.

export function corsHeaders(
  origin: string | null,
  selfOrigin: string,
  env: Env,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
  if (origin && isAllowedOrigin(origin, selfOrigin, env)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Access-Control-Allow-Credentials'] = 'true'
  }
  return headers
}

function isAllowedOrigin(origin: string, selfOrigin: string, env: Env): boolean {
  if (origin === selfOrigin) return true
  const configured = env.ALLOWED_ORIGINS?.split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter((value) => value.length > 0)
  return configured?.includes(origin) ?? false
}

// Content-Security-Policy for the SPA document and its assets. Nearly
// everything is same-origin (the Worker serves the build), so 'self' covers
// scripts, styles, fonts, the service worker and the WebSocket. Exceptions:
//   - style-src 'unsafe-inline': React writes inline style attributes and
//     daisyUI/emoji-picker set inline custom properties. CSP3 has no way to
//     allow attribute styles without this; script-src stays strict, which is
//     where the XSS risk actually lives.
//   - img-src/media-src blob: — object URLs for upload previews and the
//     in-browser video transcode.
//   - connect-src <B2 endpoint>: uploads go straight from the browser to a
//     presigned PUT, so the bytes never pass through the Worker (lib/media.ts).
//     Reads come back through /api/media/, so only the upload host is listed,
//     and it comes from the env var rather than a literal — a different bucket
//     region would otherwise silently break every upload.
// frame-ancestors 'none' is the clickjacking fix; there is no reason to embed
// a chat in someone else's page.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
]

/** Origin of the B2 S3 endpoint, or null when it is unset or unparseable. */
function uploadOrigin(env: Env | undefined): string | null {
  if (!env?.B2_S3_ENDPOINT) return null
  try {
    return new URL(env.B2_S3_ENDPOINT).origin
  } catch {
    return null
  }
}

/** Headers every response carries, document or API. */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

/**
 * Applies security headers in place. `document` adds the CSP (only meaningful
 * on HTML/asset responses; JSON APIs get the cheap subset). HSTS is emitted
 * over https only — sending it from a localhost dev server would pin the
 * browser to https for every other localhost port.
 */
export function applySecurityHeaders(
  headers: Headers,
  {
    document = false,
    https = false,
    env,
  }: { document?: boolean; https?: boolean; env?: Env } = {},
): void {
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) headers.set(name, value)
  if (https) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  if (document) {
    const upload = uploadOrigin(env)
    const directives = [
      ...CSP_DIRECTIVES,
      upload ? `connect-src 'self' ${upload}` : "connect-src 'self'",
      ...(https ? ['upgrade-insecure-requests'] : []),
    ]
    headers.set('Content-Security-Policy', directives.join('; '))
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers)
  h.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(data), { status, headers: h })
}

// Error shape for every API error: { error: <machine code>, message?: <human> }
export function apiError(
  code: string,
  status: number,
  message?: string,
  headers?: HeadersInit,
): Response {
  return json({ error: code, ...(message ? { message } : {}) }, status, headers)
}
