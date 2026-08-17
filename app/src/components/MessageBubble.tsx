// Chat bubble (styleguide §6): received = base-200 + retro-border, sent =
// accent + retro-border, radius 0, retro-shadow-sm. Body is plain text —
// React escapes it; never rendered as HTML (PRD §3.6). Image/video messages
// render straight from the public media URL (media_key), image click opens a
// retro lightbox (native <dialog> + daisyUI modal).

import { useRef } from 'react'
import type { ThreadMessage } from '../hooks/useConversation'
import { mediaUrl } from '../lib/media'

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function MediaContent({ message }: { message: ThreadMessage }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  if (!message.media_key) return null
  const src = mediaUrl(message.media_key)

  if (message.msg_type === 'video') {
    return (
      <video
        controls
        preload="metadata"
        src={src}
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

export function MessageBubble({ message, mine }: { message: ThreadMessage; mine: boolean }) {
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
      <p
        className={`mt-1 font-mono text-[10px] uppercase tracking-[0.2em] ${
          mine ? 'opacity-60' : 'opacity-40'
        }`}
      >
        {message.status === 'sending' ? (
          <>
            enviando<span className="terminal-cursor">_</span>
          </>
        ) : (
          formatTime(message.created_at)
        )}
      </p>
    </div>
  )
}
