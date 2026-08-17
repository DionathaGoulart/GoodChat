// Message composer: retro field, Enter sends, Shift+Enter breaks line.
// client_id/optimistic state live in useConversation — this only emits text.

import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MAX_BODY_LENGTH } from '../lib/protocol'

export function Composer({ onSend }: { onSend: (body: string) => void }) {
  const [body, setBody] = useState('')
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

  return (
    <form
      className="retro-border flex items-end gap-2 bg-base-200 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        className="max-h-32 min-h-11 flex-1 resize-none bg-transparent p-2 font-mono text-sm outline-none [field-sizing:content] placeholder:uppercase placeholder:tracking-widest placeholder:opacity-40"
        placeholder="mensagem_"
        rows={1}
        maxLength={MAX_BODY_LENGTH}
        value={body}
        onChange={(event) => setBody(event.target.value)}
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
  )
}
