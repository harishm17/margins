'use client'

import { useSyncExternalStore } from 'react'

/**
 * Whether a CSS media query matches now, and again when it changes. `serverValue` is what the server (and the first
 * paint of a hydrating page) assumes, so a caller that knows the answer from a cookie can pass it and avoid a swap.
 */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', notify)
      return () => list.removeEventListener('change', notify)
    },
    () => window.matchMedia(query).matches,
    () => serverValue
  )
}
