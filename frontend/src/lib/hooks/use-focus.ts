'use client'

import * as React from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** An element that is not drawn (hidden, or not in the page) cannot take focus. */
const shown = (element: HTMLElement) => element.getClientRects().length > 0

/**
 * Moves keyboard focus to `element`, making it a focus target first when it is not one (a heading, a status line).
 * The page scrolls only as far as it takes to show it. Use it where the element that had focus has just gone, or
 * where a result has just appeared, so a keyboard or screen-reader student lands on what changed instead of on the page.
 */
export function focusElement(element: HTMLElement | null | undefined): boolean {
  if (!element || !shown(element)) return false
  if (!element.matches(FOCUSABLE) && !element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1')
  element.focus({ preventScroll: true })
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView?.({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' })
  return document.activeElement === element
}

/** The first focusable element after `from` in the page, outside it. For when `from` is about to leave the page. */
export function nextFocusableAfter(from: HTMLElement): HTMLElement | null {
  for (const candidate of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (from.contains(candidate)) continue
    if (from.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING && shown(candidate)) return candidate
  }
  return null
}

/**
 * Focus on request: give each target a name with `register(name)` (a ref callback), and call `request(name)` from the
 * handler that changes the page. Focus moves once the change has been drawn, to that element if it is there by then.
 */
export function useFocusRequest() {
  const targets = React.useRef(new Map<string, HTMLElement>())
  const pending = React.useRef<string | null>(null)
  const [asked, setAsked] = React.useState(0)

  React.useEffect(() => {
    const name = pending.current
    pending.current = null
    if (name) focusElement(targets.current.get(name))
  }, [asked])

  const register = React.useCallback(
    (name: string) => (element: HTMLElement | null) => {
      if (element) targets.current.set(name, element)
      else targets.current.delete(name)
    },
    []
  )
  const request = React.useCallback((name: string) => {
    pending.current = name
    setAsked((value) => value + 1)
  }, [])
  return { register, request }
}

/** Focuses `ref`'s element when it first shows (if `when` is true then) and each time `when` turns true again. */
export function useFocusWhen(when: boolean, ref: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (when) focusElement(ref.current)
  }, [when, ref])
}
