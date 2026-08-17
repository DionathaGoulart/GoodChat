// Admin CLI: create an account in the local D1 database (no public sign-up).
// Usage: npm run user:create -- <username> <password> [display name]
// For the remote DB, run the printed SQL manually with `--remote` after review.

import { insertUser } from './lib.ts'

const [username, password, displayName] = process.argv.slice(2)

if (!username || !password) {
  console.error('usage: npm run user:create -- <username> <password> [display name]')
  process.exit(1)
}

await insertUser(username, password, displayName ?? username)
console.log(`user "${username}" created`)
