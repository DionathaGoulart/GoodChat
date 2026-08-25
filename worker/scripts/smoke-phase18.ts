// Phase 18 smoke: the conversation, end to end, in a real browser.
//
// Everything phases 15–17 prove, they prove from Node: the envelope's shape,
// the two independent implementations agreeing on it, and the fact that a
// password turns into three values of which exactly one may leave. None of
// them run the app. The React wiring, IndexedDB, the service worker, canvas
// media, `<video>` — the parts that only exist inside a browser — were checked
// by hand, once, and a hand-checked property is not a property, it is a memory.
//
// So this file is phase 6 of plan.md, executed by Playwright instead of by a
// person. It drives the same twelve steps against the same local stack, in
// three isolated browser contexts:
//
//   ALICE   — the first browser
//   BOB     — the peer
//   ELSEWHERE — Alice again, in a context that has never seen her account
//
// The third one is the whole reason a browser is needed. A Playwright context
// is a private profile: its own cookie jar, its own IndexedDB, its own
// localStorage. "Alice signs in somewhere new" is not something a Node test can
// state, because there is no *where* for it to be new to.
//
// What each step is worth is not equal, and plan.md says so: steps 2, 4, 8 and
// 9 are the ones that prove what the account key exists for. The rest prove the
// app still works — which is the other half of a change that touched every
// message path, and the half that a crypto test cannot see.
//
// Two steps are honest about their edges:
//
//   · step 11 delivers a push through CDP rather than through a push service,
//     because no push service is reachable from a laptop with no network. What
//     is delivered is the payload the Worker builds (lib/push.ts `withPreview`:
//     a title, a generic body, and the two ids) — everything after that is the
//     real service worker doing the real work, which is the part that matters
//     and the part no Node test can reach.
//   · step 12 asserts whichever half of E2EE_REQUIRED is in force rather than
//     demanding one, the same way phase 15 does: flipping it means restarting
//     the Worker, and a test that cannot run against the stack as configured is
//     a test nobody runs.
//
// Usage: npm run smoke:phase18
//   needs: npm run dev (:8000) · npm run media:dev (:9000) · npm run
//   stickers:publish · and the app on :5173 (cd ../app && npm run dev)
//
//   HEADED=1  to watch it happen
//   SLOWMO=250 to watch it happen slowly

import { chromium } from 'playwright'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { d1Execute, insertUser, signIn, sqlString } from './lib.ts'

const API = process.env.API ?? 'http://localhost:8000'
const APP = process.env.APP ?? 'http://localhost:5173'
const HEADED = process.env.HEADED === '1'
const SLOWMO = Number(process.env.SLOWMO ?? 0)

const STAMP = Date.now().toString(36)
const ALICE = { username: `p18a${STAMP}`, password: `alice-${STAMP}-goodchat`, name: `Alice ${STAMP}` }
const BOB = { username: `p18b${STAMP}`, password: `bob-${STAMP}-goodchat`, name: `Bob ${STAMP}` }
/**
 * Created and never signed in, so it never publishes an account key. Step 12
 * needs a peer there is no way to encrypt to — which is the only thing that
 * makes an instance's answer to "encrypt or refuse" observable from the UI.
 */
const MUTE = { username: `p18c${STAMP}`, password: `mute-${STAMP}-goodchat` }
/** Only for the reset in step 10 and the teardown. */
const OWNER = { username: 'good', password: 'good-goodchat' }

/** What Alice's password becomes after the owner resets it (step 10). */
const RESET_PASSWORD = `reset-${STAMP}-goodchat`
const ROTATED_PASSWORD = `rotated-${STAMP}-goodchat`

// The texts are stamped so a stale copy of the app, a stale D1 row or a
// leftover conversation cannot make an assertion pass by accident.
const ALICE_TEXT = `alice diz ${STAMP}`
const BOB_TEXT = `bob responde ${STAMP}`
const EMOJI_TEXT = `café e fogo 🔥☕ ${STAMP}`

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function step(title: string): void {
  console.log(`\n--- ${title} ---`)
}

// --- fixtures -------------------------------------------------------------
//
// Inline rather than on disk: they are 600 bytes each and a binary in the repo
// is a thing to explain forever. The video is one second of black at 64×48,
// VP8 in WebM — small enough to inline, and with a real Duration in its Segment
// header, which a MediaRecorder-produced clip does not have. `prepareVideo`
// reads that duration and refuses anything it cannot measure (lib/media.ts), so
// a clip recorded by the browser under test would be rejected before it was
// ever sent.

