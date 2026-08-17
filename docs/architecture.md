# Architecture

System design reference for GoodChat. For product requirements see
[.harness/prd.md](../.harness/prd.md); for the visual system see
[.harness/styleguide.md](../.harness/styleguide.md).

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
| POST   | `/api/auth/logout`            | no   | Revoke session (idempotent)            |
| GET    | `/api/auth/me`                | yes  | Current user                           |
| GET    | `/api/users/lookup?q=`        | yes  | Prefix search by username              |
| GET    | `/api/conversations`          | yes  | List with preview and unread count     |
| POST   | `/api/conversations/resolve`  | yes  | Deterministic conversation id, no side effects |
| GET    | `/api/ws/:conversationId?with=` | yes | WebSocket upgrade, forwarded to the DO |
| POST   | `/api/media/upload-url`       | yes  | Presigned B2 PUT for a validated file  |
| GET    | `/api/media/<key>`            | yes  | Signed read-through proxy for the private bucket |
| GET    | `/api/push/vapid-public-key`  | no   | Public VAPID key for subscribing       |
| POST   | `/api/push/subscribe`         | yes  | Upsert a push subscription             |
| POST   | `/api/push/unsubscribe`       | yes  | Remove own push subscription           |

CORS is applied centrally and reflects the request Origin (the session
cookie requires `Allow-Credentials`, which forbids the wildcard). In
production the SPA and the API share one origin, so CORS is mostly inert.

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
- Account creation is CLI-only (`npm run user:create`), no public sign-up.

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
| server    | `history`        | On connect: last 50 plus anything undelivered       |
| server    | `message`        | Full message; your own echo is the "sent" ack       |
| server    | `message_status` | `sent -> delivered -> read` transitions             |
| server    | `typing`         | Forwarded to the peer only (not your own tabs)      |
| server    | `read_receipt`   | Broadcast of the peer's read position               |
| server    | `error`          | Validation errors; the socket stays open            |

Delivery semantics: at-least-once with dedup by `(sender_id, client_id)`
(unique index). If the peer has a live connection the message is stored and
broadcast as `delivered`; otherwise it is stored as `sent` and promoted to
`delivered` when the peer connects, which also notifies the sender.
Messages are kept in the DO's internal SQLite, one table per PRD 4.4.

### Media pipeline

1. Client requests `POST /api/media/upload-url` with MIME and size.
2. Worker validates session, MIME allowlist (`image/jpeg png webp gif`,
   `video/mp4 webm`) and size caps (8MB image, 32MB video), then returns a
   presigned S3-compatible PUT (aws4fetch). Content-Type and Content-Length
   are part of the signature, so the storage itself rejects mismatched bytes.
3. Client compresses images in the browser (canvas, WebP with JPEG
   fallback, target ~1.5MB, GIFs pass through), validates video duration
   (max 60s), uploads directly to the bucket with XHR progress.
4. The message carries only the object key; bubbles render from
   `/api/media/<key>`. Upload bytes never touch the Worker.
5. Reads do: the bucket is private, so `GET /api/media/<key>` checks the
   session cookie, signs a GET against B2 and streams the object back,
   forwarding `Range` so video seeking keeps working. Successful full
   responses are stored in the Cloudflare edge cache (`caches.default`,
   immutable), so a repeated view costs one Worker request and no B2 read.
   B2 → Cloudflare egress is free (Bandwidth Alliance), so the proxy adds
   no bandwidth cost.

Keys are `media/<yyyy-mm>/<uuid>.<ext>`: prefixed by month to make future
retention trivial, and unguessable — which matters because the access rule
is "any valid session", not "a participant of that conversation" (the
message rows live inside each Durable Object, so the Worker cannot check
membership without asking the DO). The bucket being private is what keeps a
leaked key from outliving the session check.

Local development uses a fake-B2 stub (`npm run media:dev`), so no B2
account is required. The signing code is generic S3, so Cloudflare R2 works
with the same environment variables.

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
- Gone subscriptions (404/410 from the push service) are pruned; transient
  errors are logged and the row is kept.
- The service worker displays the notification and focuses or opens the
  right thread on click.

## Frontend (app/)

- `src/lib`: REST client (cookie credentials, uniform `ApiError`), a
  literal copy of the worker's `protocol.ts` (kept in sync by hand), hash
  router (`#/` list, `#/t/<userId>` thread), media compression, push
  opt-in flow, sticker manifest client.
- `src/hooks`: `useSession` (context provider, `me` on load),
  `useConversation` (the core: WebSocket with exponential backoff and
  jitter, history resync on reconnect, optimistic sends with client_id
  dedup, status rank so out-of-order frames never downgrade, offline
  queue, read receipts, typing with throttle), `useTheme`, `usePush`.
- `src/screens`: Login, Conversations (search, previews, unread badges,
  visible-only 15s poll), Thread (bubbles, receipts, typing line, composer
  with attach, emoji and sticker pickers).
- Theming: every color exists once as a `--palette-*` token in
  `src/styles/palettes.css`; daisyUI themes and utilities consume tokens
  only. No hex values anywhere else. Entrance animations are fade/slide
  with ease-out only, no springs or overshoot.
- PWA: `public/sw.js` caches hashed `/assets/` (cache-first) and the app
  shell as an offline fallback, never the API. `manifest.webmanifest` plus
  pixel-art icons generated from `public/icon.svg`.

## Data model

D1 (metadata):

| Table                | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `users`              | id, unique case-insensitive username, password hash |
| `sessions`           | SHA-256 of token, user, created/expires timestamps  |
| `conversations`      | Deterministic id, ordered pair, last_message_at     |
| `login_attempts`     | Rate-limit counters per account and per IP          |
| `push_subscriptions` | Endpoint (PK), user, p256dh, auth                   |

Durable Object SQLite (per conversation):

| Table          | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `messages`     | id, client_id, sender, type, body, media_key, status     |
| `participants` | The pinned user pair, defense in depth for connections   |

## Security notes

- All user content is rendered as text, never as HTML.
- Server-side validation at every boundary: Zod on REST bodies and every
  WebSocket frame, MIME and size checks on uploads, slug check on sticker
  ids, https-only check on push endpoints (stored endpoints are outbound
  fetch targets, so this is an SSRF guard).
- Session tokens and push endpoints are treated as secrets: hashed at rest
  or excluded from logs.
