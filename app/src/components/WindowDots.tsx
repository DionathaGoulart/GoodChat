// OS-window dots motif (styleguide §4.7): accent + two base-300 circles.

export function WindowDots() {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      <span className="size-2.5 rounded-full bg-accent" />
      <span className="size-2.5 rounded-full bg-base-300" />
      <span className="size-2.5 rounded-full bg-base-300" />
    </div>
  )
}
