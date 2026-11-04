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
import { isSectionNotReady, NOT_READY_REASON } from './course-nav'
import { useShell } from './shell-provider'

/** The bar's height. Other full-height pages and sticky bottoms subtract it (`var(--tabbar-height, 0px)`). */
const BAR = '3.5rem'

type Tab = { key: string; label: string; href: string; icon: React.ElementType; active: boolean; badge?: number; notReady?: boolean }

function TabLink({ tab }: { tab: Tab }) {
  const Icon = tab.icon
  if (tab.notReady) {
    // Nothing behind it while the course is in setup: dimmed, not a link, and the reason is read out.
    return (
      <span
        role="link"
        aria-disabled="true"
        aria-label={`${tab.label}. ${NOT_READY_REASON}`}
        className="flex h-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-control text-caption text-fg-3"
      >
        <Icon aria-hidden="true" className="size-[22px] text-fg-3" />
        <span className="max-w-full truncate" aria-hidden="true">
          {tab.label}
        </span>
      </span>
    )
  }
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
  notReady,
}: {
  href: string
  icon: React.ElementType
  label: string
  badge?: number
  notReady?: boolean
}) {
  if (notReady) {
    return (
      <span role="link" aria-disabled="true" className="flex min-h-12 items-center gap-3 rounded-control px-3 text-body-strong text-fg-3">
        <Icon aria-hidden="true" className="size-5 text-fg-3" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 text-caption font-normal">{NOT_READY_REASON}</span>
      </span>
    )
  }
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
  const { nav, setMobileNavOpen } = useShell()
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
  if (!course) return null

  const base = `/courses/${course.id}`
  const inMore = ['review', 'map', 'exams', 'materials', 'settings'].some((section) => pathname.startsWith(`${base}/${section}`))
  const notReady = (key: string) => isSectionNotReady(key, course)
  const tabs: Tab[] = [
    { key: 'overview', label: 'Overview', href: base, icon: House, active: pathname === base, badge: course.dueCount },
    { key: 'plan', notReady: notReady('plan'), label: 'Plan', href: `${base}/plan`, icon: CalendarCheck, active: pathname.startsWith(`${base}/plan`) },
    { key: 'topics', notReady: notReady('topics'), label: 'Topics', href: `${base}/topics`, icon: ListBullets, active: pathname.startsWith(`${base}/topics`) },
    { key: 'ask', notReady: notReady('ask'), label: 'Ask', href: `${base}/ask`, icon: ChatCircleText, active: pathname.startsWith(`${base}/ask`) },
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
            <MoreRow href={`${base}/review`} icon={ArrowsClockwise} label="Review" badge={course.dueCount} notReady={notReady('review')} />
            <MoreRow href={`${base}/map`} icon={TreeStructure} label="Map" notReady={notReady('map')} />
            <MoreRow href={`${base}/exams`} icon={Exam} label="Mock exams" notReady={notReady('exams')} />
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
              <span className="min-w-0 flex-1 truncate">All courses and topics</span>
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
