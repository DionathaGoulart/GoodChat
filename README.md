# GoodChat

Private real-time 1:1 chat with a retro terminal look. Built on Cloudflare
Workers, Durable Objects, D1 and Backblaze B2. Ships as an installable PWA
with native web push notifications, all within free tiers.

## Features

- Real-time 1:1 messaging over WebSockets, with offline delivery and
  at-least-once semantics (client-side dedup by message id)
- Delivery states (sent, delivered, read) and a typing indicator
- Media messages: images and short videos, compressed and transcoded in the
  browser and uploaded directly to object storage (upload bytes never touch
  the server); the bucket stays private and reads are proxied by the Worker,
  which checks that the caller is a participant of the conversation the
  object belongs to
- Curated retro sticker pack and an emoji picker (pt-BR, self-hosted data)
- Settings screen: ten color palettes (four light, six dark) plus a
  light/dark/system mode, stored on the account so the choice follows the
  person across devices instead of living in one browser
- Owner console: accounts, storage per account (message bytes and bucket
  bytes), history purges, and on-demand maintenance
- Session auth: opaque tokens, HttpOnly Strict cookies, rate-limited login
  with no timing oracle, case-insensitive usernames
- Guest accounts: a throwaway account that lives 5 hours and then deletes
  itself with its data — while keeping the conversations whose other side is
  a permanent account, and taking a guest-to-guest thread with the last of
  the pair to expire
- Hardened by default: CSP with `frame-ancestors 'none'`, CORS allowlist,
  per-connection WebSocket rate limiting, per-account upload quotas, hourly
  cleanup of expired sessions, expired accounts and orphaned uploads
- Installable PWA: service worker, offline shell, VAPID web push with
  explicit opt-in
- Retro design system: ten daisyUI 5 custom themes sharing one geometry,
  JetBrains Mono, hard shadows, square corners, scanline and terminal cursor
  motifs

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
                      |- cron: hourly cleanup (sessions, orphan media)
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
.harness/   Product docs (PRD, style guide)
plan.md     Internal build log, kept in Portuguese
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
| `npm run smoke:phase3..10` | Smoke test suites (see Testing)             |
| `npm run typecheck`     | TypeScript check                               |
| `npm run deploy:full`   | Build the app and deploy the Worker            |

App (`cd app`):

| Script              | Purpose                    |
| ------------------- | -------------------------- |
| `npm run dev`       | Vite dev server, port 5173 |
| `npm run build`     | Production build           |
| `npm run typecheck` | TypeScript check           |
| `npm run lint`      | Oxlint                     |

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

## Documentation

| Document                                       | Content                                  |
| ---------------------------------------------- | ---------------------------------------- |
| [docs/architecture.md](docs/architecture.md)   | System design, data model, protocol      |
| [docs/development.md](docs/development.md)     | Local setup, workflows, conventions      |
| [docs/deployment.md](docs/deployment.md)       | Full production deployment guide         |
| [.harness/prd.md](.harness/prd.md)             | Product requirements                     |
| [.harness/styleguide.md](.harness/styleguide.md) | Visual design system                   |

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
