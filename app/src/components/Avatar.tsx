// Square retro avatar: the profile picture when the account has one, otherwise
// the initial on accent.
//
// `avatar_key` is a bucket key, so the URL comes from mediaUrl() — the same
// proxied path a media message uses. The object can be unreadable (deleted
// account, a purge that took it): onError falls back to the initial instead of
// leaving a broken frame in the thread header.

import { useEffect, useState } from 'react'
import type { PublicUser } from '../lib/api'
import { mediaUrl } from '../lib/media'

/** Two sizes, both squares: the list/header one and the settings preview. */
const SIZES = {
  md: 'size-10 text-lg',
  lg: 'size-20 text-4xl',
} as const

export function Avatar({
  user,
  size = 'md',
  className = '',
}: {
  user: PublicUser
  size?: keyof typeof SIZES
  className?: string
}) {
  const name = user.display_name ?? user.username
  const [failed, setFailed] = useState(false)

  // A new key is a new picture: give it its own chance to load.
  useEffect(() => setFailed(false), [user.avatar_key])

  return (
    <div
      className={`retro-border flex shrink-0 items-center justify-center overflow-hidden bg-accent text-accent-content ${SIZES[size]} ${className}`}
      aria-hidden="true"
    >
      {user.avatar_key && !failed ? (
        <img
          src={mediaUrl(user.avatar_key)}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <span className="font-black uppercase">{name.slice(0, 1)}</span>
      )}
    </div>
  )
}
