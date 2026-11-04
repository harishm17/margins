'use client'

import * as React from 'react'
import { CaretRight } from '@phosphor-icons/react/dist/ssr'

const SEEN_KEY = 'margins:map-key-seen'

/**
 * The map's "Key" disclosure. The colours and shapes need the key the first time a student sees the map, so it
 * starts open once and, after that, closed (the map is the point, the key is for when you wonder). Opening or
 * closing it by hand always works; the "seen" mark is kept in this browser.
 */
export function KeyDetails({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDetailsElement>(null)
  React.useEffect(() => {
    try {
      if (localStorage.getItem(SEEN_KEY)) return
      localStorage.setItem(SEEN_KEY, '1')
      // The element is the thing being synchronised, so it is opened directly.
      if (ref.current) ref.current.open = true
    } catch {
      // Without storage the key stays closed; a click opens it.
    }
  }, [])
  return (
    <details ref={ref} className="group mt-3 text-small text-fg-2">
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip text-fg-2 hover:text-fg max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <CaretRight aria-hidden="true" className="size-3.5 transition-transform duration-180 group-open:rotate-90" />
        Key
      </summary>
      {children}
    </details>
  )
}
