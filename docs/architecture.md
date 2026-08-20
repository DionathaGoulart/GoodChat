# Architecture

System design reference for GoodChat. For product requirements see
[.harness/prd.md](../.harness/prd.md); for the visual system see
[.harness/styleguide.md](../.harness/styleguide.md) — the shared foundation and
the skin contract, with one style guide per skin under
[.harness/styleguides/](../.harness/styleguides/).

## Overview

```
Browser ---https---> Cloudflare Worker (single origin)
                      |- /api/*  REST + WebSocket upgrade
                      |            |-> ConversationAgent (one DO per chat)
                      |- /*      SPA static assets (Vite build, SPA fallback)
                      |- D1: users, sessions, conversations, push_subscriptions
                      |- Web Push -> FCM / Mozilla autopush / Apple
Browser ---PUT-----> Backblaze B2 (private bucket, presigned uploads)
Worker  ---GET-----> Backblaze B2 (signed reads, streamed back to the browser)
```

Design goals: 50-300ms end-to-end message latency, zero idle cost
(WebSocket Hibernation), zero infrastructure to operate, everything within
free tiers.

## Backend (worker/)

### HTTP API

All endpoints return JSON. Errors always use the shape
`{ "error": "<machine_code>", "message": "<optional human text>" }`.

| Method | Path                          | Auth | Purpose                                |
| ------ | ----------------------------- | ---- | -------------------------------------- |
| GET    | `/api/health`                 | no   | Liveness check                         |
| POST   | `/api/auth/login`             | no   | Session cookie from username/password  |
| POST   | `/api/auth/temp`              | no   | Guest account (expires) + session, credentials returned once |
| POST   | `/api/auth/logout`            | no   | Revoke session (idempotent)            |
| GET    | `/api/auth/me`                | yes  | Current user (includes `role`, the three theme fields, `skin` and `push_preview`) |
| PATCH  | `/api/settings`               | yes  | Appearance (`theme_mode`, `theme_light`, `theme_dark` per call; `skin` and `push_preview` optional, absent keeps the stored one) |
| POST   | `/api/presence`               | yes  | Heartbeat: marks the caller online and answers for the ids in the body it shares a conversation with |
| PATCH  | `/api/profile`                | yes  | Own display name and/or picture (`display_name`, `avatar_key` — both optional, `null` clears) |
| GET    | `/api/users/lookup?q=`        | yes  | Search by username — prefix, or exact for a guest account |
| GET    | `/api/conversations`          | yes  | List with preview and unread count     |
| POST   | `/api/conversations/resolve`  | yes  | Deterministic conversation id, no side effects |
| GET    | `/api/ws/:conversationId?with=` | yes | WebSocket upgrade, forwarded to the DO |
| POST   | `/api/media/upload-url`       | yes  | Presigned B2 PUT for a validated file  |
| GET    | `/api/media/<key>`            | yes  | Signed read-through proxy for the private bucket |
| GET    | `/api/push/vapid-public-key`  | no   | Public VAPID key for subscribing       |
| POST   | `/api/push/subscribe`         | yes  | Upsert a push subscription             |
| POST   | `/api/push/unsubscribe`       | yes  | Remove own push subscription           |

Owner console — every route additionally requires `role = 'owner'`:

| Method | Path                                     | Purpose                                    |
| ------ | ---------------------------------------- | ------------------------------------------ |
| GET    | `/api/admin/overview`                    | Instance totals, D1/DO and bucket bytes    |
| GET    | `/api/admin/users`                       | Accounts with their storage footprint      |
| POST   | `/api/admin/users`                       | Create an account                          |
| PATCH  | `/api/admin/users/:id`                   | Rename, reset password, disable, set role  |
| DELETE | `/api/admin/users/:id`                   | Delete the account and every thread it took part in |
| POST   | `/api/admin/users/:id/purge`             | Wipe every history it takes part in        |
| GET    | `/api/admin/conversations`               | Threads with participants and size         |
| POST   | `/api/admin/conversations/:id/purge`     | Wipe one thread for both sides             |
| POST   | `/api/admin/cleanup`                     | Run the maintenance sweep now              |
| POST   | `/api/admin/media/reindex`               | Backfill the media index from the DOs      |
| GET    | `/api/admin/audit`                       | The owner action trail (newest first)      |

