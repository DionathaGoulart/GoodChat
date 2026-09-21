// Seeds the local D1 database with two test users. Idempotent (OR IGNORE).
// Credentials are dev-only fixtures, also documented in README.md (Quickstart).

import { insertUser } from './lib.ts'

const SEED_USERS = [
  { username: 'alice', password: 'alice-goodchat', displayName: 'Alice' },
  { username: 'bob', password: 'bob-goodchat', displayName: 'Bob' },
]

for (const user of SEED_USERS) {
  await insertUser(user.username, user.password, user.displayName, { ignoreExisting: true })
  console.log(`seeded "${user.username}" (password: ${user.password})`)
}
