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

### The owner account

Migration 0003 grants `role = 'owner'` to the account named `good`. If the
instance owner is named something else, promote it explicitly:

```bash
npm run user:role -- --remote <username> owner
```

The owner reaches `/api/admin/*` and the `#/admin` screen: create and
disable accounts, reset passwords, see storage per account, and purge
conversation histories. Everything else is a plain `user`. There is no
bootstrap endpoint — promoting an account requires the deploy key, on
purpose. An owner cannot disable, demote or delete itself.

## 2. Media (Backblaze B2)

Full recipe also in `worker/.env.example`. Summary:

1. Bucket, **private**: `b2 bucket create goodchat-media allPrivate`
   (web UI: "Arquivos no Bucket" → Privado). The browser never reads from
   B2 — the Worker signs every GET and streams it at `/api/media/<key>`,
   so a public bucket would only widen the blast radius of a leaked key.
2. Scoped application key:
   `b2 key create --bucket goodchat-media goodchat-worker listBuckets,readFiles,writeFiles`
   (keyID and applicationKey are shown once, save them)
3. CORS on the bucket. Uploads go browser → B2 directly, so B2 itself has
   to answer the preflight; reads need no rule, they never leave the
   Worker. The web UI preset "share with all origins" only covers
   downloads — the rule must name the S3 operation `s3_put` explicitly:
   ```bash
   b2 bucket update goodchat-media allPrivate --cors-rules '[
     {
       "corsRuleName": "s3UploadFromThisOneOrigin",
       "allowedOrigins": ["https://goodchat.dionatha.com.br"],
       "allowedOperations": ["s3_put"],
       "allowedHeaders": ["*"],
       "exposeHeaders": ["etag"],
       "maxAgeSeconds": 3600
     }
   ]'
   ```
   `--cors-rules` replaces the whole set, so read the current rules first
   (`b2 bucket get goodchat-media`) and resend them alongside the new one.
   Needs a key with `writeBuckets` — the scoped worker key from step 2 does
   not have it, so authorize with the master key (the CLI caches one
   account at a time in `~/.b2_account_info`; back it up if another B2
   account is already authorized). Check the result end to end:
   ```bash
   curl -i -X OPTIONS "$B2_S3_ENDPOINT/goodchat-media/media/probe" \
     -H "Origin: https://goodchat.dionatha.com.br" \
     -H "Access-Control-Request-Method: PUT" \
     -H "Access-Control-Request-Headers: content-type"
   ```
   A 200 with `access-control-allow-methods: PUT` means uploads work; a
   200 without those headers is the failure this step fixes.
4. Note the S3 endpoint shown in the bucket UI, e.g.
   `https://s3.us-west-004.backblazeb2.com`
5. Lifecycle rule (web UI, Bucket Settings, Lifecycle Settings): **keep only
   the last version**. B2 buckets default to keeping every version, and an
   S3 `DELETE` against such a bucket only writes a hide marker — every
   deletion the Worker performs (history purges, guest expiry, the orphan
   and retention sweeps) would keep billing for the bytes it thinks it
   freed. B2 itself never deletes anything on its own; this rule is what
   makes deletion real.
