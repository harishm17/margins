'use client'

import { useSyncExternalStore } from 'react'
import { firstName, homeGreeting } from '@/lib/format'

const subscribe = () => () => {}

/**
 * "Good evening, Harish" by the visitor's local time ("Welcome, Harish" until the account has studied). The server does not know the time zone,
 * so the words stay hidden (the line keeps its height) until the browser has worked them out.
 */
export function Greeting({ name, firstVisit = false }: { name: string | null; firstVisit?: boolean }) {
  const hour = useSyncExternalStore(
    subscribe,
    () => new Date().getHours(),
    () => null
  )
  const first = firstName(name)
  const text = homeGreeting({ name, hour, firstVisit })
  // A first visit does not depend on the time of day, so there is nothing to wait for.
  return (
    <span className={hour === null && first && !firstVisit ? 'invisible' : undefined} suppressHydrationWarning>
      {text}
    </span>
  )
}
