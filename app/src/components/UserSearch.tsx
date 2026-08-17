// Inline @username lookup (phase-3 endpoint) to start a new conversation.
// Debounced 250ms; picking a result navigates to the thread (created lazily
// on first message — nothing is persisted here).

import { useEffect, useRef, useState } from 'react'
import { lookupUsers } from '../lib/api'
import type { PublicUser } from '../lib/api'
import { navigate } from '../lib/router'
import { Avatar } from './Avatar'

export function UserSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PublicUser[] | null>(null)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (q === '' || q === '@') {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      lookupUsers(q)
        .then(({ users }) => {
          if (!cancelled) setResults(users)
        })
        .catch(() => {
          if (!cancelled) setResults([])
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <label className="input flex w-full items-center gap-2 font-mono text-sm">
        <span className="font-black text-accent" aria-hidden="true">
          {'>'}
        </span>
        <input
          type="text"
          className="grow placeholder:uppercase placeholder:tracking-widest placeholder:opacity-40"
          placeholder="buscar @username"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
        />
      </label>

      {open && results !== null && (
        <div className="animate-enter absolute inset-x-0 top-full z-10 mt-2 retro-border bg-base-200 retro-shadow">
          {results.length === 0 ? (
            <p className="p-3 font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
              nenhum usuário encontrado
            </p>
          ) : (
            results.map((user) => (
              <button
                key={user.id}
                type="button"
                className="flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors duration-150 hover:bg-accent hover:text-accent-content"
                onClick={() => {
                  setQuery('')
                  setResults(null)
                  setOpen(false)
                  navigate({ name: 'thread', userId: user.id })
                }}
              >
                <Avatar user={user} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-black uppercase">
                    {user.display_name ?? user.username}
                  </span>
                  <span className="block font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
                    @{user.username}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
