// Everything a password turns into, all of it on this side of the wire.
//
// Until this module existed, signing in meant posting the password to the
// worker, which hashed it and compared. That is the ordinary shape and it was
// fine while the password only bought *access* — but the account key (lib/
// accountKeys.ts) is wrapped under a key derived from the same password, so a
// server that sees the password is a server that can unwrap every message the
// account can read. The premise of the product is that it cannot. So the
// password stops travelling.
//
// Three values come out of one password, and only one of them leaves:
//
//   masterKey = PBKDF2-SHA256(password, kdf_salt, 600_000)   stays here
//   authToken = PBKDF2-SHA256(masterKey, password, 1)        goes to the server
//   wrapKey   = HKDF(masterKey, "goodchat/wrap/v1")          stays here
//
// The server stores `hashPassword(authToken)` — worker/src/lib/password.ts is
// untouched, it just gets a different string as input. Learning `authToken`,
// by reading D1 or by watching the wire, does not give up `masterKey`: PBKDF2
// is one-way in the direction that matters, so there is no path from the token
// back to the key that unwraps anything.
//
// 600_000 iterations, which is the OWASP figure for PBKDF2-SHA-256 and which
// the worker could never reach: the Workers runtime caps `crypto.subtle`
// PBKDF2 at 100k. That cap was a documented compromise in password.ts; moving
// the expensive derivation into the browser makes it go away rather than
// trading it for something else. A browser has no such limit, and ~600ms once
// per sign-in is a cost a person pays willingly and an offline attacker pays
// per guess.
//
// `authToken` is derived from `masterKey` *and* the password rather than from
// `masterKey` alone, and with one iteration rather than many: one iteration
// because `masterKey` is already 600k iterations deep and stretching it again
// buys nothing, and the password as the second input because it keeps the two
// derivations from ever collapsing into the same value if the info strings
// were to drift.
//
// No import, on purpose — not React, not ./api, nothing. That is what lets
// worker/scripts/lib.ts import this file directly and create an account from
// the terminal that the browser can actually sign in to. Two implementations
// of this that agreed *nearly* would be an instance where nobody can log in.

/**
 * What a password costs to turn into a key. Stored per account (migration
 * 0013) rather than assumed, so the number can go up later without locking
 * anybody out: an account keeps whatever it was created with until it rotates.
 */
export const KDF_ITERATIONS = 600_000

/** Salt length. 16 random bytes, the same as lib/password.ts uses. */
const KDF_SALT_BYTES = 16

/** Bytes out of every derivation here. */
const KEY_BYTES = 32

/**
 * The minimum this instance accepts, and the one number in this file that is
 * a product decision rather than a cryptographic one.
 *
 * Twelve rather than eight, because what a password protects changed. It used
 * to protect a login, which a rate limiter defends: five guesses per fifteen
 * minutes makes an eight-character password survivable. It now also protects
 * every message the account can read, against somebody holding a copy of D1
 * and no rate limiter at all — offline, at whatever rate their hardware runs.
 * 600k iterations is what makes each of those guesses expensive; the length is
 * what makes there be too many of them.
 *
 * Mirrored by MIN_PASSWORD_LENGTH in worker/src/lib/users.ts, which is where
 * the check still runs for the paths on which the worker does see a password
 * (the owner console and the CLI). On the paths it does not, this constant is
 * the whole of the enforcement — stated here so that is not a surprise.
 */
export const MIN_PASSWORD_LENGTH = 12

/** What `POST /api/auth/kdf` answers with. */
export interface KdfParams {
  /** base64url, 16 bytes. */
  salt: string
  iterations: number
}

/**
 * The two things a password becomes.
 *
 * `masterKey` is deliberately not among them. It exists for the length of one
 * call and is never returned, stored or logged: anything holding it can mint
 * both of these, and nothing in the app needs to.
 */
export interface AccountSecrets {
  /** base64url. The only value here that is ever sent anywhere. */
  authToken: string
  /**
   * AES-GCM 256, non-extractable, for wrapping the account key (lib/
   * accountKeys.ts). Non-extractable because nothing should be able to
   * serialize it out — it is used, never copied.
   */
  wrapKey: CryptoKey
}

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Fresh parameters, for a new account or a rotation. */
export function newKdfParams(): KdfParams {
  return {
    salt: base64url(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES))),
    iterations: KDF_ITERATIONS,
  }
}

async function pbkdf2(
  material: BufferSource,
  salt: BufferSource,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

/**
 * One password, one round of the expensive derivation, both outputs.
 *
 * One function rather than two because the expensive half must run exactly
 * once per sign-in: two entry points would eventually mean two 600k
 * derivations back to back, which is the difference between a login that feels
 * slow and one that feels broken.
 */
export async function deriveAccountSecrets(
  password: string,
  params: KdfParams,
): Promise<AccountSecrets> {
  const passwordBytes = new TextEncoder().encode(password)
  const masterKey = await pbkdf2(
    passwordBytes as BufferSource,
    fromBase64url(params.salt) as BufferSource,
    params.iterations,
  )

  const authToken = await pbkdf2(masterKey as BufferSource, passwordBytes as BufferSource, 1)

  const material = await crypto.subtle.importKey(
    'raw',
    masterKey as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  )
  const wrapKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // No salt: `masterKey` is already salted, by `params.salt`, at 600k
      // iterations. A second salt here would be ceremony.
      salt: new Uint8Array(0) as BufferSource,
      info: new TextEncoder().encode('goodchat/wrap/v1') as BufferSource,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { authToken: base64url(authToken), wrapKey }
}

// --- the meter ------------------------------------------------------------
//
// Not a password policy. Required classes of character are how people end up
// with "Password1!", which is four classes and no entropy; length is what
// actually costs an offline attacker anything, and the only hard rule here is
// MIN_PASSWORD_LENGTH above.
//
// So this scores rather than refuses, and it scores the two things that are
// true regardless of which wordlist somebody has: how long it is, and how much
// of it is not repetition of the rest. It exists because point 1 of this
// plan's cost list is "weak password + a copy of D1 = readable", and a number
// nobody is shown is a number nobody acts on.

export interface PasswordStrength {
  /** 0–4. Below 2 is worth saying something about. */
  score: number
  label: string
}

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) return { score: 0, label: '' }

  // Distinct characters rather than character classes: "aaaaaaaaaaaaaaaa" is
  // sixteen characters and one of them.
  const distinct = new Set(password).size
  const variety = Math.min(1, distinct / 12)
  const length = Math.min(1, password.length / 20)
  // Length weighted heavier, because it is the term that actually multiplies
  // the search space.
  const score = Math.round((length * 0.65 + variety * 0.35) * 4)

  const labels = ['muito fraca', 'fraca', 'ok', 'boa', 'forte']
  return { score, label: labels[Math.min(4, Math.max(0, score))] as string }
}
