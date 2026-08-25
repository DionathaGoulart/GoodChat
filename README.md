# GoodChat

Private real-time 1:1 chat with a retro terminal look. Built on Cloudflare
Workers, Durable Objects, D1 and Backblaze B2. Ships as an installable PWA
with native web push notifications, all within free tiers.

It is not built to keep conversations. Every message deletes itself — from the
database and from the bucket — within at most seven days, and a conversation
can choose as little as three hours. Messages and their attachments are
end-to-end encrypted: the server routes and expires what it cannot read.

## Features

- End-to-end encryption, per account: a random content key per message,
  wrapped by ECDH for the two people in the conversation, so the server stores
  ciphertext and holds no key that opens it. Your key is generated in a
  browser and stored encrypted under a key derived from your password — which
  never reaches the server — so signing in anywhere opens the whole history,
  with nothing to pair and nothing to scan. Attachments are sealed before they
  reach the bucket, push previews are decrypted by the service worker, and a
  safety number in the thread catches a swapped key. Three things follow from
  this and are worth knowing before you rely on it:
  - **Lose the password, lose the history.** There is no recovery, by
    construction: there is nothing on the server that could perform one.
  - **A weak password is the weak link.** Somebody holding a copy of the
    database can attack it offline, without a rate limiter. Twelve characters
    minimum, and the app shows you how you are doing.
  - **No forward secrecy.** ECDH is static, so a key that leaks opens what that
    account could read — bounded by the seven-day ceiling below, and in
    practice by the three hours after a message is read.
- Real-time 1:1 messaging over WebSockets, with offline delivery and
  at-least-once semantics (client-side dedup by message id)
- Delivery states (sent, delivered, read) and a typing indicator
- Media messages: images and short videos, compressed and transcoded in the
  browser and uploaded directly to object storage (upload bytes never touch
  the server); the bucket stays private and reads are proxied by the Worker,
  which checks that the caller is a participant of the conversation the
  object belongs to
- Curated retro sticker pack and an emoji picker (pt-BR, self-hosted data)
- Settings screen: a profile card (display name and picture), ten color
  palettes (four light, six dark) plus a light/dark/system mode. All of it is
  stored on the account, so the choices follow the person across devices
  instead of living in one browser; the palette shelf shows the palettes of
  the mode that is on screen
- Owner console: accounts, storage per account (message bytes and bucket
  bytes), history purges, on-demand maintenance, and an audit trail of every
  owner action that changed something
- Session auth where the password stays in the browser: it is stretched with
  600k PBKDF2 iterations locally and only a derived token is posted, so the
  server verifies a login without ever holding something that could unwrap a
  message. Opaque session tokens, HttpOnly Strict cookies, rate-limited login
  with no timing oracle, case-insensitive usernames, and a self-service
  password change that re-seals the account key and signs every other device
  out — the counters store a salted digest of the caller's address, never the
  address
- Disappearing messages, on a clock the reader starts: every message deletes
  itself — from the database, the bucket and every cache that copied it —
  three hours after the recipient reads it, and in seven days if they never
  do. One rule, the same in every conversation, and one row on the server, so
  both sides watch the same countdown and lose it in the same second. The
  thread says so: a read message counts down, fades over its last five minutes
  and then folds out of the column. What "read" means is deliberately
  expensive to earn — decrypted text on screen, half the bubble visible, the
  window focused, held for a second — because a read is what deletes
- Notifications that do not outlive the message: the push preview is generic
  by default ("@alice te mandou uma mensagem"), because a notification lands
  in a place the expiry clock cannot reach
- Guest accounts: a throwaway account with no password at all, which lives
  three hours and deletes itself with its data the moment you sign out —
  while keeping the conversations whose other side is a permanent account, and
  taking a guest-to-guest thread with the last of the pair to expire. With no
  password there is nothing to wrap a key under, so a guest's key never leaves
  the tab that made it
- Hardened by default: CSP with `frame-ancestors 'none'`, CORS allowlist,
  per-connection WebSocket rate limiting, per-account upload quotas, hourly
  cleanup of expired sessions, expired accounts and orphaned uploads
- Installable PWA: service worker, offline shell, VAPID web push with
  explicit opt-in
- Presence: a heartbeat while the tab is visible says who is online, shown on
  the conversation list and in the thread header — which reports the person
  you are writing to, and falls back to the link state only when your own
  socket is the thing that is down
