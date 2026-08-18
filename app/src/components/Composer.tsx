// Message composer: retro field, Enter sends, Shift+Enter breaks line.
// client_id/optimistic state live in useConversation — this emits text via
// onSend, media keys via onSendMedia (after compress+upload to B2), sticker
// ids via onSendSticker, and throttled typing hints via onTyping. Emoji are
// inserted at the caret as plain Unicode (picker content lazy-mounts on
// first open). Pickers are daisyUI focus dropdowns — clicking outside (or
// blurring after a sticker send) closes them.

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { MAX_BODY_LENGTH } from '../lib/protocol'
import { IMAGE_MIMES, MediaError, VIDEO_MIMES, prepareMedia, uploadMedia } from '../lib/media'
import type { UploadHandle } from '../lib/media'
import { ApiError } from '../lib/api'
import { readDraft, writeDraft } from '../lib/drafts'
import { EmojiPicker } from './EmojiPicker'
import { StickerPicker } from './StickerPicker'

interface Attachment {
  name: string
  phase: 'processando' | 'enviando'
  progress: number
}

/** "2.4mb" — compression feedback is only meaningful in whole-ish numbers. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}mb`
  return `${Math.max(1, Math.round(bytes / 1024))}kb`
}

const TOOL_BUTTON_CLASS =
  'tool-btn retro-border cursor-pointer self-stretch bg-base-100 px-3 text-lg font-black transition-all duration-300 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40'

export function Composer({
  conversationId,
  onSend,
  onSendMedia,
  onSendSticker,
  onTyping,
}: {
  /** Which thread the unsent text belongs to (lib/drafts.ts). */
  conversationId: string
  onSend: (body: string) => void
  onSendMedia: (msgType: 'image' | 'video', mediaKey: string) => void
  onSendSticker: (stickerId: string) => void
  onTyping: () => void
}) {
  const [body, setBody] = useState(() => readDraft(conversationId))
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  /** "12.4mb → 3.1mb" after a compression that actually won. */
  const [savings, setSavings] = useState<string | null>(null)
  // Lazy-mount flags: picker content only exists after the first open.
  const [emojiOpened, setEmojiOpened] = useState(false)
  const [stickersOpened, setStickersOpened] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const uploadRef = useRef<UploadHandle | null>(null)
  const canSend = body.trim().length > 0

  // Debounced so a fast typist is not writing to storage on every keystroke.
  // The cleanup cancels rather than flushes, which is what makes a send land
  // correctly: submit() clears the body, the pending timer for the old text is
  // dropped, and the timer for the empty string removes the key.
  useEffect(() => {
    const timer = window.setTimeout(() => writeDraft(conversationId, body), 300)
    return () => window.clearTimeout(timer)
  }, [body, conversationId])

  const submit = () => {
    if (!canSend) return
    onSend(body)
    setBody('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const onBodyChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setBody(event.target.value)
    onTyping()
  }

  // The textarea keeps its selection while unfocused, so the caret position
  // survives the click into the picker; restore it right after the re-render.
  const insertEmoji = (unicode: string) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? body.length
    const end = el?.selectionEnd ?? body.length
    const next = body.slice(0, start) + unicode + body.slice(end)
    if (next.length > MAX_BODY_LENGTH) return
    setBody(next)
    onTyping()
    requestAnimationFrame(() => {
      if (el) el.selectionStart = el.selectionEnd = start + unicode.length
    })
  }

  const pickSticker = (stickerId: string) => {
    onSendSticker(stickerId)
    // Focus dropdown: dropping focus is what closes the popover.
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // allow re-selecting the same file
    if (!file || attachment) return
    setMediaError(null)
    setSavings(null)

    try {
      // Compression is the slow phase for video (it runs in real time), so it
      // reports progress of its own instead of a spinner.
      setAttachment({ name: file.name, phase: 'processando', progress: 0 })
      const prepared = await prepareMedia(file, (fraction) =>
        setAttachment((current) =>
          current ? { ...current, phase: 'processando', progress: fraction } : current,
        ),
      )
      if (prepared.blob.size < prepared.originalSize) {
        setSavings(`${formatBytes(prepared.originalSize)} → ${formatBytes(prepared.blob.size)}`)
      }

      setAttachment({ name: file.name, phase: 'enviando', progress: 0 })
      const handle = uploadMedia(prepared.blob, prepared.mime, (fraction) =>
        setAttachment((current) => (current ? { ...current, progress: fraction } : current)),
      )
      uploadRef.current = handle
      const { key } = await handle.promise
      onSendMedia(prepared.kind, key)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // user cancelled — no error line
      } else if (error instanceof MediaError) {
        setMediaError(error.message)
      } else if (error instanceof ApiError) {
        setMediaError(
          error.code === 'payload_too_large'
            ? 'arquivo muito grande'
            : error.code === 'unsupported_media_type'
              ? 'formato não suportado'
              : error.code === 'media_not_configured'
                ? 'mídia não configurada no servidor'
                : 'falha no upload',
        )
      } else {
        setMediaError('falha no upload')
      }
    } finally {
      uploadRef.current = null
      setAttachment(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {attachment && (
        <div className="animate-enter retro-border flex flex-wrap items-center gap-x-3 gap-y-1 bg-base-200 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em]">
          <span className="w-full truncate opacity-60 sm:w-auto sm:flex-1">{attachment.name}</span>
          <span className="shrink-0">
            {attachment.phase === 'processando' && attachment.progress === 0 ? (
              <>
                processando<span className="terminal-cursor">_</span>
              </>
            ) : (
              `${attachment.phase === 'processando' ? 'comprimindo' : 'upload'}: ${Math.round(attachment.progress * 100)}%`
            )}
          </span>
          <progress
            className="progress h-2 w-16 shrink-0 sm:w-24"
            value={attachment.progress > 0 ? attachment.progress : undefined}
            max={1}
          />
          <button
            type="button"
            className="shrink-0 cursor-pointer font-black text-error hover:underline"
            onClick={() => uploadRef.current?.abort()}
          >
            cancelar
          </button>
        </div>
      )}
      {mediaError && (
        <p className="animate-enter border-2 border-error bg-error/10 px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          {mediaError}
        </p>
      )}
      {savings && !attachment && (
        <p className="animate-enter font-mono text-[10px] uppercase tracking-[0.2em] opacity-50">
          comprimido: {savings}
        </p>
      )}
      {/*
        Phone layout is two rows: the field takes one of its own and the tools
        plus the send button share the next. On a single row — which is what
        every width from `sm` up still gets — three tool buttons and a CTA left
        the field about four characters wide at 390px, which is not a composer.
        `basis-full` is what wraps it; the terminal skin trims that basis by the
        width of its `msg>` prompt (styles/skin-terminal.css) so the prompt
        rides the same row as the field it introduces.
      */}
      <form
        className="composer relative retro-border flex flex-wrap items-end gap-2 bg-base-200 p-2 sm:flex-nowrap"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={[...IMAGE_MIMES, ...VIDEO_MIMES].join(',')}
          onChange={pickFile}
        />
        <button
          type="button"
          aria-label="anexar imagem ou vídeo"
          disabled={attachment !== null}
          onClick={() => fileInputRef.current?.click()}
          className={TOOL_BUTTON_CLASS}
        >
          +
        </button>
        {/* Static on a phone so the popover below anchors to the form (which is
            `relative`) instead of to this button: a 88vw picker hung off a
            button sitting a third of the way in ran past the right edge. */}
        <div className="dropdown dropdown-top static self-stretch sm:relative">
          <button
            type="button"
            aria-label="abrir emojis"
            onClick={() => setEmojiOpened(true)}
            className={`${TOOL_BUTTON_CLASS} h-full text-sm tracking-tighter`}
          >
            :)
          </button>
          <div
            tabIndex={0}
            className="dropdown-content left-0 z-10 mb-3 retro-border bg-base-100 retro-shadow sm:left-auto"
          >
            {emojiOpened && <EmojiPicker onPick={insertEmoji} />}
          </div>
        </div>
        <div className="dropdown dropdown-top static self-stretch sm:relative">
          <button
            type="button"
            aria-label="abrir stickers"
            onClick={() => setStickersOpened(true)}
            className={`${TOOL_BUTTON_CLASS} h-full`}
          >
            ▦
          </button>
          <div
            tabIndex={0}
            className="dropdown-content left-0 z-10 mb-3 w-64 retro-border bg-base-100 retro-shadow sm:left-auto"
          >
            {stickersOpened && <StickerPicker onPick={pickSticker} />}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          className="composer-input -order-1 max-h-32 min-h-11 w-full flex-1 basis-full resize-none bg-transparent p-2 font-mono text-sm outline-none [field-sizing:content] placeholder:uppercase placeholder:tracking-widest placeholder:opacity-40 sm:order-none sm:w-auto sm:basis-0"
          placeholder="mensagem_"
          rows={1}
          maxLength={MAX_BODY_LENGTH}
          value={body}
          onChange={onBodyChange}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="btn btn-goodchat ml-auto retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0 disabled:opacity-40 sm:ml-0"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}
