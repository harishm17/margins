'use client'

import * as React from 'react'
import Link, { useLinkStatus } from 'next/link'
import { cn } from '@/lib/utils'

export type TabItem = {
  id: string
  label: React.ReactNode
  href: string
  /** A trailing status glyph: a check, "2/5", a score, a spinner. */
  glyph?: React.ReactNode
  /** Classes for the glyph's wrapper, such as a negative margin that takes back its gap on a phone. */
  glyphClassName?: string
}

type TabsProps = {
  items: TabItem[]
  activeId: string
  'aria-label': string
  className?: string
  /** Keep the page position when switching (for ?view= tabs). Default true. */
  scroll?: boolean
  /**
   * A CSS selector for the panel under the tabs, for sticky tabs. Switching while the tabs are stuck
   * to the top then puts the new panel's top right under them, instead of letting the page clamp to
   * a shorter panel and leave the tabs mid-screen. Not stuck: the scroll position is left alone.
   */
  stickyPanel?: string
  /**
   * Something after the tabs on the same line, such as a menu of tools; it sits on the bar's bottom border. A link in it
   * calls `useTabPin()` in its onClick, so it too keeps a stuck bar stuck (see `stickyPanel`).
   */
  trailing?: React.ReactNode
}

type PinHandler = (event: React.MouseEvent, id: string) => void

const TabPinContext = React.createContext<PinHandler>(() => {})

/** The click handler of a link that sits in `Tabs`' trailing slot and switches the panel like a tab (pass the id it makes active). */
export const useTabPin = (): PinHandler => React.useContext(TabPinContext)

/**
 * The tab's own underline, drawn while its link is pending (clicked, the server not answered yet), so
 * the click shows at once. Same box as the active underline. The old active underline hides while
 * one is pending, and the panel dims after a short wait (globals.css, data-tabs / data-tab-pending).
 */
function PendingUnderline() {
  const { pending } = useLinkStatus()
  return (
    <span
      aria-hidden="true"
      data-tab-indicator=""
      data-tab-pending={pending ? '' : undefined}
      className="pointer-events-none absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent opacity-0 transition-opacity duration-120 ease-enter data-tab-pending:opacity-100"
    />
  )
}

/**
 * Underline tabs that are links: the active one has aria-current="page". On narrow screens
 * the row scrolls sideways and fades at whichever edge has more to show.
 */
export function Tabs({ items, activeId, className, scroll = false, stickyPanel, trailing, ...aria }: TabsProps) {
  const rowRef = React.useRef<HTMLDivElement>(null)
  const navRef = React.useRef<HTMLElement>(null)
  // The tab clicked while the bar was stuck: the pinned scroll is for that view only, so a click that
  // never lands (an error, a newer click) or a later change by other means (Back, a link in the page)
  // does not scroll.
  const pinFor = React.useRef<string | null>(null)

  const noteStuck = (event: React.MouseEvent, itemId: string) => {
    const nav = navRef.current
    const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
    if (!stickyPanel || !nav || modified || itemId === activeId) {
      pinFor.current = null
      return
    }
    const stickyTop = parseFloat(getComputedStyle(nav).top) || 0
    pinFor.current = nav.getBoundingClientRect().top <= stickyTop + 1 ? itemId : null
  }

  // The new view is in: if the tabs were stuck when it was asked for, keep them stuck and show the
  // panel from its top. Instant, before paint; a page that is too short to scroll that far stays put.
  React.useLayoutEffect(() => {
    const pinned = pinFor.current === activeId
    pinFor.current = null
    if (!pinned) return
    const nav = navRef.current
    const panel = stickyPanel ? document.querySelector(stickyPanel) : null
    if (!nav || !panel) return
    const stickyTop = parseFloat(getComputedStyle(nav).top) || 0
    const top = panel.getBoundingClientRect().top + window.scrollY - stickyTop - nav.offsetHeight
    window.scrollTo({ top, behavior: 'instant' })
  }, [activeId, stickyPanel])

  const [edges, setEdges] = React.useState({ start: false, end: false })

  const measure = React.useCallback(() => {
    const el = rowRef.current
    if (!el) return
    setEdges({
      start: el.scrollLeft > 4,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
  }, [])

  React.useEffect(() => {
    const el = rowRef.current
    if (!el) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure, items.length])

  // Bring the current tab into view along the row only: scrollIntoView would also scroll the page when the
  // tabs sit low in a short window.
  React.useEffect(() => {
    const row = rowRef.current
    const current = row?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!row || !current) return
    const edge = 12
    const left = current.getBoundingClientRect().left - row.getBoundingClientRect().left
    const right = left + current.offsetWidth
    if (left < 0) row.scrollLeft += left - edge
    else if (right > row.clientWidth) row.scrollLeft += right - row.clientWidth + edge
  }, [activeId])

  const mask =
    edges.start && edges.end
      ? 'linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent)'
      : edges.start
        ? 'linear-gradient(to right, transparent, #000 28px)'
        : edges.end
          ? 'linear-gradient(to left, transparent, #000 28px)'
          : undefined

  return (
    <nav ref={navRef} data-tabs="" aria-label={aria['aria-label']} className={cn(trailing && 'flex', className)}>
      <div
        ref={rowRef}
        onScroll={measure}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        className={cn(
          'flex h-[41px] overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          trailing && 'min-w-0 flex-1'
        )}
      >
        {items.map((item) => {
          const active = item.id === activeId
          return (
            <Link
              key={item.id}
              href={item.href}
              scroll={scroll}
              onClick={(event) => noteStuck(event, item.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-body-strong text-fg-2 transition-colors duration-120 hover:text-fg [&:has([data-tab-pending])]:text-fg',
                active && 'text-fg after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent'
              )}
            >
              {item.label}
              <PendingUnderline />
              {item.glyph ? <span className={cn('inline-flex items-center text-caption text-fg-3', item.glyphClassName)}>{item.glyph}</span> : null}
            </Link>
          )
        })}
      </div>
      {trailing ? <div className="flex h-[41px] shrink-0 items-center border-b border-border pl-2"><TabPinContext.Provider value={noteStuck}>{trailing}</TabPinContext.Provider></div> : null}
    </nav>
  )
}
