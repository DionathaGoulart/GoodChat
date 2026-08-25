// Phase 11 smoke test — profile (display name + picture) against a live dev
// server:
//   npm run db:migrate && npm run db:seed && npm run dev   (terminal 1)
//   npm run smoke:phase11                                  (terminal 2)
//
// The fake-B2 stub (scripts/media-dev-server.ts) is started in-process on the
// port from worker/.dev.vars (9000); if it is already running (`npm run
// media:dev`), the existing instance is reused.
//
// Covers: PATCH /api/profile auth and validation, the display name round trip
// (set, clear, and how peers see it), the avatar upload rules (`purpose:
// "avatar"` prefix, MIME allowlist, size cap), adoption (only your own avatar
// key, never a message attachment or someone else's), who may read an avatar
// (any session once adopted, nobody but the uploader before), replacing and
// removing a picture deleting the old object, and the cleanup sweep leaving an
// adopted avatar alone even when it is older than the orphan TTL.
//
// Not covered here: the retention sweep's avatar exemption, which only runs
// when MEDIA_RETENTION_DAYS is set on the instance (`key NOT LIKE 'avatars/%'`
// in lib/cleanup.ts).

import { startMediaDevServer } from './media-dev-server.ts'
import { d1Execute, signIn, sqlString } from './lib.ts'

const API = process.env.API_URL ?? 'http://localhost:8000'
const MEDIA_PORT = Number(process.env.MEDIA_DEV_PORT ?? 9000)

const OWNER = { username: 'good', password: 'good-goodchat' }

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

// Signing in goes through `signIn` (scripts/lib.ts) rather than posting the
// password: since migration 0013 the stored hash is of a token the *client*
// derives, so a plaintext login is refused. ~600ms of PBKDF2 per call.
async function login(username: string, password: string): Promise<string> {
  const cookie = await signIn(API, username, password)
  if (!cookie) throw new Error(`login ${username} failed`)
  return cookie
}

/** Bytes with an image MIME: nothing in the pipeline decodes them. */
function fakeImage(size = 2048): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251
  return bytes
}

/** Presign + PUT, returning the key. */
async function uploadAvatar(
  cookie: string,
  { mime = 'image/webp', bytes = fakeImage() } = {},
): Promise<string> {
  const presigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ mime, size: bytes.length, purpose: 'avatar' }),
  })
  if (presigned.status !== 200) throw new Error(`presign failed (${presigned.status})`)
  const put = await fetch(presigned.body.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mime },
    body: bytes,
  })
  if (!put.ok) throw new Error(`upload failed (${put.status})`)
  return presigned.body.key as string
}

