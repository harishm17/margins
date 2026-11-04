'use client'

import * as React from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
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
  TreeStructure,
  FileText,
  GearSix,
  ListBullets,
  MagnifyingGlass,
  Microphone,
  Plus,
  SignOut,
  UploadSimple,
  X,
} from '@phosphor-icons/react/dist/ssr'
import { DialogOverlay } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Kbd, KeyHint } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { paletteFilter, paletteItem } from './palette-search'
import { useShell } from './shell-provider'

type Entry = {
  /** Unique id, also what "recent" stores. */
  id: string
  label: string
  /** Quiet text after the label, e.g. the course a topic belongs to. */
  hint?: string
  icon: React.ElementType
  group: 'Topics' | 'Files' | 'Courses' | 'Commands'
  keywords?: string[]
  run: (ctx: { router: ReturnType<typeof useRouter> }) => void
  /** Whether to remember it under "Recent". Actions that change state are not remembered. */
  remember?: boolean
}

const RECENT_KEY = 'margins:recent'
const MAX_RECENT = 5

/**
 * Remembers a topic when the student opens it by any route (a link, the next button, the palette), so a blank search
 * can offer the last few places they were. Same list and cap as the entries chosen in the palette.
 */
const rememberId = (id: string) => {
  try {
    const next = [id, ...readRecent().filter((item) => item !== id)].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Not remembering is fine.
  }
}

const readRecent = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

const itemClass = cn(
  'flex min-h-10 max-sm:min-h-11 cursor-default select-none items-center gap-3 rounded-control px-3 text-[13.5px] text-fg outline-none',
  'data-[selected=true]:bg-surface-2 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-3'
)

/** The label, and after it the course or unit; on a phone the hint goes on a second line so a truncated name can still be told apart. */
function EntryText({ entry }: { entry: Entry }) {
  return (
    <span className="flex min-w-0 flex-col max-sm:py-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="min-w-0 truncate">{entry.label}</span>
      {entry.hint ? <span className="min-w-0 truncate text-small text-fg-3">{entry.hint}</span> : null}
    </span>
  )
}

const headingClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-fg-3'

