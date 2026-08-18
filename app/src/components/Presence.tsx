// Presence indicators: the square dot that sits on an avatar and the micro-text
// label next to a name.
//
// A square, not a circle: every corner in the app is straight (styleguide §4.3),
// and a round dot would be the only radius on the screen. Online is `success`,
// offline is the frame color at low opacity — present but quiet, so a list of
// mostly-offline peers does not turn into a wall of indicators.

// The text side of presence lives in lib/presence.ts (resolvePresence,
// presenceText) — this file only draws.

export function PresenceDot({
  online,
  label,
  className = '',
}: {
  online: boolean
  /** Announced to screen readers — the dot is the only cue sighted users get. */
  label: string
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`size-3 border-2 border-base-200 ${
        online ? 'bg-success' : 'bg-base-300 opacity-50'
      } ${className}`}
    />
  )
}

/** Avatar plus its dot, pinned to the bottom-right corner of the square. */
export function PresenceMarker({
  online,
  label,
  children,
}: {
  online: boolean
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="relative shrink-0">
      {children}
      <PresenceDot
        online={online}
        label={label}
        className="absolute -bottom-1 -right-1 group-hover:border-accent"
      />
    </span>
  )
}
