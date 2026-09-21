# Security

GoodChat advertises end-to-end encryption, so a flaw in it is worth reporting
even when it looks small.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

- **Preferred:** GitHub's private vulnerability reporting, on this
  repository's **Security** tab → *Report a vulnerability*.
- **Or email:** dionatha.work@gmail.com, with `[GoodChat security]` in the
  subject.

Include what you found, how to reproduce it (a request, a script, or steps
against a local instance), and what an attacker gains. Please test against
your own local or self-hosted instance, not against
`goodchat.dionatha.com.br`. Real people use that instance.

This is a one-person project, so responses are best effort. Expect an
acknowledgement within a week. Fixes land on `main`, and the reference
instance deploys on every push to `main`. You will be credited in the release
notes unless you ask not to be.

## Supported versions

Only the latest release and `main` get fixes. Before 1.0, the wire format and
the key format can change between minor versions (see
[CHANGELOG.md](CHANGELOG.md)).

## What is in scope

These matter most:

- anything that lets the server, the operator, or a third party read message
  or attachment content (`app/src/lib/e2ee.ts`, `accountKeys.ts`, `kdf.ts`,
  `app/public/sw.js`, `worker/src/agent.ts`)
- recovering a password, or the key it wraps, from what the server stores
- reading media without being a participant (`worker/src/routes/media.ts`)
- authentication, session, CSRF and CORS bypasses, and owner-role escalation
- messages or media that survive past their expiry

## Known limitations

These are known and documented, so they are not vulnerabilities.
[docs/architecture.md](docs/architecture.md#end-to-end-encryption) has the
full list with the reasoning behind each one.

- **The crypto has not been audited.** It is a custom protocol built on
  WebCrypto: ECDH P-256, AES-256-GCM, HKDF, and PBKDF2-SHA-256 at 600k
  iterations.
  Independent implementations cross-check it (`smoke:phase15` and
  `smoke:phase16`). That is not a review.
- **No forward secrecy.** Keys are static ECDH keys. The retention window
  (seven days at most) bounds what a leaked key opens.
- **A hostile operator can serve hostile code.** The app comes from the same
  origin it talks to.
- **Metadata is visible to the server:** who talks to whom and when,
  ciphertext sizes, read times, usernames, display names and avatars.
- **Server timestamps and message order are not authenticated.**
- **A weak password can be attacked offline** by anyone holding a copy of
  the database.

## Operators

If you run an instance, set `RATE_LIMIT_SALT` and `KDF_DECOY_SALT` as Worker
secrets. The source contains public fallbacks for both. Leaving them unset
lets anyone reverse the rate-limit IP digests and enumerate usernames through
`/api/auth/kdf`. See [docs/deployment.md](docs/deployment.md).