- Retro design system: two skins (neobrutalist and terminal) × ten daisyUI 5
  custom themes, JetBrains Mono, square corners, scanline and terminal cursor
  motifs, and skeleton placeholders shaped like the content they stand in for
  (list, thread, console) so a wait never shifts the layout

## Tech stack

| Layer     | Technology                                                    |
| --------- | ------------------------------------------------------------- |
| Frontend  | React 19, Vite, TypeScript, Tailwind CSS 4, daisyUI 5          |
| Backend   | Cloudflare Workers, Agents SDK (Durable Objects), TypeScript   |
| Realtime  | WebSockets with Hibernation (one Durable Object per chat)      |
| Database  | Cloudflare D1 (metadata) plus per-conversation DO SQLite       |
| Storage   | Backblaze B2 (private), presigned S3 uploads + proxied reads   |
| Push      | Web Push (RFC 8291/8292) via @mmmike/web-push                  |
| Validation| Zod at every API and protocol boundary                         |

## Architecture

```
Browser ---https---> Cloudflare Worker
                      |- /api/*  REST + WebSocket upgrade -> Durable Objects
                      |- /*      SPA (assets re-emitted with the CSP)
                      |- D1: users, sessions, conversations, media index,
                      |      push subscriptions, rate-limit counters
                      |- cron: hourly cleanup (sessions, orphan media,
                      |        retention backstop)
                      |- Web Push -> FCM / Mozilla / Apple
Browser ---PUT-----> Backblaze B2 (private bucket, presigned uploads)
Worker  ---GET-----> Backblaze B2 (signed reads, streamed at /api/media/<key>)
```

Full details in [docs/architecture.md](docs/architecture.md).

## Repository layout

```
app/        React SPA (Vite)
worker/     Cloudflare Worker: API, WebSockets, Durable Object, D1, scripts
docs/       Architecture, development and deployment guides
.harness/   Product docs: the PRD, the shared style-guide index, and
            styleguides/ — one per skin
```

## Quickstart

Requirements: Node.js 24 or newer.

```bash
# Terminal 1: backend (port 8000)
cd worker
npm install
npm run db:migrate    # apply D1 migrations locally
npm run db:seed       # create test users alice and bob
npm run dev

# Terminal 2: local media store stub (port 9000, no B2 account needed)
cd worker
npm run media:dev
npm run stickers:publish   # once, publishes the sticker pack to the stub

# Terminal 3: frontend (port 5173)
cd app
npm install
npm run dev
```

Open http://localhost:5173 in two browsers or profiles and sign in as
`alice` / `alice-goodchat` and `bob` / `bob-goodchat`.

For the owner console (`#/admin`), create the owner account once:

```bash
cd worker
npm run user:create -- --owner good good-goodchat Good
```

## Scripts

Worker (`cd worker`):

| Script                  | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `npm run dev`           | Dev server on port 8000                        |
| `npm run db:migrate`    | Apply D1 migrations (local)                    |
| `npm run db:seed`       | Seed test users (idempotent)                   |
| `npm run user:create`   | Create an account: `-- [--remote] [--owner] <user> <pass> [name]` |
| `npm run user:role`     | Set a role: `-- [--remote] <user> <owner\|user>` |
| `npm run media:dev`     | Fake-B2 media store on port 9000               |
| `npm run stickers:publish` | Publish sticker pack to the media store     |
| `npm run vapid:generate`| Generate a VAPID key pair for web push         |
| `npm run smoke:phase3..18` | Smoke test suites (see Testing)             |
| `npm run typecheck`     | TypeScript check                               |
| `npm run deploy:full`   | Build the app and deploy the Worker            |

App (`cd app`):

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `npm run dev`       | Vite dev server, port 5173 |
| `npm run build`     | Production build           |
| `npm run typecheck` | TypeScript check           |
| `npm run lint`      | Oxlint                     |
| `npm run check:expiry` | The expiry display rules (§3.9), against a fixed clock — no server, no browser |

## Testing

Smoke suites run against a live dev server (port 8000, seeded database):

