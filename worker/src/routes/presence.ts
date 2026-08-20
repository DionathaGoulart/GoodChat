// POST /api/presence — the heartbeat, and the only way to read presence.
//
// One call does both halves: it stamps the caller as alive and answers with the
// state of the accounts the caller is currently showing. That pairing is what
// keeps presence to a single request per client every HEARTBEAT_MS no matter how
// many screens are watching — the conversation list and an open thread share
// the same beat (app/src/lib/presence.ts).
//
// POST rather than GET because it writes, and the body is optional: a client
// with nothing on screen still beats to stay online.

import { z } from 'zod'
import { apiError, json } from '../lib/http'
import {
  HEARTBEAT_MS,
  MAX_PRESENCE_IDS,
  ONLINE_WINDOW_MS,
  presenceOf,
  touchPresence,
} from '../lib/presence'
import { requireSession, sessionHeaders } from '../lib/session'

const HeartbeatSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(MAX_PRESENCE_IDS).optional(),
})

export async function heartbeat(request: Request, env: Env): Promise<Response> {
  const auth = await requireSession(request, env.DB)
  if (auth instanceof Response) return auth

  // An empty body is a bare "I am here" — accepted, since a client with no
  // peers on screen still has to keep its own presence alive.
  let body: unknown = {}
  const raw = await request.text()
  if (raw.trim() !== '') {
    try {
      body = JSON.parse(raw)
    } catch {
      return apiError('invalid_request', 400, 'body must be JSON')
    }
  }
  const parsed = HeartbeatSchema.safeParse(body)
  if (!parsed.success) {
    return apiError('invalid_request', 400, `ids must be at most ${MAX_PRESENCE_IDS} user ids`)
  }

  const now = Date.now()
  await touchPresence(env.DB, auth.user.id, now)
  const users = await presenceOf(env.DB, auth.user.id, parsed.data.ids ?? [], now)

  // The client mirrors the two constants rather than hardcoding them, so the
  // window can be retuned server-side without shipping an app build.
  return json(
    { now, window_ms: ONLINE_WINDOW_MS, heartbeat_ms: HEARTBEAT_MS, users },
    200,
    sessionHeaders(auth),
  )
}