function PaletteBody() {
  const { nav, setPaletteOpen } = useShell()
  const router = useRouter()
  const params = useParams<{ courseId?: string }>()
  const { resolvedTheme, setTheme } = useTheme()
  const [search, setSearch] = React.useState('')
  // Commands (new course, theme, settings, sign out) stay out of a blank search: they show for ">" or "Show commands".
  const [showCommands, setShowCommands] = React.useState(false)
  const commandMode = showCommands || search.startsWith('>')
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
      // Files open the way "Open file" on the Materials page opens them: the file itself, in a new tab.
      for (const file of course.files) {
        list.push({
          id: `file:${file.id}`,
          label: file.filename,
          hint: course.id === params.courseId ? undefined : course.name,
          icon: FileText,
          group: 'Files',
          keywords: [course.name],
          remember: true,
          run: () => window.open(`/api/materials/${file.id}/file`, '_blank', 'noopener'),
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
    list.push({ id: 'action:new-course', label: 'New course', icon: Plus, group: 'Commands', run: ({ router }) => router.push('/courses/new') })
    if (currentCourse) {
      const base = `/courses/${currentCourse.id}`
      list.push(
        { id: 'action:upload', label: 'Upload materials', icon: UploadSimple, group: 'Commands', keywords: ['files', 'add'], run: ({ router }) => router.push(`${base}/materials`) },
        { id: 'action:ask', label: 'Ask a question', icon: ChatCircleText, group: 'Commands', run: ({ router }) => router.push(`${base}/ask`) },
        { id: 'action:new-exam', label: 'New mock exam', icon: Exam, group: 'Commands', run: ({ router }) => router.push(`${base}/exams/new`) },
        { id: 'action:plan', label: 'Open the plan', icon: CalendarCheck, group: 'Commands', keywords: ['today', 'schedule', 'exam date'], run: ({ router }) => router.push(`${base}/plan`) },
        { id: 'action:review', label: 'Review what is due', icon: ArrowsClockwise, group: 'Commands', keywords: ['retry', 'missed'], run: ({ router }) => router.push(`${base}/review`) },
        { id: 'action:map', label: 'Open the map', icon: TreeStructure, group: 'Commands', keywords: ['concepts', 'graph', 'prerequisites'], run: ({ router }) => router.push(`${base}/map`) },
        { id: 'action:voice', label: 'Start voice practice', icon: Microphone, group: 'Commands', keywords: ['speak', 'talk', 'oral'], run: ({ router }) => router.push(`${base}/review/voice`) }
      )
    }
    list.push(
      {
        id: 'action:theme',
        label: 'Toggle theme',
        icon: CircleHalf,
        group: 'Commands',
        keywords: ['dark', 'light'],
        run: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'action:settings', label: 'Settings', icon: GearSix, group: 'Commands', keywords: ['account', 'allowance', 'delete'], run: ({ router }) => router.push('/settings') },
      { id: 'action:sign-out', label: 'Sign out', icon: SignOut, group: 'Commands', run: () => void signOut({ callbackUrl: '/login' }) }
    )
    return list
  }, [nav, params.courseId, currentCourse, resolvedTheme, setTheme])

  const recentEntries = recent
    .map((id) => entries.find((entry) => entry.id === id))
    .filter((entry): entry is Entry => !!entry)

  function select(entry: Entry) {
    setPaletteOpen(false)
    if (entry.remember) rememberId(entry.id)
    entry.run({ router })
  }

  const groups: Entry['group'][] = commandMode ? ['Commands'] : ['Topics', 'Files', 'Courses', 'Commands']

  const renderItem = (entry: Entry, prefix = '') => {
    const Icon = entry.icon
    return (
      <Command.Item
        key={prefix + entry.id}
        {...paletteItem(entry, prefix)}
        onSelect={() => select(entry)}
        className={itemClass}
      >
        <Icon aria-hidden="true" />
        <EntryText entry={entry} />
        <CaretRight aria-hidden="true" className="ml-auto !size-3 opacity-0 [[data-selected=true]_&]:opacity-100" />
      </Command.Item>
    )
  }

  return (
    <Command loop label="Search and commands" filter={(value, term, keywords) => paletteFilter(value, term.replace(/^>\s*/, ''), keywords)}>
            <div className="flex h-12 items-center gap-3 border-b border-border px-4">
              <MagnifyingGlass aria-hidden="true" className="size-[18px] shrink-0 text-fg-3" />
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search courses, topics and files"
                className="h-full min-w-0 flex-1 bg-transparent text-[15px] max-sm:text-[16px] text-fg outline-none placeholder:text-fg-3"
              />
              <Kbd>Esc</Kbd>
              {/* No Esc key on a phone: a button closes the search there. */}
              <DialogPrimitive.Close asChild>
                <IconButton label="Close search" icon={<X />} noTooltip className="-mr-2 sm:hidden" />
              </DialogPrimitive.Close>
            </div>
            <Command.List className="max-h-[min(380px,50vh)] overflow-y-auto p-2">
              {search === '' && !commandMode ? null : (
                <Command.Empty className="px-3 py-8 text-center text-small text-fg-2">
                  Nothing matches &ldquo;{search.replace(/^>\s*/, '')}&rdquo;.
                </Command.Empty>
              )}
              {search === '' && !commandMode && recentEntries.length === 0 ? (
                <p className="px-3 py-8 text-center text-small text-fg-2">Type to search your courses, topics and files.</p>
              ) : null}
              {search === '' && !commandMode && recentEntries.length > 0 ? (
                <Command.Group heading="Recent" className={headingClass}>
                  {recentEntries.map((entry) => (
                    <Command.Item
                      key={`recent:${entry.id}`}
                      {...paletteItem(entry, 'recent:')}
                      onSelect={() => select(entry)}
                      className={itemClass}
                    >
                      <Clock aria-hidden="true" />
                      <EntryText entry={entry} />
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}
              {(search === '' && !commandMode ? [] : groups).map((group) => {
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
              <KeyHint className="flex items-center gap-4">
                <span className="flex items-center gap-1.5">
                  <Kbd aria-label="Up arrow">&uarr;</Kbd>
                  <Kbd aria-label="Down arrow">&darr;</Kbd>
                  Navigate
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd>Enter</Kbd>
                  Open
                </span>
              </KeyHint>
              {/* Outside the key hints: those hide on a phone, and commands must stay reachable there. */}
              {commandMode ? null : (
                <button
                  type="button"
                  onClick={() => setShowCommands(true)}
                  className="inline-flex min-h-6 items-center rounded-chip text-small text-fg-2 underline-offset-2 hover:text-fg hover:underline max-sm:min-h-11 sm:ml-auto"
                >
                  Show commands
                </button>
              )}
            </div>
          </Command>
  )
}

/** Ctrl or Cmd K. Topics, courses and actions from the nav index the layout already loaded. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useShell()
  const pathname = usePathname()
  React.useEffect(() => {
    const topicId = /^\/courses\/[^/]+\/topics\/([^/]+)/.exec(pathname)?.[1]
    if (topicId) rememberId(`topic:${topicId}`)
  }, [pathname])
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
