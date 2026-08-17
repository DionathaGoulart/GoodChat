// Chat bubble (styleguide §6): received = base-200 + retro-border, sent =
// accent + retro-border, radius 0, retro-shadow-sm. Body is plain text —
// React escapes it; never rendered as HTML (PRD §3.6).

import type { ThreadMessage } from '../hooks/useConversation'

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function MessageBubble({ message, mine }: { message: ThreadMessage; mine: boolean }) {
  return (
    <div
      className={`animate-enter max-w-[80%] p-3 retro-border retro-shadow-sm sm:max-w-[70%] ${
        mine ? 'self-end bg-accent text-accent-content' : 'self-start bg-base-200'
      }`}
    >
      <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
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
