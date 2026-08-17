# Development guide

Local setup, daily workflows and project conventions.

## Prerequisites

- Node.js 24 or newer (scripts rely on native TypeScript type stripping)
- npm (ships with Node)

No accounts are required for local development: D1 runs locally through
wrangler, media uses a bundled fake-B2 stub, and dev VAPID keys are easy to
generate.

## First-time setup

```bash
# Backend
cd worker
npm install
npm run db:migrate      # apply migrations to the local D1 database
npm run db:seed         # create test users (idempotent)

# Frontend
cd ../app
npm install
```

Seed users: `alice` / `alice-goodchat` and `bob` / `bob-goodchat`.

Web push needs VAPID keys in `worker/.dev.vars` (gitignored). Generate a
pair once and paste the output:

```bash
cd worker
npm run vapid:generate
```

Without them the app works normally and the push toggle reports that push
is not configured.

## Running

Three processes, one terminal each:

| Terminal | Command                          | Port | Purpose             |
| -------- | -------------------------------- | ---- | ------------------- |
| 1        | `cd worker && npm run dev`       | 8000 | API, WS, DO, D1     |
| 2        | `cd worker && npm run media:dev` | 9000 | Fake-B2 media store |
| 3        | `cd app && npm run dev`          | 5173 | Vite dev server     |

Publish the sticker pack to the media stub once per fresh store:

```bash
cd worker && npm run stickers:publish
```

Open http://localhost:5173 in two browser profiles and chat between the
seed users. The backend always runs on port 8000; the frontend reads
`VITE_API_URL` (defaults to `http://localhost:8000`).

## Environment files

| File               | Tracked | Purpose                                        |
| ------------------ | ------- | ---------------------------------------------- |
| `worker/.dev.vars` | no      | Local secrets: fake-B2 config, dev VAPID keys  |
| `worker/.env.example` | yes  | Documentation of every backend variable        |
| `app/.env.example` | yes     | Documentation of frontend variables            |
| `app/.env.production` | yes  | Production build config (no secrets)           |

`wrangler.jsonc` holds non-secret bindings (D1, Durable Object, assets).
After changing it, regenerate types: `npm run cf-typegen`.

## Creating accounts

No public sign-up. Use the CLI:

```bash
cd worker
npm run user:create -- <username> <password> [display name]
```

Usernames match `^[a-z0-9_]{3,20}$`; passwords need at least 8 characters.

## Testing

Smoke suites are plain Node scripts, no test framework. They need the dev
server on port 8000 with a seeded database:

```bash
cd worker
npm run smoke:phase3   # lookup + conversation resolution
npm run smoke:phase4   # realtime: delivery, dedup, receipts, typing
npm run smoke:phase6   # media pipeline (starts its own stub if needed)
npm run smoke:phase7   # stickers, emoji, typing broadcast
npm run smoke:phase8   # web push: crypto roundtrip, REST, DO trigger
```

Each script prints per-check results and exits non-zero on failure. Type
checks: `npm run typecheck` in both packages. Lint (app): `npm run lint`.

## Database changes

1. Add a numbered file in `worker/migrations/` (e.g. `0003_thing.sql`).
2. Apply locally: `npm run db:migrate`.
3. In production: `npx wrangler d1 migrations apply goodchat --remote`.

Wiping local state: delete `worker/.wrangler/state`, then migrate and seed
again.

## Conventions

- **Commits**: Conventional Commits in English
  (`type(scope): imperative subject`), body only when the why is not
  obvious. No AI co-author trailers.
- **TypeScript**: strict mode everywhere, no `any`. Zod validates every
  API and protocol boundary.
- **Styling**: colors exist once, as `--palette-*` tokens in
  `app/src/styles/palettes.css`. Components consume theme tokens only,
  never hardcoded values.
- **Motion**: entrances are fade/slide with ease-out, 180-260ms, zero
  overshoot. No springs, bounce or elastic easing on appearing elements.
- **Protocol sync**: `app/src/lib/protocol.ts` is a manual copy of
  `worker/src/protocol.ts`. Change both together.
- **Ports**: backend 8000, frontend 5173, media stub 9000.
