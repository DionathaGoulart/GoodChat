// Loading placeholders, one per layout that has to wait for the network.
//
// The shape is the point: each skeleton copies the frame of the thing it stands
// in for — same border, same shadow, same row heights — so the screen does not
// jump when real data lands, and so the wait reads as "this is a list of
// conversations" instead of "something is happening". Text lines are bars at the
// same size and rhythm as the type they replace.
//
// Motion comes from daisyUI's `skeleton`, which is a slow sweep over base-300 —
// the ambient kind the team rules allow; nothing here slides in or bounces
// (index.css also flattens it under prefers-reduced-motion). Every skeleton is
// `aria-hidden` behind one `role="status"` announcement per screen, so a screen
// reader hears "carregando" once instead of a wall of empty boxes.

import type { ReactNode } from 'react'

function Bar({ className = '' }: { className?: string }) {
  return <span className={`skeleton block h-3 ${className}`} />
}

/** Wrapper that names the wait for assistive tech and hides the boxes from it. */
function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>
      <div aria-hidden="true" className="contents">
        {children}
      </div>
    </>
  )
}

/** Conversation list: tiles at the height of a real ConversationTile. */
export function ConversationListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Loading label="carregando conversas">
      <ul className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <li
            key={index}
            className="flex w-full items-center gap-3 retro-border bg-base-200 p-4 retro-shadow-sm"
          >
            <span className="skeleton size-10 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <Bar className="w-32" />
                <Bar className="w-10" />
              </span>
              <Bar className="mt-2 w-2/3" />
            </span>
          </li>
        ))}
      </ul>
    </Loading>
  )
}

/** Bubbles alternating sides — a thread seen from across the room. */
function Bubbles() {
  const bubbles = [
    { mine: false, width: 'w-40' },
    { mine: true, width: 'w-28' },
    { mine: false, width: 'w-56' },
    { mine: true, width: 'w-36' },
  ]
  return (
    <div className="flex flex-1 flex-col gap-3">
      {bubbles.map((bubble, index) => (
        <span
          key={index}
          className={`skeleton h-12 ${bubble.width} ${bubble.mine ? 'self-end' : 'self-start'}`}
        />
      ))}
    </div>
  )
}

/** Thread being resolved: the header exists (it is the way back out), plus bubbles. */
export function ThreadSkeleton() {
  return (
    <Loading label="abrindo conversa">
      <div className="flex flex-1 flex-col gap-4">
        <div className="retro-border flex items-center gap-3 bg-base-200 p-3 retro-shadow-sm">
          <span className="skeleton size-10 shrink-0" />
          <span className="min-w-0 flex-1">
            <Bar className="w-28" />
            <Bar className="mt-2 w-16" />
          </span>
        </div>
        <Bubbles />
      </div>
    </Loading>
  )
}

/**
 * The thread is resolved and its header is already painted; only the messages
 * are still coming. Shown when the conversation is known to hold some (the
 * resolve said so) and the `history` frame has not landed — never for a thread
 * that has never had a message, which has nothing to wait for.
 */
export function MessagesSkeleton() {
  return (
    <Loading label="carregando mensagens">
      <Bubbles />
    </Loading>
  )
}

/**
 * First paint of a cold start (no cached account, /api/auth/me in flight). The
 * conversation list is where an authenticated session lands, so this is the
 * shell of that screen; if the answer is "anonymous" the login screen replaces
 * it in the same tick the request resolves.
 */
export function BootSkeleton() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-4 screen-pad sm:gap-6">
      <Loading label="carregando goodchat">
        <header className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <Bar className="w-24" />
            <span className="skeleton mt-2 block h-8 w-48" />
          </div>
          <span className="skeleton h-9 w-28" />
        </header>
        <span className="skeleton h-12 w-full" />
      </Loading>
      <ConversationListSkeleton rows={3} />
    </main>
  )
}

/** Owner console: the totals grid, same columns as the real tiles. */
export function StatTilesSkeleton({ tiles = 6 }: { tiles?: number }) {
  return (
    <Loading label="carregando totais">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: tiles }, (_, index) => (
          <div key={index} className="stat-tile retro-border bg-base-200 p-3 retro-shadow-sm">
            <Bar className="w-16" />
            <span className="skeleton mt-2 block h-6 w-20" />
            <Bar className="mt-2 w-24" />
          </div>
        ))}
      </section>
    </Loading>
  )
}

/** Owner console lists (accounts, conversations): rows inside a card. */
export function CardListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <Loading label={label}>
      <ul className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className="admin-row retro-border bg-base-100 p-3">
            <Bar className="w-48" />
            <Bar className="mt-2 w-32" />
          </li>
        ))}
      </ul>
    </Loading>
  )
}
