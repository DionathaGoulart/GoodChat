// Chat bubble (styleguide §6): received = base-200 + retro-border, sent =
// accent + retro-border, radius 0, retro-shadow-sm. Body is plain text —
// React escapes it; never rendered as HTML (PRD §3.6). Image/video messages
// render straight from the public media URL (media_key), image click opens a
// retro lightbox (native <dialog> + daisyUI modal). Stickers skip the bubble
// chrome entirely — the asset carries its own baked plate. Own messages show
// the delivery state (sent/delivered/read) in the mono meta line.

import { useRef, useState } from 'react'
import type { ThreadMessage } from '../hooks/useConversation'
import { mediaUrl } from '../lib/media'
import { stickerAssetUrl, useStickerPack } from '../lib/stickers'

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

const STATUS_LABEL: Record<'sent' | 'delivered' | 'read', string> = {
  sent: 'enviado',
  delivered: 'entregue',
  read: 'lido',
}

/** Mono meta line: time, plus the delivery state on own messages. */
function MetaLine({ message, mine, className = '' }: {
  message: ThreadMessage
  mine: boolean
  className?: string
}) {
  return (
    <p className={`mt-1 font-mono text-[10px] uppercase tracking-[0.2em] ${className}`}>
      {message.status === 'sending' ? (
        <>
          enviando<span className="terminal-cursor">_</span>
        </>
      ) : (
        <>
          {formatTime(message.created_at)}
          {mine && (
            <>
              {' · '}
              <span className={message.status === 'read' ? 'font-black' : ''}>
                {STATUS_LABEL[message.status]}
              </span>
            </>
          )}
        </>
      )}
    </p>
  )
}

function MediaContent({ message }: { message: ThreadMessage }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // The object can be gone for good: media retention deleted it, or the owner
  // purged the thread. The message row survives either way, so the bubble has
  // to say so instead of showing a broken frame.
  const [gone, setGone] = useState(false)
  if (!message.media_key) return null
  const src = mediaUrl(message.media_key)

  if (gone) {
    return (
      <span className="retro-border bg-base-200 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        [mídia indisponível]
      </span>
    )
  }

  if (message.msg_type === 'video') {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={src}
        onError={() => setGone(true)}
        className="max-h-64 w-full min-w-48 bg-base-300/20"
      />
    )
  }
  return (
    <>
      <img
        src={src}
        alt="imagem"
        loading="lazy"
        onError={() => setGone(true)}
        className="max-h-64 w-auto cursor-zoom-in"
        onClick={() => dialogRef.current?.showModal()}
      />
      <dialog ref={dialogRef} className="modal">
        <div className="modal-box max-w-[92vw] border-0 bg-transparent p-0 shadow-none sm:max-w-3xl">
          <img
            src={src}
            alt="imagem ampliada"
            className="retro-border mx-auto max-h-[80vh] w-auto bg-base-100 retro-shadow"
          />
        </div>
        <form method="dialog" className="modal-backdrop cursor-zoom-out bg-base-300/60">
          <button aria-label="fechar imagem">fechar</button>
        </form>
      </dialog>
    </>
  )
}

function StickerContent({ stickerId }: { stickerId: string }) {
  const { pack, error } = useStickerPack()
  const sticker = pack?.byId.get(stickerId)

  if (!pack && !error) return <div className="skeleton h-32 w-32" />
  if (!sticker) {
    return (
      <span className="retro-border bg-base-200 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        [sticker]
      </span>
    )
  }
  return (
    <img
      src={stickerAssetUrl(sticker)}
      alt={`sticker ${sticker.label}`}
      className="h-32 w-32 retro-shadow-sm"
    />
  )
}

export function MessageBubble({ message, mine }: { message: ThreadMessage; mine: boolean }) {
  if (message.msg_type === 'sticker') {
    return (
      <div
        className={`animate-enter flex max-w-[80%] flex-col ${
          mine ? 'items-end self-end' : 'items-start self-start'
        }`}
      >
        <StickerContent stickerId={message.body} />
        <MetaLine message={message} mine={mine} className="opacity-40" />
      </div>
    )
  }

  const isMedia = message.msg_type === 'image' || message.msg_type === 'video'
  return (
    <div
      className={`animate-enter max-w-[80%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
        mine ? 'self-end bg-accent text-accent-content' : 'self-start bg-base-200'
      }`}
    >
      {isMedia && <MediaContent message={message} />}
      {message.body.length > 0 && (
        <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
      )}
      <MetaLine message={message} mine={mine} className={mine ? 'opacity-60' : 'opacity-40'} />
    </div>
  )
}
