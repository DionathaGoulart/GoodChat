// Chat bubble (styleguides/retro.md §6): received = base-200 + retro-border, sent =
// accent + retro-border, radius 0, retro-shadow-sm.
//
// The wrapper also carries the message as data — who sent it, at what time, how
// far it got — next to the `msg` hook class. The retro skin ignores all four:
// they exist so the terminal skin can rebuild the bubble as a line of an IRC
// log (`[14:22] <rafael> oi ✓✓`, styles/skin-terminal.css) out of a `::before`,
// without this component ever learning which skin is on. `sender` is passed in
// rather than derived here because only the screen knows both handles. Body is plain text —
// React escapes it; never rendered as HTML (PRD §3.6). Image/video messages
// render straight from the public media URL (media_key), image click opens a
// retro lightbox (native <dialog> + daisyUI modal). Stickers skip the bubble
// chrome entirely — the asset carries its own baked plate. Own messages show
// the delivery state (sent/delivered/read) in the mono meta line.

import { useEffect, useRef, useState } from 'react'
import type { ThreadMessage } from '../hooks/useConversation'
import { decryptBytes } from '../lib/e2ee'
import { fromBase64url } from '../lib/deviceKeys'
import { mediaUrl } from '../lib/media'
import { STICKER_ID_RE } from '../lib/protocol'
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
    <p className={`msg-meta mt-1 font-mono text-[10px] uppercase tracking-[0.2em] ${className}`}>
      {message.status === 'sending' && message.rejected ? (
        // Refused by the server and not queued for another try, so the meta
        // line has to stop saying it is on its way (hooks/useConversation.ts).
        <span className="text-warning">não enviada</span>
      ) : message.status === 'sending' ? (
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

/**
 * The bytes for one attachment.
 *
 * A plaintext object is just a URL and the browser streams it — including
 * ranged requests, so a video seeks. An encrypted one cannot be: AES-GCM
 * authenticates the whole object, so it has to arrive whole before any of it
 * can be trusted. That is the one real cost of encrypting media, it is bounded
 * by the 32MB video cap, and the honest fix is AES-CTR plus a whole-object MAC
 * fed through Media Source Extensions — a different change than this one.
 *
 * The object URL is revoked on unmount, or a thread with a few videos in it
 * would hold every one of them in memory for as long as the tab lives.
 */
function useMediaSource(message: ThreadMessage): { src: string | null; failed: boolean } {
  const plainSrc = message.media_key ? mediaUrl(message.media_key) : null
  const [decrypted, setDecrypted] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const key = message.media_key
  const contentKey = message.contentKey
  const mediaIv = message.enc_media_iv

  useEffect(() => {
    if (!key || !contentKey || !mediaIv) return
    let url: string | null = null
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(mediaUrl(key), { credentials: 'include' })
        if (!response.ok) throw new Error(String(response.status))
        const plain = await decryptBytes(
          contentKey,
          fromBase64url(mediaIv),
          await response.arrayBuffer(),
        )
        if (cancelled) return
        url = URL.createObjectURL(new Blob([plain as BlobPart], { type: message.media_mime }))
        setDecrypted(url)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [key, contentKey, mediaIv, message.media_mime])

  // Encrypted and not yet decrypted is not the same as absent: returning the
  // raw URL here would hand ciphertext to an <img> and render a broken frame.
  //
  // The key can also be legitimately missing while the IV is there — a bubble
  // restored from the local copy, which does not serialize CryptoKeys
  // (lib/threadCache.ts). That is "waiting for history", not "gone", so it
  // holds the skeleton instead of reporting a failure.
  if (mediaIv) return { src: contentKey ? decrypted : null, failed: contentKey ? failed : false }
  return { src: plainSrc, failed }
}

function MediaContent({ message }: { message: ThreadMessage }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // The object can be gone for good: media retention deleted it, or the owner
  // purged the thread. The message row survives either way, so the bubble has
  // to say so instead of showing a broken frame.
  const [gone, setGone] = useState(false)
  const { src, failed } = useMediaSource(message)
  if (!message.media_key) return null

  if (gone || failed) {
    return (
      <span className="retro-border bg-base-200 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        [mídia indisponível]
      </span>
    )
  }

  // Still fetching and decrypting. A skeleton the size of a bubble rather than
  // nothing, so the thread does not jump when the image lands.
  if (!src) return <div className="skeleton h-40 w-56" />

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
  // Validated here rather than upstream, and this is now the only place it
  // happens: an encrypted sticker id is inside the ciphertext, so the worker
  // cannot see it (worker/src/agent.ts says so at the check it used to run).
  // This is the point where the id becomes a URL, which makes it the right
  // place — it also covers a sender that never went through our client.
  const sticker = STICKER_ID_RE.test(stickerId) ? pack?.byId.get(stickerId) : undefined

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

export function MessageBubble({
  message,
  mine,
  sender,
}: {
  message: ThreadMessage
  mine: boolean
  /** Handle of whoever wrote it, without the `@` — the log line's nick. */
  sender: string
}) {
  const data = {
    'data-mine': mine ? 'true' : 'false',
    'data-sender': sender,
    'data-time': formatTime(message.created_at),
    'data-status': message.status,
  }

  // Encrypted, and not for this browser. Expected rather than broken: every
  // message sent before this device registered its key looks like this, and so
  // does one from a device that has since rotated. Saying so is better than an
  // empty bubble, which reads as a bug.
  if (message.sealed) {
    return (
      <div
        {...data}
        className={`msg animate-enter max-w-[85%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
          mine ? 'self-end bg-accent/40' : 'self-start bg-base-200'
        }`}
      >
        <p className="msg-body font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
          [mensagem de antes deste dispositivo]
        </p>
        <MetaLine message={message} mine={mine} className="opacity-40" />
      </div>
    )
  }

  if (message.msg_type === 'sticker') {
    return (
      <div
        {...data}
        className={`msg msg-sticker animate-enter flex max-w-[85%] flex-col sm:max-w-[80%] ${
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
      {...data}
      className={`msg animate-enter max-w-[85%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
        mine ? 'self-end bg-accent text-accent-content' : 'self-start bg-base-200'
      }`}
    >
      {isMedia && <MediaContent message={message} />}
      {message.body.length > 0 && (
        <p className="msg-body whitespace-pre-wrap break-words text-sm">{message.body}</p>
      )}
      <MetaLine message={message} mine={mine} className={mine ? 'opacity-60' : 'opacity-40'} />
    </div>
  )
}
