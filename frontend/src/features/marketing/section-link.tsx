'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { browserScrollEnv, scrollToSection, sectionFromHash, sectionHref, shouldScrollInPage, type SectionId } from './in-page'

type SectionLinkProps = Omit<React.ComponentProps<typeof Link>, 'href'> & {
  section: SectionId
}

/**
 * The one link to a section of the landing page: header, footer, the phone menu and "See how it
 * works". `href="/#id"` (works without JavaScript, in a new tab and when shared); on the landing page a
 * plain click scrolls there and focuses the heading, and leaves the URL and the history alone.
 */
export function SectionLink({ section, onClick, target, ...props }: SectionLinkProps) {
  const pathname = usePathname()
  return (
    <Link
      {...props}
      href={sectionHref(section)}
      target={target}
      onClick={(event) => {
        onClick?.(event)
        if (!shouldScrollInPage(event, { pathname, target })) return
        if (scrollToSection(section, browserScrollEnv())) event.preventDefault()
      }}
    />
  )
}

/**
 * On the landing page: arriving with `#id` for a section (a section link on another page, or a shared
 * link) scrolls to it, focuses its heading and takes the hash off the URL, so the address bar ends
 * clean like it does for a click on this page. Renders nothing.
 */
export function SectionArrival() {
  React.useEffect(() => {
    const section = sectionFromHash(window.location.hash)
    if (!section) return
    scrollToSection(section, browserScrollEnv(), { instant: true })
    const { pathname, search } = window.location
    window.history.replaceState(window.history.state, '', `${pathname}${search}`)
  }, [])
  return null
}
