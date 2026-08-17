// Admin CLI: create an account (no public sign-up).
// Usage: npm run user:create -- [--remote] <username> <password> [display name]
// --remote writes to the production D1 database instead of the local one.
// Usernames are stored lowercase and match case-insensitively at login.

import { insertUser } from './lib.ts'

const argv = process.argv.slice(2)
const remote = argv.includes('--remote')
const [username, password, displayName] = argv.filter((arg) => arg !== '--remote')

if (!username || !password) {
  console.error('usage: npm run user:create -- [--remote] <username> <password> [display name]')
  process.exit(1)
}

await insertUser(username, password, displayName ?? username, { remote })
console.log(`user "${username.toLowerCase()}" created (${remote ? 'remote' : 'local'})`)
