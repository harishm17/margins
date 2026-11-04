'use client'

import * as React from 'react'
import Link from 'next/link'
import { getSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { NotFoundPanel } from '@/components/shell/not-found-panel'
import { BRAND_NAME } from '@/config/brand'
import { SectionLink } from './section-link'

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

export function useSignedIn(): boolean | null {
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

/** The nav buttons: Sign in and Get started, or Open Margins when signed in. Below 640px Sign in moves into the menu (MarketingMenu). */
export function NavActions() {
  const signedIn = useSignedIn()
  return signedIn ? (
    <Button asChild variant="primary">
      <Link href="/home">Open {BRAND_NAME}</Link>
    </Button>
  ) : (
    <>
      <Button asChild variant="ghost" className="max-sm:hidden">
        <Link href="/login">Sign in</Link>
      </Button>
      <Button asChild variant="primary">
        <Link href="/login">Get started</Link>
      </Button>
    </>
  )
}

/** The page's own sign-up actions say where they lead: sign-in is Google only (the navigation keeps the short "Get started"). */
const START_LABEL = 'Start with Google'
const START_NOTE = 'Free · Google account required'

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
            <Link href="/login">{START_LABEL}</Link>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <SectionLink section="how-it-works">See how it works</SectionLink>
          </Button>
          {/* Said under the buttons, before the click: the next step is a Google sign-in, and it costs nothing. */}
          <p className="basis-full text-small text-fg-2">{START_NOTE}</p>
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
      <Link href={signedIn ? '/home' : '/login'}>{signedIn ? `Open ${BRAND_NAME}` : START_LABEL}</Link>
    </Button>
  )
}

/**
 * The way back on the public not-found page. A signed-in student goes to their home; a visitor goes to the
 * landing page (and the label says which), not to a sign-in page they did not ask for.
 */
export function NotFoundBack() {
  const signedIn = useSignedIn()
  return (
    <NotFoundPanel
      action={signedIn ? { href: '/home', label: 'Go to your courses' } : { href: '/', label: 'Go to the home page' }}
    />
  )
}
