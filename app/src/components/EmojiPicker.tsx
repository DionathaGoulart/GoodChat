// Emoji picker popover content — wraps emoji-picker-element (web component,
// shadow DOM). Everything is lazy-loaded on first open so the ~1MB emoji
// dataset never blocks the app bundle; the data JSON ships with the app
// (emoji-picker-element-data, self-hosted — no CDN). Inline emoji are plain
// Unicode in the message body (PRD §3.4), no server-side handling.

import { useEffect, useRef, useState } from 'react'
import { currentTheme } from '../hooks/useTheme'

export function EmojiPicker({ onPick }: { onPick: (unicode: string) => void }) {
  // React never renders children into the host div — the web component is
  // appended imperatively, so reconciliation cannot clash with it.
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick

  useEffect(() => {
    let disposed = false
    const host = hostRef.current
    Promise.all([
      import('emoji-picker-element'),
      import('emoji-picker-element/i18n/pt_BR.js'),
      import('emoji-picker-element-data/pt/cldr/data.json?url'),
    ])
      .then(([{ Picker }, i18n, dataUrl]) => {
        if (disposed || !host) return
        const picker = new Picker({
          dataSource: dataUrl.default,
          locale: 'pt',
          i18n: i18n.default,
        })
        // Shadow DOM cannot see daisyUI tokens — pin light/dark explicitly
        // (mounted per open, so a theme toggle re-resolves next time).
        picker.classList.add(currentTheme() === 'goodchat-dark' ? 'dark' : 'light')
        picker.addEventListener('emoji-click', (event) => {
          if (event.detail.unicode) onPickRef.current(event.detail.unicode)
        })
        host.replaceChildren(picker)
        setState('ready')
      })
      .catch(() => {
        if (!disposed) setState('failed')
      })
    return () => {
      disposed = true
      host?.replaceChildren()
    }
  }, [])

  return (
    <>
      <div ref={hostRef} />
      {state === 'loading' && (
        <p className="p-3 font-mono text-[10px] uppercase tracking-[0.2em] opacity-40">
          carregando<span className="terminal-cursor">_</span>
        </p>
      )}
      {state === 'failed' && (
        <p className="p-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-error">
          falha ao carregar emojis
        </p>
      )}
    </>
  )
}
