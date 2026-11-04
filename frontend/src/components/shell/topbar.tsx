'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { List, SidebarSimple } from '@phosphor-icons/react/dist/ssr'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { buildCrumbs, mobileContext, type MobileContext } from './breadcrumbs'
import { useShell } from './shell-provider'
import { setSidebarCollapsed, useSidebarCollapsed } from './sidebar-state'
import { SlotTarget, useSlots, type Crumb } from './slots'

function Breadcrumbs({ crumbs, mobile }: { crumbs: Crumb[]; mobile: MobileContext }) {
  if (crumbs.length === 0) return <div className="min-w-0 flex-1" />
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      {/* Phones: the page name with the course (and unit) above it, each cut only at its end. */}
      <div className="flex min-w-0 flex-col justify-center sm:hidden">
        {mobile.context ? <p className="truncate text-caption font-normal leading-4 text-fg-3">{mobile.context}</p> : null}
        <p aria-current="page" className="truncate text-body-strong text-fg">
          {mobile.title}
        </p>
      </div>
      <ol className="flex min-w-0 items-center gap-1.5 text-body max-sm:hidden">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <li key={`${index}-${crumb.label}`} className={cn('flex min-w-0 items-center gap-1.5', last ? 'shrink' : 'shrink-[3]')}>
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="inline-flex min-h-6 items-center truncate rounded-chip text-fg-3 transition-colors duration-120 hover:text-fg"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cn('truncate', last ? 'text-body-strong text-fg' : 'text-fg-3')}>
                  {crumb.label}
                </span>
              )}
              {last ? null : (
                <span aria-hidden="true" className="text-fg-3">
                  /
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * 56px, sticky. Transparent at the top of the page; once scrolled it gets a blurred canvas
 * background and a bottom hairline. Left: menu or collapse button and breadcrumbs. Right: the
 * page's actions.
 */
export function Topbar() {
  const { nav, setMobileNavOpen, attemptActive } = useShell()
  const { crumbs: override } = useSlots()
  const pathname = usePathname()
  const collapsed = useSidebarCollapsed()
  const [scrolled, setScrolled] = React.useState(false)

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const crumbs = override ?? buildCrumbs(pathname, nav)

  return (
    <header
      data-scrolled={scrolled || undefined}
      // During a study attempt the phone shows the attempt bar alone; the notch gap stays so nothing sits under it.
      className={cn(
        attemptActive && 'max-lg:h-[env(safe-area-inset-top,0px)] max-lg:overflow-hidden max-lg:border-0 max-lg:p-0 max-lg:[&>*]:hidden',
        'sticky top-0 z-topbar flex h-(--topbar-height) shrink-0 items-center gap-2 border-b border-transparent pt-[env(safe-area-inset-top)] px-4 md:px-6 lg:px-8',
        'transition-[background-color,border-color,backdrop-filter] duration-180',
        'data-[scrolled]:border-border data-[scrolled]:bg-canvas data-[scrolled]:backdrop-blur-md'
      )}
    >
      <IconButton
        label="Open menu"
        icon={<List />}
        className="-ml-2 lg:hidden"
        onClick={() => setMobileNavOpen(true)}
      />
      <IconButton
        label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        icon={<SidebarSimple />}
        className="-ml-2 hidden lg:inline-flex"
        tooltipSide="bottom"
        onClick={() => setSidebarCollapsed(!collapsed)}
      />
      <Breadcrumbs crumbs={crumbs} mobile={mobileContext(pathname, nav, crumbs)} />
      <SlotTarget name="actions" className="flex shrink-0 items-center gap-2" />
    </header>
  )
}