CORS is an allowlist: an Origin is echoed (with `Allow-Credentials`, which
forbids the wildcard) only when it is the Worker's own origin or appears in
`ALLOWED_ORIGINS`. In production the SPA and the API share one origin, so
the list is empty and CORS is inert; local dev allow-lists the Vite server
on 5173.

Every response carries `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy` and `X-Frame-Options`;
over https it also carries HSTS. The SPA document and its assets are fetched
by the Worker from the `ASSETS` binding (`run_worker_first: true`) and
re-emitted with a `Content-Security-Policy` on top — served straight from
the asset server they would carry no CSP at all. `frame-ancestors 'none'`
is the clickjacking fix; `script-src 'self'` has no `unsafe-inline`, which
is what makes the policy worth having.

### Authentication and sessions

- Passwords: PBKDF2-SHA-256, 100k iterations, WebCrypto only. Workers caps
  `crypto.subtle` PBKDF2 at 100k iterations and free-tier CPU rules out
  scrypt/argon2; the tradeoff is accepted for a closed instance and
  documented in `worker/src/lib/password.ts`.
- Session tokens: opaque 256-bit values in a cookie set exactly as
  `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=N`. The database
  stores only the SHA-256 of the token, so a leaked database cannot mint
  sessions. Sliding 7-day expiry with a 30-day hard cap; refreshes are
  persisted only when they gain at least one hour.
- Login rate limiting: fixed 15-minute window in D1, 5 failures per
  account and 20 per IP. Blocked attempts return 429 with `Retry-After`.
  Every key derived from an address is a digest salted with `RATE_LIMIT_SALT`,
  never the address: a counter only has to be countable, and this table lives
  in the database the owner console reads.