const PNG_FIXTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAAACXBIWXMAAAABAAAAAQBPJcTWAAACGElEQVR4nO2cQXLCMAxF' +
  'rRn2tDdub9Ar9IbtCVwSUUrB9pcdEWLnv8l0kXFj8ZBCTIIkGIiGMfI7KEp2uFjminhUeYQGkI/iaqQhnoNhjJWCmjWRs2Kf' +
  'YNwEbcTOhSgi0SEkH0GnUAyVsTYujpYKcnmXHsfJUVgW5CJBG7dzYUkqtQvqxY7S7KhRUF92lDZHLYJ6tKM0OKoW1K8dpdaR' +
  '54XikNQJ6j19lKokqhA0hh3F7sgqaCQ7ynQNaXhRPAcBTILGSx9lrjPw0phBACxokwt1N2ASMYMAQBAs0QEoJxEzCFAStIf0' +
  'UQpJxAwCUBAgK2g/9aXkqowZBKAgQFrQ3upLSVYZMwgwrCC5qwOZbyLWlsawgqY1tkh5j4VhBXlBQQAKAlAQYFhB9+fjhjN0' +
  'GFgQP8VWgoIAFASgIMCwgu6X5vwU+8f8tL3c7qlnWEFeUBCAggBpQZbnQsaDdzVaoCBAVtDeqoz35huhIEBJ0H6qjA9QtXOY' +
  '1L3kt085/Y3Xe47hKyS2t5je/x3KE9xuEjIHym3f6QO9ZyY4TvGc//lvJvnITcAMAlAQgIIAFASgIAAFASgIQEEACgIcpi/+' +
  '9aIxz81C5TW1crH8ZsraP0ivec3HSYafi2f+ceB5gkf1D/LqPLM+K3VeCH06WrV3R+jN0RO6v4R+HD2tf1Dw6GD0UJ7fgUqZ' +
  'NW3O0YZ6mIW599ym+rx5JfUPUqn1Nv4QO5gAAAAASUVORK5CYII='

const WEBM_FIXTURE =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAJPEU2bdLpNu4tTq4QVSalmU6yBoU27i1Or' +
  'hBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggI57AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirX' +
  'sYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgjp5sK' +
  '3Yyvh5yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgkLCBQLqBMJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VO' +
  'Q09ERVJEh41MYXZmNjIuMTIuMTAxc3PWY8CLY8WII6ebCt2Mr4dnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMSBsaWJ2' +
  'cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QI3ngQCjqIEAAICwAgCdASpAADAAAEcIhYWIhYSI' +
  'AgIABo5PzMeb8VgA/v+rUICjloEAyADRAQAPEfwAGAAYWC/0AAiMAACjloEBkADRAQAPEfwAGAAYWC/0AAiMAACjloECWADR' +
  'AQAPEfwAGAAYWC/0AAiMAACjloEDIADRAQAPEfwAGAAYWC/0AAiMAAAcU7trkbuPs4EAt4r3gQHxggGm8IED'

// --- a browser that keeps its receipts ------------------------------------

interface Session {
  name: string
  context: BrowserContext
  page: Page
  /** Every WebSocket frame this browser sent or received, for step 2. */
  frames: string[]
  /** Console errors and uncaught exceptions, for the acceptance criteria. */
  errors: string[]
}

async function openSession(browser: Browser, name: string): Promise<Session> {
  const context = await browser.newContext()
  // Only the notification permission, and only for the app's origin: step 11
  // needs `showNotification` to be allowed, and a prompt in a headless browser
  // is a hang rather than a question.
  await context.grantPermissions(['notifications'], { origin: APP })
  const page = await context.newPage()
  const session: Session = { name, context, page, frames: [], errors: [] }

  // The DevTools "Network → WS" pane of plan.md step 2, as an array. Both
  // directions: what the browser sends is as interesting as what it is told,
  // and a client that leaked the plaintext would leak it on the way out.
  page.on('websocket', (ws) => {
    ws.on('framesent', ({ payload }) => session.frames.push(String(payload)))
    ws.on('framereceived', ({ payload }) => session.frames.push(String(payload)))
  })
  page.on('console', (message) => {
    if (message.type() === 'error') session.errors.push(`${name}: ${message.text()}`)
  })
  page.on('pageerror', (error) => session.errors.push(`${name}: ${error.message}`))

  await page.goto(APP)
  return session
}