6. Publish the sticker pack (the real bucket only accepts signed PUTs, so
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
npx wrangler secret put RATE_LIMIT_SALT
```

`RATE_LIMIT_SALT` is optional but wanted: the rate-limit counters store a
salted digest of the caller's address rather than the address itself, and the
IPv4 space is small enough that an unsalted SHA-256 is a lookup table. Unset,
it falls back to a constant — addresses still never land in the table in the
clear, but the digest stops being one-way to anyone who can read `login_attempts`.
Any long random string works; changing it only resets the live counters.

Non-secrets can live in `wrangler.jsonc` (committable):

```jsonc
"vars": {
  "PUBLIC_ORIGIN": "https://chat.example.com",
  "B2_BUCKET_NAME": "goodchat-media",
  "B2_S3_ENDPOINT": "https://s3.us-west-004.backblazeb2.com",
  "VAPID_PUBLIC_KEY": "<public key from step 3>",
  "VAPID_SUBJECT": "mailto:you@example.com",
  "ALLOWED_ORIGINS": "",
  "TEMP_ACCOUNTS_ENABLED": "true",
  "TEMP_ACCOUNT_TTL_HOURS": "5",
  "TEMP_ACCOUNTS_MAX": "100",
  "TEMP_ACCOUNTS_PER_IP_HOUR": "3",
  "MEDIA_RETENTION_DAYS": "0",
  "MEDIA_LEGACY_READS": "deny",
  "DO_STORAGE_LIMIT_GB": "5",
  "B2_STORAGE_LIMIT_GB": "10"
}
```

The ones that change behaviour:

- `PUBLIC_ORIGIN` — the origin this Worker answers on, exactly as deployed
  (the `routes` entry above). Deleting a media object also evicts the copy the
  Worker wrote to the Cloudflare edge cache, and the two places that delete
  without an incoming request — the Durable Object's retention alarm and the
  hourly cron — have no other way to build that cache key. A wrong value costs
  only the eviction: reads of a deleted key are refused anyway, and a cached
  message attachment expires on its own within the shortest retention window.
- `ALLOWED_ORIGINS` — extra browser origins allowed to call the API with
  credentials, comma-separated. Empty in production: the SPA is same-origin.
  The Worker's own origin is always allowed; anything else is refused.
- `TEMP_ACCOUNTS_*` — guest accounts (`POST /api/auth/temp`). `ENABLED` is
  the off switch: `"false"` closes the instance back to invite-only and the
  login screen stops offering the button (it reads the flag from
  `/api/health`). `TTL_HOURS` is how long a guest lives before it and its
  data are deleted. `MAX` caps how many can be alive at once and
  `PER_IP_HOUR` how many one address may create per hour — the endpoint is
  unauthenticated, so both are load-bearing, not decoration.
- `MEDIA_RETENTION_DAYS` — the hourly sweep deletes claimed media older than
  this. `"0"` keeps everything forever, which is the default because
  deleting someone's photos on a timer is a product decision. Bubbles whose
  object is gone render a "mídia indisponível" placeholder.
- `MEDIA_LEGACY_READS` — how to treat objects with no row in `media_objects`
  (anything uploaded before migration 0003). Only `"allow"` opens the old rule
  (any valid session plus an unguessable key); anything else, unset included,
  refuses them, and that is the default. `media/` and `avatars/` keys are
  refused either way — both are indexed at presign time, so a missing row
  means the object was deleted, and serving it would hand back a message
  retention already took. An instance carrying pre-0003 objects should run
  `POST /api/admin/media/reindex` from the owner console once and check that
  `indexed_media_bytes` matches `bucket_bytes` in the overview before
  deploying with the flag closed.
- `PUSH_ENDPOINT_HOSTS` — comma-separated domain suffixes a push subscription
  may point at. A stored endpoint is a URL the Worker POSTs to on every message
  the account receives, so this is what keeps it a browser vendor's push service
  rather than any host on the internet. Empty keeps the built-in list (Firefox,
  Chrome/Chromium, Safari, Edge); widen it only for a browser that list misses,
  and note that a subscription already stored under a host you then remove
  stops receiving notifications.
- `DO_STORAGE_LIMIT_GB` / `B2_STORAGE_LIMIT_GB` — the totals the owner console
  shows next to each storage number (`1.2 gb / 10 gb`, plus the share of the
  ceiling). Defaults are the free tiers, 5 and 10. Display only: no upload or
  message is ever refused because of them, so raise them when the plan
  changes. `"0"` hides the total and shows plain usage again.

Then regenerate types: `npm run cf-typegen`. Note that `vars` in
`wrangler.jsonc` do not apply to local dev; `.dev.vars` rules there. Two
separate worlds by design.

### Scheduled maintenance

`wrangler.jsonc` declares `triggers.crons: ["17 * * * *"]`; `wrangler deploy`
registers it. The hourly run clears expired sessions and stale rate-limit
counters, tears down guest accounts past their expiry (keeping the threads
whose other side is a permanent account), collects tombstones nothing
references anymore, deletes uploads no message ever referenced (24h grace),
backstops per-conversation message retention (PRD §3.9 — the Durable Objects
do this on their own alarms; the sweep catches a lost one by scanning
`conversations.next_expiry_at`, so a thread that is still active does not sit
on already-expired messages, plus any bucket object whose delete failed), and
applies the instance-wide media cap when
`MEDIA_RETENTION_DAYS` is set. The owner console can trigger the same work on
demand.

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
- [ ] Guest button appears (when `TEMP_ACCOUNTS_ENABLED` is on), creates an
      account, shows the credentials once and signs in with a countdown
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

## 7. CI/CD

`.github/workflows/deploy.yml` runs on every push to `main`: install,
typecheck (app and worker), lint, build, then `wrangler deploy`. A commit
that does not compile fails the workflow instead of reaching production.

One-time setup: create an API token (dash → My Profile → API Tokens →
"Edit Cloudflare Workers" template, plus D1:Edit) and store it as the
repository secret `CLOUDFLARE_API_TOKEN` (GitHub → Settings → Secrets and
variables → Actions). Until the secret exists the checks still run and the
deploy step is skipped, so the workflow never fails for a missing token.

Manual deploys keep working (`npm run deploy:full`); the workflow only
builds and deploys what is committed.

## 8. Optional: custom domain

Everything works on `workers.dev`. A custom domain on Cloudflare adds:

1. Clean URL: in `wrangler.jsonc`,
   `"routes": [{ "pattern": "chat.yourdomain.com", "custom_domain": true }]`

Media needs nothing extra: reads already go Worker → B2, which is
Bandwidth Alliance traffic (no egress charge) and never exposes the bucket
host to the browser.

## 9. Operations and limits

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

## 10. Known gaps

Pending items, none blocking a first deploy beyond the setup above:

1. The conversation list refreshes by polling (15s, visible tabs only),
   not in real time.
2. Guest accounts are swept hourly, so their data can outlive the account by
   up to an hour. Access does not: the session and login checks read
   `expires_at` directly, so the account is unusable the moment it expires.
3. Rate limiting covers login, guest signup, upload presigns and the
   WebSocket. The remaining read endpoints rely on the session alone.
4. Message edit/delete, group chats and E2EE are out of scope by design.
