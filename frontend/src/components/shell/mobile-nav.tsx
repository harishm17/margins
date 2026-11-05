'use client'

import { X } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useShell } from './shell-provider'
import { SidebarContent } from './sidebar'

/** Below 1024px: a left sheet for switching course, search, theme and the account. The course's own places are in the tab bar and its More sheet (mobile-tabs.tsx), each reachable from one surface. */
export function MobileNav() {
  const { mobileNavOpen, setMobileNavOpen } = useShell()
  return (
    <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <SheetContent side="left" hideClose aria-describedby={undefined} className="lg:hidden">
        <SheetTitle className="px-5 pb-1 pt-4">Courses and account</SheetTitle>
        <SheetDescription className="sr-only">Switch course, search, theme and your account. The places in a course are in the tab bar and its More sheet.</SheetDescription>
        {/* A visible way out: without it the drawer closed only from the strip of page beside it. */}
        <SheetClose asChild>
          <IconButton label="Close menu" icon={<X />} noTooltip className="absolute right-2 top-2 z-10" />
        </SheetClose>
        <SidebarContent phone />
      </SheetContent>
    </Sheet>
  )
}
