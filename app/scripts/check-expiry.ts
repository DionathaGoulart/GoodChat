// The expiry display rules (PRD §3.9), executed.
//
//   npm run check:expiry
//
// Everything else about retention is checked against a live server
// (worker/scripts/smoke-phase13.ts): the deadlines, the receipt, the sweep.
// This checks the other half, which no server can see — what a person is
// actually told, and when the thread stays quiet instead.
//
// It is worth its own file because the thresholds in lib/expiry.ts are the
// feature's whole feel, and they are exactly the kind of number that gets
// nudged by one order of magnitude in a refactor without anything failing to
// compile. Pure functions and a fixed clock, so it needs no browser and no
// server: `node --experimental-strip-types` runs the TypeScript directly.

import {
  URGENT_MS,
  fadeFor,
  readCountdown,
  remainingLabel,
  tickFor,
  unreadCountdown,
} from '../src/lib/expiry.ts'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

/** A fixed clock: nothing here may depend on when it is run. */
const now = 1_000_000_000_000

let failures = 0

function eq(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`)
  } else {
    failures++
    console.error(`FAIL: ${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

console.log('\n— how long is left, in words')
eq('three hours reads as three hours', remainingLabel(3 * H), '3h')
eq('and keeps its minutes', remainingLabel(2 * H + 58 * M), '2h58')
eq('padded, so the label does not change width as it counts', remainingLabel(2 * H + 5 * M), '2h05')
eq('under an hour is minutes', remainingLabel(14 * M + 59 * S), '14min')
eq('under a minute is seconds', remainingLabel(40 * S), '40s')
eq('a week is days', remainingLabel(7 * D), '7d')
eq('and days keep their hours', remainingLabel(6 * D + 3 * H), '6d3h')
// The direction matters: a message claiming two hours must have two hours.
eq('it rounds down, never up', remainingLabel(2 * H - 1), '1h59')

console.log('\n— when a read message speaks, and when it does not')
eq('with hours left it stays quiet', readCountdown(now + 2 * H, now, false), null)
eq('unless it is the newest one read', readCountdown(now + 2 * H, now, true), 'some em 2h')
eq('under fifteen minutes every message speaks', readCountdown(now + 14 * M, now, false), 'some em 14min')
eq('just outside that, still quiet', readCountdown(now + URGENT_MS + 1, now, false), null)
eq('under a minute it stops counting', readCountdown(now + 59 * S, now, false), 'sumindo…')
eq('and past due it is going', readCountdown(now - 1, now, true), 'sumindo…')

console.log('\n— and when an unread one does')
eq('six days out is not news', unreadCountdown(now + 6 * D, now), null)
eq('the last two days are', unreadCountdown(now + D, now), 'some em 1d se ninguém abrir')

console.log('\n— the fade over the last five minutes')
eq('untouched with hours left', fadeFor(now + 2 * H, now), 1)
eq('untouched at the edge of it', fadeFor(now + 5 * M, now), 1)
eq('half way through', fadeFor(now + 2.5 * M, now), 0.7)
// Faded past reading would be deleting it early; three hours means three hours.
eq('never past readable', fadeFor(now, now), 0.4)

console.log('\n— how often the thread wakes to redraw them')
eq('hours away: twice a minute', tickFor(now + 2 * H, now), 30 * S)
eq('minutes away: every five seconds', tickFor(now + 9 * M, now), 5 * S)
eq('the last minute: every second', tickFor(now + 30 * S, now), S)
eq('nothing to expire: twice a minute', tickFor(null, now), 30 * S)

console.log(failures === 0 ? '\nexpiry rules: all green' : `\nexpiry rules: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
