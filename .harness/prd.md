# Product Requirements Document (PRD)
## Private Real-Time 1:1 Chat Application ("GoodChat")

**Version:** 1.1
**Status:** Draft
**Author:** Product/Engineering (drafted with Claude)
**Last updated:** August 17, 2026

---

## 1. Overview

### 1.1 Summary
A private, invite-only, real-time messaging application designed for direct (1:1) conversations between a small, trusted group of friends. The product intentionally rejects the "grow to millions of users" model in favor of **maximum responsiveness, strong privacy, and zero/near-zero infrastructure cost**, by running entirely on free tiers of best-in-class edge infrastructure (Cloudflare Workers/Agents SDK, Cloudflare D1, Backblaze B2).

The product is explicitly **not** a general-purpose messaging platform: no public discovery, no group chats, no virality mechanics. It is a personal tool that borrows the best UX ideas from WhatsApp/Telegram/Discord (stickers, emoji, rich media, instant delivery) while staying small, fast, and cheap to run indefinitely.

**GoodChat is not a place messages are kept — it is a place they pass through.** Everything a conversation holds expires on its own, message by message, within at most seven days (§3.9). The point of the product is privacy, and the strongest privacy guarantee a server can offer is not holding the data: what has been deleted cannot leak, cannot be subpoenaed, and cannot be read by whoever runs the instance. A conversation history is not a feature here; its absence is.

### 1.2 Problem Statement
Mainstream chat apps (WhatsApp, Telegram, Discord, iMessage) are excellent but:
- Require phone numbers or heavyweight account systems.
- Are closed-source / opaque about server-side data handling.
- Are overbuilt for a "just me and a few friends" use case.
- Cannot be self-customized (new features, custom stickers, custom UX) without forking a massive codebase.

There is room for a **minimal, self-controlled, privacy-first 1:1 chat app** that the owner fully controls, hosted at effectively $0/month, with latency competitive with — or better than — mainstream apps.

