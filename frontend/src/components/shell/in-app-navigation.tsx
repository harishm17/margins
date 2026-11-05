'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'

/**
 * Whether this page load has moved between pages of the app (a client-side navigation). Kept in the module, so a full load
 * starts at false; Go back then falls back to a same-site referrer. Next's own history marker is not used: Next writes it on
 * every page once it hydrates, so a deep link opened on its own showed Go back too, depending on when it was read.
 */
let moved = false
const listeners = new Set<() => void>()

export function subscribeInAppNavigation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const navigatedInApp = (): boolean => moved

/** Mounted once in the root providers: records the first change of path after the page loaded. */
export function InAppNavigationRecorder() {
  const pathname = usePathname()
  const first = React.useRef(pathname)
  React.useEffect(() => {
    if (moved || pathname === first.current) return
    moved = true
    for (const listener of listeners) listener()
  }, [pathname])
  return null
}
