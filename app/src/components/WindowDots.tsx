// OS-window dots motif (styleguide §4.7): accent + two base-300 circles.
//
// The `window-dots` class is the hook the terminal skin re-colors through
// (styles/skins.css) — the component itself stays skin-agnostic, which is the
// rule the whole skin layer rests on.

export function WindowDots() {
  return (
    <div className="window-dots flex items-center gap-1.5" aria-hidden="true">
      <span className="size-2.5 rounded-full bg-accent" />
      <span className="size-2.5 rounded-full bg-base-300" />
      <span className="size-2.5 rounded-full bg-base-300" />
    </div>
  )
}
