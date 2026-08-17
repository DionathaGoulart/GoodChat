// Admin CLI: create an account.
// Usage: npm run user:create -- [--remote] [--owner] <username> <password> [display name]
// --remote writes to the production D1 database instead of the local one.
// --owner  provisions the account with the owner role (admin console access);
//          use `npm run user:role` to change it later.
// Usernames are stored lowercase and match case-insensitively at login.

import { insertUser } from './lib.ts'

const argv = process.argv.slice(2)
const remote = argv.includes('--remote')
const owner = argv.includes('--owner')
const [username, password, displayName] = argv.filter((arg) => !arg.startsWith('--'))

if (!username || !password) {
  console.error(
    'usage: npm run user:create -- [--remote] [--owner] <username> <password> [display name]',
  )
  process.exit(1)
}

await insertUser(username, password, displayName ?? username, {
  remote,
  role: owner ? 'owner' : 'user',
})
console.log(
  `user "${username.toLowerCase()}" created as ${owner ? 'owner' : 'user'} (${remote ? 'remote' : 'local'})`,
)
