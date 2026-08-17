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

No public sign-up. Use the CLI, or the owner console once an owner exists:

```bash
cd worker
npm run user:create -- [--owner] <username> <password> [display name]
npm run user:role -- <username> <owner|user>    # promote or demote
```

Usernames match `^[a-z0-9_]{3,20}$`; passwords need at least 8 characters.

Migration 0003 grants the owner role to the `good` account if it exists.
For a local database, create it and sign in to reach `#/admin`:

```bash
npm run user:create -- --owner good good-goodchat Good
```

An owner can create, rename, disable, reset the password of and delete every
non-owner account from the UI, and see how much each one is storing.

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
npm run smoke:phase9   # headers, CORS, login timing, settings, owner console
npm run smoke:phase10  # guest accounts: quotas, expiry, deletion rules
```

`smoke:phase9` and `smoke:phase10` need the `good` owner account (see above)
and the media stub. Both create and delete their own throwaway accounts, and
phase 9 keeps its WebSocket flood inside the owner's own thread so the other
suites' fixtures stay clean. Phase 10 talks to D1 directly to force guest
expiry (five hours is a long wait) and to clear its own per-IP signup quota,
so it is rerunnable.
Run the suites against a freshly migrated database — a few of them assert on
state that earlier runs leave behind (`rm -rf worker/.wrangler/state`, then
migrate and seed again).

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
  never hardcoded values. A new palette touches three files that must
  agree: the theme block in `app/src/styles/themes.css`, the catalog entry
  in `app/src/lib/themes.ts`, and the id list in
  `worker/src/routes/settings.ts` (the worker rejects what it does not
  know).
- **Motion**: entrances are fade/slide with ease-out, 180-260ms, zero
  overshoot. No springs, bounce or elastic easing on appearing elements.
- **Protocol sync**: `app/src/lib/protocol.ts` is a manual copy of
  `worker/src/protocol.ts`. Change both together.
- **Ports**: backend 8000, frontend 5173, media stub 9000.
