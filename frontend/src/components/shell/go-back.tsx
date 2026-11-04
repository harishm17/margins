'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { canGoBackInApp } from './go-back-rule'

/** "Go back" for the not-found and error pages, so "head back" in their copy is something the student can do. Hidden when there is nowhere in the app to go back to. */
export function GoBack() {
  const router = useRouter()
  const [available, setAvailable] = React.useState(false)
  React.useEffect(() => {
    const state = window.history.state as unknown
    const appHistory = !!state && typeof state === 'object' && '__NA' in state
    setAvailable(canGoBackInApp(window.history.length, document.referrer, window.location.origin, appHistory))
  }, [])
  if (!available) return null
  return (
    <Button variant="link" icon={<ArrowLeft />} onClick={() => router.back()}>
      Go back
    </Button>
  )
}
