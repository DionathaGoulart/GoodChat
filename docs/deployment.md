# Deployment guide

Everything needed to take GoodChat from `localhost` to production, in
order. Expected cost: zero, everything fits Cloudflare and Backblaze free
tiers (limits in the last section).

## Architecture in production

```
Browser ---https---> Cloudflare Worker (goodchat-worker.<you>.workers.dev)
                      |- /api/*  REST + WebSocket -> Durable Objects
                      |- /*      SPA (Vite build served as static assets)
                      |- D1 (users, sessions, conversations, push subscriptions)
                      |- Web Push -> FCM / Mozilla / Apple
Browser ---PUT-----> Backblaze B2 (private bucket goodchat-media)
Worker  ---GET-----> Backblaze B2 (signed reads streamed at /api/media/<key>)
```

The SPA is served by the Worker itself, on the same origin as the API.
This is required, not cosmetic: the session cookie is `SameSite=Strict`,
so a frontend hosted on a different site (Pages, Vercel) would never send
it and login would fail. The repo is already wired for this: the
`assets` block in `worker/wrangler.jsonc` serves `app/dist` with SPA
fallback while `/api/*` always runs the Worker script, and the app's
production build uses relative API URLs (`app/.env.production`).

## Prerequisites

- Cloudflare account, logged in (`npx wrangler whoami`)
- Backblaze account (free 10GB) and the CLI: `brew install b2-tools`
- Node.js 24+, repo building clean (`npm run typecheck` in both packages)

## 1. Database (remote D1)

```bash
cd worker

# Create the real database
npx wrangler d1 create goodchat
# Paste the printed database_id into wrangler.jsonc,
# replacing the 00000000-... placeholder

# Apply migrations remotely
npx wrangler d1 migrations apply goodchat --remote
```

### Creating users in the remote database

```bash
npm run user:create -- --remote youruser your-strong-password "Display Name"
```

Without `--remote` the same command writes to the local database. Usernames
are stored lowercase and match case-insensitively, so `Good`, `GOOD` and
`good` are the same account at login and in search.

Do not seed `alice`/`bob` in production: they are dev fixtures with public
passwords.

## 2. Media (Backblaze B2)

Full recipe also in `worker/.env.example`. Summary:

1. Bucket, **private**: `b2 bucket create goodchat-media allPrivate`
   (web UI: "Arquivos no Bucket" → Privado). The browser never reads from
   B2 — the Worker signs every GET and streams it at `/api/media/<key>`,
   so a public bucket would only widen the blast radius of a leaked key.
2. Scoped application key:
   `b2 key create --bucket goodchat-media goodchat-worker listBuckets,readFiles,writeFiles`
   (keyID and applicationKey are shown once, save them)
3. CORS on the bucket (web UI, Bucket Settings, CORS Rules): all origins,
   S3 operation `s3_put`, header `content-type`. Browser uploads fail
   without this; reads need no rule, they never leave the Worker.
4. Note the S3 endpoint shown in the bucket UI, e.g.
   `https://s3.us-west-004.backblazeb2.com`
5. Publish the sticker pack (the real bucket only accepts signed PUTs, so
   pass the credentials and the publisher signs them):
   ```bash
   cd worker
   B2_KEY_ID=… B2_APPLICATION_KEY=… \
   B2_S3_ENDPOINT=https://s3.<region>.backblazeb2.com \
   B2_BUCKET_NAME=goodchat-media npm run stickers:publish
   ```

Nothing in the app points at B2: `VITE_MEDIA_URL` is `/api/media`
(`app/.env.production`), same origin as the API.

Alternative: Cloudflare R2. The signing code is generic S3, so R2 works
with the same four variables (account endpoint plus the bucket name), and
the bucket stays private with no public dev URL. Single-account setup;
switching requires no code changes.

## 3. Web push (production VAPID)

Generate a fresh pair, do not reuse the dev keys. Rotating later kills
every subscription, so generate once and store safely:

```bash
cd worker
npm run vapid:generate
```

Use a real contact as the subject, e.g. `mailto:you@example.com`.

## 4. Secrets and vars

Secrets via CLI (never in git):