- Other quotas share the same counter table, namespaced by key: guest
  signups per address per hour (`temp:<digest>`), presign requests per account
  per hour (`upload:<user id>`, 60), username searches (`lookup:<user id>`,
  200) and conversation-list reads (`conversations:<user id>`, 900 — one call
  wakes every conversation's Durable Object). All charge on success — those
  calls are expensive when they work, not when they fail.
- Permanent accounts are created by the owner (`npm run user:create` or the
  console). The only public way in is a guest account, below.

### Temporary (guest) accounts

`POST /api/auth/temp` mints a random `temp_<9 chars>` username and a
16-character password, stores `is_temp = 1` and
`expires_at = now + TEMP_ACCOUNT_TTL_HOURS` (5 by default), and signs the
browser in. The password is returned once and never recoverable. Being
unauthenticated, the endpoint is fenced three ways: a per-IP hourly quota
(`TEMP_ACCOUNTS_PER_IP_HOUR`), a ceiling on live guests
(`TEMP_ACCOUNTS_MAX`), and an off switch (`TEMP_ACCOUNTS_ENABLED`, surfaced
on `/api/health` so the login screen only offers what exists).

A guest is also the reason discovery is not uniform. Every account on the
instance is visible to every authenticated user (PRD §3.2), which was decided
when the only way in was an owner-created account. A guest is minted by
anybody, so from one, a prefix search is a free enumeration of the whole
directory — thirty-six single-letter queries and the list is out, with
`POST /api/presence` turning it into an activity graph on top. So a guest
searches by *exact* username (it has to already know the handle, which is the
case guest accounts exist for) and presence answers only for accounts the
caller shares a conversation with. Neither costs the interface anything: the
two screens that render presence both watch peers of existing conversations,
and a thread with no message yet paints the flag `resolve` already returned.

Access ends exactly at `expires_at`: `requireSession` and `login` both join
on it, and the session cookie is capped at the account's lifetime, so no
cookie outlives its account. The data is torn down by the hourly sweep
(`lib/accounts.ts`), which is where the interesting rule lives:

- a conversation whose other participant is still alive is **kept**,
  messages and media included — deleting a guest must not delete the
  permanent account's copy of the thread. Media follows the conversation,
  not the uploader;
- a conversation whose other participant is already gone is **destroyed**:
  the DO wipes its storage, the bucket objects go, the D1 row goes. Two
  guests talking means the second one to expire takes the thread with it;
- uploads that never became a message are always deleted; sessions and push
  subscriptions are deleted explicitly.

The `users` row is hard-deleted when nothing references it anymore.
Otherwise it survives as a **tombstone**: same id, `deleted_at` set, and
every credential and personal field stripped. It exists only so the
surviving side still has a thread to open — the UI renders "conta expirada",
`requireSession`/`login`/`lookup` refuse it, and the WebSocket route opens
that thread read-only (`x-goodchat-readonly`), so the DO answers a send with
`peer_unavailable` instead of storing a message nobody will ever read. A
tombstone whose last reference disappears later is collected by the same
sweep.

The `SameSite=Strict` cookie is the reason production serves the SPA from
the Worker: on a separate frontend origin the browser would never attach
the cookie.

### Conversations

`conversation_id = sha256("v1:" + min(idA, idB) + ":" + max(idA, idB))`
truncated to 128 bits (32 hex chars). Any pair of users maps to the same
id in any order. Conversation rows in D1 are created lazily on the first
persisted message via an idempotent upsert that also bumps
`last_message_at` and never moves it backwards.

### Realtime core (ConversationAgent)

One Durable Object per conversation, addressed by name with the
deterministic id. Hibernation is enabled, so idle conversations cost
nothing; per-connection identity survives hibernation in the WebSocket
attachment.

Trust model: the Worker route authenticates the session cookie, recomputes
the pair hash and stamps internal headers before forwarding. The DO
additionally pins the participant pair on first connect and closes any
third party with code 1008, even if the Worker were bypassed.

Wire protocol (Zod-validated in both directions):

| Direction | Frame            | Notes                                              |
| --------- | ---------------- | -------------------------------------------------- |
| client    | `send_message`   | `client_id` (UUID), `msg_type`, `body`, `media_key` |
| client    | `typing`         | Ephemeral, never persisted                          |
| client    | `read_receipt`   | `up_to_message_id`, marks everything up to it       |
| client    | `set_retention`  | Retunes the message window; either side may         |
| server    | `history`        | On connect: last 50 plus anything undelivered       |
| server    | `message`        | Full message; your own echo is the "sent" ack       |
| server    | `message_status` | `sent -> delivered -> read` transitions             |
| server    | `typing`         | Forwarded to the peer only (not your own tabs)      |
| server    | `read_receipt`   | Broadcast of the peer's read position               |
| server    | `retention`      | The window: on connect, and on every change         |
| server    | `messages_expired` | Ids just deleted by the retention sweep           |
| server    | `error`          | Validation errors; the socket stays open            |

Delivery semantics: at-least-once with dedup by `(sender_id, client_id)`
(unique index). If the peer has a live connection the message is stored and
broadcast as `delivered`; otherwise it is stored as `sent` and promoted to
`delivered` when the peer connects, which also notifies the sender.
Messages are kept in the DO's internal SQLite, one table per PRD 4.4.

### Message retention

Every message deletes itself `retention_ms` after it was written — the row in
the DO and the bucket object it referenced. The window belongs to the
conversation (3h, 5h, 12h, 1d, 3d, 5d, 7d; 7 days is the default and the
ceiling), is shared by both participants, and either of them can change it
from inside the thread. PRD §3.9 is the product spec; this is the mechanism.

Source of truth is the DO's `settings` table, because that is where the
messages are. D1's `conversations.retention_ms` mirrors it for the two things
that happen outside the object: the resolve endpoint, which labels the thread
before a socket exists, and the scheduled cleanup.

Three layers, so the promise does not depend on anyone being connected:

| Layer | When it runs | What it covers |
| ----- | ------------ | -------------- |
| Alarm (`expireTick`, one schedule at a time) | The moment the oldest message ages out | The normal case, including conversations nobody has open |
| Sweep on wake (`onStart`) and on connect | Every time the object runs code | Any request being served — no answer may contain a message past the window |
| Cron backstop (`lib/cleanup.ts`) | Every scheduled tick, bounded | Conversations holding *any* expired message (a lost alarm), and bucket objects whose delete failed. It scans `conversations.next_expiry_at` — the DO's mirror of when its oldest surviving message ages out — so a busy thread does not keep its old messages until the newest one expires; `swept_at` keeps idle threads from being poked twice |

Shortening is applied immediately, not only at the next deadline: the DO
sweeps the history the moment a shorter window lands, which is the entire
point of choosing one. Both sockets get `messages_expired` with the ids, so
an open thread drops them without a reload.

Clients enforce it too, since a tab can be offline while a message expires:
the thread filters what it paints against the window, and the local copies
(`threadCache`, the conversation-list previews) drop anything past it on both
read and write — plus one pass over every cached thread at boot, since read
and write only ever reach the conversation being opened.

Caches are the interesting part, because a cache is a copy with a clock of its
own. Four of them, all bounded:

| Copy | Bounded by |
| ---- | ---------- |
| `caches.default` (edge, shared) | `max-age` capped at the shortest window (3h) for `media/` keys, plus explicit eviction on every delete path (`lib/mediaGc.ts`) |
| Browser HTTP cache | The same ceiling on the `private` copy |
| `localStorage` (`threadCache`) | Window filter on read, on write, and once per boot |
| The device's notification centre | The push preview is generic by default, and the service worker closes a thread's notifications when `messages_expired` arrives |

### Media pipeline

1. Client requests `POST /api/media/upload-url` with MIME, size and `purpose`
   (`message`, the default, or `avatar`).
2. Worker validates session, MIME allowlist (`image/jpeg png webp gif`,
   `video/mp4 webm`) and size caps (8MB image, 32MB video), then returns a
   presigned S3-compatible PUT (aws4fetch). Content-Type and Content-Length
   are part of the signature, so the storage itself rejects mismatched bytes.
   An avatar is narrower on both axes — `image/jpeg png webp` only, 512KB —
   and gets a key under `avatars/` instead of `media/<yyyy-mm>/`. The prefix
   is chosen by the Worker, never sent by the client.
3. The presign is recorded in `media_objects` *before* the URL is handed
   out. That single row is what later authorizes the read, attributes the
   bytes to an account, and lets the sweep recognise an upload no message
   ever referenced.
4. Client compresses in the browser (see below), then uploads directly to
   the bucket with XHR progress.
5. The message carries only the object key; bubbles render from
   `/api/media/<key>`. Upload bytes never touch the Worker.
6. When the DO persists a message carrying a `media_key`, it claims the row
   for that conversation — only the uploader can claim, and only once.
7. Reads go through the Worker: the bucket is private, so
   `GET /api/media/<key>` checks the session, checks membership, signs a GET
   against B2 and streams the object back, forwarding `Range` so video
   seeking keeps working. Successful full responses are stored in the
   Cloudflare edge cache (`caches.default`), so a repeated view costs one
   Worker request and no B2 read. B2 → Cloudflare egress is free (Bandwidth
   Alliance), so the proxy adds no bandwidth cost.

   The cache key is built from the *object key*, not from the request URL:
   `?v=2` or a percent-encoded path would otherwise mint entries that no
   eviction could find. A `media/` object is cached for the shortest
   retention window rather than a year — it is temporary, not immutable —
   while `stickers/` and `avatars/` keep the year.
8. Deleting an object means deleting all three copies of it, in one place
   (`lib/mediaGc.ts`): the bucket object, the index row, then the edge copy.
   Every path goes through it — the DO's retention sweep, the conversation
   purge, the account teardown and the cron. The two that have no incoming
   request take the origin from `PUBLIC_ORIGIN`.
9. An object with no index row is refused under `media/` and `avatars/`: both
   prefixes are indexed at presign time, so a missing row means the object was
   deleted, not that it predates the index. `MEDIA_LEGACY_READS=allow` opens
   that door for older prefixes only, and is closed by default.

Profile pictures ride the same pipeline with different rules at every step:

- the object lives under `avatars/`, and `users.avatar_key` points at it
  (migration 0006 renamed `avatar_url`, which had never been written — the
  bucket is private, so a row can only hold a key, not a URL);
- `PATCH /api/profile` is what adopts an uploaded key: it accepts only an
  `avatars/` object this account presigned, and claims the index row.
  Without that check `avatar_key` would publish arbitrary bucket objects to
  the whole instance;
- read access is by adoption, not by conversation: a claimed avatar is
  readable by any session (it is rendered in search results, tiles and thread
  headers), an unclaimed one only by its uploader;
- the sweeps treat it as personal, not historical: retention skips
  `avatars/%`, the orphan sweep still collects avatars nobody adopted, and
  deleting an account takes its picture (which is also what lets the `users`
  row be hard-deleted instead of lingering as a tombstone);
- replacing or removing a picture deletes the old object, forgets its index
  row and evicts the edge copy, since objects are cached as immutable.

Compression, in `app/src/lib/media.ts`:

- images: resized to 1600px and re-encoded (WebP, JPEG fallback) to a ~600KB
  target. A bubble is a few hundred CSS pixels tall, so anything above that
  is detail nobody ever sees;
- video: the bucket's biggest consumer. Transcoded to 720p at ~1.5 Mbps via
  canvas + MediaRecorder, with the audio routed through a Web Audio
  `MediaStreamDestination` so the page stays silent. MediaRecorder timestamps
  by wall clock, so this runs in real time — which is why it only kicks in
  above ~2.4 Mbps or 1600px, and why WebCodecs is the natural next step;
- GIFs above 2MB are decoded frame by frame (`ImageDecoder`) and re-encoded
  as WebM, becoming video messages; smaller ones pass through as GIFs.

Every step falls back to uploading the original if the browser lacks the API
or the result comes out bigger than the source.

Authorization is membership, not obscurity: the index says which conversation
an object belongs to, and `conversations` says whether the caller is one of
its two participants. Keys are still `media/<yyyy-mm>/<uuid>.<ext>` —
month-prefixed for retention, unguessable as defense in depth. Objects
uploaded before migration 0003 have no index row; `MEDIA_LEGACY_READS`
decides whether those keep the old "any session" rule (`allow`, the default,
so existing threads keep rendering) or are refused (`deny`, after running
`POST /api/admin/media/reindex` once).

Maintenance runs hourly (`triggers.crons` → `scheduled` → `lib/cleanup.ts`):
expired sessions, stale rate-limit counters, expired guest accounts and
orphan tombstones, unclaimed uploads older than 24h, the per-conversation
retention backstop (both halves: idle conversations that still hold expired
messages, and their bucket objects), and — only when `MEDIA_RETENTION_DAYS`
is set — claimed media past that instance-wide age, which is an operator's
ceiling rather than the product's window. Each job is
bounded per run, deletes bucket objects before forgetting index rows (a
failed delete is retried instead of leaked), and bubbles whose object is
gone render a "mídia indisponível" placeholder.

Nothing in B2 expires on its own: every deletion above is an explicit S3
`DELETE` from the Worker. If the bucket keeps all versions (the B2 default),
those DELETEs only write hide markers and the bytes stay billable — set a
lifecycle rule that keeps only the last version.

Local development uses a fake-B2 stub (`npm run media:dev`), so no B2
account is required; it implements PUT, ranged GET, DELETE and ListObjectsV2.
The signing code is generic S3, so Cloudflare R2 works with the same
environment variables.

### Stickers

A curated pack of retro SVGs lives in `worker/assets/stickers/v1` with a
versioned JSON manifest, published to the media store under `stickers/v1/`.
Sticker messages carry the asset id in `body`; the DO validates the id
against a strict slug regex (the client builds URLs from it). The client
fetches the manifest once and renders stickers without bubble chrome.

### Web push

- Library: `@mmmike/web-push` (pure WebCrypto, RFC 8291 `aes128gcm`
  payload encryption, RFC 8292 VAPID, sends via `fetch`). It runs
  identically in workerd, Node scripts and the browser client.
- Subscriptions live in D1 (`push_subscriptions`), several per user.
  Endpoints are capability URLs and are never logged.
- Trigger: when a message is persisted and the recipient has no live
  connection, the DO schedules delivery with `waitUntil`, off the
  frame-processing path. Payload: sender username as title, a localized
  preview as body, the thread URL, and the conversation id as both the
  notification tag (device-side collapse) and the push topic (queue-side
  collapse while the device is offline).
- How much of the message goes in that body is the *recipient's* choice
  (`users.push_preview`, set from the settings screen), and the default is
  `generic` — "@alice te mandou uma mensagem". The transport is encrypted end
  to end and the push service reads nothing, but the notification's
  destination is the device's notification centre, which has no retention
  window: a preview shown there outlives the message it previews. For the
  same reason the page tells the service worker to close a thread's
  notifications the moment `messages_expired` arrives.
- Gone subscriptions (404/410 from the push service) are pruned; transient
  errors are logged and the row is kept.
- The service worker displays the notification and focuses or opens the
  right thread on click.

## Frontend (app/)

- `src/lib`: REST client (cookie credentials, uniform `ApiError`), a
  literal copy of the worker's `protocol.ts` (kept in sync by hand), hash
  router (`#/` list, `#/t/<userId>` thread, `#/config`, `#/admin`), media
  compression and transcoding, push opt-in flow, sticker manifest client.
- `src/hooks`: `useSession` (context provider, `me` on load, owns the
  account theme and profile, and boots stale-while-revalidate from the local
  account copy in `lib/accountCache.ts` so a reload paints the app instead of
  a boot screen), `useConversation` (the core: WebSocket with exponential
  backoff and jitter, history resync on reconnect, optimistic sends with
  client_id dedup, status rank so out-of-order frames never downgrade,
  offline queue, read receipts, typing with throttle), `useTheme`,
  `usePush`.
- `src/screens`: Login, Conversations (search, previews, unread badges,
  visible-only 15s poll), Thread (bubbles, receipts, typing line, composer
  with attach, emoji and sticker pickers), Settings (profile, theme, push,
  session), Admin (owner only).
- Loading feedback: every wait that has a known shape renders a skeleton of
  that shape (`src/components/Skeleton.tsx`) instead of a line of text — the
  conversation list, the thread being resolved, the owner console's totals
  and lists, and the cold-start boot. Motion is daisyUI's ambient sweep; one
  `role="status"` per screen names the wait and the boxes stay
  `aria-hidden`.
- Theming: every color exists once as a `--palette-*` token in
  `src/styles/palettes.css`; the ten daisyUI themes in
  `src/styles/themes.css` and the utilities consume tokens only. No hex
  values anywhere else. Entrance animations are fade/slide with ease-out
  only, no springs or overshoot.
- Presence: one heartbeat per tab (`src/lib/presence.ts`) POSTs the ids on
  screen to `/api/presence` every 25s while the tab is visible; the same call
  stamps `users.last_seen_at`, and "online" is a beat inside the 60s window
  (two beats wide, so one lost request does not blink anyone offline). The
  store is a module singleton read through `useSyncExternalStore`, so the list
  and an open thread can never disagree. REST payloads carry an `online` flag
  of their own, which is what the first paint uses before the first beat
  lands. Not the conversation DO: it only knows about its own thread, and the
  question is per account.
- Skins: the appearance preference has a second, independent axis — the
  geometry the palette is painted on, `data-skin` on `<html>`, catalogued in
  `src/lib/skins.ts` and defined in `src/styles/skins.css`. `retro` is the
  neobrutalist look the app shipped with (2px frames, hard offset shadow);
  `terminal` is the Portfolio terminal skin's geometry (1px frames, CRT glow,
  block caret, 4px scanline). A skin only redefines the tokens the `retro-*`
  utilities read, so no component knows which one is active, and the two axes
  multiply instead of adding: ten palettes × two skins. The rules are
  deliberately unlayered so they outrank Tailwind's utility layer — which is
  also why they must never touch a class a component pairs with a variant.