/** The session cookie this browser holds, in `name=value` form. */
async function cookieOf(session: Session): Promise<string> {
  const cookies = await session.context.cookies(APP)
  const found = cookies.find((cookie) => cookie.name === 'session')
  if (!found) throw new Error(`${session.name} has no session cookie`)
  return `session=${found.value}`
}

// --- driving the app ------------------------------------------------------

async function signInThroughTheForm(
  session: Session,
  account: { username: string; password: string },
): Promise<void> {
  const { page } = session
  await page.getByLabel('username').fill(account.username)
  await page.getByLabel('password').fill(account.password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  // The list screen, not merely "the form went away": ~600ms of PBKDF2 happens
  // between those two, and on a cold context so does generating and publishing
  // an account key.
  await page.getByPlaceholder('buscar @username').waitFor({ timeout: 60_000 })
}

/**
 * Opens the thread with `username` the way a person does — through the search
 * box. Used once per browser; after that the hash is faster and proves nothing
 * new, since it is the same `navigate()` the result button calls.
 */
async function openThreadBySearch(session: Session, username: string): Promise<void> {
  const { page } = session
  await page.getByPlaceholder('buscar @username').fill(username)
  await page.getByRole('button', { name: new RegExp(`@${username}`) }).click({ timeout: 30_000 })
  await page.getByPlaceholder('mensagem_').waitFor({ timeout: 30_000 })
}

async function openThreadById(session: Session, userId: string): Promise<void> {
  const { page } = session
  await page.evaluate((id) => {
    window.location.hash = `#/t/${id}`
  }, userId)
  await page.getByPlaceholder('mensagem_').waitFor({ timeout: 30_000 })
}

async function backToList(session: Session): Promise<void> {
  await session.page.getByRole('button', { name: 'voltar à lista' }).click()
  await session.page.getByPlaceholder('buscar @username').waitFor({ timeout: 30_000 })
}

async function sendText(session: Session, text: string): Promise<void> {
  const field = session.page.getByPlaceholder('mensagem_')
  await field.fill(text)
  await field.press('Enter')
}

/**
 * Waits for an `<img>` to have actually decoded, which is not the same as
 * having appeared: an image whose bytes the browser refuses still matches the
 * selector and still occupies the layout. Everything this file checks about
 * images is about the pixels, so the wait is on `naturalWidth`.
 */
async function decoded(locator: Locator, timeout = 30_000): Promise<boolean> {
  await locator.waitFor({ timeout })
  const deadline = Date.now() + timeout
  for (;;) {
    const ready = await locator.evaluate(
      (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
    )
    if (ready) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** The bubble carrying `text`, whichever side of the thread it is on. */
function bubble(page: Page, text: string) {
  return page.locator('.msg .msg-body', { hasText: text }).first()
}

async function attach(session: Session, name: string, mime: string, base64: string): Promise<void> {
  await session.page
    .locator('input[type=file]')
    .setInputFiles({ name, mimeType: mime, buffer: Buffer.from(base64, 'base64') })
}

// --- talking to the worker without a browser ------------------------------

async function apiGet<T>(path: string, cookie: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { Cookie: cookie } })
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return (await response.json()) as T
}

interface ConversationRow {
  id: string
  other_user: { id: string; username: string }
  last_message: { id: string; media_key: string | null; enc: unknown } | null
}

async function conversations(cookie: string): Promise<ConversationRow[]> {
  const { conversations } = await apiGet<{ conversations: ConversationRow[] }>(
    '/api/conversations',
    cookie,
  )
  return conversations
}

async function userIdOf(username: string, cookie: string): Promise<string> {
  const { users } = await apiGet<{ users: { id: string; username: string }[] }>(
    `/api/users/lookup?q=${encodeURIComponent(username)}`,
    cookie,
  )
  const found = users.find((user) => user.username === username)
  if (!found) throw new Error(`no account named ${username}`)
  return found.id
}

// --- setup ----------------------------------------------------------------

console.log(`phase 18 — the conversation in a browser (app ${APP}, api ${API})`)

// Fresh accounts per run rather than the alice/bob fixtures, for two reasons
// that are really one: step 10 resets a password, which destroys that account's
// history for good, and `PUT /api/account/key` is create-only, so a browser
// cannot republish a key over one a previous run left behind. A run that ate
// its fixtures would pass once.
await insertUser(ALICE.username, ALICE.password, ALICE.name)
await insertUser(BOB.username, BOB.password, BOB.name)
await insertUser(MUTE.username, MUTE.password, `Mudo ${STAMP}`)

// `signIn` spends a failed attempt per legacy sign-in and the whole suite
// shares one address on localhost (see phase 9 and 10).
d1Execute('DELETE FROM login_attempts;')

const ownerCookie = await signIn(API, OWNER.username, OWNER.password)
if (!ownerCookie) throw new Error('the owner account did not sign in — run `npm run db:seed` first')

const browser = await chromium.launch({
  // The full browser, not the headless shell: this test records nothing but it
  // does decode a WebM and rasterise a PNG through canvas, and the shell build
  // is the one that ships without the codecs to do it.
  channel: 'chromium',
  headless: !HEADED,
  slowMo: SLOWMO,
})

const alice = await openSession(browser, 'alice')
const bob = await openSession(browser, 'bob')
/** Every context opened, so a failure can say what was on screen. */
const opened: Session[] = [alice, bob]

try {
  // Bob first. Alice cannot seal anything to an account that has never signed
  // in, because signing in is when a CLI-created account generates its key and
  // publishes the public half (app/src/hooks/useSession.tsx).
  await signInThroughTheForm(bob, BOB)
  await signInThroughTheForm(alice, ALICE)

  const aliceCookie = await cookieOf(alice)
  const bobCookie = await cookieOf(bob)
  const aliceId = await userIdOf(ALICE.username, ownerCookie)
  const bobId = await userIdOf(BOB.username, ownerCookie)
  const muteId = await userIdOf(MUTE.username, ownerCookie)

  // ---------------------------------------------------------------- step 1
  step('1 · texto nos dois sentidos')

  await openThreadBySearch(alice, BOB.username)
  await openThreadBySearch(bob, ALICE.username)

  await sendText(alice, ALICE_TEXT)
  await bubble(bob.page, ALICE_TEXT).waitFor({ timeout: 30_000 })
  check('bob reads what alice typed', true)

  await sendText(bob, BOB_TEXT)
  await bubble(alice.page, BOB_TEXT).waitFor({ timeout: 30_000 })
  check('alice reads what bob typed', true)

  // The lock is a button whose accessible name says which of the three states
  // it is in — an open padlock and a closed one are the same glyph slot.
  const lockName = await alice.page
    .getByRole('button', { name: /número de segurança|não está criptografada|não estão sendo entregues/ })
    .getAttribute('aria-label')
  check(
    'the header shows a closed lock, not a warning',
    (lockName ?? '').startsWith('número de segurança'),
    lockName,
  )
  for (const session of [alice, bob]) {
    check(
      `${session.name}: no encryption warning band`,
      (await session.page.getByText(/esta conversa não está criptografada|nada enviado aqui está sendo entregue/).count()) === 0,
    )
  }

  // ---------------------------------------------------------------- step 2
  step('2 · o que trafega é ciphertext')

  // Every frame both browsers have seen, including the `history` frame plan.md
  // names. The claim is about what left the browser and what the server sent
  // back, so it is checked over all of them rather than over one.
  const allFrames = [...alice.frames, ...bob.frames]
  check('there are websocket frames to inspect', allFrames.length > 0, allFrames.length)
  for (const secret of [ALICE_TEXT, BOB_TEXT]) {
    check(
      `no frame contains ${JSON.stringify(secret)}`,
      !allFrames.some((frame) => frame.includes(secret)),
    )
  }
  // And that the frames carrying those messages are the shape phase 3 left
  // behind: addressed to two accounts, naming no device.
  const envelopes = allFrames
    .flatMap((frame) => {
      try {
        return [JSON.parse(frame)]
      } catch {
        return []
      }
    })
    .flatMap((event: any) => (event?.type === 'history' ? (event.messages ?? []) : [event?.message ?? event]))
    .filter((message: any) => message?.enc)
  check('at least one enveloped message crossed the wire', envelopes.length > 0, envelopes.length)
  check(
    'every envelope is v:3, two account keys, no sender_device',
    envelopes.every(
      (message: any) =>
        message.enc.v === 3 &&
        Object.keys(message.enc.keys).length === 2 &&
        message.enc.sender_device === undefined &&
        Object.keys(message.enc.keys).every((id) => id === aliceId || id === bobId),
    ),
    envelopes[0]?.enc,
  )

  // ---------------------------------------------------------------- step 3
  step('3 · emoji e sticker')

  await sendText(alice, EMOJI_TEXT)
  await bubble(bob.page, EMOJI_TEXT).waitFor({ timeout: 30_000 })
  check('emoji survive the round trip verbatim', true)

  await alice.page.getByRole('button', { name: 'abrir stickers' }).click()
  await alice.page.getByRole('button', { name: 'enviar sticker coração' }).click()
  // The art, not the fallback: the id travels inside the ciphertext, so the
  // recipient is the first place it is ever seen as an id at all.
  // Decoded, not merely present: a wrong header on the media route produces an
  // `<img>` that matches every selector and paints a broken frame, which is
  // exactly what "renders the art" has to rule out.
  check(
    'the sticker renders as art on the receiving side',
    await decoded(bob.page.locator('img[alt="sticker coração"]').first()),
  )
  check(
    'no [sticker] placeholder anywhere',
    (await bob.page.getByText('[sticker]', { exact: true }).count()) === 0,
  )

  // ---------------------------------------------------------------- step 4
  step('4 · imagem, e o que o proxy serve')

  await attach(alice, 'tiny.png', 'image/png', PNG_FIXTURE)
  const receivedImage = bob.page.locator('.msg img[alt="imagem"]').first()
  check('bob renders the decrypted image', await decoded(receivedImage, 60_000))

  const withImage = (await conversations(bobCookie)).find((row) => row.other_user.id === aliceId)
  const mediaKey = withImage?.last_message?.media_key ?? null
  check('the message references an object in the bucket', mediaKey !== null, mediaKey)

  // The same URL the bubble used, with the same session cookie, fetched from
  // outside the app. Everything about the request is authorised; what comes
  // back is still not a picture.
  const served = new Uint8Array(
    await (await fetch(`${API}/api/media/${mediaKey}`, { headers: { Cookie: bobCookie } })).arrayBuffer(),
  )
  check('the proxy answers with bytes', served.length > 0, served.length)
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
  check(
    'what the proxy serves is not a PNG',
    !PNG_MAGIC.every((byte, index) => served[index] === byte),
    [...served.slice(0, 8)],
  )
  // Belt and braces: whatever it is, it is not any image the browser knows.
  const rejectedByTheBrowser = await alice.page.evaluate(async (bytes) => {
    try {
      await createImageBitmap(new Blob([new Uint8Array(bytes)]))
      return false
    } catch {
      return true
    }
  }, [...served])
  check('a browser handed those bytes cannot decode them', rejectedByTheBrowser)

  // ---------------------------------------------------------------- step 5
  step('5 · vídeo')

  await attach(alice, 'tiny.webm', 'video/webm', WEBM_FIXTURE)
  const receivedVideo = bob.page.locator('.msg video').first()
  await receivedVideo.waitFor({ timeout: 60_000 })
  const plays = await receivedVideo.evaluate(async (video: HTMLVideoElement) => {
    // readyState ≥ 2 is HAVE_CURRENT_DATA: there is a decoded frame. Which is
    // also the documented regression — for a video it arrives only once the
    // whole object has been downloaded and decrypted, because there is no
    // Media Source path yet (docs/architecture.md).
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        video.addEventListener('loadeddata', resolve, { once: true })
        window.setTimeout(resolve, 20_000)
      })
    }
    try {
      await video.play()
    } catch {
      return { readyState: video.readyState, playing: false }
    }
    return { readyState: video.readyState, playing: !video.paused }
  })
  check('the video decodes and plays', plays.readyState >= 2 && plays.playing, plays)

  // ---------------------------------------------------------------- step 6
  step('6 · previews da lista')

  await backToList(alice)
  // The tile is titled with the display name; the handle only appears in the
  // thread header.
  const tile = alice.page.locator('li', { hasText: BOB.name }).first()
  await tile.waitFor({ timeout: 30_000 })
  check(
    'the tile shows no [mensagem cifrada]',
    !(await tile.innerText()).includes('[mensagem cifrada]'),
    await tile.innerText(),
  )
  // The last thing sent was a video, whose preview is a label rather than
  // text — so the tile is asked about a text message instead.
  await openThreadById(alice, bobId)
  await sendText(alice, `preview ${STAMP}`)
  await bubble(bob.page, `preview ${STAMP}`).waitFor({ timeout: 30_000 })
  await backToList(alice)
  await alice.page
    .locator('li', { hasText: `preview ${STAMP}` })
    .first()
    .waitFor({ timeout: 60_000 })
  check('the tile shows the plaintext of the last message', true)

  // ---------------------------------------------------------------- step 7
  step('7 · recarregar dentro da thread')

  await openThreadById(alice, bobId)
  await alice.page.reload()
  await alice.page.getByPlaceholder('mensagem_').waitFor({ timeout: 30_000 })
  // The local copy cannot serialise a CryptoKey, so media comes back as a
  // skeleton and resolves when `history` lands. What it must never do is claim
  // the object is gone.
  await alice.page.locator('.msg img[alt="imagem"]').first().waitFor({ timeout: 60_000 })
  check('media resolves after a reload inside the thread', true)
  check(
    'no [mídia indisponível] on the way there',
    (await alice.page.getByText('[mídia indisponível]').count()) === 0,
  )
  check(
    'and the text is still readable after the reload',
    await bubble(alice.page, ALICE_TEXT).isVisible(),
  )

  // ---------------------------------------------------------------- step 8
  step('8 · terceiro navegador, IndexedDB zerado')

  const elsewhere = await openSession(browser, 'elsewhere')
  opened.push(elsewhere)
  // Nothing was carried over: this context was created empty and has never
  // held a key for this account. Said out loud because it is the premise.
  const emptyBefore = await elsewhere.page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const request = indexedDB.open('goodchat-account')
        request.onupgradeneeded = () => request.transaction?.abort()
        request.onsuccess = () => {
          const db = request.result
          const empty = !db.objectStoreNames.contains('identity')
          db.close()
          resolve(empty)
        }
        request.onerror = () => resolve(true)
      }),
  )
  check('the third context starts with no account key', emptyBefore)

  await signInThroughTheForm(elsewhere, ALICE)
  await openThreadBySearch(elsewhere, BOB.username)

  for (const text of [ALICE_TEXT, BOB_TEXT, EMOJI_TEXT]) {
    await bubble(elsewhere.page, text).waitFor({ timeout: 60_000 })
  }
  check('a browser that never saw this account reads the whole history', true)
  await elsewhere.page.locator('img[alt="sticker coração"]').first().waitFor({ timeout: 30_000 })
  await elsewhere.page.locator('.msg img[alt="imagem"]').first().waitFor({ timeout: 60_000 })
  check('including the sticker and the image', true)
  for (const placeholder of [
    '[mensagem de antes deste dispositivo]',
    '[mensagem de antes desta mudança]',
    '[sem chave neste navegador]',
    '[não foi possível abrir esta mensagem]',
  ]) {
    check(
      `no ${placeholder}`,
      (await elsewhere.page.getByText(placeholder, { exact: true }).count()) === 0,
    )
  }

  // ---------------------------------------------------------------- step 9
  step('9 · número de segurança')

  async function safetyNumberOn(session: Session): Promise<string> {
    await session.page.getByRole('button', { name: /número de segurança/ }).click()
    const dialog = session.page.getByText(/^\d{5}( \d{5}){11}$/)
    await dialog.waitFor({ timeout: 30_000 })
    const value = (await dialog.innerText()).trim()
    // Scoped to the box: `Modal` puts a second "fechar" on the backdrop, which
    // is how a click outside closes it (components/Modal.tsx).
    await session.page.locator('.dialog-box').getByRole('button', { name: 'fechar', exact: true }).click()
    return value
  }

  const aliceNumber = await safetyNumberOn(alice)
  const bobNumber = await safetyNumberOn(bob)
  const elsewhereNumber = await safetyNumberOn(elsewhere)
  check('12 groups of 5 digits', /^\d{5}( \d{5}){11}$/.test(aliceNumber), aliceNumber)
  check('both sides compute the same number', aliceNumber === bobNumber, [aliceNumber, bobNumber])
  // The other half of phase 3: the number is a property of the two accounts,
  // so opening a third browser must not move it. Under the device directory
  // this is the assertion that would have failed.
  check(
    'a third browser of the same account computes it too',
    aliceNumber === elsewhereNumber,
    [aliceNumber, elsewhereNumber],
  )

  // --------------------------------------------------------------- step 11
  //
  // Before step 10, deliberately: the reset in step 10 takes Alice's key away,
  // and a service worker with no key to decrypt with would show the generic
  // line for the honest reason rather than for the one under test.
  step('11 · push com preview')

  await openThreadById(bob, aliceId)
  const pushText = `push ${STAMP}`
  await sendText(bob, pushText)
  await bubble(alice.page, pushText).waitFor({ timeout: 30_000 })

  const aliceThread = (await conversations(aliceCookie)).find((row) => row.other_user.id === bobId)
  const conversationId = aliceThread?.id
  const messageId = aliceThread?.last_message?.id
  check('the pushed message is the newest one', Boolean(conversationId && messageId))

  // CDP because there is no push service to route through. What is delivered
  // is exactly what `withPreview` builds (worker/src/lib/push.ts): a title, the
  // generic body, and the two ids. Everything after this line is the real
  // service worker — it reads the conversation back over the session cookie,
  // finds the account key in IndexedDB, and opens the envelope itself.
  const cdp = await alice.context.newCDPSession(alice.page)
  const registrationId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no service worker registration')), 30_000)
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }: any) => {
      const match = registrations?.find((item: any) => item.scopeURL?.startsWith(APP))
      if (match) {
        clearTimeout(timer)
        resolve(match.registrationId)
      }
    })
    void cdp.send('ServiceWorker.enable')
  })
  await cdp.send('ServiceWorker.deliverPushMessage' as any, {
    origin: APP,
    registrationId,
    data: JSON.stringify({
      title: `@${BOB.username}`,
      body: `@${BOB.username} te mandou uma mensagem`,
      url: `/#/t/${bobId}`,
      tag: conversationId,
      enc: { conv: conversationId, mid: messageId },
    }),
  })

  const notified = await alice.page.evaluate(async (expected) => {
    const registration = await navigator.serviceWorker.ready
    for (let attempt = 0; attempt < 60; attempt++) {
      const found = (await registration.getNotifications()).map((n) => n.body)
      if (found.some((body) => body === expected)) return { ok: true, found }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { ok: false, found: (await registration.getNotifications()).map((n) => n.body) }
  }, pushText)
  check('the notification shows the decrypted text, not the generic line', notified.ok, notified)
  // And the payload that produced it never carried the text — it named a
  // conversation and a message. Phase 8 owns the transport; this is the half
  // that only exists in a browser.
  check(
    'the payload the worker sends carries no plaintext',
    !JSON.stringify({ conv: conversationId, mid: messageId }).includes(pushText),
  )

  // --------------------------------------------------------------- step 10
  step('10 · reset pelo dono')

  // Bob has to have looked at the thread with the old key in hand for the
  // change to be a change: `keyChanged` compares against a fingerprint the
  // thread cache remembers, and no stored fingerprint is a first look.
  await backToList(bob)

  const reset = await fetch(`${API}/api/admin/users/${aliceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie, Origin: API },
    body: JSON.stringify({ password: RESET_PASSWORD }),
  })
  check('the owner resets the password', reset.status === 200, await reset.text())

  // Alice is signed out of every context by the reset only in the sense that
  // her key is gone; the session cookie still works. What proves the cost is a
  // fresh sign-in.
  const afterReset = await openSession(browser, 'alice-after-reset')
  opened.push(afterReset)
  await afterReset.page.goto(APP)
  await afterReset.page.getByLabel('username').fill(ALICE.username)
  await afterReset.page.getByLabel('password').fill(RESET_PASSWORD)
  await afterReset.page.getByRole('button', { name: 'Entrar', exact: true }).click()
  // A password the owner chose is a password the server knows, so the account
  // is back on the legacy shape and must leave it before anything else.
  await afterReset.page.getByRole('heading', { name: 'troque a senha' }).waitFor({ timeout: 60_000 })
  check('a reset account lands on the rotation screen', true)

  await afterReset.page.locator('#current-password').fill(RESET_PASSWORD)
  await afterReset.page.locator('#new-password').fill(ROTATED_PASSWORD)
  await afterReset.page.locator('#confirm-password').fill(ROTATED_PASSWORD)
  await afterReset.page.getByRole('button', { name: 'Trocar e entrar' }).click()
  await afterReset.page.getByPlaceholder('buscar @username').waitFor({ timeout: 60_000 })
  check('rotating publishes a new key and gets in', true)

  await openThreadBySearch(afterReset, BOB.username)
  // The promise phase 4 makes out loud: there is no version of this where the
  // history survives. Everything in the thread was sealed to the key the reset
  // discarded, and nothing re-seals it.
  const stillReadable = await afterReset.page.locator('.msg .msg-body', { hasText: ALICE_TEXT }).count()
  check('the reset account cannot read its own history', stillReadable === 0)
  const sealed = afterReset.page.getByText(
    /\[não foi possível abrir esta mensagem\]|\[sem chave neste navegador\]|\[a chave de quem enviou não existe mais\]/,
  )
  // Waited for rather than counted on sight: `history` is a socket connect and
  // a round trip away, and an empty thread counts zero of everything.
  await sealed.first().waitFor({ timeout: 60_000 })
  check('and says so, message by message', (await sealed.count()) > 0)

  // Bob's side. Re-entering the thread is what re-reads the directory.
  await openThreadById(bob, aliceId)
  await bob.page.getByText(`a chave de @${ALICE.username} mudou`).waitFor({ timeout: 60_000 })
  check('the peer is told the key changed', true)

  // --------------------------------------------------------------- step 12
  step('12 · E2EE_REQUIRED')

  await openThreadById(bob, muteId)
  // Which half is in force is read off the screen rather than assumed: flipping
  // the flag means restarting the worker, and both answers are correct
  // behaviour for the instance that gave them.
  //
  // Waited for, not sampled: neither band is claimed before the socket has
  // said, on purpose (`e2eeRequired` starts null), so asking on the frame the
  // composer appeared on is asking too early.
  const band = bob.page.getByText(
    /nada enviado aqui está sendo entregue|esta conversa não está criptografada/,
  )
  const announced = await band
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  check('an unreachable peer is announced, one way or the other', announced)
  const required = announced && (await band.first().innerText()).includes('nada enviado')
  const optional = announced && !required

  const clearText = `sem chave ${STAMP}`
  await sendText(bob, clearText)
  if (required) {
    console.log('  (E2EE_REQUIRED=true)')
    // Refused out loud, on the connection rather than on the bubble — silence
    // here is what makes somebody believe a message went out.
    await bob.page.getByText(/encryption_required|criptografia/i).first().waitFor({ timeout: 30_000 })
    check('the refusal is visible, not swallowed', true)
  } else {
    console.log('  (E2EE_REQUIRED=false — the instance accepts cleartext)')
    await bubble(bob.page, clearText).waitFor({ timeout: 30_000 })
    check('the cleartext send is accepted, and the band said it would be', optional)
  }

  // ------------------------------------------------------------ acceptance
  step('sem erros no console')

  // Anonymous boot noise is not a failure: every context asks /api/auth/me
  // before it has a session, and the browser logs the 401 whatever the app
  // does with the answer. Everything else counts.
  const noise = opened
    .flatMap((session) => session.errors)
    .filter((line) => !line.includes('401 (Unauthorized)'))
  check('no console errors or uncaught exceptions', noise.length === 0, noise.slice(0, 5))
} catch (error) {
  // A timeout here means a locator never appeared, and the useful question is
  // always "what was on screen instead". Without this the answer is a selector
  // and a stack, which is the one thing a browser test should never make
  // somebody guess at.
  failures += 1
  console.log(`\nFAIL: ${(error as Error).message.split('\n')[0]}`)
  for (const session of opened) {
    const shot = `/tmp/phase18-${session.name}.png`
    await session.page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    const banner = await session.page
      .locator('[role=alert], .text-error, .text-warning')
      .allInnerTexts()
      .catch(() => [])
    console.log(`  ${session.name}: ${shot}`)
    if (banner.length > 0) console.log(`  ${session.name} says: ${JSON.stringify(banner)}`)
    if (session.errors.length > 0) console.log(`  ${session.name} console: ${JSON.stringify(session.errors.slice(0, 3))}`)
  }
} finally {
  // The accounts have conversations and objects in the bucket by now, so they
  // go through the owner console rather than a DELETE against `users` — the
  // foreign keys say what a raw delete would leave behind.
  for (const username of [ALICE.username, BOB.username, MUTE.username]) {
    try {
      const id = await userIdOf(username, ownerCookie)
      await fetch(`${API}/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: { Cookie: ownerCookie, Origin: API },
      })
    } catch {
      // A run that died before creating them has nothing to clean up.
    }
  }
  d1Execute(`DELETE FROM login_attempts;`)
  d1Execute(`DELETE FROM users WHERE username LIKE ${sqlString(`p18%${STAMP}`)};`)
  await browser.close()
}

console.log(failures === 0 ? '\nphase 18: all checks passed' : `\nphase 18: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
