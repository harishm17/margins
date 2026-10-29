'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import {
  CalendarCheck,
  CaretDown,
  ChatCircleText,
  Exam,
  Files,
  House,
  ListBullets,
  MagnifyingGlass,
  ArrowsClockwise,
} from '@phosphor-icons/react/dist/ssr'
import { Kbd, KeyHint } from '@/components/ui/kbd'
import { MasteryIndicator } from '@/components/ui/mastery-indicator'
import { Tooltip } from '@/components/ui/tooltip'
import { groupTopicsByUnit } from '@/lib/topics/units'
import { useIsMac } from '@/lib/hooks/use-is-mac'
import { cn } from '@/lib/utils'
import { AccountMenu } from './account-menu'
import { Brand } from './brand'
import { CourseSwitcher } from './course-switcher'
import { useShell } from './shell-provider'
import { useSidebarCollapsed } from './sidebar-state'
import { readUnitChoices, useUnitState } from './unit-state'
import type { NavCourse, NavTopic } from '@/server/queries/courses'

type NavItem = {
  key: string
  label: string
  href: string
  icon: React.ElementType
  active: boolean
  badge?: React.ReactNode
}

function NavLink({ item, rail }: { item: NavItem; rail: boolean }) {
  const Icon = item.icon
  const link = (
    <Link
      href={item.href}
      aria-current={item.active ? 'page' : undefined}
      aria-label={rail ? item.label : undefined}
      className={cn(
        'group flex h-[34px] max-lg:h-11 items-center gap-2.5 rounded-control px-2.5 text-body-strong text-fg-2',
        'transition-colors duration-120 hover:bg-surface-2 hover:text-fg',
        'rail:justify-center rail:px-0',
        item.active && 'bg-surface-2 text-fg'
      )}
    >
      <Icon
        aria-hidden="true"
        weight={item.active ? 'fill' : 'regular'}
        className={cn('size-[18px] shrink-0', item.active ? 'text-accent' : 'text-fg-3')}
      />
      <span className="min-w-0 flex-1 truncate rail:hidden">{item.label}</span>
      {item.badge ? <span className="rail:hidden">{item.badge}</span> : null}
    </Link>
  )
  return rail ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  )
}

function TopicLink({ courseId, topic, active }: { courseId: string; topic: NavTopic; active: boolean }) {
  return (
    <li>
      <Link
        href={`/courses/${courseId}/topics/${topic.id}`}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-8 max-lg:h-11 items-center gap-2.5 rounded-control px-2.5 text-[13.5px] text-fg-2',
          'transition-colors duration-120 hover:bg-surface-2 hover:text-fg',
          active && 'bg-surface-2 text-fg'
        )}
      >
        <MasteryIndicator mastery={topic.mastery} variant="ring" />
        <span className="min-w-0 flex-1 truncate">{topic.name}</span>
      </Link>
    </li>
  )
}

/** A mastery value for a unit: the mean over its topics, not-started ones counting as 0. */
const unitMasteryOf = (topics: NavTopic[]): number | null =>
  topics.length === 0 ? null : topics.reduce((sum, topic) => sum + (topic.mastery ?? 0), 0) / topics.length

/**
 * The sidebar's topic list. A flat course is one plain list; with units each unit is a button that
 * opens and closes its topics (remembered per course). A unit with no saved choice is open when it
 * holds the current topic, or, away from a topic, when it is the first with unfinished work.
 */