- Palettes: the preference is a mode (`light` / `dark` / null = follow the
  OS) plus which palette each mode uses — four light, six dark, catalogued
  in `src/lib/themes.ts` and offered by the appearance screen, which shows the
  shelf of the mode that is on screen — flipping the mode shows the other
  shelf, applied instead of previewed. The header button only moves the mode;
  each mode keeps its own palette. Ids are the
  Portfolio terminal palettes, so a palette means the same thing in both
  apps. It resolves in order account → local copy → catalog default: the
  account value is the source of truth and the local copy only exists so the
  first paint has no flash while `/api/auth/me` is in flight. "System" is a
  real state, not an alias for light, but it can no longer mean "pin
  nothing" — the OS says light or dark and does not know which of the four
  light palettes was picked, so the attribute is always pinned and a
  `matchMedia` listener repins it when the OS flips.
- PWA: `public/sw.js` caches hashed `/assets/` (cache-first) and the app
  shell as an offline fallback, never the API. `manifest.webmanifest` plus
  pixel-art icons generated from `public/icon.svg`.

## Data model

D1 (metadata):

| Table                | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `users`              | id, unique case-insensitive username, `display_name`, `avatar_key`, password hash, `role`, `theme_mode`, `theme_light`, `theme_dark`, `skin`, `push_preview`, `last_seen_at`, `created_by`, `disabled_at`, `is_temp`, `expires_at`, `deleted_at` |
| `sessions`           | SHA-256 of token, user, created/expires timestamps  |
| `conversations`      | Deterministic id, ordered pair, last_message_at, `retention_ms` (mirror of the DO's window), `next_expiry_at` (mirror of its oldest message's deadline), `swept_at` |
| `login_attempts`     | Rate-limit counters, keyed by purpose (login, guest signup, uploads), plus the hashed "this address has signed in to this account" rows that exempt a known address from the account lockout |
| `push_subscriptions` | Endpoint (PK), user, p256dh, auth                   |
| `media_objects`      | Every presigned object: uploader, conversation, mime, size, claim timestamp |
| `admin_audit`        | One row per mutating owner action: actor, action, target, details, timestamp |

