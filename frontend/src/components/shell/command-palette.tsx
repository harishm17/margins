'use client'

import * as React from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Command } from 'cmdk'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { signOut } from 'next-auth/react'
import { useTheme } from 'next-themes'
import {
  ArrowsClockwise,
  BookOpenText,
  CalendarCheck,
  CaretRight,
  ChatCircleText,
  CircleHalf,
  Clock,
  Exam,
  GearSix,
  ListBullets,
  MagnifyingGlass,
  Microphone,
  Plus,
  SignOut,
  UploadSimple,
} from '@phosphor-icons/react/dist/ssr'
import { DialogOverlay } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useShell } from './shell-provider'

type Entry = {
  /** Unique id, also what "recent" stores. */
  id: string
  label: string
  /** Quiet text after the label, e.g. the course a topic belongs to. */
  hint?: string
  icon: React.ElementType
  group: 'Topics' | 'Courses' | 'Actions'
  keywords?: string[]
  run: (ctx: { router: ReturnType<typeof useRouter> }) => void
  /** Whether to remember it under "Recent". Actions that change state are not remembered. */
  remember?: boolean
}

const RECENT_KEY = 'margins:recent'
const MAX_RECENT = 5

const readRecent = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const itemClass = cn(
  'flex h-10 cursor-default select-none items-center gap-3 rounded-control px-3 text-[13.5px] text-fg outline-none',
  'data-[selected=true]:bg-surface-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3'
)

const headingClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-fg-3'