### 1.3 Goals
1. Deliver messages between two connected users with **perceived-instant delivery** (target latency band: **50–300ms** end-to-end under normal network conditions).
2. Support rich conversational features: text, emoji, stickers, images, video, and file attachments.
3. Keep the entire stack inside free infrastructure tiers for as long as technically feasible (target: $0/month at the group's expected scale of ~5–50 users, low-hundreds of conversations).
4. Provide strong, simple privacy guarantees: no public profile discovery beyond exact `@username` lookup, secure session handling, and an optional end-to-end encryption (E2EE) path for message bodies.
5. **Keep nothing longer than it has to be kept:** every message — text, image, video, audio, file — deletes itself from the database and the object store three hours after it is read, and in at most seven days if it never is (§3.9).
6. Ship a functional MVP quickly, then iterate.

### 1.4 Non-Goals (Out of Scope for v1)
- Group chats / channels / servers.
- Public user discovery, search engines, or social graph features (follow/friend suggestions).
- Voice/video calling (real-time media streaming — RTC).
- Multi-device sync beyond "log in anywhere with the same account" (no cross-device message queue merge logic beyond what the DB naturally provides). Encryption does not narrow this any further: the account key means a new browser reads the same history as an old one, with no pairing step.
- Message backup/export tooling, searchable archives, or any "history" feature. Not merely out of scope: retention (§3.9) is the product, and a tool whose purpose is to keep messages around contradicts it.
- Monetization, ads, or growth mechanics of any kind.
- Native mobile apps (v1 targets installable PWA only).

---

## 2. Target Users & Use Cases

### 2.1 Persona
**"The Friend Group Member"** — a small, closed circle (family or close friends, roughly 5–50 people total) who want a private space to talk that isn't run by a large corporation, and who trust the app owner (who is also a member of the group) to operate the backend responsibly.

### 2.2 Core Use Cases
| # | Use case | Priority |
|---|---|---|
| UC1 | User logs in securely and stays logged in across sessions | P0 |
| UC2 | User finds a friend by exact `@username` and starts a 1:1 conversation | P0 |
| UC3 | User sends/receives text messages in real time | P0 |
| UC4 | User sends/receives emoji reactions and inline emoji in text | P0 |
| UC5 | User sends/receives images | P0 |
| UC6 | User sends/receives short video clips | P1 |
| UC7 | User sends/receives stickers (curated packs) | P1 |
| UC8 | User sees delivery/read receipts and typing indicators | P1 |
| UC9 | User sees message history when reopening a conversation | P0 |
| UC10 | User receives a push/browser notification for new messages while app is closed/backgrounded | P2 |

---

## 3. Product Requirements

### 3.1 Authentication & Account Management
- **No public sign-up.** Accounts are created by the app owner/admin (invite-based) or via a signed invite link, consistent with the "closed friend group" model.
- Each account has: `id`, `username` (unique, immutable or rarely changeable, used for `@lookup`), `display_name`, `avatar_url`, `password_hash`, `created_at`.
- Passwords hashed with a modern algorithm (Argon2id or scrypt via Web Crypto-compatible library suitable for the Workers runtime).
- **Session model:** opaque session token (random 256-bit value) stored server-side (D1) with expiry, mapped to a cookie:
  - `Set-Cookie: session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=<N>`
  - No sensitive data in the cookie itself (no JWT payload with claims client-readable) — token is opaque and validated server-side on every request. This avoids JWT revocation problems entirely.
  - Sessions are revocable (logout invalidates the D1 row immediately).
  - Sliding expiration: session refreshed on activity, hard cap (e.g., 30 days) regardless of activity.
- Rate limiting on login attempts (per-IP and per-account) to mitigate brute force.
- Optional (P2): WebAuthn/passkey support for passwordless login, since the user base is small and technical.

### 3.2 User Discovery
- The **only** discovery mechanism is exact or prefix match on `@username` (e.g., typing `@joao` returns exact/prefix matches only among users the account is *allowed* to see — see 3.2.1).
- No user directory browsing, no "people you may know," no phone-number contact matching.

**3.2.1 Visibility model (decision needed — see Open Questions):**
- Option A: All accounts in the closed instance are mutually visible by `@username` (simplest, appropriate for a fully trusted friend group).
- Option B: Visibility requires a prior mutual "connection" step (adds friction but stronger privacy default).
- **Recommendation for v1:** Option A, since the entire instance is invite-only and small. Revisit if the group grows.

### 3.3 Conversations
- A conversation is **strictly 1:1** — uniquely identified by the unordered pair of user IDs (`conversation_id = hash(min(user_a, user_b), max(user_a, user_b))`).
- Starting a conversation with a user who has no existing conversation creates it implicitly on first message.
- Conversation list view shows: other participant's display name/avatar, last message preview, timestamp, unread count.

### 3.4 Real-Time Messaging
- **Transport:** persistent WebSocket connection per active client, routed to the Durable Object (Agent) that owns that conversation.
- **Delivery guarantee:** at-least-once delivery with client-side de-duplication via message `client_generated_id` (UUID generated on send, echoed back by server).
- **Message states:** `sending → sent → delivered → read`, reflected via lightweight status events pushed back to the sender.
- **Typing indicators:** ephemeral event (`user_typing`) broadcast to the other participant, not persisted.
- **Offline delivery:** if the recipient is not connected, the message is persisted and delivered via WebSocket push the moment they reconnect (no polling); optionally triggers a push notification (P2, see 3.8).
- **Message types supported:** `text`, `emoji` (rendered inline, no special handling needed beyond Unicode/emoji-picker UI), `sticker` (reference to a sticker asset ID), `image`, `video`, `file` (generic attachment, stretch).
- **Message editing/deletion (P1):** soft-delete and edit with a visible "edited" marker; deletions propagate in real time to the other participant.

### 3.5 Media Handling (Images, Video, Stickers)
- **Upload flow:**
  1. Client requests a signed/pre-authorized upload URL from the Worker (validates session, file type, size limit).
  2. Client uploads directly to Backblaze B2 (bypasses the Worker/DO for the actual bytes, keeping compute cost near zero).
  3. Client sends a `message` of type `image`/`video` referencing the resulting object key once upload completes.
  4. The Durable Object persists the message with the media reference and broadcasts it to the other participant.
- **Download/serving flow:** media is served through a Cloudflare-fronted custom domain in front of the B2 bucket (Bandwidth Alliance) so egress remains free regardless of volume, while storage stays capped at the B2 free allowance.
- **Client-side compression:** images and videos are compressed/resized in-browser before upload to conserve the storage quota (target: images ≤ 1–2MB after compression, video clips capped at a short duration, e.g., 60s, and constrained bitrate).
- **Stickers:** a curated, versioned sticker pack (static assets in B2), referenced by ID in messages — no per-message upload cost.
- **Size/type limits:** enforced both client-side (UX) and server-side (Worker validates before issuing upload URL) — reject disallowed MIME types and oversized files.

### 3.6 Privacy & Security
- All traffic over TLS (default on Cloudflare/Workers).
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Strict` (see 3.1).
- **CSRF protection:** since cookies are `SameSite=Strict` and all mutating requests require a custom header or same-origin check, CSRF risk is low; add an explicit CSRF token for defense-in-depth on state-changing REST endpoints if a browser extension/edge case requires relaxed `SameSite`.
- **Input sanitization:** all user-generated text rendered with strict escaping (no raw HTML rendering) to prevent stored XSS.
- **End-to-end encryption — shipped, and the unit is the account.** Written here as it ended up rather than as it was sketched: the sketch said "per-conversation key via X25519, keys stored on participant devices", and both halves changed.
  - **Per message, not per conversation.** A fresh random content key encrypts each payload; that key is wrapped twice, for the two accounts, under ECDH P-256 through HKDF. The body is authenticated under the conversation, the sender and the message id, so the server can store and forward an envelope it cannot read and cannot move.
  - **Per account, not per device.** One keypair per person, generated in a browser and stored on the server encrypted under a key derived from their password — which never reaches the server (see below). Signing in anywhere opens the whole history: nothing to pair, nothing to scan, no cross-device handover. This is what answers open question 4.
  - **The password stops arriving**, and that is the load-bearing part rather than a login hardening measure: the browser runs 600k PBKDF2 iterations locally and posts only a derived token, so the same derivation that authenticates cannot be walked backwards into the key that unwraps a message.
  - **Media too**, sealed in the browser before the presigned PUT, in independently authenticated chunks so a video can play before it has finished arriving. The bucket, the read proxy and the edge cache hold ciphertext only.
  - **The costs, which are real and are product decisions, not oversights:** lose the password and lose the history — there is nothing on the server that could perform a recovery; a weak password is attackable offline by whoever holds a database dump, hence a twelve-character minimum and a meter; and an owner's password reset discards the account key, so it hands over an account and empties it in the same action, which the console says before the click.
- **Retention as the primary privacy mechanism (§3.9):** a message lives three hours past being read, and seven days at the outside. This is the guarantee that holds without any cryptography: what is not stored cannot be breached, subpoenaed or read by the operator. E2EE, if it ships, narrows *who* can read a live message; retention narrows *how long anyone* can. Tying the clock to the read rather than to the send is what makes the usual case hours instead of days — the week is the fallback for a message that never found its reader, not the normal life of one.
- **Admin/operator transparency:** since this is a small trusted-operator deployment, the PRD assumes the operator (you) has infrastructure-level access to the database regardless of E2EE status for operational reasons (backups, debugging) — E2EE protects against external breach/subpoena/third-party exposure, not against the operator themselves, and this should be disclosed to users. Retention is what bounds that access in time: the operator can read what exists, and within a week nothing does — usually within hours. The owner console can see when a conversation's next message expires and how much of it is still unread, but cannot extend either.

### 3.7 UI/UX
- **Frontend framework:** React (Vite or Next.js) styled with **Tailwind CSS + DaisyUI** component classes for rapid, consistent, themeable UI (DaisyUI ships light/dark themes out of the box, which is a good fit for a chat app).
- **Visual style reference:** the UI must follow the **retro skin/theme** already established in the sibling project `~/desktop/good/Portfolio` (same author's existing portfolio site). That project's retro aesthetic (color palette, typography, borders/shadows, iconography, motion/animation feel) is the canonical style reference for this app — GoodChat should feel like a sibling product to the Portfolio site, not a generic DaisyUI default theme.
  - **Skins, not one site-wide look:** the visual system is split per skin. `.harness/styleguide.md` holds only the shared foundation (palettes, type family, motion rules, the skin contract, the CSS recipe); each skin has its own file under `.harness/styleguides/` — `retro.md` (the Portfolio-derived default) and `terminal.md` (CRT/shell). A skin is not a variant of one screen: switching it repaints the whole app, so a skin's style guide describes the whole app under that skin.
  - The shared tokens were extracted by directly analyzing the Portfolio project's source (its Tailwind config / CSS variables / component markup) — see `inicial.md` for the exact process the coding agent follows to produce it.
  - New skins may be added at any time, with a new style guide of their own or with none at all when they only re-set the frame tokens (criteria in `.harness/styleguide.md` §5).
  - Implementation should map the retro theme onto a custom DaisyUI theme (via `daisyui.themes` config) rather than hand-rolling one-off CSS, so the whole component library (buttons, inputs, modals, chat bubbles) inherits the retro look consistently.

### 3.8 Notifications (P2 — stretch)
- Web Push API (works with PWAs) to notify users of new messages when the tab/app is not focused, subject to browser support and user opt-in.
- No dependency on a paid push service required — Web Push works over VAPID keys directly from the Worker.

### 3.9 Message Retention (Disappearing Messages)
The defining privacy behavior of the product. Every message carries its own clock and deletes itself when it runs out — permanently, from the Durable Object's storage and from the B2 bucket. **Reading a message is what winds that clock down.**

- **The rule, whole:** `expires_at = min(created_at + 7 days, read_at + 3 hours)`. A message nobody opens is gone in a week. A message the recipient reads is gone three hours later. Both numbers are fixed for the instance; there is no window to choose, and nothing can ask for more.
- **`min`, not "whichever came last."** A message read on day seven has already spent its ceiling; the read does not hand it three more hours.
- **Per message, not per conversation.** Each row has its own deadline, so a conversation empties continuously rather than being wiped all at once. Nothing about the conversation itself expires: the pair, the thread and the settings survive; only what was said in it goes.
- **One row, one clock, both sides.** The message exists once on the server, so the two participants watch the same countdown and lose it in the same second. Neither holds a private copy that outlives the other's.
- **Only the recipient's read starts it.** Seeing your own message back has never meant anything, and a sender able to start the other side's clock could delete a message before it was read. The server refuses a receipt naming the reader's own message.
- **What counts as read** is a deliberate, per-message judgement made by the client that painted it, not a watermark: the plaintext is on screen (a device that cannot decrypt never reports), at least half the bubble is in the viewport, the window has focus, and all of it held for a second. Video and other content a thumbnail does not show report on being opened instead. Reads are named by id; "everything above this" is not a thing a client may say.
- **A read is never taken back and never restarts.** Reporting the same message twice does not grant it three more hours, and a deadline only ever moves earlier.
- **What "deleted" means:** the message row in the conversation's Durable Object, and the object in the bucket for any media it carried. Not a tombstone, not a "deleted message" placeholder, not an entry in a log. A failed bucket delete leaves the index row behind so the scheduled cleanup retries it; the row is only forgotten once the object is actually gone.
- **Enforcement (three layers, since a promise about deletion cannot depend on someone being connected):**
  1. an alarm inside the conversation's Durable Object, armed for the earliest `expires_at` it holds;
  2. a sweep on every wake of that object, on every connect, and on every read — a read can make a message due within the same second it was reported;
  3. a scheduled backstop (the cron cleanup) that pokes conversations holding at least one expired message, and sweeps bucket objects the DO could not delete.
- **Client side:** the deadlines are applied locally as well — the thread drops what it paints the moment it is due, and the local copies (thread cache, conversation-list previews) drop anything past it. A device that was offline while a message expired must not be the one place it survives.
- **What the person sees.** The clock is stated, not hidden, but it is not allowed to become the thread's main subject: a read message counts down in its meta line, fades over its last five minutes and then collapses out of the column. Only the newest read message counts down while hours remain — under fifteen minutes every message does. An unread message speaks only to its sender, and only in its last two days.
- **What is not promised.** The browser cannot stop the other person screenshotting, retyping or remembering, and the product must not imply otherwise. The promise is about what the server keeps.
- **Profile pictures are not messages** and are not subject to this clock; they are account data, replaced when the account replaces them.
- **Out of scope:** a per-message "delete for both" action, and pinning/saving a message past its deadline. The second is a deliberate refusal — an exception to retention is a hole in the promise.

---

## 4. Technical Architecture

### 4.1 High-Level Diagram (described)
```
[Client: React PWA + Tailwind/DaisyUI]
        |  HTTPS (REST: auth, user lookup, upload URL issuance)
        |  WebSocket (real-time messages)
        v
[Cloudflare Worker: edge router]
   - Validates session cookie against D1
   - Resolves conversation_id for a user pair
   - Upgrades WebSocket, forwards to the correct Durable Object
        |
        v
[Cloudflare Agents SDK / Durable Object — 1 per conversation]
   - Holds live WebSocket connections for both participants
   - Persists message history in built-in SQLite storage
   - Broadcasts new messages/typing/read-receipts in real time
   - Hibernates when idle (zero compute cost when inactive)
        |
        v (media references only, not bytes)
[Cloudflare D1: users, sessions, conversation metadata]

[Backblaze B2: image/video/sticker object storage]
        ^
        | fronted by a Cloudflare custom domain (Bandwidth Alliance = free egress)
[Client uploads/downloads media directly to/from B2 via signed URLs]
```

### 4.2 Component Responsibilities
| Component | Responsibility | Why this choice |
|---|---|---|
| Cloudflare Workers (edge router) | Auth, session validation, REST endpoints, WebSocket upgrade/routing, upload URL signing | Runs at the edge close to users globally; free tier is generous (100K req/day) |
| Cloudflare Agents SDK (Durable Objects) | One instance per 1:1 conversation; holds connection state, message history, real-time broadcast | Purpose-built for exactly this "stateful, low-latency, per-room" pattern; built-in SQLite persistence; hibernates to zero cost when idle |
| Cloudflare D1 | Source of truth for users, sessions, `@username` lookup, conversation index (which DO maps to which user pair) | Serverless SQL, free tier covers small user bases comfortably |
| Backblaze B2 | Object storage for images, videos, stickers | Best-in-class free tier (10GB permanent) + free egress through Cloudflare's Bandwidth Alliance, avoiding the "cheap storage, expensive download" trap of most providers |
| React + Tailwind + DaisyUI | Client UI | Fast to build, consistent design system, themeable, small bundle |

### 4.3 Data Model (D1 — relational metadata)
```
users
  id            TEXT PK
  username      TEXT UNIQUE NOT NULL
  display_name  TEXT
  avatar_url    TEXT
  password_hash TEXT
  created_at    INTEGER

sessions
  token         TEXT PK
  user_id       TEXT FK -> users.id
  created_at    INTEGER
  expires_at    INTEGER

conversations
  id            TEXT PK           -- deterministic hash of the two user IDs
  user_a        TEXT FK -> users.id
  user_b        TEXT FK -> users.id
  created_at    INTEGER
  last_message_at INTEGER
  next_expiry_at INTEGER NULL     -- §3.9; mirror of the DO's earliest deadline
  retention_ms  INTEGER           -- tombstone: the per-conversation window, gone
  swept_at      INTEGER NULL      -- last time the cleanup backstop ran on it
```

### 4.4 Data Model (Durable Object internal SQLite — per conversation)
```
messages
  id                TEXT PK      -- server-assigned
  client_id         TEXT         -- for de-dup, generated by sender client
  sender_id         TEXT
  type              TEXT         -- text | emoji | sticker | image | video | file
  body              TEXT         -- text content or sticker ID
  media_key         TEXT NULL    -- B2 object key, if applicable
  created_at        INTEGER
  status            TEXT         -- sent | delivered | read
  read_at           INTEGER NULL -- §3.9; when the recipient read it
  expires_at        INTEGER      -- §3.9; min(created+7d, read+3h)
  edited_at         INTEGER NULL
  deleted_at        INTEGER NULL

participants
  user_id           TEXT PK      -- the pinned pair; outsiders are refused

settings
  key               TEXT PK      -- bookkeeping only
  value             TEXT         -- the expiry alarm's id and the moment it is
                                 -- armed for, and the D1 mirror flag
```

The clock lives here rather than in D1 because this is where the messages are: the object that deletes them is the object that owns their deadlines. D1 mirrors one number — the earliest of them — so the scheduled cleanup can find a conversation with something to delete without waking every conversation in the instance.

### 4.5 Real-Time Protocol (WebSocket message shapes — illustrative)
```jsonc
// Client -> Server
{ "type": "send_message", "client_id": "uuid", "msg_type": "text", "body": "oi!" }
{ "type": "typing" }
{ "type": "read_receipt", "ids": ["...", "..."] }                  // §3.9, named, never a watermark

// Server -> Client
{ "type": "message", "id": "...", "sender_id": "...", "msg_type": "text", "body": "oi!", "created_at": 172839... }
{ "type": "message_status", "client_id": "uuid", "status": "delivered" }
{ "type": "typing", "user_id": "..." }
{ "type": "read_receipt", "user_id": "...", "reads": [{ "id": "...", "read_at": 172839..., "expires_at": 172840... }] }
{ "type": "messages_expired", "ids": ["...", "..."] }                    // just deleted
```

### 4.6 Latency Budget (target: 50–300ms end-to-end)
| Segment | Expected contribution |
|---|---|
| Client → nearest Cloudflare edge | 5–40ms (varies by user's ISP/location) |
| Edge Worker → Durable Object (co-located or nearby) | 1–20ms |
| Durable Object broadcast → recipient's edge connection | 1–10ms |
| Recipient edge → recipient client | 5–40ms |
| **Total (typical same-continent)** | **~30–150ms** |
| **Total (cross-continent worst case)** | **~150–300ms** |

This is consistent with the requested band and is achievable without exotic infrastructure, because Durable Objects run close to where the conversation's participants are and WebSockets avoid any HTTP request/response overhead per message.

---

## 5. Free-Tier Budget & Scaling Ceiling

| Resource | Free allowance | Expected usage at ~20–50 users | Headroom |
|---|---|---|---|
| Cloudflare Workers requests | 100K/day | Low hundreds/day for REST calls | Very high |
| Durable Objects | 400K GB-seconds, 1M requests/month | Chat rooms mostly idle/hibernating | High |
| Cloudflare D1 | 5GB storage, 5M reads/writes/month | Users/sessions table, tiny | Very high |
| Backblaze B2 storage | 10GB permanent free | Depends on media volume — the main constraint to monitor | Medium — plan for client-side compression and a future storage-cleanup policy |
| Backblaze B2 egress via Cloudflare | Free (Bandwidth Alliance) | N/A | High |

**Primary scaling constraint to watch:** B2's 10GB storage ceiling, driven by images/videos. Mitigations: aggressive client-side compression, optional auto-expiry of old media (configurable retention), and a manual "upgrade to paid B2 tier" fallback (~$0.006/GB/month) if ever needed — trivially cheap even if exceeded.

---

## 6. Success Metrics
Since this is not a growth product, success is defined operationally rather than commercially:
1. **Reliability:** message delivery success rate ≥ 99.9% for online recipients.
2. **Latency:** p50 message delivery latency ≤ 150ms, p95 ≤ 300ms, measured client-to-client.
3. **Cost:** $0/month infrastructure spend at target user count (5–50 users).
4. **Availability:** app usable (login + send/receive text) with no manual intervention for weeks at a time.
5. **Adoption within the group:** friends actually prefer using it over WhatsApp for at least some conversations (qualitative signal).

---

## 7. Milestones / Phasing

### Phase 0 — Foundation (Week 1)
- Cloudflare account, Workers + D1 + Durable Objects (Agents SDK) project scaffolding.
- Backblaze B2 bucket + Cloudflare custom domain fronting it.
- Auth: login, session cookie, D1 users/sessions schema.

### Phase 1 — MVP Chat (Weeks 2–3)
- `@username` lookup, conversation creation.
- WebSocket connection routed to per-conversation Durable Object.
- Text messaging, message persistence, message history load on open.
- Basic React + Tailwind + DaisyUI UI: login, conversation list, thread view.

### Phase 2 — Rich Content (Week 4)
- Emoji picker integration.
- Image upload/download pipeline (signed URLs, B2, client-side compression).
- Delivery/read receipts, typing indicators.

### Phase 3 — Polish & Stickers (Week 5)
- Sticker pack support.
- Video message support.
- PWA installability, basic Web Push notifications.

### Phase 4 — Privacy Hardening (Stretch, post-MVP)
- E2EE for message bodies (and optionally media).
- Rate limiting hardening, audit logging for the operator.
- Message edit/delete, retention policy tooling.

---

## 8. Risks & Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| B2 10GB storage fills up | Media uploads start failing | Client-side compression, retention/cleanup policy, cheap paid fallback |
| Durable Object cold start on a long-idle conversation | Slight first-message delay after hibernation | Acceptable trade-off given cost savings; typically low tens of ms, not user-perceptible |
| Single operator dependency (you run/maintain everything) | App becomes unavailable if you don't maintain it | Acceptable for a personal-scale project; document setup for future portability |
| No E2EE at launch | Operator/provider could technically read messages | Explicitly disclosed to users in-app; E2EE planned as Phase 4 |
| Free tier policy changes at any provider | Could introduce unexpected cost | Low user count keeps absolute cost trivial even off free tier; monitor provider changelogs |

---

## 9. Design Reference / Style Guide

The definitive visual reference for this project is the retro theme/skin used in the sibling **Portfolio** project (`~/desktop/good/Portfolio`). GoodChat should visually read as part of the same "product family" as that portfolio — same retro sensibility, not a generic UI kit look.

- Canonical entry point: **`.harness/styleguide.md`** — the shared foundation (palettes, type family, motion, the skin contract, the CSS recipe) plus the index of skins.
- **One style guide per skin**, under `.harness/styleguides/`: `retro.md` (default, the Portfolio-derived neobrutalist look) and `terminal.md` (CRT/shell). There is deliberately no single style guide for "the site": a rule like "hard 6px offset shadow" is law under `retro` and forbidden under `terminal`.
- Each skin nevertheless applies to the **entire app** — login, list, thread, composer, admin console, dialogs. Skins are chosen by the user in the appearance screen and are independent of the palette (`data-theme`), so ten palettes × N skins.
- The retro file was **not written by hand in advance** — it was generated by the coding agent at project kickoff by directly reading the Portfolio project's source (colors, fonts, spacing, retro effects, component treatments). The exact process is specified in `inicial.md`, the first prompt the agent receives.
- Any implementation work on UI **must read `.harness/styleguide.md` plus the style guide of every skin it touches before writing component code**, and must treat them as authoritative constraints equal in weight to the functional requirements in this PRD. A new screen is only done when it is right under *every* skin.
- Adding a skin is allowed and cheap: it may ship with a new style guide of its own, or with none when it only re-sets the frame tokens (§5 of `.harness/styleguide.md`).

## 10. Open Questions
1. **User visibility model** (3.2.1): fully open `@username` lookup within the instance, or gated by an explicit connection/approval step?
2. **Message retention:** keep forever, or auto-expire media after N days to protect the B2 quota?
3. **E2EE scope for v1.5:** message text only, or also media files?
4. ~~**Multi-device:** is simultaneous login from phone + desktop required for v1, or is "one active session" acceptable initially?~~ **Answered: simultaneous, with the full history everywhere.** The first encryption design made identity per browser, which made this question expensive — a new device started blind and needed a handover from an old one. The account key removed the question rather than answering it: the key belongs to the person, so every browser they sign into holds the same one.
5. **Invite mechanism:** admin manually creates accounts, or a signed one-time invite link flow?

---

## 11. Appendix — Technology Stack Summary
```
Frontend:        React (Vite) + Tailwind CSS + DaisyUI, PWA (manifest + service worker)
Edge compute:     Cloudflare Workers
Real-time layer:  Cloudflare Agents SDK (Durable Objects), 1 instance per conversation
Relational data:  Cloudflare D1 (users, sessions, conversation index)
Object storage:   Backblaze B2 (images, video, stickers), fronted by Cloudflare (free egress)
Auth:             Opaque session tokens in HttpOnly/Secure/SameSite=Strict cookies, validated against D1
Deployment:       Cloudflare Pages (frontend) + Wrangler (Workers/Durable Objects)
Target cost:      $0/month at expected scale (5–50 users)
Target latency:   50–300ms end-to-end message delivery
```