Durable Object SQLite (per conversation):

| Table          | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `messages`     | id, client_id, sender, type, body, media_key, status     |
| `participants` | The pinned user pair, defense in depth for connections   |
| `settings`     | The retention window, the id of the expiry alarm, and what the D1 mirrors were last known to hold |

## Roles

Two roles, in `users.role`. `user` is everyone; `owner` additionally reaches
`/api/admin/*`. Migration 0003 grants it to the `good` account; any other
instance names its owner with `npm run user:role -- [--remote] <user> owner`.
There is no bootstrap endpoint on purpose — promoting an account is a D1
write, and D1 writes need the deploy key.

An owner administers every account except another owner, and cannot disable,
demote or delete itself (that would lock the instance out of its own
console). `created_by` records who provisioned an account. Disabling is a
soft delete: `requireSession` joins on `disabled_at IS NULL`, so every live
session of that account dies on its next request, it disappears from user
search, and nobody can open a thread with it.

`DELETE /api/admin/users/:id` is the blunt instrument, on purpose: an owner
asking for an account to disappear destroys every thread it took part in,
the other participants' copies included. The guest expiry is the careful one
and keeps those threads — see "Temporary (guest) accounts".

Every mutating admin call writes a row to `admin_audit` (actor, action,
target, timestamp, a small JSON detail — never content or credentials), shown
in the console newest first; reads write nothing. The reason is the one power
that is not otherwise visible: an owner can reset a non-owner's password and
sign in as them, and what the account holder sees is being signed out, which
looks like an expired session. So the reset is also pushed to that account as
a notification, and the trail makes a stolen owner session distinguishable
from the owner working.

