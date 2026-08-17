// Phase 3 smoke test — runs against a live dev server with seed data:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase3                                   (terminal 2)
//
// Plain Node ≥24 (native fetch + type stripping), no test framework.
// Equivalent curl calls, for manual poking:
//   curl -i -c /tmp/gc.jar -X POST localhost:8000/api/auth/login \
//     -H 'Content-Type: application/json' -d '{"username":"alice","password":"alice-goodchat"}'
//   curl -b /tmp/gc.jar 'localhost:8000/api/users/lookup?q=@bo'
//   curl -b /tmp/gc.jar -X POST localhost:8000/api/conversations/resolve \
//     -H 'Content-Type: application/json' -d '{"user_id":"<id from lookup>"}'
//   curl -b /tmp/gc.jar localhost:8000/api/conversations

const API = process.env.API_URL ?? 'http://localhost:8000'

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
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.cookie) headers.set('Cookie', init.cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  const body = await res.json().catch(() => null)
  return { status: res.status, body, setCookie: res.headers.get('Set-Cookie') }
}

async function login(username: string, password: string): Promise<string> {
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (res.status !== 200 || !res.setCookie) {
    throw new Error(`login ${username} failed (${res.status}): ${JSON.stringify(res.body)}`)
  }
  return res.setCookie.split(';')[0]
}

const alice = await login('alice', 'alice-goodchat')
const bob = await login('bob', 'bob-goodchat')
console.log('logged in as alice and bob')

// --- lookup ---
const noAuth = await api('/api/users/lookup?q=bo')
check('lookup without session → 401', noAuth.status === 401, noAuth)

const prefix = await api('/api/users/lookup?q=bo', { cookie: alice })
check(
  'lookup by prefix "bo" finds bob',
  prefix.status === 200 && prefix.body.users.some((u: any) => u.username === 'bob'),
  prefix.body,
)

const atExact = await api('/api/users/lookup?q=%40bob', { cookie: alice })
check(
  'lookup "@bob" (exact, @-prefixed) finds bob',
  atExact.status === 200 && atExact.body.users.some((u: any) => u.username === 'bob'),
  atExact.body,
)

const self = await api('/api/users/lookup?q=alice', { cookie: alice })
check('lookup excludes self', self.status === 200 && self.body.users.length === 0, self.body)

const empty = await api('/api/users/lookup?q=', { cookie: alice })
check('lookup with empty q → 400', empty.status === 400, empty)

const bobId: string = prefix.body.users.find((u: any) => u.username === 'bob').id
const aliceMe = await api('/api/auth/me', { cookie: alice })
const aliceId: string = aliceMe.body.user.id

// --- resolve ---
const fromAlice = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: bobId }),
})
check(
  'resolve alice→bob returns id, exists=false (lazy creation, no row yet)',
  fromAlice.status === 200 &&
    typeof fromAlice.body.conversation_id === 'string' &&
    fromAlice.body.exists === false &&
    fromAlice.body.other_user.username === 'bob',
  fromAlice.body,
)

const fromBob = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: bob,
  body: JSON.stringify({ user_id: aliceId }),
})
check(
  'resolve bob→alice returns the SAME id (order-independent)',
  fromBob.status === 200 && fromBob.body.conversation_id === fromAlice.body.conversation_id,
  { fromAlice: fromAlice.body.conversation_id, fromBob: fromBob.body.conversation_id },
)

const selfResolve = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: aliceId }),
})
check('resolve with own id → 400', selfResolve.status === 400, selfResolve)

const ghost = await api('/api/conversations/resolve', {
  method: 'POST',
  cookie: alice,
  body: JSON.stringify({ user_id: 'no-such-user' }),
})
check('resolve unknown user → 404', ghost.status === 404, ghost)

// --- list ---
const list = await api('/api/conversations', { cookie: alice })
check(
  'conversation list responds 200 with an array (empty until first message)',
  list.status === 200 && Array.isArray(list.body.conversations),
  list.body,
)

console.log(failures === 0 ? '\nphase 3 smoke: all green' : `\nphase 3 smoke: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
