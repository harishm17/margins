'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { canGoBackInApp } from './go-back-rule'
import { navigatedInApp, subscribeInAppNavigation } from './in-app-navigation'

/** Read in the browser only; the server and the first render say no, so the markup agrees and the button appears after hydration. */
function canGoBackNow(): boolean {
  return canGoBackInApp(window.history.length, document.referrer, window.location.origin, navigatedInApp())
}

/** "Go back" for the not-found and error pages, so "head back" in their copy is something the student can do. Hidden when there is nowhere in the app to go back to. */
export function GoBack() {
  const router = useRouter()
  const available = React.useSyncExternalStore(subscribeInAppNavigation, canGoBackNow, () => false)
  if (!available) return null
  return (
    <Button variant="link" icon={<ArrowLeft />} onClick={() => router.back()}>
      Go back
    </Button>
  )
}
