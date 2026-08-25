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
//
// The meta line also carries the clock (PRD §3.9). A read message has three
// hours left and says so; in its last five minutes the whole bubble fades, so
// the disappearance arrives as something continuous rather than as a row that
// blinks out. What it does *not* do is put a countdown on every bubble — the
// rules for that are in lib/expiry.ts, and they exist because a wall of running
// clocks is a thread nobody wants to sit in.

import { useEffect, useRef, useState } from 'react'
import type { ThreadMessage } from '../hooks/useConversation'
import { fadeFor, readCountdown, unreadCountdown } from '../lib/expiry'
import {
  CHUNK_PREFIX_BYTES,
  MEDIA_CHUNK_BYTES,
  decryptBytes,
  decryptChunks,
  sealedChunkCount,
} from '../lib/e2ee'
import { fromBase64url } from '../lib/kdf'
import { mediaUrl } from '../lib/media'
import { handStreamToWorker, releaseStream } from '../lib/mediaStream'
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

/**
 * The clock, as one phrase or none.
 *
 * A read message counts down for both of them — the row is one row on the
 * server, so the deadline is shared and neither side is watching a private
 * copy. An unread one speaks only to its sender, and only near the seven-day
 * ceiling: "they still have not opened this" is the sender's problem, and
 * telling the recipient how long they have left to open it would be the app
 * nagging on the other person's behalf.
 */
function clockLine(
  message: ThreadMessage,
  mine: boolean,
  now: number,
  prominent: boolean,
): string | null {
  if (message.status === 'sending') return null
  if (message.read_at !== null) return readCountdown(message.expires_at, now, prominent)
  return mine ? unreadCountdown(message.expires_at, now) : null
}

/** Mono meta line: time, the delivery state on own messages, and the clock. */
function MetaLine({ message, mine, now, prominent, className = '' }: {
  message: ThreadMessage
  mine: boolean
  now: number
  prominent: boolean
  className?: string
}) {
  const clock = clockLine(message, mine, now, prominent)
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
          {clock && (
            <>
              {' · '}
              <span className="msg-clock whitespace-nowrap">{clock}</span>
            </>
          )}
        </>
      )}
    </p>
  )
}

/**
 * The chunk size to read one object back at, which is not always the one the
 * envelope states.
 *
 * Everything written since chunking shipped is chunked, but for a while the
 * composer dropped `chunk` on its way into the message, so those envelopes
 * describe a whole-object shape the bucket never held. The nonce is what gives
 * the real format away — eight bytes is a chunk prefix, twelve is a whole-object
 * IV — so a mismatch is read as chunked at the only size that was ever written
 * rather than as a broken attachment. Objects genuinely written before chunking
 * carry a twelve-byte IV and still take the whole-object path.
 */