```bash
cd worker
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

Non-secrets can live in `wrangler.jsonc` (committable):

```jsonc
"vars": {
  "B2_BUCKET_NAME": "goodchat-media",
  "B2_S3_ENDPOINT": "https://s3.us-west-004.backblazeb2.com",
  "VAPID_PUBLIC_KEY": "<public key from step 3>",
  "VAPID_SUBJECT": "mailto:you@example.com"
}
```

Then regenerate types: `npm run cf-typegen`. Note that `vars` in
`wrangler.jsonc` do not apply to local dev; `.dev.vars` rules there. Two
separate worlds by design.

## 5. Build and deploy

```bash
cd worker
npm run deploy:full   # builds app/dist, then wrangler deploy
```

On the first deploy wrangler offers to enable the `workers.dev`
subdomain: accept. Final URL:
`https://goodchat-worker.<your-subdomain>.workers.dev`.

## 6. Post-deploy checklist

On the production URL, in order:

- [ ] `GET /api/health` returns `{"ok":true}`
- [ ] SPA loads at the root, retro theme correct in light and dark
- [ ] Login works with the user created in step 1
- [ ] Two browsers chat in real time (`wss://` WebSocket)
- [ ] Refresh keeps session and history; offline messages arrive on reconnect
- [ ] Image upload: appears on the other side, survives reload, lightbox opens
- [ ] Stickers load (manifest and SVGs from the bucket)
- [ ] Push, now testable end to end: enable the toggle, allow the browser
      prompt, close the tab, send a message from the other user, the
      notification appears and clicking opens the right thread
- [ ] PWA: install icon in Chrome's address bar installs a standalone window
- [ ] iOS (if available): Safari, Share, Add to Home Screen, open the
      installed app, enable notifications (iOS 16.4+, not in the EU)
- [ ] `npx wrangler tail` shows no errors while testing

## 7. Optional: custom domain

Everything works on `workers.dev`. A custom domain on Cloudflare adds:

1. Clean URL: in `wrangler.jsonc`,
   `"routes": [{ "pattern": "chat.yourdomain.com", "custom_domain": true }]`

Media needs nothing extra: reads already go Worker → B2, which is
Bandwidth Alliance traffic (no egress charge) and never exposes the bucket
host to the browser.

## 8. Operations and limits

| Resource               | Free tier (per day unless noted)   | Notes                              |
| ---------------------- | ---------------------------------- | ---------------------------------- |
| Worker requests        | 100k                               | includes static asset requests     |
| Durable Objects (SQLite) | 100k requests, 13k GiB-s         | hibernation makes idle free        |
| D1                     | 5M reads, 100k writes, 5GB total   | sessions and receipts dominate     |
| B2                     | 10GB storage, egress 3x storage    | proxying through Cloudflare zeroes egress |
| Web Push               | free                               | FCM, Mozilla and Apple do not charge |

- Live logs: `cd worker && npx wrangler tail` (observability is enabled).
- Future migrations: add a file in `worker/migrations/`, apply with
  `--local` for dev and `--remote` for production.
- B2 key rotation: create a new key, `wrangler secret put` again, deploy.
  No downtime.
- VAPID rotation: avoid it, it invalidates every subscription. The client
  recovers on the next toggle.
- Rollback: `npx wrangler rollback` returns to the previous deploy.
- D1 backup: `npx wrangler d1 export goodchat --remote` on occasion. D1
  Time Travel also provides 30 days of point-in-time restore.

## 9. Known gaps

Pending items, none blocking a first deploy beyond the setup above:

1. Media retention/cleanup is not implemented; keys are month-prefixed
   (`media/<yyyy-mm>/`) to make a future cleanup job trivial.
2. `GET /api/media/<key>` authorises on "valid session", not on
   conversation membership — messages live inside each Durable Object, so
   the check would cost a DO round trip per image. Keys carry a uuid and
   the bucket is private, so guessing or crawling is not viable.
3. The conversation list refreshes by polling (15s, visible tabs only),
   not in real time.
4. Rate limiting exists on login only; other endpoints rely on sessions.
5. No CI/CD; deploys are manual. Optional: connect the repo to GitHub and
   use Workers Builds.
6. Message edit/delete, group chats and E2EE are out of scope by design.
