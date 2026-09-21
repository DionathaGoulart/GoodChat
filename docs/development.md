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
cp .env.example .dev.vars   # local config: fake-B2 stub, CORS for :5173
npm run db:migrate      # apply migrations to the local D1 database
npm run db:seed         # create test users (idempotent)

# Frontend
cd ../app
npm install
```

`worker/.dev.vars` (gitignored) overrides the `vars` in `wrangler.jsonc` for
`wrangler dev`; without it the local Worker runs with the production values —
no CORS for the Vite server on :5173, and the real B2 endpoint instead of the
stub on :9000.

Seed users: `alice` / `alice-goodchat` and `bob` / `bob-goodchat`.

Web push needs VAPID keys in that same `worker/.dev.vars`. Generate a pair
once and paste the output:

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
| `worker/.dev.vars` | no      | Local config, copied from `worker/.env.example`: fake-B2 stub, CORS for :5173, dev VAPID keys |
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

Usernames match `^[a-z0-9_]{3,20}$`; passwords need at least 12 characters.

Migration 0003 grants the owner role to the `good` account if it exists.
For a local database, create it and sign in to reach `#/admin`:

```bash
npm run user:create -- --owner good good-goodchat Good
```

An owner can create, rename, disable, reset the password of and delete every
non-owner account from the UI, and see how much each one is storing.

## Testing

Smoke suites are plain Node scripts, no test framework, one per phase from
`smoke:phase3` to `smoke:phase18`. The [Testing table in the
README](../README.md#testing) says what each one covers. Every suite except
`smoke:phase16` (pure crypto, no server) needs the dev server on port 8000
with a seeded database:

```bash
cd worker
npm run smoke:phase<N>   # e.g. npm run smoke:phase15
```

Phases 9, 10, 11, 13, 14, 15, 17 and 18 also sign in as the `good` owner
account (see above). Phases 6, 7, 9, 10, 11 and 14 start the fake-B2 stub
in-process when port 9000 is free and reuse a running one otherwise; phases 15
and 18 expect `npm run media:dev` to be running already.

`smoke:phase13` also needs the owner account: the deadline it checks is read
from the owner console. It cannot assert an actual expiry — the shortest
window is three hours and nothing can move the DO's clock — so it asserts
every input to that deletion instead: the window in force, who is told when it
changes, the D1 mirror, and the `next_expiry_at` the alarm is armed for.

`smoke:phase14` is the regression net for the privacy review: it asserts that a
`media/` object is cached for the shortest window rather than a year, that a key
whose index row is gone is refused instead of treated as legacy, that a purge
takes the bucket object and the index row together, that D1's `next_expiry_at`
follows the oldest message, and that the Origin check, the `media_key`
validation, the push preview preference and the owner audit trail all hold. It
does not assert that the edge copy was evicted — `caches.default` is read after
authorization, so a cached object is unreachable by any request the test can
make once the row is gone. That one is confirmed against production, with a GET
on a key that expired minutes ago.

`smoke:phase9`, `smoke:phase10` and `smoke:phase14` need the `good` owner
account and the media stub. All three create and delete their own throwaway
accounts, and phase 9 keeps its WebSocket flood inside the owner's own thread
so the other suites' fixtures stay clean. Phase 10 talks to D1 directly to
force guest expiry (three hours is a long wait) and to clear its own per-IP
signup quota, so it is rerunnable.
`smoke:phase18` is the only one that opens a browser, and the only one that
needs the app running as well — `cd app && npm run dev` on :5173, plus the
media stub and a published sticker pack. It drives three Playwright contexts
(two people and a third browser signing in as one of them), which is what makes
it able to state the thing no Node script can: that an account's history opens
somewhere it has never been. `npx playwright install chromium` once (in
`worker/`, where Playwright is a dev dependency), then
`HEADED=1` to watch it and `SLOWMO=250` to watch it slowly. On a failure it
writes `/tmp/phase18-<context>.png` and prints whatever the screen was saying.

It is deliberately not in CI: it wants four processes and a browser download,
and the deploy workflow typechecks, lints and builds. It is the pass you run
before believing a change to the message path.

Run the suites against a freshly migrated database — a few of them assert on
state that earlier runs leave behind (`rm -rf worker/.wrangler/state`, then
migrate and seed again).

Each script prints per-check results and exits non-zero on failure. Type
checks: `npm run typecheck` in both packages. Lint (app): `npm run lint`.
The app's expiry display rules have a check of their own that needs no server:
`npm run check:expiry` in `app/`.

## Database changes

1. Add the next numbered file in `worker/migrations/` (e.g. `0016_thing.sql`).
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
