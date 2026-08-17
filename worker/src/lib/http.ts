// Shared HTTP helpers: CORS + JSON responses with a uniform error shape.
//
// CORS policy: open to all origins, but cookie auth requires
// Access-Control-Allow-Credentials, which the spec forbids together with a
// literal "*" — so we reflect the request Origin instead (still any origin).

export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
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
