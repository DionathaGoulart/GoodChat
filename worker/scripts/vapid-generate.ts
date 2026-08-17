// Generate a VAPID key pair for Web Push (phase 8). Run once, then paste the
// output into worker/.dev.vars (local) or `wrangler secret put` (production).
// Usage: npm run vapid:generate
//
// Format matches the classic `web-push` CLI: base64url raw P-256 public key
// (65 bytes, starts with "B...") and base64url 32-byte private scalar.

import { generateVapidKeys } from '@mmmike/web-push/vapid'

const { publicKey, privateKey } = await generateVapidKeys()

console.log('# VAPID keys — paste into worker/.dev.vars (dev) or wrangler secrets (prod)')
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:you@example.com')
