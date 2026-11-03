'use client'

import * as React from 'react'

export type SeenTarget<T> = { key: string; element: Element; payload: T }

/**
 * Calls `onSeen(payload)` once per `key` when its element is on screen (the top of it is above 75% of the window, and
 * its bottom is below the top). Used for the explainer sections (spec 18.5): reading a section is instruction on its
 * idea. The targets are looked up again whenever the page changes (the markdown loads as its own chunk), on scroll and
 * on resize. `find` must return the elements that exist now; `watch` is the root whose subtree changes add targets.
 */
export function useSeenInView<T>(
  find: () => SeenTarget<T>[],
  onSeen: (payload: T) => void,
  options: { watch: React.RefObject<HTMLElement | null>; enabled?: boolean; deps: React.DependencyList }
) {
  const findRef = React.useRef(find)
  const seenRef = React.useRef(onSeen)
  React.useEffect(() => {
    findRef.current = find
    seenRef.current = onSeen
  })
  const done = React.useRef(new Set<string>())
  const { watch, enabled = true, deps } = options

  React.useEffect(() => {
    if (!enabled) return
    let frame = 0
    const check = () => {
      frame = 0
      for (const target of findRef.current()) {
        if (done.current.has(target.key)) continue
        const rect = target.element.getBoundingClientRect()
        if (rect.bottom > 0 && rect.top < window.innerHeight * 0.75) {
          done.current.add(target.key)
          seenRef.current(target.payload)
        }
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = new MutationObserver(schedule)
    if (watch.current) observer.observe(watch.current, { childList: true, subtree: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, watch, ...deps])
}

/** Scrolls to the element, with no animation for a student who asked for less motion. */
export function scrollToElement(element: Element | null) {
  if (!element) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
}
