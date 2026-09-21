// Admin CLI: grant or revoke the owner role.
// Usage: npm run user:role -- [--remote] <username> <owner|user>
//
// Migration 0003 grants "owner" to a `good` account that already existed when
// it ran — on a fresh database that is nobody, so a new instance names its
// owner here (or with `user:create -- --owner`). There is no bootstrap endpoint
// on purpose: promoting an account is a D1 write, and D1 writes need the deploy
// key.

import { ROLES, setUserRole, type Role } from './lib.ts'

const argv = process.argv.slice(2)
const remote = argv.includes('--remote')
const [username, role] = argv.filter((arg) => !arg.startsWith('--'))

if (!username || !role || !ROLES.includes(role as Role)) {
  console.error(`usage: npm run user:role -- [--remote] <username> <${ROLES.join('|')}>`)
  process.exit(1)
}

setUserRole(username, role as Role, { remote })
console.log(`user "${username.toLowerCase()}" is now ${role} (${remote ? 'remote' : 'local'})`)
