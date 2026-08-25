// The strength meter, wherever a new password is chosen.
//
// It exists because of one line in the plan's cost list: a weak password plus a
// copy of D1 is a readable account. The password stopped being only a login
// credential the moment the account key started being wrapped under a key
// derived from it (lib/kdf.ts) — the rate limiter that made eight characters
// survivable is not in the picture for somebody working offline against a
// dump, and 600k PBKDF2 iterations only multiply the cost of each guess. The
// number of guesses is the person's to decide, and they cannot decide it
// without being told.
//
// So it reports, and it does not gate: MIN_PASSWORD_LENGTH is the only hard
// rule. Required character classes are how people arrive at "Password1!",
// which satisfies four classes and no attacker.

import { passwordStrength } from '../lib/kdf'

const TONE = [
  'bg-error',
  'bg-error',
  'bg-warning',
  'bg-success',
  'bg-success',
] as const

export function PasswordStrength({ password }: { password: string }) {
  if (password.length === 0) return null
  const { score, label } = passwordStrength(password)

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((step) => (
          <span
            key={step}
            className={`h-1 flex-1 ${step < score ? TONE[score] : 'bg-base-300'}`}
          />
        ))}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        {label}
      </span>
    </div>
  )
}
