// The two icons the header toggle needs. Inline SVG rather than a sprite file:
// they are drawn in `currentColor`, so they invert with the button on hover
// like the text they replaced, and an <img> could not do that.
//
// Geometry matches the rest of the app — 2px strokes, square caps, no curves
// beyond the two circles the shapes are made of.

interface IconProps {
  className?: string
}

/** Shown when the app is in light mode: the button switches to dark. */
export function MoonIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
    >
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  )
}

/** Shown when the app is in dark mode: the button switches to light. */
export function SunIcon({ className = 'size-4' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </svg>
  )
}