The console reports storage from two sides, because they are two different
systems: message payload comes from each conversation's DO (attributed to
the sender, with the DO's real SQLite page count reported per conversation),
and bucket bytes come from `media_objects.size` — the signed Content-Length
B2 enforced on upload, so no bucket listing is needed. The overview does
list the bucket once, so the drift between what the index knows and what B2
actually holds is visible rather than hidden.

Both storage tiles read `spent / total`: the totals come from
`DO_STORAGE_LIMIT_GB` and `B2_STORAGE_LIMIT_GB` (defaults 5 and 10, the free
tiers) and are display only — nothing rejects a write when they are reached.
Setting either to `0` drops the total and shows plain usage again.

## Security notes

- All user content is rendered as text, never as HTML, with a CSP whose
  `script-src` has no `unsafe-inline` as the backstop.
- Server-side validation at every boundary: Zod on REST bodies and every
  WebSocket frame, MIME and size checks on uploads, slug check on sticker
  ids, https-only check on push endpoints (stored endpoints are outbound
  fetch targets, so this is an SSRF guard).
- Login costs the same whether or not the account exists: an unknown
  username still pays a full PBKDF2 derivation, so response time is not an
  enumeration oracle. Rate limiting stays on top (5/15min per account,
  20/15min per IP).
- WebSocket frames are rate limited per connection with two token buckets
  (persisted messages 20 burst / 2 per second, typing and receipts 40 / 8).
  A client that keeps hammering past 20 consecutive refusals is
  disconnected rather than answered.
