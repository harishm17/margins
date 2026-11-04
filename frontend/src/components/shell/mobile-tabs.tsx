'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import {
  ArrowsClockwise,
  CalendarCheck,
  ChatCircleText,
  DotsThree,
  Exam,
  Files,
  Gear,
  House,
  List,
  ListBullets,
  TreeStructure,
} from '@phosphor-icons/react/dist/ssr'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { inFirstSetup } from './course-nav'
import { useShell } from './shell-provider'

/** The bar's height. Other full-height pages and sticky bottoms subtract it (`var(--tabbar-height, 0px)`). */
const BAR = '3.5rem'

type Tab = { key: string; label: string; href: string; icon: React.ElementType; active: boolean; badge?: number }

function TabLink({ tab }: { tab: Tab }) {
  const Icon = tab.icon
  return (
    <Link
      href={tab.href}
      aria-current={tab.active ? 'page' : undefined}
      className={cn(
        'relative flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-control text-caption transition-colors duration-120',
        tab.active ? 'text-fg after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-accent' : 'text-fg-2 active:bg-surface-2'
      )}
    >
      <span className="relative">
        <Icon aria-hidden="true" weight={tab.active ? 'fill' : 'regular'} className={cn('size-[22px]', tab.active ? 'text-accent' : 'text-fg-3')} />
        {tab.badge ? (
          <span className="absolute -right-3 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-chip bg-warning-soft px-1 text-caption leading-none text-warning-soft-fg tabular">
            <span className="sr-only">{tab.badge} due for review</span>
            <span aria-hidden="true">{tab.badge}</span>
          </span>
        ) : null}
      </span>
      <span className="max-w-full truncate">{tab.label}</span>
    </Link>
  )
}

function MoreRow({
  href,
  icon: Icon,
  label,
  badge,
}: {
  href: string
  icon: React.ElementType
  label: string
  badge?: number
}) {
  return (
    <SheetClose asChild>
      <Link href={href} className="flex min-h-12 items-center gap-3 rounded-control px-3 text-body-strong text-fg hover:bg-surface-2">
        <Icon aria-hidden="true" className="size-5 text-fg-3" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {badge ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-warning-soft px-1.5 text-caption text-warning-soft-fg tabular">
            <span className="sr-only">{badge} due for review</span>
            <span aria-hidden="true">{badge}</span>
          </span>
        ) : null}
      </Link>
    </SheetClose>
  )
}

/**
 * The course navigation on a phone or small tablet: a bar of five targets fixed to the bottom, inside
 * a course (research idea 9). Overview, Plan, Topics and Ask are one tap away; More holds Review, Map, Mock
 * exams, Materials and the course settings, and the full menu (courses, topic tree, account) stays
 * on the top bar's menu button. Hidden from 1024px, where the sidebar takes over.
 */
