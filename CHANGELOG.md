# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0, a minor version may
change the wire format, the key format or the database schema. Anything that
does so is listed under **Breaking**.

## [Unreleased]

### Changed

- The license is now CC BY-NC-SA 4.0, replacing the GoodChat Attribution
  License v1.0. Non-commercial use only; credit to the author and share-alike
  are required. See LICENSE.

## [0.9.0] - 2026-09-21

First public release. It covers everything built so far, and the reference
instance at https://goodchat.dionatha.com.br already runs it.

### Messaging

- Real-time 1:1 chat over WebSockets, with one Durable Object per
  conversation.
- Offline delivery, at-least-once semantics with client-side dedup, delivery
  states (sent, delivered, read) and a typing indicator.
- Images and short videos. They are compressed in the browser, uploaded
  straight to a private Backblaze B2 bucket, and read back through a
  membership-checked proxy in the Worker.
- A curated sticker pack and a self-hosted pt-BR emoji picker.

### Encryption

- End-to-end encryption per account: a random content key per message,
  wrapped by ECDH P-256 for both participants. Attachments and push previews
  are sealed too, and a safety number reveals a swapped key.
- The password never leaves the browser. It is stretched with 600k PBKDF2
  iterations, and only a derived token is posted. The account key is wrapped
  under a key derived from the same password, so signing in anywhere opens
  the whole history.
- `E2EE_REQUIRED` makes the server refuse any message that arrives without an
  envelope. It is on in the shipped config.

### Retention

- Disappearing messages: each one deletes itself three hours after it is
  read, and within seven days if it never is. That covers the database, the
  bucket and the edge cache. A read only counts once the decrypted text has
  been on screen and in focus for a second.
- Push previews are generic by default.

### Accounts and administration

- Guest accounts: no password, they live three hours and delete themselves
  on sign-out.
- Owner console: accounts, storage per account, history purges, maintenance,
  and an audit trail of owner actions.
- Self-service password change, which re-seals the account key and signs out
  every other device.
- Presence (who is online).
- Profile card: display name and avatar.

### App and design

- Installable PWA with an offline shell and VAPID web push.
- Two skins (retro and terminal) × ten daisyUI themes, all stored on the
  account.

### Hardening

- CSP, a CORS allowlist and CSRF origin checks.
- Salted rate-limit digests, a login with no timing oracle, and upload
  quotas.
- An hourly cleanup cron.

### Tooling

- CI deploy on every push to `main`: typecheck, lint, icon validation,
  build, remote D1 migrations, deploy, and a check of the live bundle.
- Smoke suites for phases 3 to 18, including a Playwright browser pass and
  two independent implementations of the envelope format.

[Unreleased]: https://github.com/DionathaGoulart/GoodChat/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/DionathaGoulart/GoodChat/releases/tag/v0.9.0