function PaletteBody() {
  const { nav, setPaletteOpen } = useShell()
  const router = useRouter()
  const params = useParams<{ courseId?: string }>()
  const { resolvedTheme, setTheme } = useTheme()
  const [search, setSearch] = React.useState('')
  // The body mounts when the palette opens, so this reads the recent list fresh each time.
  const [recent] = React.useState<string[]>(readRecent)

  const currentCourse = nav.find((course) => course.id === params.courseId) ?? nav[0]

  const entries = React.useMemo<Entry[]>(() => {
    const list: Entry[] = []
    const ordered = [...nav].sort((a, b) => Number(b.id === params.courseId) - Number(a.id === params.courseId))
    for (const course of ordered) {
      for (const topic of course.topics) {
        const unit = course.units.find((item) => item.id === topic.unitId)?.title
        list.push({
          id: `topic:${topic.id}`,
          label: topic.name,
          hint: course.id === params.courseId ? unit : unit ? `${course.name}, ${unit}` : course.name,
          icon: ListBullets,
          group: 'Topics',
          keywords: unit ? [course.name, unit] : [course.name],
          remember: true,
          run: ({ router }) => router.push(`/courses/${course.id}/topics/${topic.id}`),
        })
      }
    }
    for (const course of nav) {
      list.push({
        id: `course:${course.id}`,
        label: course.name,
        icon: BookOpenText,
        group: 'Courses',
        remember: true,
        run: ({ router }) => router.push(`/courses/${course.id}`),
      })
    }
    list.push({ id: 'action:new-course', label: 'New course', icon: Plus, group: 'Actions', run: ({ router }) => router.push('/courses/new') })
    if (currentCourse) {
      const base = `/courses/${currentCourse.id}`
      list.push(
        { id: 'action:upload', label: 'Upload materials', icon: UploadSimple, group: 'Actions', keywords: ['files', 'add'], run: ({ router }) => router.push(`${base}/materials`) },
        { id: 'action:ask', label: 'Ask a question', icon: ChatCircleText, group: 'Actions', run: ({ router }) => router.push(`${base}/ask`) },
        { id: 'action:new-exam', label: 'New mock exam', icon: Exam, group: 'Actions', run: ({ router }) => router.push(`${base}/exams/new`) },
        { id: 'action:plan', label: 'Open the plan', icon: CalendarCheck, group: 'Actions', keywords: ['today', 'schedule', 'exam date'], run: ({ router }) => router.push(`${base}/plan`) },
        { id: 'action:review', label: 'Review what is due', icon: ArrowsClockwise, group: 'Actions', keywords: ['retry', 'missed'], run: ({ router }) => router.push(`${base}/review`) },
        { id: 'action:voice', label: 'Start voice practice', icon: Microphone, group: 'Actions', keywords: ['speak', 'talk', 'oral'], run: ({ router }) => router.push(`${base}/review/voice`) }
      )
    }
    list.push(
      {
        id: 'action:theme',
        label: 'Toggle theme',
        icon: CircleHalf,
        group: 'Actions',
        keywords: ['dark', 'light'],
        run: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'action:settings', label: 'Settings', icon: GearSix, group: 'Actions', keywords: ['account', 'allowance', 'delete'], run: ({ router }) => router.push('/settings') },
      { id: 'action:sign-out', label: 'Sign out', icon: SignOut, group: 'Actions', run: () => void signOut({ callbackUrl: '/login' }) }
    )
    return list
  }, [nav, params.courseId, currentCourse, resolvedTheme, setTheme])

  const recentEntries = recent
    .map((id) => entries.find((entry) => entry.id === id))
    .filter((entry): entry is Entry => !!entry)

  function select(entry: Entry) {
    setPaletteOpen(false)
    if (entry.remember) {
      try {
        const next = [entry.id, ...readRecent().filter((id) => id !== entry.id)].slice(0, MAX_RECENT)
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // Not remembering is fine.
      }
    }
    entry.run({ router })
  }

  const groups: Entry['group'][] = ['Topics', 'Courses', 'Actions']

  const renderItem = (entry: Entry, prefix = '') => {
    const Icon = entry.icon
    return (
      <Command.Item
        key={prefix + entry.id}
        value={`${prefix}${entry.label} ${entry.hint ?? ''}`}
        keywords={entry.keywords}
        onSelect={() => select(entry)}
        className={itemClass}
      >
        <Icon aria-hidden="true" />
        <span className="min-w-0 truncate">{entry.label}</span>
        {entry.hint ? <span className="min-w-0 truncate text-small text-fg-3">{entry.hint}</span> : null}
        <CaretRight aria-hidden="true" className="ml-auto !size-3 opacity-0 [[data-selected=true]_&]:opacity-100" />
      </Command.Item>
    )
  }

  return (
    <Command loop label="Search and commands">
            <div className="flex h-12 items-center gap-3 border-b border-border px-4">
              <MagnifyingGlass aria-hidden="true" className="size-[18px] shrink-0 text-fg-3" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search topics, courses and actions"
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-3"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(380px,50vh)] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-small text-fg-2">
                Nothing matches &ldquo;{search}&rdquo;.
              </Command.Empty>
              {search === '' && recentEntries.length > 0 ? (
                <Command.Group heading="Recent" className={headingClass}>
                  {recentEntries.map((entry) => (
                    <Command.Item
                      key={`recent:${entry.id}`}
                      value={`recent ${entry.label} ${entry.hint ?? ''}`}
                      onSelect={() => select(entry)}
                      className={itemClass}
                    >
                      <Clock aria-hidden="true" />
                      <span className="min-w-0 truncate">{entry.label}</span>
                      {entry.hint ? <span className="min-w-0 truncate text-small text-fg-3">{entry.hint}</span> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {groups.map((group) => {
                const items = entries.filter((entry) => entry.group === group)
                if (items.length === 0) return null
                return (
                  <Command.Group key={group} heading={group} className={headingClass}>
                    {items.map((entry) => renderItem(entry))}
                  </Command.Group>
                )
              })}
            </Command.List>
            <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-caption font-normal text-fg-3">
              <span className="flex items-center gap-1.5">
                <Kbd>Up</Kbd>
                <Kbd>Down</Kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Enter</Kbd>
                Open
              </span>
            </div>
          </Command>
  )
}

/** Ctrl or Cmd K. Topics, courses and actions from the nav index the layout already loaded. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useShell()
  return (
    <DialogPrimitive.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            'fixed inset-x-0 top-[20vh] z-modal mx-auto w-[calc(100%-32px)] max-w-[600px] overflow-hidden outline-none',
            'rounded-card border border-border bg-surface shadow-float',
            'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out'
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search and commands</DialogPrimitive.Title>
          <PaletteBody />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
