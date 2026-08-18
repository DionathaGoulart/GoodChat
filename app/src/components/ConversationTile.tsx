// Conversation list item — the retro skin's interactive-tile pattern
// (styleguides/retro.md §6):
// retro-border + hover accent + -translate-y-1, shadow sm→md, press back down.
//
// Presence rides along: a square dot on the avatar and, when the peer is around,
// the word "online" next to their name. The dot is always there (dim when
// offline) so "no dot" never has to mean two different things.

import type { ConversationListItem } from '../lib/api'
import type { Presence } from '../hooks/usePresence'
import { presenceText, resolvePresence } from '../lib/presence'
import { navigate } from '../lib/router'
import { Avatar } from './Avatar'
import { PresenceMarker } from './Presence'

const MEDIA_PREVIEW: Record<string, string> = {
  sticker: '[sticker]',
  image: '[imagem]',
  video: '[vídeo]',
  file: '[arquivo]',
}

function preview(item: ConversationListItem): string {
  const last = item.last_message
  if (!last) return '— sem mensagens —'
  return MEDIA_PREVIEW[last.msg_type] ?? last.body
}

function formatWhen(ms: number | null): string {
  if (ms === null) return ''
  const date = new Date(ms)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

/**
 * `presence` is the live value from the heartbeat store; the payload that listed
 * the conversation already carried one, which is what the tile paints until the
 * first beat lands.
 */
export function ConversationTile({
  item,
  presence,
}: {
  item: ConversationListItem
  presence?: Presence
}) {
  const gone = item.other_user.deleted === true
  const state = resolvePresence(presence, item.other_user)
  const label = gone ? 'conta expirada' : presenceText(state, Date.now())

  return (
    <button
      type="button"
      className="tile group animate-enter flex w-full cursor-pointer items-center gap-3 retro-border bg-base-200 p-4 text-left retro-shadow-sm transition-all duration-300 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow active:translate-y-0"
      onClick={() => navigate({ name: 'thread', userId: item.other_user.id })}
    >
      <PresenceMarker online={!gone && state.online} label={label}>
        <Avatar user={item.other_user} className="group-hover:border-accent-content" />
      </PresenceMarker>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="tile-name truncate text-sm font-black uppercase tracking-tight">
              {gone ? 'conta expirada' : (item.other_user.display_name ?? item.other_user.username)}
            </span>
            {!gone && state.online && (
              <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-success group-hover:text-accent-content">
                online
              </span>
            )}
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
            {formatWhen(item.last_message_at)}
          </span>
        </span>
        <span className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate text-xs opacity-70">{preview(item)}</span>
          {item.unread_count > 0 && (
            <span className="tile-unread shrink-0 bg-accent px-2 py-0.5 font-mono text-[10px] font-black text-accent-content group-hover:bg-accent-content group-hover:text-accent">
              {item.unread_count}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