- Media reads require conversation membership, not just a valid session, and
  a key whose index row is gone is refused rather than treated as legacy.
- The WebSocket handshake checks `Origin` against the same allowlist CORS
  uses. `SameSite=Strict` already covers it in every current browser; this
  removes the trap armed for the day that has to change.
- Presence timestamps are published rounded down to the minute: the endpoint
  answers for any account id, and the raw value would let anyone poll an
  activity graph of anyone.
- An address that has signed in successfully to an account is exempt from
  that account's failure lockout (its own per-IP limit still applies), so a
  discoverable username cannot be used to keep its owner locked out.
- Session tokens and push endpoints are treated as secrets: hashed at rest
  or excluded from logs.

### What this is not

There is no end-to-end encryption. Messages are stored as plain text in each
conversation's Durable Object, and media is stored unencrypted in the
bucket. Transport is TLS and the platform encrypts its disks, but whoever
controls the Cloudflare account can read every conversation. That is a
deliberate trade — the push preview, the owner console's storage accounting
and history purges all depend on the server being able to read content —
and it is written down here so "private chat" is not mistaken for E2EE.

Adding it later is tractable for fixed 1:1 threads (X25519 per account,
ECDH to a conversation key, AES-256-GCM per message, all WebCrypto), and
the costs are the interesting part: push previews become generic, history
is unrecoverable without a password-wrapped key backup, multi-device needs
key sync or per-device fan-out, and media has to be encrypted client-side
before upload. Forward secrecy would additionally require a ratchet.
