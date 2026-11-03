'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { X } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { SkipLink } from './skip-link'
import { SlotsProvider, SlotTarget, useSlots } from './slots'

/** Where "Exit" goes: one level up from the current page. */
export function exitHref(pathname: string): string {
  const parts = pathname.split('?')[0].split('/').filter(Boolean)
  // /courses/x/exams/y/take goes to /courses/x/exams/y
  return parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/home'
}

/**
 * The focus layout: no sidebar. A 56px bar with Exit on the left, a title, then the key status
 * (timer, save state) and the primary action on the right. Pages fill the slots with
 * <FocusHeader title status actions />.
 */
export function FocusShell({ children }: { children: React.ReactNode }) {
  return (
    <SlotsProvider>
      <FocusFrame>{children}</FocusFrame>
    </SlotsProvider>
  )
}

function FocusFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { exitGuard } = useSlots()
  return (
    <>
      <SkipLink />
      <header className="sticky top-0 z-topbar flex h-(--topbar-height) items-center gap-3 border-b border-border bg-canvas/90 pt-[env(safe-area-inset-top)] px-4 backdrop-blur-md md:px-6">
        <Button asChild variant="ghost" size="sm" icon={<X />} className="-ml-2">
          <Link
            href={exitHref(pathname)}
            onClick={(event) => {
              // A page can ask for a confirm first (the exam taker does).
              if (exitGuard.current && !exitGuard.current()) event.preventDefault()
            }}
          >
            Exit
          </Link>
        </Button>
        <SlotTarget name="title" className="min-w-0 flex-1 truncate text-body-strong text-fg" />
        <SlotTarget name="status" className="flex shrink-0 items-center gap-3 text-small text-fg-2" />
        <SlotTarget name="actions" className="flex shrink-0 items-center gap-2" />
      </header>
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </>
  )
}
