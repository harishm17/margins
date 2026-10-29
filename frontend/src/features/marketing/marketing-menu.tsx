'use client'

import * as React from 'react'
import Link from 'next/link'
import { List } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useSignedIn } from './auth-actions'
import { SECTION_LINKS } from './nav-links'
import { SectionLink } from './section-link'

const item = 'flex min-h-11 items-center rounded-control px-3 text-body-strong text-fg hover:bg-surface-2'

/**
 * The public pages' navigation below 768px, where the header has no room for its links: a menu
 * button that opens the same links, plus Sign in below 640px, where the header drops it. A popover,
 * so it opens with the motion every other floating surface uses, closes on Escape or a tap outside,
 * and gives focus back to the button.
 */
export function MarketingMenu({ className }: { className?: string }) {
  const signedIn = useSignedIn()
  const [open, setOpen] = React.useState(false)
  // A section link moves focus to the section's heading; closing must not send it back to the button.
  const followedLink = React.useRef(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) followedLink.current = false
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label="Menu" icon={<List />} noTooltip className={className} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        padding="menu"
        className="w-60"
        onCloseAutoFocus={(event) => {
          if (followedLink.current) event.preventDefault()
        }}
      >
        <nav aria-label="Primary" className="flex flex-col">
          {SECTION_LINKS.map((link) => (
            <SectionLink
              key={link.section}
              section={link.section}
              className={item}
              onClick={() => {
                followedLink.current = true
                setOpen(false)
              }}
            >
              {link.label}
            </SectionLink>
          ))}
          {signedIn ? null : (
            <>
              <div aria-hidden="true" className="my-1 h-px bg-border sm:hidden" />
              <Link href="/login" className={cn(item, 'sm:hidden')} onClick={() => setOpen(false)}>
                Sign in
              </Link>
            </>
          )}
        </nav>
      </PopoverContent>
    </Popover>
  )
}
