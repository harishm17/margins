'use client'

import { X } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useShell } from './shell-provider'
import { SidebarContent } from './sidebar'

/** Below 1024px the sidebar is a left sheet with the same content. */
export function MobileNav() {
  const { mobileNavOpen, setMobileNavOpen } = useShell()
  return (
    <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <SheetContent side="left" hideClose aria-describedby={undefined} className="lg:hidden">
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Courses, more places in this course, topics and account</SheetDescription>
        {/* A visible way out: without it the drawer closed only from the strip of page beside it. */}
        <SheetClose asChild>
          <IconButton label="Close menu" icon={<X />} noTooltip className="absolute right-2 top-1.5 z-10" />
        </SheetClose>
        <SidebarContent omitTabs />
      </SheetContent>
    </Sheet>
  )
}
