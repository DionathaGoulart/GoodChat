// Square retro avatar: image when available, otherwise the initial on accent.

import type { PublicUser } from '../lib/api'

export function Avatar({ user, className = '' }: { user: PublicUser; className?: string }) {
  const name = user.display_name ?? user.username
  return (
    <div
      className={`retro-border flex size-10 shrink-0 items-center justify-center overflow-hidden bg-accent text-accent-content ${className}`}
      aria-hidden="true"
    >
      {user.avatar_url ? (
        <img src={user.avatar_url} alt="" className="size-full object-cover" />
      ) : (
        <span className="text-lg font-black uppercase">{name.slice(0, 1)}</span>
      )}
    </div>
  )
}