function TopicList({ course, activeTopicId }: { course: NavCourse; activeTopicId: string | undefined }) {
  const { choices, setOpen } = useUnitState(course.units.length > 0 ? course.id : null)
  const idPrefix = React.useId()
  // The nav list is already in course order; groupTopicsByUnit wants that order as a number.
  const groups = React.useMemo(
    () => groupTopicsByUnit(course.topics.map((topic, orderIndex) => ({ ...topic, orderIndex })), course.units),
    [course.topics, course.units]
  )

  const activeUnitId = course.topics.find((topic) => topic.id === activeTopicId)?.unitId ?? null
  const firstUnfinished = groups.find((group) => group.unit && group.topics.some((topic) => (topic.mastery ?? 0) < 0.8))?.unit?.id
  const defaultUnit = activeUnitId ?? firstUnfinished ?? groups.find((group) => group.unit)?.unit?.id ?? null

  // Opening a topic from anywhere (a link, the palette, the next button) shows it in the list.
  const courseId = course.id
  React.useEffect(() => {
    if (activeUnitId && readUnitChoices(courseId)[activeUnitId] === false) setOpen(activeUnitId, true)
  }, [courseId, activeTopicId, activeUnitId, setOpen])

  if (course.units.length === 0) {
    return (
      <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {course.topics.map((topic) => (
          <TopicLink key={topic.id} courseId={course.id} topic={topic} active={activeTopicId === topic.id} />
        ))}
      </ul>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      {groups.map((group, index) => {
        if (!group.unit) {
          return (
            <ul key="loose" className={cn(index > 0 && 'mt-1')}>
              {group.topics.map((topic) => (
                <TopicLink key={topic.id} courseId={course.id} topic={topic} active={activeTopicId === topic.id} />
              ))}
            </ul>
          )
        }
        const unit = group.unit
        const open = choices[unit.id] ?? unit.id === defaultUnit
        const panelId = `${idPrefix}-${unit.id}`
        return (
          <div key={unit.id}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen(unit.id, !open)}
              title={unit.weekLabel ? `${unit.weekLabel}: ${unit.title}` : unit.title}
              className={cn(
                'flex h-8 w-full max-lg:h-11 items-center gap-2 rounded-control px-2.5 text-left text-[13.5px] font-medium text-fg',
                'transition-colors duration-120 hover:bg-surface-2'
              )}
            >
              <CaretDown
                aria-hidden="true"
                weight="bold"
                className={cn('size-3 shrink-0 text-fg-3 transition-transform duration-180', !open && '-rotate-90')}
              />
              <span className="min-w-0 flex-1 truncate">
                {unit.weekLabel ? <span className="sr-only">{unit.weekLabel}: </span> : null}
                {unit.title}
              </span>
              <MasteryIndicator mastery={unitMasteryOf(group.topics)} variant="ring" />
            </button>
            <ul id={panelId} hidden={!open} data-collapsible="" className="ml-[15px] border-l border-border pl-1.5">
              {group.topics.map((topic) => (
                <TopicLink key={topic.id} courseId={course.id} topic={topic} active={activeTopicId === topic.id} />
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Everything in the sidebar. The desktop aside and the mobile sheet both render it; only the
 * desktop one can be a rail (`allowRail`).
 */
export function SidebarContent({ allowRail = false }: { allowRail?: boolean }) {
  const { nav, setPaletteOpen } = useShell()
  const pathname = usePathname()
  const params = useParams<{ courseId?: string; topicId?: string }>()
  const collapsed = useSidebarCollapsed()
  const isMac = useIsMac()
  const rail = allowRail && collapsed
  const topicsLabelId = React.useId()

  const course = nav.find((item) => item.id === params.courseId)
  const base = course ? `/courses/${course.id}` : null

  const items: NavItem[] = base
    ? [
        {
          key: 'overview',
          label: 'Overview',
          href: base,
          icon: House,
          active: pathname === base,
          badge:
            course && course.dueCount > 0 ? (
              <span
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-warning-soft px-1.5 text-caption text-warning-soft-fg tabular"
                title={`${course.dueCount} due for review`}
              >
                <span className="sr-only">{course.dueCount} due for review</span>
                <span aria-hidden="true">{course.dueCount}</span>
              </span>
            ) : null,
        },
        { key: 'plan', label: 'Plan', href: `${base}/plan`, icon: CalendarCheck, active: pathname.startsWith(`${base}/plan`) },
        {
          key: 'topics',
          label: 'Topics',
          href: `${base}/topics`,
          icon: ListBullets,
          active: pathname === `${base}/topics`,
          badge: course?.needsTopicReview ? (
            <span className="inline-flex items-center" title="Topics need review">
              <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
              <span className="sr-only">Topics need review</span>
            </span>
          ) : null,
        },
        { key: 'materials', label: 'Materials', href: `${base}/materials`, icon: Files, active: pathname.startsWith(`${base}/materials`) },
        { key: 'ask', label: 'Ask', href: `${base}/ask`, icon: ChatCircleText, active: pathname.startsWith(`${base}/ask`) },
        { key: 'exams', label: 'Mock exams', href: `${base}/exams`, icon: Exam, active: pathname.startsWith(`${base}/exams`) },
        { key: 'review', label: 'Review', href: `${base}/review`, icon: ArrowsClockwise, active: pathname.startsWith(`${base}/review`) },
      ]
    : []

  const search = (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      aria-label={rail ? 'Search' : undefined}
      className={cn(
        'flex h-[34px] w-full items-center gap-2.5 rounded-control px-2.5 text-body-strong text-fg-2',
        'transition-colors duration-120 hover:bg-surface-2 hover:text-fg',
        'rail:justify-center rail:px-0'
      )}
    >
      <MagnifyingGlass aria-hidden="true" className="size-[18px] shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate text-left rail:hidden">Search</span>
      <KeyHint className="flex gap-1 rail:hidden" aria-hidden="true">
        <Kbd>{isMac ? 'Cmd' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </KeyHint>
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center px-4 rail:justify-center rail:px-0">
        <Link href="/home" aria-label="Margins home" className="rounded-chip">
          <Brand wordmarkClassName="rail:hidden" />
        </Link>
      </div>

      <div className="px-3">
        <CourseSwitcher rail={rail} />
      </div>

      {items.length > 0 ? (
        <nav aria-label="Course" className="mt-3 flex flex-col gap-0.5 px-3">
          {items.map((item) => (
            <NavLink key={item.key} item={item} rail={rail} />
          ))}
        </nav>
      ) : (
        <nav aria-label="Courses" className="mt-3 flex flex-col gap-0.5 px-3">
          <NavLink
            rail={rail}
            item={{ key: 'home', label: 'Home', href: '/home', icon: House, active: pathname === '/home' }}
          />
        </nav>
      )}

      {course?.active && course.topics.length > 0 ? (
        // A labelled group, not a heading: the sidebar comes before <main> in the page, and its label
        // must not be the first heading a screen reader meets (the page's h1 is).
        <div role="group" aria-labelledby={topicsLabelId} className="mt-5 flex min-h-0 flex-1 flex-col rail:hidden">
          <p id={topicsLabelId} className="px-5 pb-1.5 text-caption text-fg-3">
            Topics
          </p>
          <TopicList course={course} activeTopicId={params.topicId} />
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="flex flex-col gap-0.5 border-t border-border p-3">
        {rail ? (
          <Tooltip content="Search" side="right" shortcut={isMac ? 'Cmd K' : 'Ctrl K'}>
            {search}
          </Tooltip>
        ) : (
          search
        )}
        <AccountMenu rail={rail} />
      </div>
    </div>
  )
}

/** The desktop sidebar: 248px, or a 64px rail. Hidden below 1024px (the mobile sheet takes over). */
export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        'sidebar-desktop sticky top-0 z-sidebar hidden h-dvh shrink-0 border-r border-border bg-surface lg:block',
        'w-(--sidebar-width) [[data-sidebar=collapsed]_&]:w-(--sidebar-rail-width)'
      )}
    >
      <SidebarContent allowRail />
    </aside>
  )
}