| Suite           | Covers                                                     |
| --------------- | ---------------------------------------------------------- |
| `smoke:phase3`  | User lookup, deterministic conversation resolution         |
| `smoke:phase4`  | WebSocket handshake, delivery, dedup, receipts, typing     |
| `smoke:phase6`  | Media presign validation, upload roundtrip, realtime flow  |
| `smoke:phase7`  | Stickers, emoji persistence, typing broadcast              |
| `smoke:phase8`  | Web push: aes128gcm roundtrip with decrypt, REST, trigger  |
| `smoke:phase9`  | Security headers, CORS, login timing, settings, owner console |
| `smoke:phase10` | Guest accounts: quotas, expiry, deletion keeping the peer's history |
| `smoke:phase11` | Profile: display name, avatar upload rules, adoption, read access, replacement |
| `smoke:phase12` | Presence: heartbeat, online window, presence on the listing endpoints, skin preference |
| `smoke:phase13` | Retention: the deadline a new message carries, the read that pulls it in to three hours, both sides being told the same moment, the D1 mirror, and the three refusals that make reading safe to be destructive |
| `smoke:phase14` | The copies of a message: cache ceilings per prefix, a key whose index row is gone, deletion taking bucket and index together, the deadline the cron scans by, `media_key` validation, the WebSocket Origin check, the push preview preference, the owner audit trail, the login lockout exemption |
| `smoke:phase15` | The account envelope, against a second implementation of the wire format written from the docs rather than imported: the key directory, a message the two participants open and nobody else does, the binding that stops it being moved or replayed, ciphertext in the Durable Object and in the bucket, the content key that opens both a message and its attachment, the push preview the service worker decrypts, the safety number, and both sides of `E2EE_REQUIRED` |
| `smoke:phase16` | The app's own crypto, executed: `app/src/lib/e2ee.ts` and the service worker's copy of the key derivation, cross-checked against phase 15's independent implementation in both directions — the app opens what the reference sealed and the reference opens what the app sealed |
| `smoke:phase17` | Where the key comes from: nothing the wrapping key derives from appears in any request the client sends, a copy of D1 plus the token the server verifies does not open the wrapped account key, a browser with an empty key store signs in with the password alone and reads the whole history, and `/api/auth/kdf` answers a nonexistent username with the same salt every time |
| `smoke:phase18` | The conversation itself, in three isolated Chromium profiles: the twelve steps of the manual pass, driven by Playwright — text both ways with a closed lock, ciphertext on the wire, sticker art and emoji, an image the app renders and the proxy will not, a video that plays, list previews, a reload inside a thread, a browser that has never seen the account reading the whole history, a safety number that does not move when it opens, a push the service worker decrypts, an owner reset and what it costs, and whichever half of `E2EE_REQUIRED` the instance is running. Needs the app on :5173 as well |

## Documentation

| Document                                       | Content                                  |
| ---------------------------------------------- | ---------------------------------------- |
| [docs/architecture.md](docs/architecture.md)   | System design, data model, protocol      |
| [docs/development.md](docs/development.md)     | Local setup, workflows, conventions      |
| [docs/deployment.md](docs/deployment.md)       | Full production deployment guide         |
| [.harness/prd.md](.harness/prd.md)             | Product requirements                     |
| [.harness/styleguide.md](.harness/styleguide.md) | Shared visual foundation + how skins work |
| [.harness/styleguides/retro.md](.harness/styleguides/retro.md) | Style guide of the `retro` skin (default) |
| [.harness/styleguides/terminal.md](.harness/styleguides/terminal.md) | Style guide of the `terminal` skin |

## Deployment

Everything runs within Cloudflare and Backblaze free tiers. The SPA is
served by the Worker itself on a single origin (required by the strict
session cookie). Pushes to `main` are typechecked, linted and built by
`.github/workflows/deploy.yml` before `wrangler deploy` runs. See
[docs/deployment.md](docs/deployment.md) for the step-by-step guide.

## License

Licensed under the GoodChat Attribution License v1.0 (see [LICENSE](LICENSE)).

Free to use, modify and deploy, including commercially, as long as credit
is given. In short:

- Keep the copyright notice and license in the source code.
- Public repositories of forks must credit "Based on GoodChat by
  Dionatha Goulart" in their README.
- Deployed products must show "Built with GoodChat by Dionatha Goulart" in
  a persistent footer, at 12px minimum, legible, linking to
  https://dionatha.com.br:

```html
<footer>
  <a href="https://dionatha.com.br">
    Built with GoodChat by Dionatha Goulart
  </a>
</footer>
```

See the [LICENSE](LICENSE) file for the exact requirements.