export function MobileTabs() {
  const { nav, setMobileNavOpen, attemptActive } = useShell()
  const params = useParams<{ courseId?: string }>()
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = React.useState(false)

  const course = nav.find((item) => item.id === params.courseId)
  // A navigation closes the sheet (the links also close it; this covers the browser's back button).
  const [lastPath, setLastPath] = React.useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMoreOpen(false)
  }
  // An open attempt owns the phone screen: no bar, no --tabbar-height, no spacer.
  if (!course || attemptActive) return null

  const base = `/courses/${course.id}`
  const inMore = ['review', 'map', 'exams', 'materials', 'settings'].some((section) => pathname.startsWith(`${base}/${section}`))
  // Steps 1 and 2 of setup: no dead study tabs. The bar holds the setup steps, the files, the course settings and the way
  // back to the courses (the setup page itself shows the steps and where the student is).
  if (inFirstSetup(course)) {
    const setupTabs: Tab[] = [
      { key: 'overview', label: 'Setup', href: base, icon: House, active: pathname === base },
      { key: 'materials', label: 'Materials', href: `${base}/materials`, icon: Files, active: pathname.startsWith(`${base}/materials`) },
      { key: 'settings', label: 'Settings', href: `${base}/settings`, icon: Gear, active: pathname.startsWith(`${base}/settings`) },
      { key: 'courses', label: 'Courses', href: '/home', icon: List, active: false },
    ]
    return (
      <>
        <style>{`@media (max-width: 1023px) { :root { --tabbar-height: calc(${BAR} + env(safe-area-inset-bottom)); } }`}</style>
        <div aria-hidden="true" className="h-(--tabbar-height) lg:hidden" />
        <nav
          aria-label="Course tabs"
          className="fixed inset-x-0 bottom-0 z-topbar border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:hidden"
        >
          <div className="grid h-14 grid-cols-4 px-1">
            {setupTabs.map((tab) => (
              <TabLink key={tab.key} tab={tab} />
            ))}
          </div>
        </nav>
      </>
    )
  }
  const tabs: Tab[] = [
    { key: 'overview', label: 'Overview', href: base, icon: House, active: pathname === base, badge: course.dueCount },
    { key: 'plan', label: 'Plan', href: `${base}/plan`, icon: CalendarCheck, active: pathname.startsWith(`${base}/plan`) },
    { key: 'topics', label: 'Topics', href: `${base}/topics`, icon: ListBullets, active: pathname.startsWith(`${base}/topics`) },
    { key: 'ask', label: 'Ask', href: `${base}/ask`, icon: ChatCircleText, active: pathname.startsWith(`${base}/ask`) },
  ]

  return (
    <>
      {/* The bar takes this height at the bottom of every course page below 1024px. */}
      <style>{`@media (max-width: 1023px) { :root { --tabbar-height: calc(${BAR} + env(safe-area-inset-bottom)); } }`}</style>
      <div aria-hidden="true" className="h-(--tabbar-height) lg:hidden" />
      <nav
        aria-label="Course tabs"
        className="fixed inset-x-0 bottom-0 z-topbar border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:hidden"
      >
        <div className="grid h-14 grid-cols-5 px-1">
          {tabs.map((tab) => (
            <TabLink key={tab.key} tab={tab} />
          ))}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-control text-caption transition-colors duration-120',
              inMore ? 'text-fg' : 'text-fg-2 active:bg-surface-2'
            )}
          >
            <DotsThree aria-hidden="true" weight={inMore ? 'fill' : 'bold'} className={cn('size-[22px]', inMore ? 'text-accent' : 'text-fg-3')} />
            <span>More</span>
          </button>
        </div>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="right" aria-describedby={undefined} className="lg:hidden">
          <div className="px-5 pb-1 pt-2 sm:pt-5">
            <SheetTitle>{course.name}</SheetTitle>
            <SheetDescription className="sr-only">More places in this course</SheetDescription>
          </div>
          <div className="flex flex-col gap-0.5 px-2 pb-[max(1rem,env(safe-area-inset-bottom))] pt-1">
            <MoreRow href={`${base}/review`} icon={ArrowsClockwise} label="Review" badge={course.dueCount} />
            <MoreRow href={`${base}/map`} icon={TreeStructure} label="Map" />
            <MoreRow href={`${base}/exams`} icon={Exam} label="Mock exams" />
            <MoreRow href={`${base}/materials`} icon={Files} label="Materials" />
            <MoreRow href={`${base}/settings`} icon={Gear} label="Course settings" />
            <button
              type="button"
              onClick={() => {
                setMoreOpen(false)
                setMobileNavOpen(true)
              }}
              className="flex min-h-12 items-center gap-3 rounded-control px-3 text-left text-body-strong text-fg hover:bg-surface-2"
            >
              <List aria-hidden="true" className="size-5 text-fg-3" />
              <span className="min-w-0 flex-1 truncate">Switch course or browse topics</span>
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
