// Phase 12 smoke test — presence and the skin preference, against a live dev
// server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase12                                  (terminal 2)
//
// Covers: POST /api/presence auth, the empty-body heartbeat, the id cap, the
// beat marking the caller online, the window turning a stale beat into offline,
// presence riding along on the endpoints that list people (lookup, the
// conversation list, resolve), and the skin half of PATCH /api/settings —
// stored, validated, and left alone when the field is absent.
//
// The stale-beat case is written straight into D1 rather than waited out: the
// window is a minute wide, and a smoke test that sleeps for it is a smoke test
// nobody runs.

import { d1Execute, sqlString } from './lib.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'

const ALICE = { username: 'alice', password: 'alice-goodchat' }
const BOB = { username: 'bob', password: 'bob-goodchat' }

/** Mirrors ONLINE_WINDOW_MS in src/lib/presence.ts. */
const ONLINE_WINDOW_MS = 60_000

let failures = 0

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${label}`)
  } else {
    failures++
    console.error(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function api(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const setCookie = res.headers.get('Set-Cookie')
  if (res.status !== 200 || !setCookie) throw new Error(`login ${username} failed (${res.status})`)
  return setCookie.split(';')[0]
}

const aliceCookie = await login(ALICE.username, ALICE.password)
const bobCookie = await login(BOB.username, BOB.password)

const lookup = await api(`/api/users/lookup?q=${BOB.username}`, { cookie: aliceCookie })
const bobId: string = lookup.body?.users?.[0]?.id
if (!bobId) throw new Error('seeded account "bob" not found')

console.log('\n— presence')

const anonymous = await api('/api/presence', { method: 'POST', body: JSON.stringify({ ids: [] }) })
check('a heartbeat without a session is refused', anonymous.status === 401)

const bare = await fetch(`${API}/api/presence`, {
  method: 'POST',
  headers: { Cookie: aliceCookie },
})
check('a heartbeat with no body still counts', bare.status === 200)

const tooMany = await api('/api/presence', {
  method: 'POST',
  cookie: aliceCookie,
  body: JSON.stringify({ ids: Array.from({ length: 65 }, (_, i) => `u${i}`) }),
})
check('more ids than the cap is a 400', tooMany.status === 400, tooMany.body)

const bobBeat = await api('/api/presence', {
  method: 'POST',
  cookie: bobCookie,
  body: JSON.stringify({ ids: [] }),
})
check(
  'a heartbeat answers with the server clock and the window',
  bobBeat.body?.window_ms === ONLINE_WINDOW_MS && typeof bobBeat.body?.now === 'number',
  bobBeat.body,
)

const afterBeat = await api('/api/presence', {
  method: 'POST',
  cookie: aliceCookie,
  body: JSON.stringify({ ids: [bobId] }),
})
check(
  'a peer that just beat reads as online',
  afterBeat.body?.users?.[0]?.id === bobId && afterBeat.body?.users?.[0]?.online === true,
  afterBeat.body,
)

const unknown = await api('/api/presence', {
  method: 'POST',
  cookie: aliceCookie,
  body: JSON.stringify({ ids: ['nobody-by-this-id'] }),
})
check('an unknown id is absent rather than offline', unknown.body?.users?.length === 0)

console.log('\n— the window')

// Two windows back: old enough that no rounding can call it online.
const stale = Date.now() - ONLINE_WINDOW_MS * 2
d1Execute(`UPDATE users SET last_seen_at = ${stale} WHERE username = ${sqlString(BOB.username)};`)

const afterStale = await api('/api/presence', {
  method: 'POST',
  cookie: aliceCookie,
  body: JSON.stringify({ ids: [bobId] }),
})
check(
  'a beat older than the window reads as offline',
  afterStale.body?.users?.[0]?.online === false &&
    afterStale.body?.users?.[0]?.last_seen_at === stale,
  afterStale.body,
)

const staleLookup = await api(`/api/users/lookup?q=${BOB.username}`, { cookie: aliceCookie })
check(
  'search results carry presence',
  staleLookup.body?.users?.[0]?.online === false &&
    staleLookup.body?.users?.[0]?.last_seen_at === stale,
  staleLookup.body?.users?.[0],
)

const resolved = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: aliceCookie,
  body: JSON.stringify({ user_id: bobId }),
})
check(
  'resolve carries the peer presence',
  resolved.body?.other_user?.online === false && resolved.body?.other_user?.last_seen_at === stale,
  resolved.body?.other_user,
)

await api('/api/presence', { method: 'POST', cookie: bobCookie, body: JSON.stringify({ ids: [] }) })
const list = await api('/api/conversations', { cookie: aliceCookie })
const bobTile = list.body?.conversations?.find((c: any) => c.other_user?.id === bobId)
check(
  'the conversation list carries the peer presence',
  bobTile === undefined || bobTile.other_user.online === true,
  bobTile?.other_user,
)

console.log('\n— skin')

const before = await api('/api/auth/me', { cookie: aliceCookie })
const theme = {
  theme_mode: before.body?.user?.theme_mode ?? null,
  theme_light: before.body?.user?.theme_light ?? 'goodchat-crimson',
  theme_dark: before.body?.user?.theme_dark ?? 'goodchat-rose',
}
const originalSkin: string | null = before.body?.user?.skin ?? null

const setSkin = await api('/api/settings', {
  method: 'PATCH',
  cookie: aliceCookie,
  body: JSON.stringify({ ...theme, skin: 'terminal' }),
})
check('a known skin is stored', setSkin.body?.user?.skin === 'terminal', setSkin.body)

const kept = await api('/api/settings', {
  method: 'PATCH',
  cookie: aliceCookie,
  body: JSON.stringify(theme),
})
check('a call without the field keeps the stored skin', kept.body?.user?.skin === 'terminal')

const cleared = await api('/api/settings', {
  method: 'PATCH',
  cookie: aliceCookie,
  body: JSON.stringify({ ...theme, skin: null }),
})
check('null clears the skin back to the default', cleared.body?.user?.skin === null)

const bogus = await api('/api/settings', {
  method: 'PATCH',
  cookie: aliceCookie,
  body: JSON.stringify({ ...theme, skin: 'vaporwave' }),
})
check('an unknown skin is refused', bogus.status === 400, bogus.body)

const reloaded = await api('/api/auth/me', { cookie: aliceCookie })
check('the session reports the stored skin', reloaded.body?.user?.skin === null)

// Leave the seeded account as it was found.
await api('/api/settings', {
  method: 'PATCH',
  cookie: aliceCookie,
  body: JSON.stringify({ ...theme, skin: originalSkin }),
})

console.log(failures === 0 ? '\nphase 12 smoke: all green' : `\nphase 12 smoke: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
