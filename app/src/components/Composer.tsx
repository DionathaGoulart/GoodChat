// Message composer: retro field, Enter sends, Shift+Enter breaks line.
// client_id/optimistic state live in useConversation — this emits text via
// onSend, media keys via onSendMedia (after compress+upload to B2), sticker
// ids via onSendSticker, and throttled typing hints via onTyping. Emoji are
// inserted at the caret as plain Unicode (picker content lazy-mounts on
// first open). Pickers are daisyUI focus dropdowns — clicking outside (or
// blurring after a sticker send) closes them.

import { useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { MAX_BODY_LENGTH } from '../lib/protocol'
import {
  IMAGE_MIMES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MediaError,
  VIDEO_MIMES,
  compressImage,
  uploadMedia,
  videoDurationSeconds,
} from '../lib/media'
import type { UploadHandle } from '../lib/media'
import { ApiError } from '../lib/api'
import { EmojiPicker } from './EmojiPicker'
import { StickerPicker } from './StickerPicker'

interface Attachment {
  name: string
  phase: 'processando' | 'enviando'
  progress: number
}

const TOOL_BUTTON_CLASS =
  'retro-border cursor-pointer self-stretch bg-base-100 px-3 text-lg font-black transition-all duration-300 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40'

export function Composer({
  onSend,
  onSendMedia,
  onSendSticker,
  onTyping,
}: {
  onSend: (body: string) => void
  onSendMedia: (msgType: 'image' | 'video', mediaKey: string) => void
  onSendSticker: (stickerId: string) => void
  onTyping: () => void
}) {
  const [body, setBody] = useState('')
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [mediaError, setMediaError] = useState<string | null>(null)
  // Lazy-mount flags: picker content only exists after the first open.
  const [emojiOpened, setEmojiOpened] = useState(false)
  const [stickersOpened, setStickersOpened] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const uploadRef = useRef<UploadHandle | null>(null)
  const canSend = body.trim().length > 0

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

    try {
      let blob: Blob
      let mime: string
      let kind: 'image' | 'video'
      if (IMAGE_MIMES.includes(file.type)) {
        kind = 'image'
        setAttachment({ name: file.name, phase: 'processando', progress: 0 })
        ;({ blob, mime } = await compressImage(file))
      } else if (VIDEO_MIMES.includes(file.type)) {
        kind = 'video'
        if (file.size > MAX_VIDEO_BYTES) throw new MediaError('vídeo muito grande (máx 32mb)')
        setAttachment({ name: file.name, phase: 'processando', progress: 0 })
        const duration = await videoDurationSeconds(file)
        if (duration > MAX_VIDEO_SECONDS) throw new MediaError('vídeo muito longo (máx 60s)')
        blob = file
        mime = file.type
      } else {
        throw new MediaError('formato não suportado (jpg/png/webp/gif/mp4/webm)')
      }

      setAttachment({ name: file.name, phase: 'enviando', progress: 0 })
      const handle = uploadMedia(blob, mime, (fraction) =>
        setAttachment((current) => (current ? { ...current, progress: fraction } : current)),
      )
      uploadRef.current = handle
      const { key } = await handle.promise
      onSendMedia(kind, key)
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
        <div className="animate-enter retro-border flex items-center gap-3 bg-base-200 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em]">
          <span className="truncate opacity-60">{attachment.name}</span>
          <span className="shrink-0">
            {attachment.phase === 'processando' ? (
              <>
                processando<span className="terminal-cursor">_</span>
              </>
            ) : (
              `upload: ${Math.round(attachment.progress * 100)}%`
            )}
          </span>
          <progress
            className="progress h-2 w-24 shrink-0"
            value={attachment.phase === 'enviando' ? attachment.progress : undefined}
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
      <form
        className="retro-border flex items-end gap-2 bg-base-200 p-2"
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
        <div className="dropdown dropdown-top self-stretch">
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
            className="dropdown-content z-10 mb-3 retro-border bg-base-100 retro-shadow"
          >
            {emojiOpened && <EmojiPicker onPick={insertEmoji} />}
          </div>
        </div>
        <div className="dropdown dropdown-top self-stretch">
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
            className="dropdown-content z-10 mb-3 w-64 retro-border bg-base-100 retro-shadow"
          >
            {stickersOpened && <StickerPicker onPick={pickSticker} />}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          className="max-h-32 min-h-11 flex-1 resize-none bg-transparent p-2 font-mono text-sm outline-none [field-sizing:content] placeholder:uppercase placeholder:tracking-widest placeholder:opacity-40"
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
          className="btn btn-goodchat retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:retro-shadow active:translate-y-0 disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}
