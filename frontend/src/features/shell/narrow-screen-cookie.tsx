'use client'

import * as React from 'react'
import { NARROW_QUERY, writeNarrowCookie } from '@/lib/map/narrow'

/**
 * Tells the server whether the window is phone width, now and whenever it changes, so a page that
 * opens differently on a phone (the map opens on its list) can choose on the server. Renders nothing.
 */
export function NarrowScreenCookie() {
  React.useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const write = () => writeNarrowCookie(query.matches)
    write()
    query.addEventListener('change', write)
    return () => query.removeEventListener('change', write)
  }, [])
  return null
}
