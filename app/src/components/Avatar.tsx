// Square retro avatar: the profile picture when the account has one, otherwise
// the initial on accent.
//
// `avatar_key` is a bucket key, so the URL comes from mediaUrl() — the same
// proxied path a media message uses. The object can be unreadable (deleted
// account, a purge that took it): onError falls back to the initial instead of
// leaving a broken frame in the thread header.
//
// Three states, because a picture arrives over the network: a skeleton while
// the bytes are in flight, the image once it decodes, the initial if it never
// does. Before, the frame sat on the accent fill and the photo popped in — the
// jump was small in a list tile and loud at the 20-square in settings.

import { useRef, useState } from 'react'
import type { PublicUser } from '../lib/api'
import { mediaUrl } from '../lib/media'

/** Two sizes, both squares: the list/header one and the settings preview. */
const SIZES = {
  md: 'size-10 text-lg',
  lg: 'size-20 text-4xl',
} as const

type LoadState = 'loading' | 'ready' | 'failed'

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
  const [state, setState] = useState<LoadState>('loading')

  // A new key is a new picture: back to the skeleton while it loads. Done
  // during render rather than in an effect because the ref below settles an
  // already-cached image synchronously — an effect runs *after* that and would
  // undo it, flashing the skeleton for a frame on every avatar the browser
  // already holds (and it holds them for a year: the media proxy answers
  // `immutable`, worker/src/routes/media.ts).
  const shown = useRef(user.avatar_key)
  if (shown.current !== user.avatar_key) {
    shown.current = user.avatar_key
    setState('loading')
  }

  // `complete` is already true for a cache hit by the time the ref runs, and
  // naturalWidth is how a decoded image is told from a broken one.
  const settle = (img: HTMLImageElement | null) => {
    if (img?.complete) setState(img.naturalWidth > 0 ? 'ready' : 'failed')
  }

  return (
    <div
      className={`retro-border relative flex shrink-0 items-center justify-center overflow-hidden bg-accent text-accent-content ${SIZES[size]} ${className}`}
      aria-hidden="true"
    >
      {user.avatar_key && state !== 'failed' ? (
        <>
          <img
            ref={settle}
            src={mediaUrl(user.avatar_key)}
            alt=""
            // The settings preview is above the fold on the screen that owns
            // it; the small one is mostly list rows, which is what lazy is for.
            loading={size === 'lg' ? 'eager' : 'lazy'}
            onLoad={() => setState('ready')}
            onError={() => setState('failed')}
            className={`size-full object-cover transition-opacity duration-200 ${
              state === 'ready' ? 'opacity-100' : 'opacity-0'
            }`}
          />
          {state === 'loading' && <span className="skeleton absolute inset-0" />}
        </>
      ) : (
        <span className="font-black uppercase">{name.slice(0, 1)}</span>
      )}
    </div>
  )
}
