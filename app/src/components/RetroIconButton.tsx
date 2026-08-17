// Compact interactive tile (styleguide §6 tile pattern) for header actions —
// the btn-goodchat variants are CTA-sized, too large for toolbar use.

import type { ButtonHTMLAttributes } from 'react'

export function RetroIconButton({
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`retro-border cursor-pointer bg-base-200 px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all duration-300 hover:-translate-y-1 hover:bg-accent hover:text-accent-content hover:retro-shadow-sm active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  )
}
