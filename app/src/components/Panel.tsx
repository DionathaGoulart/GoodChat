// Framed content panel with a fake window title bar — the shape both skins
// give a section (Portfolio: retro/ti/Projects.tsx and the terminal skin's
// TermWindow chrome="bar"). The frame is daisyUI's card wearing the theme's
// border and the skin's shadow, same as before; what is new is the bar.
//
// The bar carries the retro finish inline and the terminal skin repaints it
// through the `window-bar` / `window-bar-title` hook classes (styles/skins.css)
// — no branching here, the component never learns which skin is on.
//
// `title` is the decorative filename of the motif (`CONTAS.CFG`), not the
// heading: the real <h2> stays in the body where a screen reader expects it,
// which is also how the Portfolio does it (its bars read PROJECT_FILE_1.EXE
// while the project title lives below).

import { type ComponentPropsWithoutRef, type ElementType, type ReactNode } from 'react'

import { WindowDots } from './WindowDots'

/**
 * `form` is here because the login panel is one, and it is the screen most
 * worth framing — the Portfolio does the same with its CV viewer. The props
 * are typed off `form` so `onSubmit` type-checks; every element below accepts
 * it, since React declares the form events on the shared HTML attributes.
 */
interface PanelProps extends Omit<ComponentPropsWithoutRef<'form'>, 'title'> {
  /** Shown uppercase in the bar. Written lowercase at the call site. */
  title: string
  /** Right end of the bar, after the title. */
  right?: ReactNode
  as?: 'section' | 'div' | 'form'
  /** Gap and padding of the body, when the default spacing is wrong. */
  bodyClassName?: string
  children: ReactNode
}

export function Panel({
  title,
  right,
  as = 'section',
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  // The three tags carry different event-handler element types, so the union
  // cannot be spread into JSX as-is. Widening here rather than at the prop
  // boundary keeps the call sites checked against `form` — the widest of the
  // three — which is the side that actually passes handlers.
  const Tag = as as ElementType

  return (
    <Tag
      className={`panel card card-border overflow-hidden border-base-300 bg-base-200 retro-shadow ${className ?? ''}`}
      {...rest}
    >
      <div className="window-bar flex items-center justify-between gap-3 border-b-2 border-base-300 bg-base-100 px-4 py-3">
        <WindowDots />
        <span
          className="window-bar-title truncate font-mono text-[10px] font-bold uppercase opacity-40"
          aria-hidden="true"
        >
          {title}
        </span>
        {right}
      </div>
      <div className={`panel-body card-body ${bodyClassName ?? 'gap-4'}`}>{children}</div>
    </Tag>
  )
}
