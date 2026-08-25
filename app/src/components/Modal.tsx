// Native <dialog>, so Escape and a backdrop click close it without extra
// wiring, and focus is trapped by the platform instead of by us.
//
// Shared: the owner console's confirmations and the thread's safety-number
// dialog are the same box (styleguides/retro.md §6 — panel geometry,
// `dialog-box` is the hook the terminal skin repaints).

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

export function Modal({ onCancel, children }: { onCancel: () => void; children: ReactNode }) {
  const [element, setElement] = useState<HTMLDialogElement | null>(null)

  useEffect(() => {
    element?.showModal()
  }, [element])

  return (
    <dialog ref={setElement} className="modal" onCancel={onCancel} onClose={onCancel}>
      <div className="dialog-box modal-box retro-border flex max-w-md flex-col gap-4 bg-base-100 retro-shadow">
        {children}
      </div>
      <form method="dialog" className="modal-backdrop bg-base-300/60">
        <button aria-label="fechar">fechar</button>
      </form>
    </dialog>
  )
}