function chunkSizeOf(message: ThreadMessage): number | undefined {
  if (message.enc_media_chunk) return message.enc_media_chunk
  if (!message.enc_media_iv) return undefined
  return fromBase64url(message.enc_media_iv).length === CHUNK_PREFIX_BYTES
    ? MEDIA_CHUNK_BYTES
    : undefined
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

  const mediaChunk = chunkSizeOf(message)
  const isVideo = message.msg_type === 'video'

  useEffect(() => {
    if (!key || !contentKey || !mediaIv) return
    let url: string | null = null
    let cancelled = false
    let handed: string | null = null
    void (async () => {
      try {
        // Video, sealed in chunks: handed to the service worker instead of
        // downloaded here. The element then plays and seeks against a URL the
        // worker answers a range at a time, which is the whole point of the
        // chunked format — a blob URL would mean waiting for all 32MB first.
        //
        // Images take the simple path whatever their shape. They are capped at
        // 8MB, they are useless until complete anyway, and an <img> has no
        // range requests to make.
        if (isVideo && mediaChunk) {
          handed = await handStreamToWorker({
            mediaKey: key,
            contentKey,
            prefix: mediaIv,
            chunk: mediaChunk,
            mime: message.media_mime,
            url: mediaUrl(key),
          })
          if (cancelled) return
          if (handed) {
            setDecrypted(handed)
            return
          }
          // No worker to hand it to — a browser that refuses one, or a tab that
          // is not controlled yet. Falls through to downloading it whole, which
          // is what every video did before this path existed.
        }

        const response = await fetch(mediaUrl(key), { credentials: 'include' })
        if (!response.ok) throw new Error(String(response.status))
        const bytes = new Uint8Array(await response.arrayBuffer())
        const plain = mediaChunk
          ? await decryptChunks(
              contentKey,
              fromBase64url(mediaIv),
              bytes,
              0,
              sealedChunkCount(bytes.length, mediaChunk),
              mediaChunk,
            )
          : // Written before chunking, and readable for as long as retention
            // keeps it: one whole ciphertext under a twelve-byte IV.
            await decryptBytes(contentKey, fromBase64url(mediaIv), bytes as BufferSource)
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
      if (handed) void releaseStream(handed)
    }
  }, [key, contentKey, mediaIv, mediaChunk, isVideo, message.media_mime])

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

function MediaContent({ message, onOpened }: {
  message: ThreadMessage
  /**
   * The person actually opened this attachment (PRD §3.9). Only a video calls
   * it — an image's thumbnail *is* the image, so it is read the moment it is on
   * screen like any other bubble, while a video scrolled past is a poster frame
   * nobody watched.
   */
  onOpened?: () => void
}) {
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
        onPlay={onOpened}
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

/**
 * What an unopened message says. Four sentences rather than one, because the
 * causes call for different reactions (`useConversation.ts` documents each).
 *
 * `[mensagem de antes deste dispositivo]` used to be the commonest of these
 * and is gone: with one key per account, a browser signing in can open the
 * whole history. What replaced it is narrower and true — a message sealed
 * before that change, to a key this browser never had — and it stops appearing
 * at all once retention has cleared the last of them.
 */
const SEALED_TEXT: Record<NonNullable<ThreadMessage['sealedReason']>, string> = {
  'no-key': '[sem chave neste navegador]',
  'predates-account-key': '[mensagem de antes desta mudança]',
  'unknown-sender': '[a chave de quem enviou não existe mais]',
  undecryptable: '[não foi possível abrir esta mensagem]',
}

/**
 * The line under it, for the cases somebody can make sense of. A private
 * window keeps no key, so every message in every thread reads as `no-key` —
 * saying why once per bubble beats letting it look like data loss.
 */
const SEALED_HINT: Partial<Record<NonNullable<ThreadMessage['sealedReason']>, string>> = {
  'no-key': 'janela anônima ou dados apagados',
  'predates-account-key': 'só abre no navegador que a recebeu',
}

export function MessageBubble({
  message,
  mine,
  sender,
  now,
  prominent = false,
  watch,
  onOpened,
}: {
  message: ThreadMessage
  mine: boolean
  /** Handle of whoever wrote it, without the `@` — the log line's nick. */
  sender: string
  /** The thread's clock — one for all of its bubbles (hooks/useExpiryClock.ts). */
  now: number
  /** The newest read message in its run: the one allowed to count down early. */
  prominent?: boolean
  /**
   * Ref callback that puts this bubble under the read observer, or undefined
   * when it must not be watched — my own message, one already read, or one this
   * device could not decrypt. Passing it is the caller's statement that what is
   * on screen is the real thing (lib/readObserver.ts).
   */
  watch?: (element: HTMLElement | null) => void
  /** Reports this message read on an explicit open — see `MediaContent`. */
  onOpened?: () => void
}) {
  const data = {
    'data-mine': mine ? 'true' : 'false',
    'data-sender': sender,
    'data-time': formatTime(message.created_at),
    'data-status': message.status,
  }
  // Only in the last five minutes, and only then: an inline opacity on every
  // bubble would fight the entrance animation for the other 99% of a message's
  // life, and there is nothing to say while three hours are left.
  const fade = fadeFor(message.expires_at, now)
  const fading = fade < 1
  const clockProps = {
    style: fading ? { opacity: fade } : undefined,
    'data-expiring': fading ? 'true' : undefined,
  }

  // Encrypted and unopened. Expected rather than broken in three of the four
  // cases: a message older than the account key, a sender whose key is gone,
  // or a browser that keeps no keys at all. Saying which is better than one
  // sentence for all of them, and far better than an empty bubble.
  if (message.sealed) {
    const reason = message.sealedReason ?? 'undecryptable'
    const hint = SEALED_HINT[reason]
    return (
      <div
        {...data}
        {...clockProps}
        className={`msg animate-enter max-w-[85%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
          fading ? 'msg-fading ' : ''
        }${mine ? 'self-end bg-accent/40' : 'self-start bg-base-200'}`}
      >
        <p
          className={`msg-body font-mono text-[10px] uppercase tracking-[0.2em] ${
            reason === 'undecryptable' ? 'text-warning opacity-80' : 'opacity-60'
          }`}
        >
          {SEALED_TEXT[reason]}
        </p>
        {hint && (
          <p className="font-mono text-[9px] uppercase tracking-[0.15em] opacity-40">{hint}</p>
        )}
        <MetaLine message={message} mine={mine} now={now} prominent={prominent} className="opacity-40" />
      </div>
    )
  }

  if (message.msg_type === 'sticker') {
    return (
      <div
        {...data}
        {...clockProps}
        ref={watch}
        className={`msg msg-sticker animate-enter flex max-w-[85%] flex-col sm:max-w-[80%] ${
          fading ? 'msg-fading ' : ''
        }${mine ? 'items-end self-end' : 'items-start self-start'}`}
      >
        <StickerContent stickerId={message.body} />
        <MetaLine message={message} mine={mine} now={now} prominent={prominent} className="opacity-40" />
      </div>
    )
  }

  const isMedia = message.msg_type === 'image' || message.msg_type === 'video'
  return (
    <div
      {...data}
      {...clockProps}
      ref={watch}
      className={`msg animate-enter max-w-[85%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
        fading ? 'msg-fading ' : ''
      }${mine ? 'self-end bg-accent text-accent-content' : 'self-start bg-base-200'}`}
    >
      {isMedia && <MediaContent message={message} onOpened={onOpened} />}
      {message.body.length > 0 && (
        <p className="msg-body whitespace-pre-wrap break-words text-sm">{message.body}</p>
      )}
      <MetaLine
        message={message}
        mine={mine}
        now={now}
        prominent={prominent}
        className={mine ? 'opacity-60' : 'opacity-40'}
      />
    </div>
  )
}
