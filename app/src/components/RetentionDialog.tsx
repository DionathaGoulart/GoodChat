// The per-conversation message window (PRD §3.9).
//
// One setting, two owners: whichever side changes it, the other one's thread
// changes with it — so the copy says so plainly instead of letting someone
// believe they set something private to themselves. Seven days is where every
// conversation starts and the longest anyone can pick; the rest of the list
// exists for a conversation that wants less.
//
// Shortening is destructive on the spot: the server sweeps the history against
// the new window the moment it lands. That is the point of the feature, and it
// is what the warning line under the grid is for.

import { Modal } from './Modal'
import { RETENTION_CHOICES, retentionLabel } from '../lib/retention'
import type { RetentionMs } from '../lib/protocol'

export function RetentionDialog({
  current,
  peerName,
  disabled,
  onSelect,
  onClose,
}: {
  current: RetentionMs
  /** Who else this applies to — the setting is shared, and it should read so. */
  peerName: string
  /** The socket is down: the choice cannot be made shared right now. */
  disabled: boolean
  onSelect: (retentionMs: RetentionMs) => void
  onClose: () => void
}) {
  return (
    <Modal onCancel={onClose}>
      <div>
        <h2 className="section-label font-mono text-xs font-bold uppercase tracking-widest text-accent">
          <span className="sigil">{'>'}</span> prazo das mensagens
        </h2>
        <p className="mt-2 text-sm opacity-70">
          Cada mensagem se apaga sozinha depois desse tempo — texto, imagem, vídeo e
          áudio, do servidor e do armazenamento. Vale para você e para @{peerName}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {RETENTION_CHOICES.map((option) => {
          const active = option === current
          return (
            <button
              key={option}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onSelect(option)}
              className={`retro-border cursor-pointer p-3 font-mono text-[11px] font-black uppercase tracking-widest transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? 'bg-accent text-accent-content retro-shadow-sm'
                  : 'bg-base-200 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow-sm active:translate-y-0'
              }`}
            >
              {retentionLabel(option)}
            </button>
          )
        })}
      </div>

      <p className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-60">
        {disabled
          ? 'sem conexão — reconecte para mudar o prazo'
          : 'um prazo menor apaga agora o que já passou dele'}
      </p>

      <form method="dialog" className="flex justify-end">
        <button
          type="submit"
          className="icon-btn retro-border cursor-pointer bg-base-200 px-3 py-2 font-mono text-[10px] font-black uppercase tracking-widest transition-all duration-300 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow-sm active:translate-y-0"
        >
          fechar
        </button>
      </form>
    </Modal>
  )
}
