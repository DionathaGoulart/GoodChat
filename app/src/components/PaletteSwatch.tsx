// Preview tile for one palette in the settings screen: the palette's own page
// background with its accent and foreground sitting on top, so the three
// colors are judged against each other and not against the current theme.
//
// The colors arrive as `var(--palette-*)` strings from lib/themes.ts, which is
// why they can be inline styles without breaking the "hex only in
// palettes.css" rule — nothing here knows an actual color value.

import type { PaletteOption } from '../lib/themes'

export function PaletteSwatch({ palette }: { palette: PaletteOption }) {
  return (
    <span
      aria-hidden="true"
      className="retro-border flex h-8 w-11 shrink-0 items-center justify-center gap-1"
      style={{ background: palette.bg }}
    >
      <span className="h-4 w-2.5" style={{ background: palette.acc }} />
      <span className="h-4 w-2.5" style={{ background: palette.fg }} />
    </span>
  )
}
