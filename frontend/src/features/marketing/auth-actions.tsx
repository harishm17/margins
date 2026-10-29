'use client'

import * as React from 'react'
import Link from 'next/link'
import { getSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { BRAND_NAME } from '@/config/brand'

/**
 * Whether the visitor is signed in, read in the browser so public pages stay fully static.
 * Null until known; the pages render their signed-out buttons first.
 */
/** One session request shared by every island on the page. */
let sessionRequest: Promise<boolean> | null = null
function readSignedIn(): Promise<boolean> {
  sessionRequest ??= getSession().then((session) => !!session?.user)
  return sessionRequest
}

function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    let cancelled = false
    readSignedIn()
      .then((value) => {
        if (!cancelled) setSignedIn(value)
      })
      .catch(() => {
        sessionRequest = null
      })
    return () => {
      cancelled = true
    }
  }, [])
  return signedIn
}

/** The nav buttons: Sign in and Get started, or Open Margins when signed in. */
export function NavActions() {
  const signedIn = useSignedIn()
  return signedIn ? (
    <Button asChild variant="primary">
      <Link href="/home">Open {BRAND_NAME}</Link>
    </Button>
  ) : (
    <>
      <Button asChild variant="ghost">
        <Link href="/login">Sign in</Link>
      </Button>
      <Button asChild variant="primary">
        <Link href="/login">Get started</Link>
      </Button>
    </>
  )
}

/** The hero buttons (large). */
export function HeroActions() {
  const signedIn = useSignedIn()
  return (
    <div className="mt-8 flex flex-wrap gap-3">
      {signedIn ? (
        <Button asChild variant="primary" size="lg">
          <Link href="/home">Open {BRAND_NAME}</Link>
        </Button>
      ) : (
        <>
          <Button asChild variant="primary" size="lg">
            <Link href="/login">Get started</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <a href="#how-it-works">See how it works</a>
          </Button>
        </>
      )}
    </div>
  )
}

/** The closing call to action: Get started, or Open Margins when signed in. */
export function FinalCta() {
  const signedIn = useSignedIn()
  return (
    <Button asChild variant="primary" size="lg">
      <Link href={signedIn ? '/home' : '/login'}>{signedIn ? `Open ${BRAND_NAME}` : 'Get started'}</Link>
    </Button>
  )
}