function mediaStatus(key: string, cookie?: string): Promise<number> {
  return fetch(`${API}/api/media/${key}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  }).then((res) => res.status)
}

let ownedServer: Awaited<ReturnType<typeof startMediaDevServer>> | null = null
try {
  ownedServer = await startMediaDevServer(MEDIA_PORT)
  console.log(`media stub started on :${MEDIA_PORT}`)
} catch (err: any) {
  if (err?.code !== 'EADDRINUSE') throw err
  console.log(`media stub already running on :${MEDIA_PORT} — reusing`)
}

try {
  const aliceCookie = await login('alice', 'alice-goodchat')
  const bobCookie = await login('bob', 'bob-goodchat')

  // --- auth and validation ---------------------------------------------
  const anonymous = await api('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify({ display_name: 'ninguém' }),
  })
  check('PATCH /api/profile requires a session', anonymous.status === 401, anonymous.body)

  const empty = await api('/api/profile', { method: 'PATCH', cookie: aliceCookie, body: '{}' })
  check('a patch with no fields is rejected', empty.status === 400, empty.body)

  const tooLong = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ display_name: 'a'.repeat(65) }),
  })
  check('display_name over 64 chars is rejected', tooLong.status === 400, tooLong.body)

  // --- display name ------------------------------------------------------
  const named = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ display_name: '  Alice Smoke  ' }),
  })
  check(
    'display_name is stored trimmed',
    named.status === 200 && named.body?.user?.display_name === 'Alice Smoke',
    named.body?.user,
  )

  const afterName = await api('/api/auth/me', { cookie: aliceCookie })
  check(
    'display_name survives on the account',
    afterName.body?.user?.display_name === 'Alice Smoke',
    afterName.body?.user,
  )

  const seenByBob = await api('/api/users/lookup?q=alice', { cookie: bobCookie })
  check(
    'peers see the display name in lookup',
    seenByBob.body?.users?.[0]?.display_name === 'Alice Smoke',
    seenByBob.body?.users?.[0],
  )

  const blanked = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ display_name: '   ' }),
  })
  check(
    'a blank display_name clears it (falls back to @username)',
    blanked.body?.user?.display_name === null,
    blanked.body?.user,
  )

  const nulled = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ display_name: null }),
  })
  check('null display_name also clears it', nulled.body?.user?.display_name === null)

  // --- avatar upload rules ----------------------------------------------
  const videoAvatar = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'video/mp4', size: 1000, purpose: 'avatar' }),
  })
  check('an avatar cannot be a video', videoAvatar.status === 415, videoAvatar.body)

  const gifAvatar = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'image/gif', size: 1000, purpose: 'avatar' }),
  })
  check('an avatar cannot be a gif', gifAvatar.status === 415, gifAvatar.body)

  const fatAvatar = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'image/webp', size: 900 * 1024, purpose: 'avatar' }),
  })
  check('an avatar over 512kb is rejected', fatAvatar.status === 413, fatAvatar.body)

  const presigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'image/webp', size: 2048, purpose: 'avatar' }),
  })
  check(
    'an avatar upload lands under avatars/',
    presigned.body?.key?.startsWith('avatars/') === true,
    presigned.body?.key,
  )

  const messagePresigned = await api('/api/media/upload-url', {
    method: 'POST',
    cookie: aliceCookie,
    body: JSON.stringify({ mime: 'image/webp', size: 2048 }),
  })
  check(
    'a message upload still lands under media/',
    messagePresigned.body?.key?.startsWith('media/') === true,
    messagePresigned.body?.key,
  )

  // --- adoption ----------------------------------------------------------
  const aliceKey = await uploadAvatar(aliceCookie)

  check(
    'an avatar nobody adopted is private to its uploader',
    (await mediaStatus(aliceKey, bobCookie)) === 404 &&
      (await mediaStatus(aliceKey, aliceCookie)) === 200,
  )

  const stolen = await api('/api/profile', {
    method: 'PATCH',
    cookie: bobCookie,
    body: JSON.stringify({ avatar_key: aliceKey }),
  })
  check("another account cannot adopt someone else's avatar", stolen.status === 400, stolen.body)

  const notAnAvatar = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ avatar_key: messagePresigned.body.key }),
  })
  check(
    'a message attachment cannot be adopted as an avatar',
    notAnAvatar.status === 400,
    notAnAvatar.body,
  )

  const madeUp = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ avatar_key: 'avatars/00000000-0000-4000-8000-000000000000.webp' }),
  })
  check('a key that was never presigned is rejected', madeUp.status === 400, madeUp.body)

  const adopted = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ avatar_key: aliceKey }),
  })
  check(
    'adopting my own avatar key sets it on the account',
    adopted.status === 200 && adopted.body?.user?.avatar_key === aliceKey,
    adopted.body?.user,
  )

  check(
    'an adopted avatar is readable by any session',
    (await mediaStatus(aliceKey, bobCookie)) === 200,
  )
  check('an avatar still needs a session', (await mediaStatus(aliceKey)) === 401)

  const bobsView = await api('/api/conversations/resolve', {
    method: 'POST',
    cookie: bobCookie,
    body: JSON.stringify({ user_id: adopted.body.user.id }),
  })
  check(
    'the peer payload carries the avatar key',
    bobsView.body?.other_user?.avatar_key === aliceKey,
    bobsView.body?.other_user,
  )

  // --- replace and remove ------------------------------------------------
  const secondKey = await uploadAvatar(aliceCookie, { mime: 'image/jpeg' })
  const replaced = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ avatar_key: secondKey }),
  })
  check('replacing the picture moves the account to the new key', replaced.body?.user?.avatar_key === secondKey)
  check(
    'the replaced object is gone from the bucket',
    (await mediaStatus(aliceKey, aliceCookie)) === 404,
  )

  // Older than the orphan TTL: an adopted avatar must survive the sweep that
  // deletes uploads no message ever referenced.
  d1Execute(
    `UPDATE media_objects SET created_at = 0 WHERE key = ${sqlString(secondKey)};`,
  )
  const ownerCookie = await login(OWNER.username, OWNER.password).catch(() => null)
  if (ownerCookie) {
    const cleanup = await api('/api/admin/cleanup', { method: 'POST', cookie: ownerCookie })
    check('cleanup runs', cleanup.status === 200, cleanup.body)
    check(
      'the orphan sweep leaves an adopted avatar alone',
      (await mediaStatus(secondKey, aliceCookie)) === 200,
    )
  } else {
    console.log('  (owner "good" missing — skipping the cleanup checks)')
    console.log(`   create it with: npm run user:create -- --owner ${OWNER.username} ${OWNER.password} Good`)
  }

  const removed = await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ avatar_key: null }),
  })
  check('removing the picture clears the account field', removed.body?.user?.avatar_key === null)
  check(
    'removing the picture deletes its object',
    (await mediaStatus(secondKey, aliceCookie)) === 404,
  )

  // Leave the seeded account as db:seed made it.
  await api('/api/profile', {
    method: 'PATCH',
    cookie: aliceCookie,
    body: JSON.stringify({ display_name: 'Alice' }),
  })
} finally {
  if (ownedServer) await new Promise<void>((resolve) => ownedServer!.close(() => resolve()))
}

console.log(failures === 0 ? '\nphase 11 smoke: all green' : `\nphase 11 smoke: ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
